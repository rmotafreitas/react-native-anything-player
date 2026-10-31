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
  /// `exact`: frame-accurate; otherwise the nearest keyframe is fine.
  func seek(to seconds: Double, exact: Bool)
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
  /// Video players: decode and show the picture, or not (the sound plays on).
  func setVideoEnabled(_ enabled: Bool)
  /// Video players with an adaptive source: what its own ABR must keep to.
  func setQuality(_ constraints: QualityConstraints)
  /// Repeat a finite item from the start, seamlessly where the platform can.
  func setLoop(_ loop: Bool)
  /// Drop the item an `open(swap: true)` was preparing.
  func cancelSwap(generation: Int)
  /// The output plays one item at a time: a quality switch re-opens in place, as on Cast.
  var swapsInPlace: Bool { get }
  /// Play these of the source's own tracks (`nil` text: none of them, which
  /// is also how an app's subtitle file is shown: by the overlay).
  func selectTracks(audio: String?, text: String?)
}

/// Audio drivers have no picture, qualities or switches; the engine restarts
/// an item that ends when looping.
extension EngineDriver {
  func seek(to seconds: Double, exact: Bool) { seek(to: seconds) }
  func setVideoEnabled(_ enabled: Bool) {}
  func setQuality(_ constraints: QualityConstraints) {}
  func setLoop(_ loop: Bool) {}
  func cancelSwap(generation: Int) {}
  var swapsInPlace: Bool { false }
  func selectTracks(audio: String?, text: String?) {}
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
  /// Something the app should hear that stops nothing and starts no recovery (a quality switch that failed).
  func engine(warning: PlayerError)
  func engineDidEnd()
  /// The sleep timer paused the player (`sleep` event).
  func engineSleepFired()
  func engine(diagnostic: DiagnosticEntry)
  /// The engine wants `onWakeup()` at this monotonic instant (`nil` = none).
  func engine(wakeupAt: Int64?)
  /// The source needs a new URL. Answer with `sourceRefreshed` or
  /// `sourceRefreshFailed` for the same `loadId`.
  func engine(refreshRequested loadId: Int, reason: RefreshReason)
}

extension EngineDelegate {
  /// Without an answer the engine backs off as for any failure.
  func engine(refreshRequested loadId: Int, reason: RefreshReason) {}
}

/// Playback wanted, nothing heard yet: the foreground recovers these at once.
private let waitingStates: Set<PlaybackState> = [.reconnecting, .buffering, .loading]
/// States in which the screen stays on for a visible video player.
private let awakeStates: Set<PlaybackState> = [.loading, .buffering, .playing, .reconnecting]
/// States a rebuffer goes on through (the user is still waiting).
private let rebufferStates: Set<PlaybackState> = [.buffering, .reconnecting, .loading]
/// Heights a view's size is rounded up to before it caps an adaptive source.
private let standardHeights = [144, 240, 360, 480, 540, 720, 1080, 1440, 2160, 4320]

private func minOf<T: Comparable>(_ a: T?, _ b: T?) -> T? {
  guard let a else { return b }
  guard let b else { return a }
  return min(a, b)
}

private func notVideoPlayer() -> PlayerError {
  .code(.invalidArgument, "This is not a video player (create it with `video`).", recoverable: false)
}

final class PlaybackEngine {
  private let driver: EngineDriver
  private let clock: EngineClock
  weak var delegate: EngineDelegate?
  var options: EngineOptions

  // ── Source & intent ──
  private(set) var source: SourceDescriptor?
  private(set) var generation = 0
  /// The last generation handed out. Every open takes the next one, so an
  /// item a quality switch was preparing (a generation ahead of the current
  /// one) can never share a number with a later open.
  private var issuedGeneration = 0
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
  /// Repeat a finite item from the start instead of ending.
  private var loop = false

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
  /// While waiting, where the playhead's current run at the playback rate
  /// began, and the last reading (the playhead can prove playback).
  private var waitingFrom: Double?
  private var waitingLast: (position: Double, at: Int64) = (0, 0)
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

  // ── Video: surroundings ──
  private var backgrounded = false
  private var pictureInPicture = false
  /// The view's cap when Picture in Picture started: it holds while the window is up.
  private var pipCap: Int?
  private var view = ViewState()
  /// No view since this instant: the picture goes off `viewDetachGraceMs` later.
  private var detachedSince: Int64?
  /// In the background without Picture in Picture: pause at this instant.
  private var pipDecisionAt: Int64?
  private var metered = false
  private var saveData = false

  // ── Video: the picture ──
  private var listenOnly = false
  private var videoInfo: VideoInfo?
  /// What a quality switch's new file said about its picture, for when it takes over.
  private var swapVideoInfo: VideoInfo?
  private var firstFrame = false
  private var variants: [VideoVariant] = []
  /// What the driver was last told (`nil`: nothing yet; drivers start with the picture on).
  private var appliedVideoEnabled: Bool?
  /// The constraints the driver was last given (an adaptive source).
  private var appliedQuality: String?
  private var lastAudioOnly: AudioOnlyReason?

  // ── Video: renditions ──
  private var renditions: [Rendition]?
  private var selectedQuality: String?
  /// The app's pick, kept across loads (`nil`: automatic).
  private var wantedQuality: String?
  /// Quiet step ups: counted from the load; the last one; how many stalls undid.
  private var quietSince: Int64 = 0
  private var quietUpAt: Int64?
  private var quietUndone = 0
  /// The engine's own pick among the renditions (automatic quality).
  private var abrLevel: Int?
  private var currentRendition: Int?
  private var pendingSwap: PendingSwap?
  private var failedUntil: [Int: Int64] = [:]
  /// The last bandwidth reading, kept across loads for the next start.
  private var bandwidth: Double?
  /// When this load last had a reading.
  private var bandwidthAt: Int64?
  private var stallTimes: [Int64] = []
  private var lastSwitchAt: Int64?
  /// The bandwidth has been under the current rendition's bitrate since…
  private var abrLowSince: Int64?
  /// …above `abrUpRatio` × the next one's since.
  private var abrUpSince: Int64?

  // ── Video: the audio-only fallback ──
  private var fallbackActive = false
  private var fallbackSince: Int64?
  /// The bandwidth has been under the fallback's drop ratio since…
  private var dropSince: Int64?
  /// …above its return ratio since.
  private var returnSince: Int64?

  // ── Refresh ──
  private var pendingRefresh: PendingRefresh?
  private var refreshAskAt: Int64?
  /// Bumped by every `sourceRefreshed`; `openedRevision` is its value at the last open.
  private var sourceRevision = 0
  private var openedRevision = 0

  // ── Stats ──
  private var loadStartedAt: Int64?
  private var counters = EngineStats()
  private var rebufferSince: Int64?

  // ── Tracks ──
  /// The source's own audio and text tracks (the driver's).
  private var sourceTracks: [MediaTrack] = []
  /// The app's subtitle files (`load({ subtitles })`, `addSubtitles`).
  private var appTracks: [MediaTrack] = []
  /// The app's audio pick (`nil`: automatic).
  private var chosenAudio: String?
  /// The app's text pick.
  private var chosenText: TextChoice = .auto
  private var audioTrack: String?
  private var textTrack: String?
  /// What the driver was last told (`nil`: nothing yet for this item).
  private var appliedTracks: String?
  private var system = SystemPreferences()
  private var subtitleDelay: Double = 0
  private var fullscreen = false

  private enum TextChoice: Equatable {
    case auto
    case off
    case track(String)
  }

  private struct PendingSwap {
    let generation: Int
    let rendition: Int
    let startedAt: Int64
    /// What the new file reported when ready: the item's facts once it takes over.
    var info: ReadyInfo?
    var readyAt: Int64?

    /// The new file must play by then: `swapTimeoutMs` to be ready, `swapAlignMs` once ready.
    var deadline: Int64 {
      if let readyAt { return readyAt + RecoveryPolicy.swapAlignMs }
      return startedAt + RecoveryPolicy.swapTimeoutMs
    }
  }

  private struct PendingRefresh {
    let reason: RefreshReason
    let deadline: Int64
    /// The failure that asked for it (`unauthorized`).
    let error: PlayerError?
  }

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
    s.qualities = statusQualities()
    if !s.qualities.isEmpty {
      s.quality = currentQualityId()
      s.selectedQuality = selectedQuality
    }
    s.video = videoStatus()
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
    if remote || focusExempt { return false }
    return playWhenReady || fadeOutThen != nil || (interruption?.resumable ?? false)
  }

  /// Native observations for any other generation are stale and must be dropped.
  func accepts(_ generation: Int) -> Bool {
    !released && generation == self.generation
  }

  // MARK: - Commands

  /// `quality`: the quality to play, for this load and the next (`nil`:
  /// automatic); only used when `qualityGiven`, else the current pick stays.
  func load(
    _ newSource: SourceDescriptor, autoplay: Bool?, startPosition: Double?, qualityGiven: Bool = false,
    quality: String? = nil
  ) throws {
    try ensureAlive()
    if qualityGiven { try chooseQuality(newSource, quality) }
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
    videoLoad()
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
    cancelSwap("reset")
    generation = issueGeneration()
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

  func seek(to seconds: Double, exact: Bool = false) throws {
    try ensureAlive()
    guard source != nil else { throw PlayerError.code(.noSource, "No source loaded.", recoverable: false) }
    guard seekable, !isLive else {
      throw PlayerError.code(.notSeekable, "This source is not seekable.", recoverable: false)
    }
    guard seconds.isFinite, seconds >= 0 else {
      throw PlayerError.code(.invalidArgument, "Seek position must be a finite number ≥ 0.", recoverable: false)
    }
    let target = duration.map { min(seconds, $0) } ?? seconds
    // A quality switch in flight was opened at the old position.
    cancelSwap("seek")
    resumePosition = target
    lastPosition = target
    lastPositionAdvanceAt = now
    if state == .ended { setState(.paused, cause: "seek after end") }
    if connectionReleased || state == .stopped || state == .error {
      // Nothing is open: the next play re-opens at `resumePosition`.
      commit()
      return
    }
    driver.seek(to: target, exact: exact)
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
    let was = muted
    muted = value
    applyVolume()
    if was && !value { unmuted() }
    commit()
  }

  /// Repeat a finite item from the start (the driver loops it seamlessly where it can).
  func setLoop(_ value: Bool) throws {
    try ensureAlive()
    loop = value
    driver.setLoop(value)
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
    cancelSwap("release")
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
    if isSwapGeneration(gen) {
      // A quality switch's file: its facts wait for it to take over.
      pendingSwap?.info = info
      if pendingSwap?.readyAt == nil { pendingSwap?.readyAt = now }
      return swapNote("ready")
    }
    guard accepts(gen) else { return logStale("ready", gen) }
    applyFacts(info)
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
    // A quality switch's new item plays: it is the current item from now on.
    if isSwapGeneration(gen) { completeSwap() }
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
    videoPlaying(t)
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
    if isSwapGeneration(gen) { return swapNote("buffering") }
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
    if isSwapGeneration(gen) {
      swapFailed(error)
      return commit()
    }
    guard accepts(gen) else { return logStale("failed", gen) }
    completeFadeOut()
    // A stop's fade-out landed: the item is gone.
    guard accepts(gen) else { commit(); return }
    handleFailure(error)
    commit()
  }

  func onEnded(generation gen: Int) {
    if isSwapGeneration(gen) { return swapNote("ended") }
    guard accepts(gen) else { return logStale("ended", gen) }
    if state == .ended { return logStale("ended again", gen) }
    completeFadeOut()
    // A stop's fade-out landed: the item is gone.
    guard accepts(gen) else { commit(); return }
    // Unknown duration reads as a live stream that dropped, unless the app
    // said the source is a file (`live: false`).
    if source?.liveHint != false && (isLive || duration == nil) {
      handleFailure(.code(.streamEnded, "The stream closed the connection.", recoverable: true))
    } else if loop && playWhenReady {
      // The driver could not loop it seamlessly: start over.
      restartFromEnd(cause: "loop")
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
    if isSwapGeneration(gen) { return swapNote("paused") }
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
      cancelSwap("handoff")
      generation = issueGeneration()
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
    guard !released else { return }
    // Read before a video player resumes: its resume is not a stall.
    let stalled = autoReconnect && !remote && waitingStates.contains(state)
    videoForegrounded()
    if stalled { attemptReconnect(reason: "app foregrounded") }
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
        stallPublished(t)
      }
    }
    videoWakeup(t)
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
    if remote || focusExempt { return .granted }
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
    cancelSwap("pause")
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
    cancelSwap("open")
    generation = issueGeneration()
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
    var target = source
    var index: Int?
    if renditions != nil, let current = currentRendition {
      target = renditionSource(current)
      index = current
    }
    driver.open(
      OpenRequest(
        generation: generation, source: target, startPosition: startPosition,
        playWhenReady: playWhenReady, allowReconnect: options.reconnect, rendition: index))
    videoOpened()
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
    let sample = driver.sample()
    lastBuffered = sample.bufferedPosition
    waitingFrom = sample.position
    waitingLast = (sample.position, now)
  }

  /// Whether the playhead has run on, reading after reading, at about the
  /// playback rate for `playheadProofS` (a jump, like a live edge or a seek,
  /// or a frozen playhead, starts the run again).
  private func playheadPlays(_ t: Int64, _ p: Double) -> Bool {
    guard var from = waitingFrom, !remote else { return false }
    let dt = Double(t - waitingLast.at) / 1000
    let dp = p - waitingLast.position
    let r = max(rate, 0.1)
    let runs = dt > 0 && dp >= 0.5 * r * dt && dp <= 1.5 * r * dt + 0.25
    waitingLast = (p, t)
    if !runs {
      from = p
      waitingFrom = p
    }
    return runs && p - from >= RecoveryPolicy.playheadProofS
  }

  private func handleFailure(_ error: PlayerError) {
    // A 401/403 on a source the app can refresh waits for a new URL first.
    if refreshOnFailure(error) { return }
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
          stallPublished(t)
        }
      }
      if let since = playingSince, t - since >= RecoveryPolicy.stablePlaybackMs {
        playingSince = nil
        stable = true
        backoff.reset()
        offlineSkips = 0
        recoveringSince = nil
      }
      videoHeartbeat(t)
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
      if playheadPlays(t, p) {
        // The platform plays but never said so: the playhead is the proof.
        log("playhead moving", ["at": String(format: "%.1f", p)])
        onPlaying(generation: generation)
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
    if stalledAtEnd() {
      // A re-open would land at the end and stall again, in a loop.
      log("stall at the end", ["reason": reason])
      onEnded(generation: generation)
    } else if options.reconnect {
      attemptReconnect(reason: reason)
    } else {
      failStall(reason)
    }
  }

  /// The playhead and the buffer are at a file's end: no data is coming because there is none left.
  private func stalledAtEnd() -> Bool {
    guard let duration, !isLive, !remote else { return false }
    let end = duration - RecoveryPolicy.endSlackS
    let sample = driver.sample()
    return sample.position >= end && sample.bufferedPosition >= end
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
    videoPlaying(t)
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
    cancelSwap("release")
    generation = issueGeneration()
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
    stateChanged(next)
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
    videoWakeups(&candidates)
    return candidates.min()
  }
}

// MARK: - Video
//
// What a video player does in the background and off screen, when the
// picture is decoded, its audio focus and media session, keeping the screen
// on, its quality (the caps of an adaptive source's own ABR; the engine's own
// ABR over separate files, switched behind the picture under a new
// generation), the audio-only fallback, refreshing a signed source, and the
// quality-of-experience counters. An audio player (`options.video == nil`)
// only gets the refresh, the counters and `loop`. Twins: `EngineVideo.ts` and
// `EngineQuality.ts`, the video part of `PlaybackEngine.kt`.

extension PlaybackEngine {
  // MARK: Queries

  /// The player should own a media session (lock screen, notification).
  var wantsMediaSession: Bool {
    guard let v = options.video else { return true }
    return !(v.ambient || (muted && !v.focusWhenMuted))
  }

  /// Keep the screen on: a video playing in a visible view.
  var wantsScreenAwake: Bool {
    guard let v = options.video, v.keepAwake, !v.ambient else { return false }
    guard view.attached, view.visible, !backgrounded else { return false }
    return playWhenReady && awakeStates.contains(state)
  }

  /// Start-up, rebuffers and switches since the last `load()`.
  var stats: EngineStats {
    var s = counters
    if let since = rebufferSince { s.rebufferMs += now - since }
    return s
  }

  // MARK: Commands

  /// Pins a quality (`status.qualities[].id`), or `nil` for automatic.
  func selectQuality(_ id: String?) throws {
    try ensureAlive()
    let qualities = statusQualities()
    if let id, !qualities.contains(where: { $0.id == id }) {
      throw PlayerError.code(.invalidArgument, "No quality \"\(id)\".", recoverable: false)
    }
    // Kept for the next loads too (`load(…, quality)` overrides it).
    wantedQuality = id
    // Nothing to pick from (one file): automatic already.
    if qualities.isEmpty { return }
    selectedQuality = id
    log("quality selected", ["id": id ?? "auto"])
    applyQuality("selected")
    commit()
  }

  /// Plays the sound alone (an audio-only variant or rendition where there is one).
  func setListenOnly(_ value: Bool) throws {
    try ensureAlive()
    guard options.video != nil else { throw notVideoPlayer() }
    listenOnly = value
    applyOutput("listen-only")
    commit()
  }

  /// Plays this audio track (`nil`: back to the automatic choice).
  func selectAudioTrack(_ id: String?) throws {
    try ensureAlive()
    guard options.video != nil else { throw notVideoPlayer() }
    if let id { try assertTrack(id, audio: true) }
    chosenAudio = id
    log("audio track selected", ["id": id ?? "auto"])
    applyTracks("selected")
    commit()
  }

  /// Shows this text track; `nil` turns subtitles off.
  func selectTextTrack(_ id: String?) throws {
    try ensureAlive()
    guard options.video != nil else { throw notVideoPlayer() }
    if let id { try assertTrack(id, audio: false) }
    chosenText = id.map { .track($0) } ?? .off
    log("text track selected", ["id": id ?? "off"])
    applyTracks("selected")
    commit()
  }

  /// Shows subtitles this many seconds later (negative: earlier).
  func setSubtitleDelay(_ seconds: Double) throws {
    try ensureAlive()
    guard seconds.isFinite else {
      throw PlayerError.code(.invalidArgument, "The subtitle delay must be a finite number.", recoverable: false)
    }
    subtitleDelay = seconds
    commit()
  }

  /// The app's subtitle files for the current load.
  func setAppTracks(_ tracks: [MediaTrack]) {
    guard !released else { return }
    appTracks = tracks
    applyTracks("app tracks")
    commit()
  }

  /// The OS's languages and accessibility settings changed.
  func systemPreferencesChanged(_ preferences: SystemPreferences) {
    guard !released else { return }
    system = preferences
    applyTracks("system preferences")
    commit()
  }

  func fullscreenChanged(_ active: Bool) {
    guard !released, active != fullscreen else { return }
    fullscreen = active
    commit()
  }

  /// The source's own audio and text tracks.
  func onTracks(generation gen: Int, tracks: [MediaTrack]) {
    guard accepts(gen) else { return logStale("tracks", gen) }
    sourceTracks = tracks
    applyTracks("source tracks")
    commit()
  }

  /// The app's new source for `loadId` (after `refreshRequested`).
  func sourceRefreshed(loadId: Int, source next: SourceDescriptor) {
    guard !released else { return }
    guard loadId == self.loadId, source != nil else {
      log("refresh ignored", ["loadId": "\(loadId)"])
      return
    }
    let pending = pendingRefresh
    pendingRefresh = nil
    var refreshed = next
    refreshed.refreshable = true
    source = refreshed
    if let nextRenditions = next.renditions, renditions != nil { renditions = nextRenditions }
    sourceRevision += 1
    armExpiry()
    log("source refreshed", ["reason": pending?.reason.rawValue ?? "none"])
    if pending?.reason == .unauthorized { useRefreshedSource() }
    commit()
  }

  /// The app could not make a new source for `loadId`.
  func sourceRefreshFailed(loadId: Int) {
    guard !released, loadId == self.loadId else { return }
    let pending = pendingRefresh
    pendingRefresh = nil
    log("refresh failed", ["reason": pending?.reason.rawValue ?? "none"])
    if pending?.reason == .unauthorized, let error = pending?.error {
      settlePendingLoad(.failed(error))
      fail(error)
    }
    commit()
  }

  /// The platform read a rendition's height or bitrate from its file.
  func renditionInfo(index: Int, height: Int?, bitrate: Int64?) {
    guard !released, var table = renditions, table.indices.contains(index) else { return }
    if let height { table[index].height = height }
    if let bitrate { table[index].bitrate = bitrate }
    renditions = table
    commit()
  }

  // MARK: System inputs

  /// The app went to the background (`whenBackgrounded`).
  func appBackgrounded() {
    guard !released, !backgrounded else { return }
    backgrounded = true
    if let v = options.video, !pictureOnAnotherScreen {
      backgroundPolicy(v)
      applyOutput("background")
    }
    commit()
  }

  /// The view showing the player changed (mounted, scrolled, resized).
  func viewChanged(_ next: ViewState) {
    guard !released else { return }
    let previous = view
    view = next
    guard let v = options.video else { return }
    if next.attached {
      detachedSince = nil
    } else if previous.attached {
      detachedSince = now
    } else {
      detachedSince = detachedSince ?? now
    }
    if v.ambient { ambientCheck() }
    applyOutput("view")
    commit()
  }

  func pictureInPictureChanged(_ active: Bool) {
    guard !released, active != pictureInPicture else { return }
    if active { pipCap = viewCap() }
    pictureInPicture = active
    log("picture in picture", ["active": "\(active)"])
    if active { pipDecisionAt = nil } else { pictureInPictureClosed() }
    applyOutput("picture in picture")
    commit()
  }

  /// A metered network (cellular caps) and the OS's data saver.
  func networkCostChanged(metered: Bool, saveData: Bool) {
    guard !released else { return }
    guard metered != self.metered || saveData != self.saveData else { return }
    self.metered = metered
    self.saveData = saveData
    applyQuality("network cost")
    commit()
  }

  // MARK: Driver observations

  /// A bandwidth estimate, bits per second (for the current item or a switch's).
  func onBandwidth(generation gen: Int, bitsPerSecond: Double) {
    guard accepts(gen) || isSwapGeneration(gen) else { return }
    guard bitsPerSecond.isFinite, bitsPerSecond > 0 else { return }
    let t = now
    bandwidth = bitsPerSecond
    bandwidthAt = t
    trackBandwidth(t, bitsPerSecond)
  }

  /// An adaptive source's qualities.
  func onVariants(generation gen: Int, variants: [VideoVariant]) {
    guard accepts(gen) else { return logStale("variants", gen) }
    self.variants = variants
    // A pick among renditions stands: each file's variants are not the list.
    if let selected = selectedQuality, renditions == nil, !variants.contains(where: { $0.id == selected }) {
      selectedQuality = nil
    }
    if selectedQuality == nil, let wanted = wantedQuality, renditions == nil,
      variants.contains(where: { $0.id == wanted })
    {
      selectedQuality = wanted
    }
    applyQuality("variants")
    commit()
  }

  func onVideoInfo(generation gen: Int, info: VideoInfo) {
    // A switch's new file: its picture is the one once it takes over.
    if isSwapGeneration(gen) {
      swapVideoInfo = info
      return
    }
    guard accepts(gen) else { return logStale("video info", gen) }
    videoInfo = info
    if let index = currentRendition, var table = renditions, table[index].height == nil, info.height > 0 {
      table[index].height = info.height
      renditions = table
    }
    applyQuality("video info")
    commit()
  }

  func onFirstFrame(generation gen: Int) {
    guard accepts(gen) else { return logStale("first frame", gen) }
    firstFrame = true
    commit()
  }

  // MARK: Hooks in the engine's paths

  fileprivate var focusExempt: Bool {
    guard let v = options.video else { return false }
    return v.ambient || (muted && !v.focusWhenMuted)
  }

  fileprivate func issueGeneration() -> Int {
    issuedGeneration += 1
    return issuedGeneration
  }

  fileprivate func videoStatus() -> VideoStatus? {
    guard options.video != nil else { return nil }
    return VideoStatus(
      width: videoInfo?.width, height: videoInfo?.height, hdr: videoInfo?.hdr ?? false,
      firstFrame: firstFrame, audioOnly: audioOnlyReason, pictureInPicture: pictureInPicture,
      tracks: allTracks, audioTrack: audioTrack, textTrack: textTrack, subtitleDelay: subtitleDelay,
      fullscreen: fullscreen)
  }

  fileprivate func videoLoad() {
    loadStartedAt = now
    counters = EngineStats()
    rebufferSince = nil
    pendingRefresh = nil
    sourceRevision = 0
    openedRevision = 0
    armExpiry()
    // The qualities are any player's (an audio player's renditions too).
    resetQuality()
    guard let v = options.video else { return }
    firstFrame = false
    resetTracks()
    if !view.attached && detachedSince == nil { detachedSince = now }
    lastAudioOnly = audioOnlyReason
    if v.ambient && !shown && playWhenReady {
      // Not on screen: it starts when its view is (nothing is open to pause).
      playWhenReady = false
      interruption = Interruption(
        reason: backgrounded ? .background : .offscreen, resumable: true, since: clock.wallMs)
    }
  }

  fileprivate func videoOpened() {
    openedRevision = sourceRevision
    // A new item plays its default tracks until it is told again.
    appliedTracks = nil
    guard options.video != nil, renditions == nil else { return }
    // A new item starts from the driver's defaults: tell it the caps again.
    appliedQuality = nil
    applyQuality("open")
  }

  fileprivate func isSwapGeneration(_ gen: Int) -> Bool {
    !released && pendingSwap?.generation == gen
  }

  fileprivate func completeSwap() {
    guard let swap = pendingSwap else { return }
    pendingSwap = nil
    generation = swap.generation
    currentRendition = swap.rendition
    if let info = swap.info { applyFacts(info) }
    readyForGeneration = true
    connectionReleased = false
    openedRevision = sourceRevision
    lastSwitchAt = now
    abrLowSince = nil
    abrUpSince = nil
    counters.qualitySwitches += 1
    if let info = swapVideoInfo { videoInfo = info }
    swapVideoInfo = nil
    log("quality switched", ["to": "r\(swap.rendition)"])
    appliedTracks = nil
    applyTracks("quality switched")
  }

  fileprivate func swapFailed(_ error: PlayerError) {
    guard let swap = pendingSwap else { return }
    dropSwap(swap, reason: "failed: \(error.code.rawValue)", cause: error)
  }

  /// The item's duration, live state and seekability, as the platform reports them.
  private func applyFacts(_ info: ReadyInfo) {
    duration = info.duration
    isLive = source?.liveHint ?? info.isLive
    seekable = info.seekable && !isLive
  }

  fileprivate func swapNote(_ event: String) {
    log("quality switch", ["event": event])
  }

  fileprivate func cancelSwap(_ reason: String) {
    guard let swap = pendingSwap else { return }
    pendingSwap = nil
    driver.cancelSwap(generation: swap.generation)
    log("quality switch cancelled", ["reason": reason])
  }

  fileprivate func refreshOnFailure(_ error: PlayerError) -> Bool {
    guard source?.refreshable == true else { return false }
    guard error.httpStatus == 401 || error.httpStatus == 403 else { return false }
    if sourceRevision > openedRevision {
      // A new source came in ahead (`expiresAt`): use it now.
      log("refreshed source", ["note": "already here"])
      useRefreshedSource()
      return true
    }
    if pendingRefresh?.reason == .unauthorized { return true }
    lastError = error
    requestRefresh(.unauthorized, error: error)
    if playWhenReady {
      if !isLive { rememberPosition() }
      if recoveringSince == nil { recoveringSince = now }
      nextAttemptAt = nil
      reconnectReason = "refresh"
      setState(.reconnecting, cause: "waiting for a new source")
    }
    return true
  }

  fileprivate func videoPlaying(_ t: Int64) {
    if counters.startupMs == nil, let started = loadStartedAt { counters.startupMs = t - started }
    endRebuffer(t)
  }

  fileprivate func stallPublished(_ t: Int64) {
    counters.rebufferCount += 1
    if rebufferSince == nil { rebufferSince = t }
    guard !remote else { return }
    if audioOnlyReason == nil {
      stallTimes.append(t)
      stallTimes.removeAll { t - $0 >= RecoveryPolicy.fallbackProbeMs }
    }
    evaluateAbr(t, stalled: true)
    // The audio-only fallback is the picture's.
    if options.video != nil { evaluateFallback(t, stalled: true) }
  }

  fileprivate func stateChanged(_ next: PlaybackState) {
    if rebufferSince != nil && !rebufferStates.contains(next) { endRebuffer(now) }
  }

  fileprivate func unmuted() {
    guard let v = options.video, !v.ambient, !v.focusWhenMuted else { return }
    guard !remote, playWhenReady else { return }
    // A muted video took no focus: it asks now, and a refusal pauses it.
    switch delegate?.engineRequestsAudioFocus() ?? .granted {
    case .granted: break
    case .delayed: systemPause(reason: .audioFocusDelayed, resumable: true)
    case .denied: systemPause(reason: .audioFocusDenied, resumable: false)
    }
  }

  fileprivate func videoWakeup(_ t: Int64) {
    if let due = pipDecisionAt, due <= t { pipDecision() }
    if let since = detachedSince, t - since >= RecoveryPolicy.viewDetachGraceMs { noViewDue() }
    if let refresh = pendingRefresh, refresh.deadline <= t { refreshTimedOut(refresh) }
    if let ask = refreshAskAt, ask <= t { expiryDue() }
    if let swap = pendingSwap, t >= swap.deadline {
      dropSwap(swap, reason: "timeout")
    }
  }

  fileprivate func videoWakeups(_ candidates: inout [Int64]) {
    if let due = pipDecisionAt { candidates.append(due) }
    if let since = detachedSince, pictureMayGoOff {
      candidates.append(since + RecoveryPolicy.viewDetachGraceMs)
    }
    if let refresh = pendingRefresh { candidates.append(refresh.deadline) }
    if let ask = refreshAskAt { candidates.append(ask) }
    if let swap = pendingSwap { candidates.append(swap.deadline) }
  }

  /// The app came back (`appForegrounded`).
  fileprivate func videoForegrounded() {
    guard backgrounded else { return }
    backgrounded = false
    pipDecisionAt = nil
    guard let v = options.video else { return }
    if v.ambient {
      ambientCheck()
    } else if pausedFor(.background) {
      interruption = nil
      startPlayback(cause: "foreground")
    }
    applyOutput("foreground")
  }

  /// The watchdog's tick, while playback is wanted.
  fileprivate func videoHeartbeat(_ t: Int64) {
    guard !remote, state == .playing, options.video != nil || renditions != nil else { return }
    // A switch a seek or a pause cancelled is tried again.
    if renditions != nil && pendingSwap == nil { retarget("resume switch") }
    evaluateAbr(t, stalled: false)
    if options.video != nil { evaluateFallback(t, stalled: false) }
  }

  // MARK: Surroundings

  /// The picture is on another screen (Cast, AirPlay): the app's state does not matter.
  private var pictureOnAnotherScreen: Bool { remote || route.kind == .airplay }

  /// The view is attached, visible, and the app in the foreground.
  private var shown: Bool { view.attached && view.visible && !backgrounded }

  private var audioOnlyReason: AudioOnlyReason? {
    guard options.video != nil else { return nil }
    if listenOnly { return .listen }
    if backgroundAudio { return .background }
    if fallbackActive { return .fallback }
    return nil
  }

  /// `whenBackgrounded: 'audio'` applies now.
  private var backgroundAudio: Bool {
    guard let v = options.video, !v.ambient, backgrounded else { return false }
    guard !pictureInPicture, !pictureOnAnotherScreen else { return false }
    return v.whenBackgrounded == .audio
  }

  /// Decode the picture: something shows it, or a view went away only just now.
  private var wantsPicture: Bool {
    if audioOnlyReason != nil { return false }
    if pictureInPicture || view.attached || remote { return true }
    guard let since = detachedSince else { return true }
    return now - since < RecoveryPolicy.viewDetachGraceMs
  }

  /// The no-view grace can still turn the picture off.
  private var pictureMayGoOff: Bool {
    options.video != nil && source != nil && appliedVideoEnabled != false
  }

  /// The system paused it for `reason` and may resume it.
  private func pausedFor(_ reason: InterruptionReason) -> Bool {
    guard let i = interruption else { return false }
    return i.resumable && i.reason == reason
  }

  private func backgroundPolicy(_ v: VideoEngineOptions) {
    if v.ambient { return ambientCheck() }
    if pictureInPicture { return }
    switch v.whenBackgrounded {
    case .pip:
      // Picture in Picture may start a moment after the app leaves.
      pipDecisionAt = now + RecoveryPolicy.pipGraceMs
    case .pause:
      if playWhenReady { systemPause(reason: .background, resumable: false) }
    case .audio:
      break
    }
  }

  /// Closing Picture in Picture from the background pauses, unless the app
  /// comes back ("back to app" brings the app forward right after).
  private func pictureInPictureClosed() {
    guard let v = options.video, !v.ambient, backgrounded else { return }
    if v.whenBackgrounded != .audio { pipDecisionAt = now + RecoveryPolicy.pipGraceMs }
  }

  /// The Picture in Picture grace ran out in the background.
  private func pipDecision() {
    pipDecisionAt = nil
    guard backgrounded, !pictureInPicture else { return }
    if playWhenReady { systemPause(reason: .background, resumable: false) }
  }

  private func noViewDue() {
    if appliedVideoEnabled != false { applyOutput("no view") }
  }

  private func expiryDue() {
    refreshAskAt = nil
    if pendingRefresh == nil { requestRefresh(.expiring, error: nil) }
  }

  /// An ambient player plays only when shown, and resumes when shown again.
  private func ambientCheck() {
    guard shown else {
      if playWhenReady {
        systemPause(reason: backgrounded ? .background : .offscreen, resumable: true)
      }
      return
    }
    let waiting = pausedFor(.background) || pausedFor(.offscreen)
    if waiting && source != nil {
      interruption = nil
      startPlayback(cause: "on screen")
    }
  }

  /// Sends what changed about the picture: on or off, audio only, the quality.
  private func applyOutput(_ cause: String) {
    guard options.video != nil, source != nil else { return }
    let reason = audioOnlyReason
    if reason != lastAudioOnly {
      if lastAudioOnly == nil { counters.audioOnlySwitches += 1 }
      log("audio only", ["reason": reason?.rawValue ?? "off", "cause": cause])
      lastAudioOnly = reason
    }
    let on = wantsPicture
    if on != (appliedVideoEnabled ?? true) {
      appliedVideoEnabled = on
      driver.setVideoEnabled(on)
      log("picture", ["on": "\(on)", "cause": cause])
    }
    applyQuality(cause)
  }

  private var allTracks: [MediaTrack] { sourceTracks + appTracks }

  private func resetTracks() {
    sourceTracks = []
    appTracks = []
    chosenAudio = nil
    chosenText = .auto
    audioTrack = nil
    textTrack = nil
    appliedTracks = nil
    subtitleDelay = 0
  }

  private func assertTrack(_ id: String, audio: Bool) throws {
    guard allTracks.contains(where: { $0.id == id && ($0.kind == .audio) == audio }) else {
      throw PlayerError.code(
        .invalidArgument, "No \(audio ? "audio" : "text") track \"\(id)\".", recoverable: false)
    }
  }

  /// The tracks to play: the app's pick where it made one, else the automatic choice.
  private func applyTracks(_ cause: String) {
    guard let v = options.video else { return }
    let all = allTracks
    let auto = TrackSelection.select(
      all,
      TrackPreferences(
        languages: v.tracks.languages, followSystem: v.tracks.followSystem,
        systemLanguages: system.languages, systemCaptions: system.captions,
        systemAudioDescriptions: system.audioDescriptions))
    let has = { (id: String?) in id.map { id in all.contains { $0.id == id } } ?? false }
    let audio = has(chosenAudio) ? chosenAudio : auto.audio
    let text: String?
    switch chosenText {
    case .auto: text = auto.text
    case .off: text = nil
    case .track(let id): text = has(id) ? id : auto.text
    }
    audioTrack = audio
    textTrack = text
    sendTracks(audio, text, cause: cause)
  }

  /// The driver plays the source's own tracks; an app's subtitle file is the overlay's.
  private func sendTracks(_ audio: String?, _ text: String?, cause: String) {
    guard source != nil, !sourceTracks.isEmpty else { return }
    let own = { (id: String?) -> String? in
      guard let id, self.sourceTracks.contains(where: { $0.id == id }) else { return nil }
      return id
    }
    let key = "\(own(audio) ?? "-")|\(own(text) ?? "-")"
    guard key != appliedTracks else { return }
    appliedTracks = key
    driver.selectTracks(audio: own(audio), text: own(text))
    log("tracks", ["audio": audio ?? "-", "text": text ?? "-", "cause": cause])
  }

  private func endRebuffer(_ t: Int64) {
    guard let since = rebufferSince else { return }
    counters.rebufferMs += t - since
    rebufferSince = nil
  }

  // MARK: Refresh

  /// A 401/403 met a source the app already replaced, or the app's answer came.
  private func useRefreshedSource() {
    let opening = playWhenReady || pendingLoadId != nil
    if opening || state == .loading {
      if !isLive && readyForGeneration { rememberPosition() }
      reopen(reason: "refreshed source")
    } else {
      connectionReleased = true
    }
  }

  private func armExpiry() {
    guard let current = source, current.refreshable, let expires = current.expiresAt else {
      refreshAskAt = nil
      return
    }
    let left = expires - clock.wallMs - RecoveryPolicy.refreshAheadMs
    refreshAskAt = now + max(0, left)
  }

  private func requestRefresh(_ reason: RefreshReason, error: PlayerError?) {
    pendingRefresh = PendingRefresh(
      reason: reason, deadline: now + RecoveryPolicy.refreshTimeoutMs, error: error)
    log("refresh requested", ["reason": reason.rawValue])
    delegate?.engine(refreshRequested: loadId, reason: reason)
  }

  /// The app did not answer in time (JavaScript frozen, a slow token server).
  private func refreshTimedOut(_ refresh: PendingRefresh) {
    pendingRefresh = nil
    log("refresh timed out", ["reason": refresh.reason.rawValue])
    guard refresh.reason == .unauthorized, let error = refresh.error else { return }
    settlePendingLoad(.failed(error))
    if playWhenReady && options.reconnect {
      // Try the old source again in the backoff; a 401/403 asks again.
      pendingEvents.append { [weak self] in self?.delegate?.engine(error: error, fatal: false) }
      scheduleReconnect(reason: "refresh timed out")
    } else {
      fail(error)
    }
  }

  // MARK: Quality

  /// A new source: the renditions and the quality facts start over.
  private func resetQuality() {
    videoInfo = nil
    variants = []
    quietSince = now
    quietUpAt = nil
    quietUndone = 0
    fallbackActive = false
    fallbackSince = nil
    stallTimes = []
    failedUntil = [:]
    bandwidthAt = nil
    abrLowSince = nil
    abrUpSince = nil
    dropSince = nil
    returnSince = nil
    lastSwitchAt = nil
    appliedQuality = nil
    // An audio player's renditions are all rungs of one ladder: none is the
    // picture's audio-only fallback.
    let audio = options.video == nil
    if let table = source?.renditions, !table.isEmpty {
      renditions = table.map { r in
        var rung = r
        rung.audioOnly = r.audioOnly && !audio
        return rung
      }
    } else {
      renditions = nil
    }
    // The app's pick holds from the first byte where this source has it; an
    // adaptive source's variants take it when they are known (onVariants).
    selectedQuality = wantedQuality.flatMap { renditionIndex($0) != nil ? $0 : nil }
    abrLevel = renditions != nil ? startLevel() : nil
    currentRendition = targetRendition()
  }

  /// The quality the status reports as playing.
  private func currentQualityId() -> String? {
    guard let table = renditions else { return videoInfo?.variantId }
    return currentRendition.map { table[$0].id(at: $0) }
  }

  private func applyQuality(_ cause: String) {
    guard source != nil else { return }
    if renditions != nil {
      retarget(cause)
      return
    }
    guard options.video != nil else { return }
    let c = constraints()
    let key = "\(String(describing: c.maxHeight))|\(String(describing: c.maxBitrate))|\(c.pinned ?? "-")|\(c.audioOnly)"
    guard key != appliedQuality else { return }
    appliedQuality = key
    driver.setQuality(c)
  }

  /// The caps for an adaptive source's ABR (and the allowed renditions).
  private func constraints() -> QualityConstraints {
    // An audio player has no caps: they are the picture's.
    guard let q = options.video?.quality else {
      return QualityConstraints(maxHeight: nil, maxBitrate: nil, pinned: nil, audioOnly: false)
    }
    var maxHeight = q.maxHeight
    var maxBitrate = q.maxBitrate
    if metered {
      maxHeight = minOf(maxHeight, q.cellularMaxHeight)
      maxBitrate = minOf(maxBitrate, q.cellularMaxBitrate)
    }
    if saveData && q.followDataSaver { maxHeight = minOf(maxHeight, RecoveryPolicy.dataSaverMaxHeight) }
    if q.capToView { maxHeight = minOf(maxHeight, viewCap()) }
    return QualityConstraints(
      maxHeight: maxHeight, maxBitrate: maxBitrate,
      pinned: renditions == nil ? selectedQuality : nil, audioOnly: audioOnlyReason != nil)
  }

  /// The picture height the view can show (contain fit), rounded up; `nil`: no cap.
  private func viewCap() -> Int? {
    // Picture in Picture keeps the quality it started with: no switch (and
    // no rebuffer) on the way in or back for a window that small.
    if pictureInPicture { return pipCap }
    guard view.attached, view.height > 0 else { return nil }
    let shownHeight = self.shownHeight(view)
    guard let table = renditions else { return standardHeights.first { Double($0) >= shownHeight } }
    // The smallest rendition that fills it.
    return table.filter { !$0.audioOnly }.compactMap(\.height).filter { Double($0) >= shownHeight }.min()
  }

  /// How many rows of the picture the view shows.
  private func shownHeight(_ view: ViewState) -> Double {
    guard let info = videoInfo, info.width > 0, info.height > 0, view.width > 0 else {
      return Double(view.height)
    }
    let scale = min(Double(view.width) / Double(info.width), Double(view.height) / Double(info.height))
    return Double(info.height) * scale
  }

  /// The qualities the status lists. An audio player picks among renditions
  /// only: an adaptive source's variants are the platform's to switch.
  private func statusQualities() -> [VideoVariant] {
    options.video == nil && renditions == nil ? [] : qualityList()
  }

  /// `load(…, quality)`: the pick for this load and the next (`nil`:
  /// automatic). Checked before anything changes: an id the source's
  /// renditions lack is refused.
  private func chooseQuality(_ source: SourceDescriptor, _ quality: String?) throws {
    if let quality, let table = source.renditions, !table.isEmpty,
      !table.enumerated().contains(where: { $0.element.id(at: $0.offset) == quality })
    {
      throw PlayerError.code(.invalidArgument, "No quality \"\(quality)\".", recoverable: false)
    }
    wantedQuality = quality
  }

  /// A rendition's index by its id, `nil` when there is none.
  private func renditionIndex(_ id: String) -> Int? {
    renditions?.enumerated().first(where: { $0.element.id(at: $0.offset) == id })?.offset
  }

  private func qualityList() -> [VideoVariant] {
    guard let table = renditions else { return variants }
    return table.enumerated().map { i, r in
      // Every quality of an audio player is sound alone.
      VideoVariant(
        id: r.id(at: i), height: r.height, bitrate: r.bitrate, audioOnly: r.audioOnly || options.video == nil,
        label: r.label)
    }
  }

  private func renditionSource(_ index: Int) -> SourceDescriptor {
    let r = renditions![index]
    return SourceDescriptor(
      uri: r.uri, headers: r.headers ?? source?.headers ?? [:], liveHint: source?.liveHint, drm: source?.drm)
  }

  /// A rendition's bitrate, or an estimate from its height and a known one.
  private func bitrateOf(_ index: Int) -> Int64? {
    let table = renditions!
    let r = table[index]
    if let bitrate = r.bitrate { return bitrate }
    guard let height = r.height else { return nil }
    guard
      let known = table.first(where: { !$0.audioOnly && $0.bitrate != nil && $0.height != nil }),
      let knownBitrate = known.bitrate, let knownHeight = known.height
    else { return nil }
    let ratio = Double(height) / Double(knownHeight)
    return Int64((Double(knownBitrate) * ratio * ratio).rounded())
  }

  /// The video renditions, lowest first.
  private func videoOrder() -> [Int] {
    guard let table = renditions else { return [] }
    return table.indices.filter { !table[$0].audioOnly }.sorted { compareRenditions($0, $1) < 0 }
  }

  private func compareRenditions(_ a: Int, _ b: Int) -> Int {
    if let ba = bitrateOf(a), let bb = bitrateOf(b), ba != bb { return ba < bb ? -1 : 1 }
    if let ha = renditions![a].height, let hb = renditions![b].height, ha != hb {
      return ha < hb ? -1 : 1
    }
    return a < b ? -1 : (a > b ? 1 : 0)
  }

  /// The video renditions the caps allow and none failed of, lowest first.
  private func allowedOrder() -> [Int] {
    let order = videoOrder()
    guard !order.isEmpty else { return order }
    let t = now
    let usable = order.filter { (failedUntil[$0] ?? 0) <= t }
    let pool = usable.isEmpty ? order : usable
    let c = constraints()
    let allowed = pool.filter { withinCaps($0, c) }
    return allowed.isEmpty ? [pool[0]] : allowed
  }

  private func withinCaps(_ index: Int, _ c: QualityConstraints) -> Bool {
    let height = renditions![index].height
    let bitrate = bitrateOf(index)
    if let maxHeight = c.maxHeight, let height, height > maxHeight { return false }
    guard let maxBitrate = c.maxBitrate, let bitrate else { return true }
    return bitrate <= maxBitrate
  }

  private func audioRendition() -> Int? {
    renditions?.firstIndex(where: \.audioOnly)
  }

  /// The highest rendition that fits a bandwidth, among `order` (lowest first).
  private func fitting(_ order: [Int], _ bandwidth: Double) -> Int? {
    order.last { i in
      guard let bitrate = bitrateOf(i) else { return false }
      return Double(bitrate) <= RecoveryPolicy.abrFitRatio * bandwidth
    }
  }

  private func startLevel() -> Int? {
    let order = allowedOrder()
    guard let first = order.first, let last = order.last else { return nil }
    // An audio player starts at the highest (a sound's bitrates are small)
    // unless a file's bandwidth says otherwise; a live one cannot say.
    guard let video = options.video else {
      if let bandwidth, !isLive { return fitting(order, bandwidth) ?? first }
      return last
    }
    switch video.quality.startQuality {
    case .lowest: return first
    case .highest: return last
    case .height(let value): return tallestUpTo(order, value)
    case .auto:
      if let bandwidth { return fitting(order, bandwidth) ?? first }
      return automaticStart(order)
    }
  }

  /// The tallest rendition no taller than `height`, or the lowest.
  private func tallestUpTo(_ order: [Int], _ height: Int) -> Int {
    order.last { i in renditions![i].height.map { $0 <= height } ?? false } ?? order[0]
  }

  /// No bandwidth reading yet: the lowest at least 480p (or the tallest under it).
  private func automaticStart(_ order: [Int]) -> Int {
    let table = renditions!
    if let tall = order.first(where: { i in
      table[i].height.map { $0 >= RecoveryPolicy.startMinHeight } ?? false
    }) {
      return tall
    }
    let allKnown = order.allSatisfy { table[$0].height != nil }
    return allKnown ? order[order.count - 1] : order[0]
  }

  /// Which rendition should play now.
  private func targetRendition() -> Int? {
    guard renditions != nil else { return nil }
    if audioOnlyReason != nil, let audio = audioRendition() { return audio }
    if let selected = selectedQuality, let index = renditionIndex(selected) {
      let failed = (failedUntil[index] ?? 0) > now
      return failed ? currentRendition : index
    }
    let order = allowedOrder()
    guard let first = order.first else { return currentRendition }
    guard let level = abrLevel else { return first }
    if order.contains(level) { return level }
    // Not allowed any more (caps, a failure): the highest allowed below it.
    let all = videoOrder()
    let position = all.firstIndex(of: level) ?? -1
    return order.last { (all.firstIndex(of: $0) ?? -1) < position } ?? first
  }

  /// Moves to the target rendition if it changed.
  private func retarget(_ cause: String) {
    guard let target = targetRendition() else { return }
    if pendingSwap?.rendition == target { return }
    if pendingSwap != nil { cancelSwap("retarget") }
    if target != currentRendition { moveTo(target, cause: cause) }
  }

  private func moveTo(_ target: Int, cause: String) {
    let open = readyForGeneration && !connectionReleased
    let flowing = state == .playing || state == .buffering
    // A Cast receiver (or an output like Safari's AirPlay) plays one item: it re-opens in place.
    if flowing && open && playWhenReady && !remote && !driver.swapsInPlace { return startSwap(target, cause: cause) }
    // A switch in place counts as one (the next quiet step up waits again).
    if target != currentRendition { lastSwitchAt = now }
    currentRendition = target
    // Stopped, ended, failed or reconnecting: the next open uses it.
    let reopens = state == .loading || (open && (flowing || state == .paused))
    guard reopens else { return }
    // A load still opening keeps its start position.
    if open && !isLive { rememberPosition() }
    reopen(reason: "quality: \(cause)")
  }

  private func startSwap(_ target: Int, cause: String) {
    let position = isLive ? nil : driver.sample().position
    let gen = issueGeneration()
    pendingSwap = PendingSwap(generation: gen, rendition: target, startedAt: now)
    log("quality switch", ["to": "r\(target)", "cause": cause])
    driver.open(
      OpenRequest(
        generation: gen, source: renditionSource(target), startPosition: position,
        playWhenReady: true, allowReconnect: options.reconnect, swap: true, rendition: target))
  }

  /// A switch that failed or timed out: its file sits out a while, and the
  /// app hears it (non-fatal: the current file plays on). `cause`: the new
  /// file's own failure, if it had one.
  private func dropSwap(_ swap: PendingSwap, reason: String, cause: PlayerError? = nil) {
    failedUntil[swap.rendition] = now + RecoveryPolicy.failedRenditionMs
    if abrLevel == swap.rendition { abrLevel = currentRendition }
    cancelSwap(reason)
    let target = renditions![swap.rendition].id(at: swap.rendition)
    var error = PlayerError.code(
      .qualitySwitchFailed,
      "The switch to quality \"\(target)\" \(cause != nil ? "failed" : "timed out"); the current one plays on.",
      recoverable: true)
    // The new file's own failure: its code, then its message.
    error.cause = cause.map { "\($0.code.rawValue): \($0.message)" } ?? reason
    error.platformDomain = cause?.platformDomain
    error.platformCode = cause?.platformCode
    pendingEvents.append { [weak self] in self?.delegate?.engine(warning: error) }
  }

  private func trackBandwidth(_ t: Int64, _ bps: Double) {
    trackFallbackBandwidth(t, bps)
    guard renditions != nil else { return }
    let level = abrLevel ?? currentRendition
    if let level, let bitrate = videoBitrateOf(level), bps < Double(bitrate) {
      if abrLowSince == nil { abrLowSince = t }
    } else {
      abrLowSince = nil
    }
    if let level, let next = nextAllowed(level), let nextBitrate = bitrateOf(next),
      bps > RecoveryPolicy.abrUpRatio * Double(nextBitrate)
    {
      if abrUpSince == nil { abrUpSince = t }
    } else {
      abrUpSince = nil
    }
  }

  /// A video rendition's bitrate (`nil` for the audio-only one).
  private func videoBitrateOf(_ index: Int) -> Int64? {
    renditions![index].audioOnly ? nil : bitrateOf(index)
  }

  /// The allowed rendition above `index`, if any.
  private func nextAllowed(_ index: Int) -> Int? {
    let order = allowedOrder()
    guard let position = order.firstIndex(of: index), position + 1 < order.count else { return nil }
    return order[position + 1]
  }

  private func trackFallbackBandwidth(_ t: Int64, _ bps: Double) {
    guard let f = options.video?.fallback, let lowest = lowestVideoBitrate() else { return }
    if bps < f.dropBelowRatio * Double(lowest) {
      if dropSince == nil { dropSince = t }
    } else {
      dropSince = nil
    }
    if bps > f.returnAboveRatio * Double(lowest) {
      if returnSince == nil { returnSince = t }
    } else {
      returnSince = nil
    }
  }

  private func lowestVideoBitrate() -> Int64? {
    if renditions != nil { return videoOrder().first.flatMap { bitrateOf($0) } }
    return variants.filter { !$0.audioOnly }.compactMap(\.bitrate).min()
  }

  private func hasAudioOption() -> Bool {
    if renditions != nil { return audioRendition() != nil }
    return variants.contains(where: \.audioOnly)
  }

  private func stallsWithin(_ t: Int64, _ windowMs: Int64) -> Int {
    stallTimes.filter { t - $0 < windowMs }.count
  }

  /// The bandwidth reading of this load, if it had one.
  private var currentBandwidth: Double? {
    // A live sound arrives at its own bitrate: its reading is no headroom.
    if options.video == nil && isLive { return nil }
    return bandwidthAt != nil ? bandwidth : nil
  }

  /// The engine picks among the renditions itself (none pinned, the picture on).
  private var automaticRenditions: Bool {
    renditions != nil && selectedQuality == nil && audioOnlyReason == nil
  }

  /// The engine's own ABR over the renditions (automatic quality only).
  private func evaluateAbr(_ t: Int64, stalled: Bool) {
    guard automaticRenditions else { return }
    let order = allowedOrder()
    // The engine's pick, whether or not its switch has landed yet.
    guard !order.isEmpty, let level = abrLevel ?? currentRendition else { return }
    let position = order.firstIndex(of: level) ?? 0
    let next: Int
    if stalled {
      next = stallStep(order, position, t)
    } else if options.video == nil && currentBandwidth == nil {
      next = quietStep(order, position, t)
    } else {
      next = bandwidthStep(order, position, t)
    }
    if next == position && order[position] == abrLevel { return }
    // Stalls undid a quiet step up: the next one waits longer.
    if stalled && next < position, let quietUp = quietUpAt {
      if t - quietUp < RecoveryPolicy.abrQuietUpMs { quietUndone += 1 }
      quietUpAt = nil
    }
    abrLevel = order[next]
    abrLowSince = nil
    abrUpSince = nil
    retarget(stalled ? "stall" : "bandwidth")
  }

  /// A stall steps down: to what the bandwidth fits, or one step without a reading.
  private func stallStep(_ order: [Int], _ position: Int, _ t: Int64) -> Int {
    guard position > 0 else { return 0 }
    let bw = currentBandwidth
    let repeated = stallsWithin(t, RecoveryPolicy.abrStallWindowMs) >= 2
    var slow = false
    if let bw, let bitrate = bitrateOf(order[position]) {
      slow = bw < RecoveryPolicy.abrStallRatio * Double(bitrate)
    }
    guard repeated || slow else { return position }
    guard let bw else { return position - 1 }
    guard let fit = fitting(Array(order[0..<position]), bw) else { return 0 }
    return order.firstIndex(of: fit) ?? 0
  }

  /// An audio player that measures nothing it can trust steps up one after
  /// a quiet while (no stall since the load and the last switch); each step
  /// up that stalls undid waits twice as long (at most 8 times).
  private func quietStep(_ order: [Int], _ position: Int, _ t: Int64) -> Int {
    let quiet = RecoveryPolicy.abrQuietUpMs << Int64(min(quietUndone, 3))
    guard position < order.count - 1 else { return position }
    let since = max(lastSwitchAt ?? Int64.min, quietSince)
    if t - since < quiet || stallsWithin(t, quiet) > 0 { return position }
    quietUpAt = t
    return position + 1
  }

  /// Sustained low bandwidth steps down; sustained headroom steps up.
  private func bandwidthStep(_ order: [Int], _ position: Int, _ t: Int64) -> Int {
    if position > 0, let low = abrLowSince, t - low >= RecoveryPolicy.abrLowMs { return position - 1 }
    if position < order.count - 1 && canStepUp(t) { return position + 1 }
    return position
  }

  private func canStepUp(_ t: Int64) -> Bool {
    guard let up = abrUpSince, t - up >= RecoveryPolicy.abrUpMs else { return false }
    if let last = lastSwitchAt, t - last < RecoveryPolicy.abrUpMs { return false }
    return stallsWithin(t, RecoveryPolicy.abrUpMs) == 0
  }

  /// The audio-only fallback (`fallbackToAudio`).
  private func evaluateFallback(_ t: Int64, stalled: Bool) {
    guard let f = options.video?.fallback, !listenOnly else { return }
    guard hasAudioOption() else {
      if fallbackActive { endFallback("no audio-only option") }
      return
    }
    if fallbackActive {
      checkFallbackReturn(t, f)
      return
    }
    if let cause = fallbackCause(t, stalled: stalled, f) { startFallback(t, cause) }
  }

  /// Why the picture should go now, or `nil`.
  private func fallbackCause(_ t: Int64, stalled: Bool, _ f: FallbackPolicy) -> String? {
    // The renditions step down first; audio is the step below the lowest.
    guard atLowestRendition else { return nil }
    if let drop = dropSince, t - drop >= f.dropAfterMs { return "slow network" }
    if stalled && stallsWithin(t, f.stallWindowMs) >= f.dropAfterStalls { return "stalls" }
    return nil
  }

  private var atLowestRendition: Bool {
    guard renditions != nil, selectedQuality == nil else { return true }
    let order = allowedOrder()
    return order.isEmpty || currentRendition == order[0]
  }

  private func startFallback(_ t: Int64, _ cause: String) {
    fallbackActive = true
    fallbackSince = t
    stallTimes = []
    dropSince = nil
    returnSince = nil
    applyOutput(cause)
  }

  private func checkFallbackReturn(_ t: Int64, _ f: FallbackPolicy) {
    let since = fallbackSince ?? t
    if let back = returnSince, t - back >= f.returnAfterMs {
      endFallback("network recovered")
      return
    }
    // No reading since the drop: try the picture again after a quiet minute.
    let measured = bandwidthAt.map { $0 >= since } ?? false
    if measured || t - since < RecoveryPolicy.fallbackProbeMs { return }
    if stallsWithin(t, RecoveryPolicy.fallbackProbeMs) == 0 { endFallback("probe") }
  }

  private func endFallback(_ cause: String) {
    fallbackActive = false
    fallbackSince = nil
    dropSince = nil
    returnSince = nil
    stallTimes = []
    applyOutput(cause)
  }
}
