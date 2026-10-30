import Foundation

@testable import AnythingPlayerCore

/// The fake wall clock reads this at monotonic 0.
let wallBase: Int64 = 1_700_000_000_000

/// Deterministic clock: time only moves when a test advances it.
final class FakeClock: EngineClock {
  var monotonicMs: Int64 = 0
  var wallMs: Int64 { wallBase + monotonicMs }
}

/// Records every driver call and simulates a playhead.
final class FakeDriver: EngineDriver {
  /// `loaded`: the whole file is buffered: the playhead advances, the buffer stays where it is.
  enum Motion { case flowing, frozen, trickle, loaded }

  let clock: FakeClock
  var commands: [String] = []
  /// Like ExoPlayer: report readiness/playing synchronously from inside commands.
  var reentrant = false
  weak var engine: PlaybackEngine?
  private var openGeneration = 0
  private var motion = Motion.frozen
  private var anchorTime: Int64 = 0
  private var anchorPosition: Double = 0
  private var anchorBuffered: Double = 0
  /// The item an `open(swap: true)` is preparing, and where it starts.
  private(set) var swapGeneration: Int?
  private var swapStart: Double = 0

  init(clock: FakeClock) { self.clock = clock }

  func setMotion(_ next: Motion, buffered: Double? = nil) {
    let current = sample()
    anchorPosition = current.position
    anchorBuffered = buffered ?? current.bufferedPosition
    anchorTime = clock.monotonicMs
    motion = next
    if next == .flowing { anchorBuffered = max(anchorBuffered, anchorPosition + 10) }
  }

  func setPosition(_ value: Double) {
    let current = sample()
    anchorBuffered = max(current.bufferedPosition, value)
    anchorPosition = value
    anchorTime = clock.monotonicMs
  }

  func sample() -> PlaybackSample {
    let elapsed = Double(clock.monotonicMs - anchorTime) / 1000
    switch motion {
    case .flowing:
      return PlaybackSample(
        position: anchorPosition + elapsed, bufferedPosition: anchorBuffered + elapsed)
    case .frozen:
      return PlaybackSample(position: anchorPosition, bufferedPosition: anchorBuffered)
    case .trickle:
      return PlaybackSample(
        position: anchorPosition, bufferedPosition: anchorBuffered + elapsed * 0.5)
    case .loaded:
      return PlaybackSample(position: anchorPosition + elapsed, bufferedPosition: anchorBuffered)
    }
  }

  func open(_ request: OpenRequest) {
    let start = request.startPosition.map { String(format: "%.1f", $0) } ?? "-"
    let rendition = request.rendition.map { ",r=\($0)" } ?? ""
    let swap = request.swap ? ",swap" : ""
    commands.append(
      "open(gen=\(request.generation),start=\(start),play=\(request.playWhenReady)\(rendition)\(swap))")
    if request.swap {
      // Prepared behind the current item: its playhead is not this one's.
      swapGeneration = request.generation
      swapStart = request.startPosition ?? 0
      return
    }
    swapGeneration = nil
    anchorPosition = request.startPosition ?? 0
    anchorBuffered = anchorPosition
    anchorTime = clock.monotonicMs
    motion = .frozen
    openGeneration = request.generation
    if reentrant && request.playWhenReady {
      engine?.onReady(generation: request.generation, info: ReadyInfo(duration: 30, isLive: false, seekable: true))
      setMotion(.flowing)
      engine?.onPlaying(generation: request.generation)
    }
  }
  func play() {
    commands.append("play")
    if reentrant {
      setMotion(.flowing)
      engine?.onPlaying(generation: openGeneration)
    }
  }
  func pause() { commands.append("pause") }
  func seek(to seconds: Double) { seek(to: seconds, exact: false) }
  func seek(to seconds: Double, exact: Bool) {
    commands.append("seek(\(String(format: "%.1f", seconds))\(exact ? ",exact" : ""))")
    setPosition(seconds)
  }
  func setVideoEnabled(_ enabled: Bool) { commands.append("video(\(enabled ? "on" : "off"))") }
  func setQuality(_ c: QualityConstraints) {
    let height = c.maxHeight.map { "\($0)" } ?? "-"
    let bitrate = c.maxBitrate.map { "\($0)" } ?? "-"
    commands.append(
      "quality(maxH=\(height),maxBps=\(bitrate),pin=\(c.pinned ?? "-"),audioOnly=\(c.audioOnly))")
  }
  func setLoop(_ loop: Bool) { commands.append("loop(\(loop))") }
  func selectTracks(audio: String?, text: String?) {
    commands.append("tracks(audio=\(audio ?? "-"),text=\(text ?? "-"))")
  }
  func cancelSwap(generation: Int) {
    commands.append("cancelSwap(gen=\(generation))")
    if swapGeneration == generation { swapGeneration = nil }
  }

  /// The swap's item shows its first frame: its playhead becomes the one.
  func completeSwap() {
    swapGeneration = nil
    anchorPosition = swapStart
    anchorBuffered = swapStart + 10
    anchorTime = clock.monotonicMs
    motion = .flowing
  }
  func releaseConnection() { commands.append("release") }
  func unload() { commands.append("unload") }
  func setVolume(_ effective: Double) { commands.append("volume(\(String(format: "%.2f", effective)))") }
  func setRate(_ rate: Double) { commands.append("rate(\(String(format: "%.2f", rate)))") }
  func switchOutput(_ outputId: String) {
    commands.append("switchOutput(\(outputId))")
    // The playhead stops where it is; the engine re-opens at a position.
    setMotion(.frozen)
  }
}

/// Collects everything the engine reports.
final class Recorder: EngineDelegate {
  var focus: FocusResult = .granted
  var statuses: [Status] = []
  var loads: [String] = []
  var errors: [String] = []
  var ended = 0
  /// Sleep timers that fired.
  var sleeps = 0
  /// `fadeTo` calls that settled.
  var fades = 0
  var diagnostics: [DiagnosticEntry] = []
  var wakeupAt: Int64?
  /// Source refreshes asked for, `loadId:reason`.
  var refreshes: [String] = []
  /// Ordering invariant breaches (an event delivered before its status).
  var violations: [String] = []

  func engineRequestsAudioFocus() -> FocusResult { focus }
  func engine(statusChanged status: Status) { statuses.append(status) }
  func engine(loadSettled loadId: Int, outcome: LoadOutcome) {
    switch outcome {
    case .ready: loads.append("\(loadId):ready")
    case .superseded: loads.append("\(loadId):superseded")
    case .failed(let error): loads.append("\(loadId):failed:\(error.code.rawValue)")
    }
  }
  func engine(error: PlayerError, fatal: Bool) {
    if fatal && statuses.last?.state != .error { violations.append("fatal error before error status") }
    if !fatal && statuses.last?.state != .reconnecting { violations.append("recoverable error before reconnecting status") }
    errors.append("\(error.code.rawValue):\(fatal ? "fatal" : "recoverable")")
  }
  func engineDidEnd() {
    if statuses.last?.state != .ended { violations.append("ended before ended status") }
    ended += 1
  }
  func engineSleepFired() {
    if let last = statuses.last {
      if last.sleepAt != nil { violations.append("sleep event before its status") }
      // The timer always leaves the player paused: a playing player is
      // paused, and a paused one stays paused, so `playWhenReady` is false.
      if last.playWhenReady { violations.append("sleep event while playWhenReady") }
    } else {
      violations.append("sleep event before its status")
    }
    sleeps += 1
  }
  func engine(diagnostic: DiagnosticEntry) { diagnostics.append(diagnostic) }
  func engine(wakeupAt: Int64?) { self.wakeupAt = wakeupAt }
  func engine(refreshRequested loadId: Int, reason: RefreshReason) {
    refreshes.append("\(loadId):\(reason.rawValue)")
  }
}

/// Engine + fakes wired together, with a clock that fires wake-ups in order.
final class EngineHarness {
  let clock = FakeClock()
  let driver: FakeDriver
  let recorder = Recorder()
  let engine: PlaybackEngine

  init(options: EngineOptions = EngineOptions()) {
    driver = FakeDriver(clock: clock)
    engine = PlaybackEngine(driver: driver, clock: clock, options: options, random: { 0.5 })
    engine.delegate = recorder
    driver.engine = engine
  }

  func advance(_ ms: Int64) {
    let target = clock.monotonicMs + ms
    var guardCount = 0
    while let wake = recorder.wakeupAt, wake <= target {
      guardCount += 1
      precondition(guardCount < 100_000, "wake-up loop")
      clock.monotonicMs = max(clock.monotonicMs, wake)
      engine.onWakeup()
    }
    clock.monotonicMs = target
  }
}
