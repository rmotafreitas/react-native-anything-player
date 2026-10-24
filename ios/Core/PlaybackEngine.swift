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
  /// Effective output volume (volume × mute × duck × fades), 0...1.
  func setVolume(_ effective: Double)
  func setRate(_ rate: Double)
  /// Send what follows to another output (`"local"`, `"cast:<device>"`). Only
  /// the platform's routing driver implements a real switch; the engine calls
  /// it from `handoff`, after unloading the item from the previous output.
  func switchOutput(_ outputId: String)
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
  /// The sleep timer paused the player (`sleep` event).
  func engineSleepFired()
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

  // ── Output ──
  private var route: AudioRoute = .unknown
  private var outputId = "local"
  /// The audio plays on another device (Cast): the local audio rules are off.
  private var remote = false

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
  /// Bumped by every network edge; `openNetworkRevision` is its value at the last open.
  private var networkRevision = 0
  /// The engine detected a stall native never reported (it still says playing).
  private var silentStall = false
  private var openNetworkRevision = -1
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

  // ── Fades & sleep timer (monotonic ms) ──
  // The output volume is volume × duck × gain × sleep attenuation (or 0 when
  // muted): fades never touch the app's `volume` except `fadeTo`, whose
  // target is the new volume.
  /// What a fade-out leads to when it reaches silence.
  private enum FadeOutEnd: String { case pause, stop }
  /// `volume` still on its way to a `fadeTo` target.
  private var levelRamp: Ramp?
  private var fadeToDone: (() -> Void)?
  /// The play/pause/stop fade, 0…1 (`gainRamp` while it moves).
  private var gain: Double = 1
  private var gainRamp: Ramp?
  /// A fade-out under way: the intent is already off; at silence it pauses or stops.
  private var fadeOutThen: FadeOutEnd?
  /// Playback was asked for with a fade-in: it starts when the audio does.
  private var fadeInPending = false
  private var fadeTickAt: Int64?
  /// What the driver was last given.
  private var appliedVolume: Double = 1
  private var sleepAt: Int64?
  /// The sleep timer's fade-out: the last `sleepFadeMs` before `sleepAt`.
  private var sleepFadeMs: Int64 = 0
  private var sleepWallAt: Int64?

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
    s.route = route
    s.sleepAt = sleepWallAt
    return s
  }

  /// Whether a background keepalive should run: playback is wanted but no
  /// audio is being rendered (iOS suspends a silent background app, freezing
  /// recovery with it).
  var wantsKeepalive: Bool {
    playWhenReady && (state == .loading || state == .buffering || state == .reconnecting)
  }

  /// Whether the player holds (or may soon re-take) audio focus. A remote
  /// output always has it.
  var needsAudioFocus: Bool {
    if remote { return false }
    return playWhenReady || fadeOutThen != nil || (interruption?.resumable ?? false)
  }

  /// Native observations for any other generation are stale and must be dropped.
  func accepts(_ generation: Int) -> Bool {
    !released && generation == self.generation
  }

  // MARK: - Commands

  func load(_ newSource: SourceDescriptor, autoplay: Bool?, startPosition: Double?) throws {
    try ensureAlive()
    // A fade-out ends with the item it was fading.
    cancelFadeOut()
    let flowing = playWhenReady && state == .playing
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
    if wanted { applyFocus(requestFocus()) }
    if playWhenReady { startFadeIn(flowing: flowing) }
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
    let focus = requestFocus()
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
    if fadeOutThen != nil {
      // A pause during a fade-out: silence now.
      completeFadeOut()
      commit()
      return
    }
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
    if !beginFadeOut(end: .pause) { pauseIntent(cause: "pause") }
    commit()
  }

  func stop() throws {
    try ensureAlive()
    guard source != nil else { return }
    if fadeOutThen != nil {
      // A stop during a fade-out: stop now.
      completeFadeOut(override: .stop)
    } else if playWhenReady && beginFadeOut(end: .stop) {
      playWhenReady = false
      interruption = nil
    } else {
      stopNow()
    }
    commit()
  }

  private func stopNow() {
    settlePendingLoad(.superseded)
    holdGain()
    playWhenReady = false
    interruption = nil
    resetRecovery()
    pauseReleaseAt = nil
    stallStartedAt = nil
    pausedAt = nil
    releaseItemConnection()
    resumePosition = isLive ? nil : 0
    setState(.stopped, cause: "stop")
  }

  func reset() throws {
    try ensureAlive()
    cancelFadeOut()
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
    cancelFadeTo()
    volume = min(max(value, 0), 1)
    applyVolume()
    commit()
  }

  /// Moves the volume to `value` over `durationMs`; `done` runs when it gets
  /// there, or when `setVolume`, another `fadeTo` or `release` replaces it.
  /// `volume` is the target from the start. Instant on a remote output.
  func fadeTo(_ value: Double, durationMs: Double, done: @escaping () -> Void) throws {
    try ensureAlive()
    guard value.isFinite else {
      throw PlayerError.code(.invalidArgument, "Volume must be a finite number.", recoverable: false)
    }
    guard Self.validDuration(durationMs) else { throw Self.invalidDuration("A fade duration") }
    let t = now
    let from = levelAt(t)
    cancelFadeTo()
    volume = min(max(value, 0), 1)
    fadeToDone = done
    let ms = Int64(durationMs.rounded())
    if ms > 0 && !remote && from != volume {
      levelRamp = Ramp(from: from, to: volume, startAt: t, endAt: t + ms)
      log("fade", ["to": "\(volume)", "ms": "\(ms)"])
    } else {
      applyVolume()
      settleFadeTo()
    }
    commit()
  }

  /// Pauses after `afterMs` of wall time (counting while paused too), fading
  /// out over its last `fadeOutMs` (default `options.fadeOutMs`). `nil`
  /// cancels; a new timer replaces the previous one.
  func sleep(afterMs: Double?, fadeOutMs: Double?) throws {
    try ensureAlive()
    if let afterMs {
      guard Self.validDuration(afterMs) else { throw Self.invalidDuration("The sleep delay") }
      if let fadeOutMs, !Self.validDuration(fadeOutMs) {
        throw Self.invalidDuration("The sleep fade-out")
      }
    }
    endSleep()
    if let afterMs {
      let after = Int64(afterMs.rounded())
      sleepAt = now + after
      sleepWallAt = clock.wallMs + after
      sleepFadeMs = min(fadeOutMs.map { Int64($0.rounded()) } ?? options.fadeOutMs, after)
      log("sleep timer", ["afterMs": "\(after)", "fadeOutMs": "\(sleepFadeMs)"])
    } else {
      log("sleep timer", ["note": "cancelled"])
    }
    commit()
  }

  /// The fades of play (in) and of pause and stop (out), in ms; `0` = none.
  /// A fade under way keeps its course.
  func setFades(inMs: Double, outMs: Double) throws {
    try ensureAlive()
    guard Self.validDuration(inMs) else { throw Self.invalidDuration("A fade-in") }
    guard Self.validDuration(outMs) else { throw Self.invalidDuration("A fade-out") }
    options.fadeInMs = Int64(inMs.rounded())
    options.fadeOutMs = Int64(outMs.rounded())
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
    // The receiver mixes its own audio: ducking is the phone's business.
    if !remote { applyVolume() }
  }

  func release() {
    guard !released else { return }
    settlePendingLoad(.failed(.code(.playerReleased, "The player was released.", recoverable: false)))
    cancelFadeOut()
    cancelFadeTo()
    sleepAt = nil
    sleepWallAt = nil
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
      // Fading out: the audio keeps going until the fade ends.
      if fadeOutThen != nil { return commit() }
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
    silentStall = false
    lastOpenAt = nil
    nextAttemptAt = nil
    let sample = driver.sample()
    lastPosition = sample.position
    lastPositionAdvanceAt = t
    playingSince = t
    if fadeInPending {
      fadeInPending = false
      rampGain(to: 1, fullScaleMs: options.fadeInMs)
    }
    // Drift is only enforced at moments that are silent anyway (resuming from
    // a pause, or during a published stall): cutting audio that has just
    // resumed to jump to the live edge would add a gap for no audible gain.
    setState(.playing, cause: "audio flowing")
    commit()
  }

  /// Playback wanted, waiting for data.
  func onBuffering(generation gen: Int) {
    guard accepts(gen) else { return logStale("buffering", gen) }
    // Nothing left to fade.
    completeFadeOut()
    // Native reports the stall itself: its own `playing` will end it.
    silentStall = false
    if state == .playing && stallPublishAt == nil {
      stallStartedAt = now
      stallPublishAt = now + RecoveryPolicy.stallDebounceMs
      playingSince = nil
    }
    commit()
  }

  func onFailed(generation gen: Int, error: PlayerError) {
    guard accepts(gen) else { return logStale("failed", gen) }
    completeFadeOut()
    // A stop's fade-out landed: the item is gone.
    guard accepts(gen) else { commit(); return }
    handleFailure(error)
    commit()
  }

  func onEnded(generation gen: Int) {
    guard accepts(gen) else { return logStale("ended", gen) }
    if state == .ended { return logStale("ended again", gen) }
    completeFadeOut()
    // A stop's fade-out landed: the item is gone.
    guard accepts(gen) else { commit(); return }
    // Unknown duration reads as a live stream that dropped, unless the app
    // said the source is a file (`live: false`).
    if source?.liveHint != false && (isLive || duration == nil) {
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
    if fadeOutThen != nil {
      completeFadeOut()
      return commit()
    }
    guard playWhenReady else { return }
    systemPause(reason: reason, resumable: false)
  }

  // MARK: - Outputs

  /// The local output changed (headphones, AirPlay, Bluetooth). Ignored while casting.
  func routeChanged(_ route: AudioRoute) {
    guard !released else { return }
    if remote {
      log("route ignored", ["kind": route.kind.rawValue, "note": "remote output"])
      return
    }
    self.route = route
    commit()
  }

  /// The audio moves to another output: a Cast receiver, or back to the device.
  /// The item is unloaded from the previous output and, if it was active,
  /// re-opened on the new one at the same position. `resume` keeps the play
  /// intent; without it the item arrives paused. An inactive item (stopped,
  /// ended, failed) re-opens on the new output at the next `play()`.
  func handoff(route: AudioRoute, outputId: String, resume: Bool) {
    guard !released else { return }
    if outputId == self.outputId {
      self.route = route
      commit()
      return
    }
    // A fade-out lands first: the pause belongs to the old output.
    completeFadeOut()
    let position = handoffPosition()
    // A paused stream whose connection was released stays released.
    let active =
      source != nil && Self.continuesIntent(state)
      && !(state == .paused && connectionReleased)
    if source != nil { driver.unload() }
    driver.switchOutput(outputId)
    self.outputId = outputId
    self.route = route
    remote = route.kind == .cast
    log("handoff", ["to": outputId, "resume": "\(resume)"])
    settleFades()
    applyVolume()
    if active {
      playWhenReady = resume && playWhenReady
      resetRecovery()
      resumePosition = position
      if playWhenReady { applyFocus(requestFocus()) }
      open(startPosition: position, reason: "handoff")
    } else {
      // Old-output callbacks are stale; nothing is loaded on the new one.
      generation += 1
      readyForGeneration = false
      if source != nil { connectionReleased = true }
    }
    commit()
  }

  // MARK: - System events

  func interruptionBegan(reason: InterruptionReason, resumable: Bool) {
    guard !released else { return }
    if remote {
      // A call on the phone does not pause the living-room speaker.
      log("interruption ignored", ["reason": reason.rawValue, "note": "remote output"])
      return
    }
    systemPause(reason: reason, resumable: resumable)
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
    if remote {
      // The receiver has its own network: the phone's must not reload it.
      commit()
      return
    }
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
      if autoReconnect && state != .playing {
        attemptReconnect(reason: "network restored")
      }
    } else if previous == .online && next == .online && interfaceChanged {
      // Wi-Fi ↔ cellular: the stream's socket died with the old route. The
      // buffer keeps playing until it drains, so only make detection eager.
      markNetworkEdge(t)
      log("network handoff", [:])
      if autoReconnect && (state == .buffering || state == .reconnecting) {
        attemptReconnect(reason: "network handoff")
      }
    }
    commit()
  }

  /// The app came to the foreground. A suspended app (iOS) may have slept
  /// through its backoff deadline; audio that is wanted but not flowing is
  /// recovered now. An open that is still young is left alone.
  func appForegrounded() {
    guard !released, autoReconnect, !remote else { return }
    if state == .reconnecting || state == .buffering || state == .loading {
      attemptReconnect(reason: "app foregrounded")
    }
    commit()
  }

  /// The platform media stack was reset (iOS media services); the driver has
  /// already been rebuilt. Re-open what was loaded, keeping the intent.
  func platformReset() {
    guard !released, !remote, source != nil, state != .idle else { return }
    log("platform reset", [:])
    completeFadeOut()
    if state == .stopped || state == .ended || state == .error || connectionReleased {
      // Nothing was open (a paused stream may have released its connection):
      // `play()` opens it, as before the reset.
      connectionReleased = true
      commit()
      return
    }
    if !options.reconnect {
      // Re-opening on its own is what `reconnect: false` turns off.
      handleFailure(.code(.networkError, "The media services were reset.", recoverable: true))
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
        releaseItemConnection()
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
    fireSleepIfDue(t)
    stepFades(t)
    if heartbeatDue && t - lastHeartbeatAt >= RecoveryPolicy.heartbeatMs - 50 {
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

  /// Audio focus is the device's: a remote output always has it.
  private func requestFocus() -> FocusResult {
    if remote { return .granted }
    return delegate?.engineRequestsAudioFocus() ?? .granted
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

  /// A system pause (interruptions and the driver share it). `playWhenReady`
  /// may already be false when the OS refuses to start playback.
  private func systemPause(reason: InterruptionReason, resumable: Bool) {
    // A user's fade-out stops at once; the pause stays the user's.
    completeFadeOut()
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

  /// Turns the intent on from any state (focus already granted).
  private func startPlayback(cause: String) {
    if fadeOutThen != nil {
      // Playing again during a fade-out: the audio never stopped.
      fadeOutThen = nil
      playingSince = now
      log("fade-out cancelled", ["cause": cause])
    }
    startFadeIn(flowing: state == .playing)
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
      restartFromEnd(cause: cause)
    case .buffering, .playing, .reconnecting:
      break
    }
  }

  /// An ended item that is still open restarts in place; one that left its
  /// output (a handoff) is opened again.
  private func restartFromEnd(cause: String) {
    resumePosition = 0
    if connectionReleased {
      reopen(reason: "\(cause): restart", startPosition: 0)
      return
    }
    setState(.buffering, cause: "\(cause): restart")
    beginWaiting()
    driver.seek(to: 0)
    driver.play()
  }

  /// Turns the intent off (user or system). `playWhenReady` already false.
  private func pauseIntent(cause: String) {
    holdGain()
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
    silentStall = false
    connectionReleased = false
    stallStartedAt = nil
    pausedAt = nil
    playingSince = nil
    driftMs = 0
    pauseReleaseAt = nil
    lastOpenAt = now
    openNetworkRevision = networkRevision
    lastPosition = startPosition ?? 0
    lastBuffered = 0
    lastBufferedAdvanceAt = now
    lastPositionAdvanceAt = now
    lastHeartbeatAt = now
    setState(.loading, cause: reason)
    driver.open(
      OpenRequest(
        generation: generation, source: source, startPosition: startPosition,
        playWhenReady: playWhenReady, allowReconnect: options.reconnect))
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

  /// Where the item is, read before it leaves its output.
  private func handoffPosition() -> Double? {
    guard !isLive else { return nil }
    let sampled = state == .playing || state == .buffering || state == .paused
    if sampled && readyForGeneration && !connectionReleased { rememberPosition() }
    return resumePosition ?? currentPositionEstimate()
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
    releaseItemConnection()
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
    // Issued after the latest network edge (a revision, not a time: an open
    // and the edge that caused it can share a millisecond).
    return openNetworkRevision == networkRevision && now - opened < RecoveryPolicy.openGraceMs
  }

  private func attemptReconnect(reason: String) {
    guard playWhenReady, source != nil else { return }
    if openInFlight {
      log("reconnect skipped", ["reason": reason, "note": "open in flight"])
      return
    }
    if recoveringSince == nil { recoveringSince = now }
    if !remote && network == .offline && offlineSkips < RecoveryPolicy.offlineProbeEvery {
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

  /// Recovery may re-open on its own: playback is wanted and reconnecting is on.
  private var autoReconnect: Bool { playWhenReady && options.reconnect }

  /// Playback is wanted, or an open is outstanding (it times out either way).
  private var heartbeatDue: Bool { playWhenReady || state == .loading }

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
      } else if remote {
        // A receiver's position is interpolated between its reports: only the
        // state it reports (buffering, failed) counts.
      } else {
        let limit = suspect ? RecoveryPolicy.suspectSilentStallMs : RecoveryPolicy.silentStallMs
        // A native stall awaiting publication is not silent.
        if stallPublishAt == nil && t - lastPositionAdvanceAt >= limit && rate > 0 {
          log("silent stall", ["frozenMs": "\(t - lastPositionAdvanceAt)"])
          setState(.buffering, cause: "silent stall")
          beginWaiting()
          stallStartedAt = lastPositionAdvanceAt
          silentStall = true
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
      if remote {
        // No buffer to watch on a receiver: only a stall that lasts too long.
        if let stalled = stallStartedAt, t - stalled >= RecoveryPolicy.stallMaxMs {
          recoverStall(reason: "stalled \(t - stalled)ms")
        }
        break
      }
      let sample = driver.sample()
      // A re-open resumes where the playhead got to during the stall; a reading
      // behind the last trusted position (a start seek still pending) is not one.
      let p = sample.position
      if !isLive && p.isFinite && p >= max(lastPosition, resumePosition ?? 0) {
        resumePosition = p
      }
      if silentStall && p > lastPosition + 0.05 {
        // The stall was ours (native never left playing): the playhead moving
        // again is the only sign it is over.
        endSilentStall(t, p)
        return
      }
      if sample.bufferedPosition > lastBuffered + 0.01 {
        lastBuffered = sample.bufferedPosition
        lastBufferedAdvanceAt = t
      }
      guard let stalled = stallStartedAt else { return }
      if network == .offline {
        // Nothing to re-open over. Play out the buffer, then wait for the link.
        if t - lastBufferedAdvanceAt >= RecoveryPolicy.stallDeadMs {
          if !options.reconnect { failStall("offline"); return }
          if recoveringSince == nil { recoveringSince = stalled }
          scheduleReconnect(reason: "offline")
        }
        return
      }
      let deadLimit = suspect ? RecoveryPolicy.suspectStallDeadMs : RecoveryPolicy.stallDeadMs
      if t - lastBufferedAdvanceAt >= deadLimit {
        recoverStall(reason: "stalled \(t - stalled)ms with no data")
      } else if t - stalled >= RecoveryPolicy.stallMaxMs {
        recoverStall(reason: "stalled \(t - stalled)ms")
      } else if isLive && driftMs + (t - stalled) >= options.liveMaxDriftMs {
        recoverStall(reason: "live drift during stall")
      }
    default:
      break
    }
  }

  /// A stall the watchdog gave up waiting on: re-open, or fail with reconnecting off.
  private func recoverStall(reason: String) {
    if options.reconnect { attemptReconnect(reason: reason) } else { failStall(reason) }
  }

  private func failStall(_ reason: String) {
    log("stall, reconnect off", ["reason": reason])
    fail(
      .code(
        .networkError,
        "Playback stalled (\(reason)) and reconnecting is off.",
        recoverable: true))
  }

  /// Native kept saying playing through a silent stall: the audio flows again.
  private func endSilentStall(_ t: Int64, _ position: Double) {
    silentStall = false
    if let stalled = stallStartedAt { driftMs += t - stalled }
    stallStartedAt = nil
    lastPosition = position
    lastPositionAdvanceAt = t
    playingSince = t
    setState(.playing, cause: "silent stall over")
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

  /// Releases the item's connection and invalidates its generation: callbacks
  /// the driver already queued for it (an end, a failure) must not move the
  /// player out of `stopped`, `paused` or `error`. Resuming opens a new one.
  private func releaseItemConnection() {
    generation += 1
    readyForGeneration = false
    silentStall = false
    driver.releaseConnection()
    connectionReleased = true
  }

  private func markNetworkEdge(_ t: Int64) {
    networkRevision += 1
    suspectUntil = t + RecoveryPolicy.networkSuspectMs
  }

  private func applyVolume() {
    let value = outputVolume(now)
    appliedVolume = value
    driver.setVolume(value)
  }

  /// Sends the output volume only when it changed (fade steps).
  private func refreshVolume() {
    if outputVolume(now) != appliedVolume { applyVolume() }
  }

  private func outputVolume(_ t: Int64) -> Double {
    if muted { return 0 }
    let duck = remote ? 1 : duckFactor
    return levelAt(t) * duck * gainAt(t) * sleepGainAt(t)
  }

  // MARK: - Fades & sleep timer

  /// The longest sleep timer or fade: 24 h (larger values overflow native timers).
  private static let maxTimerMs: Double = 86_400_000

  private static func invalidDuration(_ what: String) -> PlayerError {
    .code(.invalidArgument, "\(what) must be a finite number from 0 to 24 h.", recoverable: false)
  }

  private static func validDuration(_ ms: Double) -> Bool {
    ms.isFinite && ms >= 0 && ms <= maxTimerMs
  }

  private func levelAt(_ t: Int64) -> Double { levelRamp?.value(at: t) ?? volume }

  private func gainAt(_ t: Int64) -> Double { gainRamp?.value(at: t) ?? gain }

  /// In the sleep timer's last `sleepFadeMs`: the fade-out (local output only).
  private func sleepFading(_ t: Int64) -> Bool {
    guard let at = sleepAt else { return false }
    return sleepFadeMs > 0 && !remote && t >= at - sleepFadeMs
  }

  private func sleepGainAt(_ t: Int64) -> Double {
    guard let at = sleepAt, sleepFading(t) else { return 1 }
    return min(1, max(0, Double(at - t) / Double(sleepFadeMs)))
  }

  private func setGain(_ value: Double) {
    gainRamp = nil
    gain = value
    refreshVolume()
  }

  /// Stops the gain where it is.
  private func freezeGain() {
    gain = gainAt(now)
    gainRamp = nil
  }

  /// The audio stops: a pending fade-in is dropped, the gain stays where it is.
  private func holdGain() {
    fadeInPending = false
    freezeGain()
  }

  /// Moves the gain to `to` at `fullScaleMs` per 0…1 (instant when `0`).
  private func rampGain(to: Double, fullScaleMs: Int64) {
    let t = now
    let from = gainAt(t)
    let ms = Int64((Double(fullScaleMs) * abs(to - from)).rounded())
    if ms <= 0 {
      setGain(to)
      return
    }
    gain = from
    gainRamp = Ramp(from: from, to: to, startAt: t, endAt: t + ms)
  }

  /// The intent turns on: from silence when a fade-in is set, else full.
  private func startFadeIn(flowing: Bool) {
    fadeInPending = false
    let ms = remote ? 0 : options.fadeInMs
    if ms > 0 && !flowing {
      // Silent until the audio flows, then `onPlaying` starts the ramp.
      fadeInPending = true
      setGain(0)
    } else {
      rampGain(to: 1, fullScaleMs: ms)
    }
  }

  /// Starts the fade-out of a pause or a stop; `false` when there is nothing to fade.
  private func beginFadeOut(end: FadeOutEnd) -> Bool {
    let ms = remote ? 0 : options.fadeOutMs
    guard ms > 0, state == .playing, stallPublishAt == nil else { return false }
    fadeInPending = false
    rampGain(to: 0, fullScaleMs: ms)
    guard let ramp = gainRamp else { return false }
    fadeOutThen = end
    resetRecovery()
    playingSince = nil
    log("fade-out", ["end": end.rawValue, "ms": "\(ramp.endAt - ramp.startAt)"])
    return true
  }

  /// Lands a fade-out now (`override` changes what it ends in): silence, then
  /// the pause or the stop.
  private func completeFadeOut(override: FadeOutEnd? = nil) {
    guard let pending = fadeOutThen else { return }
    let end = override ?? pending
    fadeOutThen = nil
    setGain(0)
    if end == .stop { stopNow() } else { pauseIntent(cause: "pause: faded out") }
  }

  private func cancelFadeOut() {
    fadeOutThen = nil
    fadeInPending = false
    freezeGain()
  }

  private func cancelFadeTo() {
    guard levelRamp != nil else { return }
    levelRamp = nil
    settleFadeTo()
  }

  private func settleFadeTo() {
    guard let done = fadeToDone else { return }
    fadeToDone = nil
    pendingEvents.append(done)
  }

  /// Fades belong to the output: a handoff lands them where they were going.
  private func settleFades() {
    fadeInPending = false
    gainRamp = nil
    gain = 1
    cancelFadeTo()
  }

  /// Clears the sleep timer. Its fade-out, if under way, becomes the gain: it
  /// climbs back at the speed it went down (or keeps falling into a pause).
  private func endSleep() {
    guard sleepAt != nil else { return }
    let t = now
    let attenuation = sleepGainAt(t)
    let fadeMs = sleepFadeMs
    sleepAt = nil
    sleepWallAt = nil
    sleepFadeMs = 0
    guard attenuation < 1 else { return }
    let combined = gainAt(t) * attenuation
    if fadeOutThen != nil, let ramp = gainRamp {
      gainRamp = Ramp(from: combined, to: 0, startAt: t, endAt: ramp.endAt)
      return
    }
    gain = combined
    gainRamp = nil
    if playWhenReady && !fadeInPending { rampGain(to: 1, fullScaleMs: fadeMs) }
  }

  private func fireSleepIfDue(_ t: Int64) {
    guard let due = sleepAt, due <= t else { return }
    let attenuation = sleepGainAt(t)
    sleepAt = nil
    sleepWallAt = nil
    sleepFadeMs = 0
    log("sleep timer", ["note": "fired"])
    // Like a user pause: a pending system resume is cancelled too.
    interruption = nil
    if fadeOutThen != nil {
      completeFadeOut()
    } else if playWhenReady {
      gain = gainAt(t) * attenuation
      gainRamp = nil
      refreshVolume()
      playWhenReady = false
      pauseIntent(cause: "sleep timer")
    }
    pendingEvents.append { [weak self] in self?.delegate?.engineSleepFired() }
  }

  private func stepFades(_ t: Int64) {
    if let tick = fadeTickAt, tick <= t { fadeTickAt = nil }
    if let level = levelRamp, t >= level.endAt {
      levelRamp = nil
      settleFadeTo()
    }
    if let ramp = gainRamp, t >= ramp.endAt {
      gain = ramp.to
      gainRamp = nil
    }
    refreshVolume()
    if fadeOutThen != nil && gainRamp == nil { completeFadeOut() }
  }

  private var fading: Bool {
    levelRamp != nil || gainRamp != nil || (playWhenReady && sleepFading(now))
  }

  private func fadeWakeups(_ candidates: inout [Int64]) {
    if fading {
      let tick = fadeTickAt ?? now + RecoveryPolicy.fadeTickMs
      fadeTickAt = tick
      candidates.append(tick)
    } else {
      fadeTickAt = nil
    }
    if let level = levelRamp { candidates.append(level.endAt) }
    if let ramp = gainRamp { candidates.append(ramp.endAt) }
    guard let at = sleepAt else { return }
    candidates.append(at)
    let fadeFrom = at - sleepFadeMs
    if sleepFadeMs > 0 && fadeFrom > now { candidates.append(fadeFrom) }
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
    if heartbeatDue { candidates.append(lastHeartbeatAt + RecoveryPolicy.heartbeatMs) }
    fadeWakeups(&candidates)
    return candidates.min()
  }
}
