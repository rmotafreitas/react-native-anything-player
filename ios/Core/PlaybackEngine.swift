import Foundation

// The playback engine: one per player. A deterministic state machine that owns
// the play intent, the recovery policy and every timing decision. It never
// touches AVFoundation — it drives an `EngineDriver` (the AVPlayer adapter in
// production, a recorder in tests) and reads time from an `EngineClock`.
//
// Threading: every entry point must be called on the same serial context
// (the main thread in production). The engine never blocks and never sleeps;
// it asks its delegate for a single wake-up instant instead of owning timers.
//
// Stale-event protection: every source open gets a new `generation`. Native
// observations carry the generation they were installed for; anything else is
// dropped at the door (`accepts(_:)`). See docs/architecture.md.
//
// Kotlin twin: `android/.../core/PlaybackEngine.kt`. Both run `conformance/`.

protocol EngineDriver: AnyObject {
  func open(_ request: OpenRequest)
  /// Start/resume the current item (latched until the item is ready).
  func play()
  func pause()
  func seek(to seconds: Double)
  /// Drop the network connection / decoder but keep nothing playing.
  func releaseConnection()
  /// Remove the current item entirely.
  func unload()
  /// Effective output volume (volume × mute × duck), 0...1.
  func setVolume(_ effective: Double)
  func setRate(_ rate: Double)
  func sample() -> PlaybackSample
}

protocol EngineClock: AnyObject {
  /// Monotonic milliseconds (including device sleep).
  var monotonicMs: Int64 { get }
  /// Wall-clock epoch milliseconds (for timestamps shown to apps).
  var wallMs: Int64 { get }
}

enum LoadOutcome: Equatable {
  case ready
  case superseded
  case failed(PlayerError)
}

protocol EngineDelegate: AnyObject {
  /// Requests (or confirms) audio focus / an active audio session.
  func engineRequestsAudioFocus() -> FocusResult
  func engine(statusChanged status: Status)
  func engine(loadSettled loadId: Int, outcome: LoadOutcome)
  func engine(error: PlayerError, fatal: Bool)
  func engineDidEnd()
  func engine(diagnostic: DiagnosticEntry)
  /// The engine wants `onWakeup()` at this monotonic instant (`nil` = none).
  func engine(wakeupAt: Int64?)
}

final class PlaybackEngine {
  private let driver: EngineDriver
  private let clock: EngineClock
  weak var delegate: EngineDelegate?
  var options: EngineOptions

  // ── Source & intent ──
  private(set) var source: SourceDescriptor?
  private(set) var generation = 0
  private(set) var loadId = 0
  private var pendingLoadId: Int?
  private(set) var state: PlaybackState = .idle
  private(set) var playWhenReady = false
  private var released = false

  // ── Source facts ──
  private var isLive = false
  private var duration: Double?
  private var seekable = false
  /// The item became ready at least once for the current generation.
  private var readyForGeneration = false

  // ── System ──
  private(set) var interruption: Interruption?
  private var lastError: PlayerError?
  private var network: NetworkState = .unknown
  private var duckFactor: Double = 1
  private var volume: Double = 1
  private var muted = false
  private var rate: Double = 1

  // ── Timing (monotonic ms) ──
  private var lastOpenAt: Int64?
  /// Audio flowed since the last open (an in-flight open is no longer protected).
  private var flowedSinceOpen = false
  private var stallStartedAt: Int64?
  /// A native stall waiting out `stallDebounceMs` before it is published.
  private var stallPublishAt: Int64?
  private var lastPosition: Double = 0
  private var lastPositionAdvanceAt: Int64 = 0
  private var lastBuffered: Double = 0
  private var lastBufferedAdvanceAt: Int64 = 0
  private var pausedAt: Int64?
  /// Live: how far behind the live edge the current open has fallen (ms).
  private var driftMs: Int64 = 0
  private var playingSince: Int64?
  /// First failure of the current recovery episode (cleared by stable playback).
  private var recoveringSince: Int64?
  /// Audio has flowed for `stablePlaybackMs`: the next loss reconnects at once.
  private var stable = false
  private var nextAttemptAt: Int64?
  private var reconnectReason = ""
  private var backoff: Backoff
  private var offlineSkips = 0
  private var lastNetworkEdgeAt: Int64 = Int64.min
  private var suspectUntil: Int64 = Int64.min
  private var pauseReleaseAt: Int64?
  private var connectionReleased = false
  /// VOD: where a re-open should resume.
  private var resumePosition: Double?
  private var lastHeartbeatAt: Int64 = 0
  private var lastPublished: Status?
  /// Discrete events wait until the status they imply was published, so a
  /// listener never sees `ended`/`error` while the status still says playing.
  private var pendingEvents: [() -> Void] = []

  init(
    driver: EngineDriver, clock: EngineClock, options: EngineOptions = EngineOptions(),
    random: @escaping () -> Double = { Double.random(in: 0..<1) }
  ) {
    self.driver = driver
    self.clock = clock
    self.options = options
    self.backoff = Backoff(random: random)
  }

  private var now: Int64 { clock.monotonicMs }

  // MARK: - Queries

  var status: Status {
    var s = Status()
    s.state = state
    s.playWhenReady = playWhenReady
    s.loadId = loadId
    s.isLive = isLive
    s.duration = duration
    s.seekable = seekable
    s.interruption = interruption
    s.error = state == .error ? lastError : nil
    if state == .reconnecting || (state == .loading && backoff.attempts > 0) {
      let wallAt = nextAttemptAt.map { clock.wallMs + max(0, $0 - now) }
      s.reconnect = ReconnectInfo(
        attempt: max(1, backoff.attempts), nextAttemptAt: wallAt, reason: reconnectReason)
    }
    s.network = network
    s.volume = volume
    s.muted = muted
    s.rate = rate
    return s
  }

  /// Whether a background keepalive should run: playback is wanted but no
  /// audio is being rendered (iOS suspends a silent background app, freezing
  /// recovery with it).
  var wantsKeepalive: Bool {
    playWhenReady && (state == .loading || state == .buffering || state == .reconnecting)
  }

  /// Whether the player holds (or may soon re-take) audio focus.
  var needsAudioFocus: Bool {
    playWhenReady || (interruption?.resumable ?? false)
  }

  /// Native observations for any other generation are stale and must be dropped.
  func accepts(_ generation: Int) -> Bool {
    !released && generation == self.generation
  }

  // MARK: - Commands

  func load(_ newSource: SourceDescriptor, autoplay: Bool?, startPosition: Double?) throws {
    try ensureAlive()
    let wanted = autoplay ?? (playWhenReady && Self.continuesIntent(state))
    if let previous = pendingLoadId {
      pendingLoadId = nil
      delegate?.engine(loadSettled: previous, outcome: .superseded)
    }
    source = newSource
    loadId += 1
    pendingLoadId = loadId
    isLive = newSource.liveHint ?? false
    duration = nil
    seekable = false
    lastError = nil
    interruption = nil
    resetRecovery()
    resumePosition = startPosition
    playWhenReady = wanted
    if wanted { applyFocus(delegate?.engineRequestsAudioFocus() ?? .granted) }
    log("load", ["uri": newSource.uri, "autoplay": "\(playWhenReady)"])
    open(startPosition: startPosition, reason: "load")
    commit()
  }

  func play() throws {
    try ensureAlive()
    guard source != nil else { throw PlayerError.code(.noSource, "No source loaded.", recoverable: false) }
    if playWhenReady && Self.continuesIntent(state) {
      commit()
      return
    }
    let focus = delegate?.engineRequestsAudioFocus() ?? .granted
    switch focus {
    case .denied:
      interruption = Interruption(reason: .audioFocusDenied, resumable: false, since: clock.wallMs)
      log("play refused", ["focus": "denied"])
      commit()
      throw PlayerError.code(
        .audioFocusDenied, "The system refused audio focus (another app or a call holds it).",
        recoverable: true)
    case .delayed:
      interruption = Interruption(reason: .audioFocusDelayed, resumable: true, since: clock.wallMs)
      log("play deferred", ["focus": "delayed"])
      commit()
      return
    case .granted:
      break
    }
    interruption = nil
    startPlayback(cause: "play")
    commit()
  }

  func pause() throws {
    try ensureAlive()
    let hadInterruption = interruption != nil
    interruption = nil
    guard playWhenReady else {
      // Already paused (by the system, or a duplicate pause): it is now a user
      // pause — a pending OS resume must not resurrect it.
      if hadInterruption { log("pause", ["note": "cancels system resume"]) }
      commit()
      return
    }
    playWhenReady = false
    pauseIntent(cause: "pause")
    commit()
  }

  func stop() throws {
    try ensureAlive()
    guard source != nil else { return }
    settlePendingLoad(.superseded)
    playWhenReady = false
    interruption = nil
    resetRecovery()
    pauseReleaseAt = nil
    stallStartedAt = nil
    pausedAt = nil
    driver.releaseConnection()
    connectionReleased = true
    resumePosition = isLive ? nil : 0
    setState(.stopped, cause: "stop")
    commit()
  }

  func reset() throws {
    try ensureAlive()
    settlePendingLoad(.superseded)
    generation += 1
    source = nil
    playWhenReady = false
    interruption = nil
    lastError = nil
    isLive = false
    duration = nil
    seekable = false
    resetRecovery()
    pauseReleaseAt = nil
    connectionReleased = false
    driver.unload()
    setState(.idle, cause: "reset")
    commit()
  }

  func seek(to seconds: Double) throws {
    try ensureAlive()
    guard source != nil else { throw PlayerError.code(.noSource, "No source loaded.", recoverable: false) }
    guard seekable, !isLive else {
      throw PlayerError.code(.notSeekable, "This source is not seekable.", recoverable: false)
    }
    guard seconds.isFinite, seconds >= 0 else {
      throw PlayerError.code(.invalidArgument, "Seek position must be a finite number ≥ 0.", recoverable: false)
    }
    let target = duration.map { min(seconds, $0) } ?? seconds
    resumePosition = target
    lastPosition = target
    lastPositionAdvanceAt = now
    if state == .ended { setState(.paused, cause: "seek after end") }
    if connectionReleased || state == .stopped || state == .error {
      // Nothing is open: the next play re-opens at `resumePosition`.
      commit()
      return
    }
    driver.seek(to: target)
    commit()
  }

  func setVolume(_ value: Double) throws {
    try ensureAlive()
    guard value.isFinite else {
      throw PlayerError.code(.invalidArgument, "Volume must be a finite number.", recoverable: false)
    }
    volume = min(max(value, 0), 1)
    applyVolume()
    commit()
  }

  func setMuted(_ value: Bool) throws {
    try ensureAlive()
    muted = value
    applyVolume()
    commit()
  }

  func setRate(_ value: Double) throws {
    try ensureAlive()
    guard value.isFinite, value > 0 else {
      throw PlayerError.code(.invalidArgument, "Rate must be a finite number > 0.", recoverable: false)
    }
    rate = value
    driver.setRate(value)
    commit()
  }

  /// Ducking requested by the OS (Android < 8; the system ducks newer versions itself).
  func setDucked(_ ducked: Bool) {
    guard !released else { return }
    duckFactor = ducked ? 0.2 : 1
    applyVolume()
  }

  func release() {
    guard !released else { return }
    settlePendingLoad(.failed(.code(.playerReleased, "The player was released.", recoverable: false)))
    playWhenReady = false
    interruption = nil
    resetRecovery()
    pauseReleaseAt = nil
    driver.unload()
    setState(.idle, cause: "release")
    commit()
    released = true
    delegate?.engine(wakeupAt: nil)
  }

  // MARK: - Native observations (generation-guarded)

  func onReady(generation gen: Int, info: ReadyInfo) {
    guard accepts(gen) else { return logStale("ready", gen) }
    duration = info.duration
    isLive = source?.liveHint ?? info.isLive
    seekable = info.seekable && !isLive
    readyForGeneration = true
    if state == .loading {
      if playWhenReady {
        setState(.buffering, cause: "ready")
        beginWaiting()
      } else {
        setState(.paused, cause: "ready")
        pausedAt = now
        armPauseRelease()
      }
    }
    settlePendingLoad(.ready)
    commit()
  }

  /// Audio is actually flowing.
  func onPlaying(generation gen: Int) {
    guard accepts(gen) else { return logStale("playing", gen) }
    guard playWhenReady else {
      // A straggler from before a pause (or a self-resume the user overrode).
      log("native playing without intent", [:])
      driver.pause()
      commit()
      return
    }
    if !readyForGeneration {
      readyForGeneration = true
      settlePendingLoad(.ready)
    }
    let t = now
    stallPublishAt = nil
    if let stalled = stallStartedAt {
      driftMs += t - stalled
      stallStartedAt = nil
    }
    flowedSinceOpen = true
    lastOpenAt = nil
    nextAttemptAt = nil
    let sample = driver.sample()
    lastPosition = sample.position
    lastPositionAdvanceAt = t
    playingSince = t
    // Drift is only enforced at moments that are silent anyway (resuming from
    // a pause, or during a published stall): cutting audio that has just
    // resumed to jump to the live edge would add a gap for no audible gain.
    setState(.playing, cause: "audio flowing")
    commit()
  }

  /// Playback wanted, waiting for data.
  func onBuffering(generation gen: Int) {
    guard accepts(gen) else { return logStale("buffering", gen) }
    if state == .playing && stallPublishAt == nil {
      stallStartedAt = now
      stallPublishAt = now + RecoveryPolicy.stallDebounceMs
      playingSince = nil
    }
    commit()
  }

  func onFailed(generation gen: Int, error: PlayerError) {
    guard accepts(gen) else { return logStale("failed", gen) }
    handleFailure(error)
    commit()
  }

  func onEnded(generation gen: Int) {
    guard accepts(gen) else { return logStale("ended", gen) }
    if isLive || duration == nil {
      handleFailure(.code(.streamEnded, "The stream closed the connection.", recoverable: true))
    } else {
      playWhenReady = false
      resumePosition = 0
      stallStartedAt = nil
      setState(.ended, cause: "end of media")
      pendingEvents.append { [weak self] in self?.delegate?.engineDidEnd() }
    }
    commit()
  }

  /// The platform paused the player without being asked to.
  func onPausedExternally(generation gen: Int, reason: InterruptionReason) {
    guard accepts(gen) else { return logStale("paused externally", gen) }
    guard playWhenReady else { return }
    interruptionBegan(reason: reason, resumable: false)
  }

  // MARK: - System events

  func interruptionBegan(reason: InterruptionReason, resumable: Bool) {
    guard !released else { return }
    guard playWhenReady else {
      // Nothing to pause. A permanent loss while paused cancels a pending resume.
      if let current = interruption, current.resumable, !resumable {
        interruption = Interruption(reason: reason, resumable: false, since: current.since)
      }
      commit()
      return
    }
    playWhenReady = false
    interruption = Interruption(reason: reason, resumable: resumable, since: clock.wallMs)
    pauseIntent(cause: "system: \(reason.rawValue)")
    commit()
  }

  /// The OS ended an interruption. `shouldResume` folds in the platform hints
  /// (iOS `.shouldResume` and no other app now primary; Android focus regained).
  func interruptionEnded(shouldResume: Bool) {
    guard !released, let current = interruption else { return }
    if current.resumable && shouldResume && options.autoResumeAfterInterruption && source != nil {
      interruption = nil
      log("system resume", ["reason": current.reason.rawValue])
      startPlayback(cause: "system resume")
    } else {
      // Over, but the app (not the OS) decides what happens next.
      interruption = Interruption(reason: current.reason, resumable: false, since: current.since)
    }
    commit()
  }

  func networkChanged(_ next: NetworkState, interfaceChanged: Bool) {
    guard !released else { return }
    let previous = network
    network = next
    let t = now
    if previous == .online && next == .offline {
      markNetworkEdge(t)
      log("network lost", [:])
    } else if previous == .offline && next == .online {
      // (`unknown` → `online` is the first reading: a baseline, not an edge.)
      markNetworkEdge(t)
      backoff.reset()
      offlineSkips = 0
      log("network restored", [:])
      if playWhenReady && state != .playing {
        attemptReconnect(reason: "network restored")
      }
    } else if previous == .online && next == .online && interfaceChanged {
      // Wi-Fi ↔ cellular: the stream's socket died with the old route. The
      // buffer keeps playing until it drains, so only make detection eager.
      markNetworkEdge(t)
      log("network handoff", [:])
      if playWhenReady && (state == .buffering || state == .reconnecting) {
        attemptReconnect(reason: "network handoff")
      }
    }
    commit()
  }

  /// The app came to the foreground. A suspended app (iOS) may have slept
  /// through its backoff deadline; audio that is wanted but not flowing is
  /// recovered now. An open that is still young is left alone.
  func appForegrounded() {
    guard !released, playWhenReady else { return }
    if state == .reconnecting || state == .buffering || state == .loading {
      attemptReconnect(reason: "app foregrounded")
    }
    commit()
  }

  /// The platform media stack was reset (iOS media services); the driver has
  /// already been rebuilt. Re-open what was loaded, keeping the intent.
  func platformReset() {
    guard !released, source != nil, state != .idle else { return }
    log("platform reset", [:])
    if state == .stopped || state == .ended || state == .error {
      connectionReleased = true
      commit()
      return
    }
    reopen(reason: "media services reset")
    commit()
  }

  // MARK: - Clock

  func onWakeup() {
    guard !released else { return }
    let t = now
    if let due = pauseReleaseAt, due <= t {
      pauseReleaseAt = nil
      if state == .paused && !playWhenReady && !connectionReleased {
        driver.releaseConnection()
        connectionReleased = true
        log("paused stream released", [:])
      }
    }
    if let due = stallPublishAt, due <= t {
      stallPublishAt = nil
      if state == .playing, let started = stallStartedAt {
        setState(.buffering, cause: "native stall")
        beginWaiting()
        stallStartedAt = started
        lastBufferedAdvanceAt = started
      }
    }
    if state == .reconnecting, let due = nextAttemptAt, due <= t {
      nextAttemptAt = nil
      attemptReconnect(reason: "backoff elapsed")
    }
    if playWhenReady && t - lastHeartbeatAt >= RecoveryPolicy.heartbeatMs - 50 {
      lastHeartbeatAt = t
      heartbeat(t)
    }
    commit()
  }

  // MARK: - Internals

  private static func continuesIntent(_ state: PlaybackState) -> Bool {
    switch state {
    case .loading, .buffering, .playing, .reconnecting, .paused: return true
    default: return false
    }
  }

  private func ensureAlive() throws {
    if released {
      throw PlayerError.code(.playerReleased, "The player was released.", recoverable: false)
    }
  }

  private func applyFocus(_ focus: FocusResult) {
    switch focus {
    case .granted: break
    case .delayed:
      playWhenReady = false
      interruption = Interruption(reason: .audioFocusDelayed, resumable: true, since: clock.wallMs)
    case .denied:
      playWhenReady = false
      interruption = Interruption(reason: .audioFocusDenied, resumable: false, since: clock.wallMs)
    }
  }

  /// Turns the intent on from any state (focus already granted).
  private func startPlayback(cause: String) {
    playWhenReady = true
    pauseReleaseAt = nil
    if state == .error { lastError = nil }
    switch state {
    case .idle:
      playWhenReady = false
    case .loading:
      driver.play()
    case .paused:
      let pausedFor = pausedAt.map { now - $0 } ?? 0
      pausedAt = nil
      if connectionReleased || !readyForGeneration {
        reopen(reason: "\(cause): connection released", startPosition: isLive ? nil : resumePosition)
      } else if isLive && driftMs + pausedFor >= options.liveMaxDriftMs {
        reopen(reason: "\(cause): live edge after \(pausedFor)ms paused")
      } else {
        driftMs += pausedFor
        // State first: drivers may report "playing" re-entrantly from play().
        setState(.buffering, cause: cause)
        beginWaiting()
        driver.play()
      }
    case .stopped, .error:
      reopen(reason: cause, startPosition: isLive ? nil : resumePosition)
    case .ended:
      resumePosition = 0
      setState(.buffering, cause: "\(cause): restart")
      beginWaiting()
      driver.seek(to: 0)
      driver.play()
    case .buffering, .playing, .reconnecting:
      break
    }
  }

  /// Turns the intent off (user or system). `playWhenReady` already false.
  private func pauseIntent(cause: String) {
    resetRecovery()
    stallStartedAt = nil
    playingSince = nil
    defer { driver.pause() }
    switch state {
    case .playing, .buffering:
      rememberPosition()
      pausedAt = now
      setState(.paused, cause: cause)
      armPauseRelease()
    case .reconnecting:
      // Nothing is connected: resuming re-opens.
      connectionReleased = true
      pausedAt = now
      setState(.paused, cause: cause)
    case .loading:
      // Opening continues without intent; `onReady` lands it in `paused`.
      log("paused while loading", [:])
    default:
      break
    }
  }

  private func open(startPosition: Double?, reason: String) {
    guard let source else { return }
    generation += 1
    readyForGeneration = false
    flowedSinceOpen = false
    connectionReleased = false
    stallStartedAt = nil
    pausedAt = nil
    playingSince = nil
    driftMs = 0
    pauseReleaseAt = nil
    lastOpenAt = now
    lastPosition = startPosition ?? 0
    lastBuffered = 0
    lastBufferedAdvanceAt = now
    lastPositionAdvanceAt = now
    lastHeartbeatAt = now
    setState(.loading, cause: reason)
    driver.open(
      OpenRequest(
        generation: generation, source: source, startPosition: startPosition,
        playWhenReady: playWhenReady))
  }

  /// Re-open the loaded source: at the live edge for live streams, at the last
  /// position otherwise.
  private func reopen(reason: String, startPosition: Double? = nil) {
    let position = isLive ? nil : (startPosition ?? resumePosition ?? currentPositionEstimate())
    log("reopen", ["reason": reason])
    open(startPosition: position, reason: reason)
  }

  private func currentPositionEstimate() -> Double? {
    guard !isLive else { return nil }
    return lastPosition > 0 ? lastPosition : nil
  }

  private func rememberPosition() {
    guard !isLive else { return }
    let p = driver.sample().position
    if p.isFinite && p >= 0 {
      lastPosition = p
      resumePosition = p
    }
  }

  private func beginWaiting() {
    stallStartedAt = now
    playingSince = nil
    lastBufferedAdvanceAt = now
    lastBuffered = driver.sample().bufferedPosition
  }

  private func handleFailure(_ error: PlayerError) {
    lastError = error
    let wasInitialLoad = !readyForGeneration && pendingLoadId != nil
    settlePendingLoad(.failed(error))
    log(
      "failure",
      ["code": error.code.rawValue, "recoverable": "\(error.recoverable)", "message": error.message])
    if !error.recoverable {
      fail(error)
      return
    }
    if playWhenReady && options.reconnect {
      pendingEvents.append { [weak self] in self?.delegate?.engine(error: error, fatal: false) }
      if !isLive { rememberPosition() }
      scheduleReconnect(reason: error.code.rawValue)
    } else if playWhenReady || wasInitialLoad {
      fail(error)
    } else {
      // The prepared stream died while paused: nothing to tell the user; the
      // next play() re-opens it.
      connectionReleased = true
      pauseReleaseAt = nil
      if state == .loading || state == .buffering { setState(.paused, cause: "died while paused") }
    }
  }

  private func fail(_ error: PlayerError) {
    lastError = error
    playWhenReady = false
    resetRecovery()
    pauseReleaseAt = nil
    stallStartedAt = nil
    driver.releaseConnection()
    connectionReleased = true
    setState(.error, cause: error.code.rawValue)
    pendingEvents.append { [weak self] in self?.delegate?.engine(error: error, fatal: true) }
  }

  private func scheduleReconnect(reason: String) {
    let t = now
    if recoveringSince == nil { recoveringSince = t }
    if state == .reconnecting && nextAttemptAt != nil { return }
    // A healthy stream that suddenly drops (server kick, handoff) reconnects
    // immediately; repeated failures back off.
    let delay: Int64
    if stable {
      stable = false
      delay = 0
    } else {
      delay = backoff.next()
    }
    nextAttemptAt = t + delay
    reconnectReason = reason
    stallStartedAt = nil
    playingSince = nil
    setState(.reconnecting, cause: "\(reason) — attempt \(backoff.attempts) in \(delay)ms")
  }

  private var openInFlight: Bool {
    guard state == .loading, let opened = lastOpenAt, !flowedSinceOpen else { return false }
    return opened > lastNetworkEdgeAt && now - opened < RecoveryPolicy.openGraceMs
  }

  private func attemptReconnect(reason: String) {
    guard playWhenReady, source != nil else { return }
    if openInFlight {
      log("reconnect skipped", ["reason": reason, "note": "open in flight"])
      return
    }
    if recoveringSince == nil { recoveringSince = now }
    if network == .offline && offlineSkips < RecoveryPolicy.offlineProbeEvery {
      offlineSkips += 1
      let delay = backoff.next()
      nextAttemptAt = now + delay
      reconnectReason = "offline"
      setState(.reconnecting, cause: "\(reason): offline, probe in \(delay)ms")
      return
    }
    offlineSkips = 0
    if backoff.attempts == 0 { _ = backoff.next() }
    nextAttemptAt = nil
    reconnectReason = reason
    reopen(reason: "reconnect: \(reason)")
  }

  private func heartbeat(_ t: Int64) {
    if let since = recoveringSince, let limit = options.giveUpAfterMs, t - since >= limit,
      state != .playing
    {
      let error =
        lastError
        ?? .code(.networkError, "Recovery gave up after \(limit / 1000)s.", recoverable: true)
      log("giving up", ["afterMs": "\(t - since)"])
      fail(error)
      return
    }
    let suspect = t < suspectUntil
    switch state {
    case .loading:
      if let opened = lastOpenAt, t - opened >= RecoveryPolicy.openTimeoutMs {
        handleFailure(.code(.timeout, "Opening the source timed out.", recoverable: true))
      }
    case .playing:
      let sample = driver.sample()
      if !isLive { resumePosition = sample.position }
      if sample.position > lastPosition + 0.05 || sample.position < lastPosition - 0.5 {
        lastPosition = sample.position
        lastPositionAdvanceAt = t
      } else {
        let limit = suspect ? RecoveryPolicy.suspectSilentStallMs : RecoveryPolicy.silentStallMs
        if t - lastPositionAdvanceAt >= limit && rate > 0 {
          log("silent stall", ["frozenMs": "\(t - lastPositionAdvanceAt)"])
          setState(.buffering, cause: "silent stall")
          beginWaiting()
          stallStartedAt = lastPositionAdvanceAt
        }
      }
      if let since = playingSince, t - since >= RecoveryPolicy.stablePlaybackMs {
        playingSince = nil
        stable = true
        backoff.reset()
        offlineSkips = 0
        recoveringSince = nil
      }
    case .buffering:
      let sample = driver.sample()
      if sample.bufferedPosition > lastBuffered + 0.01 {
        lastBuffered = sample.bufferedPosition
        lastBufferedAdvanceAt = t
      }
      guard let stalled = stallStartedAt else { return }
      if network == .offline {
        // Nothing to re-open over. Play out the buffer, then wait for the link.
        if t - lastBufferedAdvanceAt >= RecoveryPolicy.stallDeadMs {
          if recoveringSince == nil { recoveringSince = stalled }
          scheduleReconnect(reason: "offline")
        }
        return
      }
      let deadLimit = suspect ? RecoveryPolicy.suspectStallDeadMs : RecoveryPolicy.stallDeadMs
      if t - lastBufferedAdvanceAt >= deadLimit {
        attemptReconnect(reason: "stalled \(t - stalled)ms with no data")
      } else if t - stalled >= RecoveryPolicy.stallMaxMs {
        attemptReconnect(reason: "stalled \(t - stalled)ms")
      } else if isLive && driftMs + (t - stalled) >= options.liveMaxDriftMs {
        attemptReconnect(reason: "live drift during stall")
      }
    default:
      break
    }
  }

  private func armPauseRelease() {
    guard let source, source.isNetwork, isLive || duration == nil, !connectionReleased else {
      return
    }
    pauseReleaseAt = now + RecoveryPolicy.pausedStreamReleaseMs
  }

  private func resetRecovery() {
    stable = false
    backoff.reset()
    nextAttemptAt = nil
    recoveringSince = nil
    offlineSkips = 0
    reconnectReason = ""
  }

  private func markNetworkEdge(_ t: Int64) {
    lastNetworkEdgeAt = t
    suspectUntil = t + RecoveryPolicy.networkSuspectMs
  }

  private func applyVolume() {
    driver.setVolume(muted ? 0 : volume * duckFactor)
  }

  private func settlePendingLoad(_ outcome: LoadOutcome) {
    guard let id = pendingLoadId else { return }
    pendingLoadId = nil
    delegate?.engine(loadSettled: id, outcome: outcome)
  }

  private func setState(_ next: PlaybackState, cause: String) {
    guard next != state else { return }
    if next != .playing { stallPublishAt = nil }
    let previous = state
    state = next
    log("transition", ["from": previous.rawValue, "to": next.rawValue, "cause": cause])
  }

  private func log(_ event: String, _ details: [String: String]) {
    delegate?.engine(
      diagnostic: DiagnosticEntry(
        wallTime: clock.wallMs, generation: generation, state: state, event: event,
        details: details))
  }

  private func logStale(_ event: String, _ gen: Int) {
    log("stale event dropped", ["event": event, "eventGeneration": "\(gen)"])
  }

  /// Publishes the status (if changed) and the next wake-up instant.
  private func commit() {
    let current = status
    if current != lastPublished {
      lastPublished = current
      delegate?.engine(statusChanged: current)
    }
    let events = pendingEvents
    pendingEvents.removeAll()
    events.forEach { $0() }
    delegate?.engine(wakeupAt: nextWakeup())
  }

  private func nextWakeup() -> Int64? {
    guard !released else { return nil }
    var candidates: [Int64] = []
    if let r = pauseReleaseAt { candidates.append(r) }
    if let p = stallPublishAt { candidates.append(p) }
    if state == .reconnecting, let a = nextAttemptAt { candidates.append(a) }
    if playWhenReady { candidates.append(lastHeartbeatAt + RecoveryPolicy.heartbeatMs) }
    return candidates.min()
  }
}
