import Foundation

@testable import AirwaveCore

/// Deterministic clock: time only moves when a test advances it.
final class FakeClock: EngineClock {
  var monotonicMs: Int64 = 0
  var wallMs: Int64 { 1_700_000_000_000 + monotonicMs }
}

/// Records every driver call and simulates a playhead.
final class FakeDriver: EngineDriver {
  enum Motion { case flowing, frozen, trickle }

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

  init(clock: FakeClock) { self.clock = clock }

  func setMotion(_ next: Motion) {
    let current = sample()
    anchorPosition = current.position
    anchorBuffered = current.bufferedPosition
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
    }
  }

  func open(_ request: OpenRequest) {
    let start = request.startPosition.map { String(format: "%.1f", $0) } ?? "-"
    commands.append("open(gen=\(request.generation),start=\(start),play=\(request.playWhenReady))")
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
  func seek(to seconds: Double) {
    commands.append("seek(\(String(format: "%.1f", seconds)))")
    setPosition(seconds)
  }
  func releaseConnection() { commands.append("release") }
  func unload() { commands.append("unload") }
  func setVolume(_ effective: Double) { commands.append("volume(\(String(format: "%.2f", effective)))") }
  func setRate(_ rate: Double) { commands.append("rate(\(String(format: "%.2f", rate)))") }
}

/// Collects everything the engine reports.
final class Recorder: EngineDelegate {
  var focus: FocusResult = .granted
  var statuses: [Status] = []
  var loads: [String] = []
  var errors: [String] = []
  var ended = 0
  var diagnostics: [DiagnosticEntry] = []
  var wakeupAt: Int64?
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
  func engine(diagnostic: DiagnosticEntry) { diagnostics.append(diagnostic) }
  func engine(wakeupAt: Int64?) { self.wakeupAt = wakeupAt }
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
