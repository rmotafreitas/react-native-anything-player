import Foundation
import os

final class SystemClock: EngineClock {
  static let shared = SystemClock()
  /// CLOCK_MONOTONIC on Darwin keeps counting while the device sleeps.
  var monotonicMs: Int64 { Int64(clock_gettime_nsec_np(CLOCK_MONOTONIC) / 1_000_000) }
  var wallMs: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

typealias Resolve = (Any?) -> Void
typealias Reject = (String, String, NSError?) -> Void

/// Parsed `PlayerOptions` (src/types.ts).
struct PlayerOptions {
  var engine = EngineOptions()
  var mediaSession = true
  var remoteCommands: Set<String> = []
  var speech = false
  var mixWithOthers = false
  var titleFormat: StreamTitleFormat = .artistTitle
  var useStreamMetadata = true

  init(_ dict: NSDictionary) {
    if let recovery = dict["recovery"] as? NSDictionary {
      if let v = recovery["reconnect"] as? Bool { engine.reconnect = v }
      if recovery["giveUpAfterMs"] is NSNull {
        engine.giveUpAfterMs = nil
      } else if let v = recovery["giveUpAfterMs"] as? NSNumber {
        engine.giveUpAfterMs = v.int64Value
      }
      if let v = recovery["liveMaxDriftMs"] as? NSNumber { engine.liveMaxDriftMs = v.int64Value }
    }
    if let v = (dict["interruptions"] as? NSDictionary)?["autoResume"] as? Bool {
      engine.autoResumeAfterInterruption = v
    }
    if let session = dict["mediaSession"] as? NSDictionary {
      if let v = session["enabled"] as? Bool { mediaSession = v }
      if let v = session["commands"] as? [String] { remoteCommands = Set(v) }
    }
    if let audio = dict["audio"] as? NSDictionary {
      speech = (audio["contentType"] as? String) == "speech"
      mixWithOthers = audio["mixWithOthers"] as? Bool ?? false
    }
    if let metadata = dict["metadata"] as? NSDictionary {
      titleFormat = StreamTitleFormat(rawValue: metadata["streamTitleFormat"] as? String ?? "") ?? .artistTitle
      useStreamMetadata = metadata["useStreamMetadataForNowPlaying"] as? Bool ?? true
    }
  }
}

/// Lock-screen fields given by the app (source metadata or overrides).
struct NowPlayingFields: Equatable {
  var title: String?
  var artist: String?
  var album: String?
  var artwork: String?
  /// The song's length and position (seconds) — a progress bar for a live stream.
  var duration: Double?
  var elapsed: Double?

  init(_ dict: NSDictionary?) {
    title = dict?["title"] as? String
    artist = dict?["artist"] as? String
    album = dict?["album"] as? String
    artwork = dict?["artwork"] as? String ?? (dict?["artwork"] as? NSDictionary)?["uri"] as? String
    duration = (dict?["duration"] as? NSNumber)?.doubleValue
    elapsed = (dict?["elapsed"] as? NSNumber)?.doubleValue
  }
}

private let diagnosticsCapacity = 300
private let log = Logger(subsystem: "com.radioanimu.airwave", category: "player")

/// One player: the engine, its AVPlayer driver and everything that crosses to
/// JS. Engine and driver run on the main thread; the lock-protected snapshots
/// are what the synchronous JS getters read from the JS thread.
final class PlayerController: EngineDelegate, DriverObserver {
  let id: String
  let options: PlayerOptions
  let driver: AVPlayerDriver
  let engine: PlaybackEngine
  private unowned let runtime: AirwaveRuntime
  private let emitEvent: ([String: Any]) -> Void

  private let lock = NSLock()
  private var snapshotStatus = Status()
  private var snapshotSeq: Int64 = 0
  private var snapshotProgress = (ProgressReading(), Int64(0), Int64(0))
  private var snapshotMetadata: (StreamMetadata, Int64)?
  private var diagnostics: [DiagnosticEntry] = []
  private var diagnosticsOn = false

  private var eventSeq: Int64 = 0
  private var sourceFields = NowPlayingFields(nil)
  private var overrides = NowPlayingFields(nil)
  /// Song progress set by the app (`updateNowPlaying` with a duration).
  private var trackClock: TrackClock?
  private var pendingLoads: [Int: (Resolve, Reject)] = [:]
  private var wakeup: DispatchWorkItem?
  private var released = false

  init(id: String, options: PlayerOptions, runtime: AirwaveRuntime, emit: @escaping ([String: Any]) -> Void) {
    self.id = id
    self.options = options
    self.runtime = runtime
    self.emitEvent = emit
    driver = AVPlayerDriver(titleFormat: options.titleFormat)
    engine = PlaybackEngine(driver: driver, clock: SystemClock.shared, options: options.engine)
    driver.observer = self
    engine.delegate = self
  }

  // MARK: - Commands (main)

  func load(_ source: SourceDescriptor, fields: NowPlayingFields, autoplay: Bool?, start: Double?,
            resolve: @escaping Resolve, reject: @escaping Reject) throws {
    sourceFields = fields
    overrides = NowPlayingFields(nil)
    trackClock = nil
    lock.sync { snapshotMetadata = nil }
    try engine.load(source, autoplay: autoplay, startPosition: start)
    pendingLoads[engine.loadId] = (resolve, reject)
    runtime.nowPlayingChanged(self)
  }

  func updateNowPlaying(_ fields: NowPlayingFields) {
    overrides = fields
    trackClock = fields.duration.map {
      TrackClock(
        elapsed: fields.elapsed ?? 0, duration: $0, now: SystemClock.shared.monotonicMs,
        running: status.state == .playing)
    }
    runtime.nowPlayingChanged(self)
  }

  /// Decoded-audio windows as `audioSample` events, emitted straight from the
  /// render thread and outside the status sequence (a stream, not a state).
  func setAudioSampling(enabled: Bool, points: Int) {
    let emitWindow: ((AudioWindow) -> Void)? =
      enabled
      ? { [weak self] window in
        guard let self, !self.released else { return }
        self.emitEvent([
          "playerId": self.id, "type": "audioSample",
          "waveform": window.waveform.map { Double($0) },
          "level": window.level, "duration": window.duration,
          "outputLatency": window.outputLatency, "timestamp": Double(window.timestampMs),
        ])
      } : nil
    driver.tap.points = points
    driver.tap.onWindow = emitWindow
    driver.streamVisualizer.points = points
    driver.streamVisualizer.onWindow = emitWindow
    driver.setSampling(enabled)
  }

  func release() {
    guard !released else { return }
    released = true
    driver.tap.onWindow = nil
    driver.streamVisualizer.onWindow = nil
    wakeup?.cancel()
    engine.release()
    driver.destroy()
    pendingLoads.removeAll()
  }

  /// Media services were reset: rebuild the AVPlayer and re-open.
  func mediaServicesReset() {
    driver.rebuild()
    engine.platformReset()
  }

  // MARK: - Snapshots (any thread)

  var status: Status { lock.sync { snapshotStatus } }
  var diagnosticsEnabled: Bool {
    get { lock.sync { diagnosticsOn } }
    set { lock.sync { diagnosticsOn = newValue } }
  }

  func statusDictionary() -> [String: Any] {
    let (status, seq) = lock.sync { (snapshotStatus, snapshotSeq) }
    return Serialization.status(status, seq: seq)
  }

  func progressDictionary() -> [String: Any] {
    let (reading, monotonic, _) = lock.sync { snapshotProgress }
    let clock = SystemClock.shared
    return Serialization.progress(reading, takenAt: monotonic, now: clock.monotonicMs, wall: clock.wallMs)
  }

  func progressReading() -> ProgressReading {
    let (reading, monotonic, _) = lock.sync { snapshotProgress }
    var r = reading
    if r.isPlaying {
      r.position += Double(SystemClock.shared.monotonicMs - monotonic) / 1000 * r.rate
      if let d = r.duration { r.position = min(r.position, d) }
    }
    return r
  }

  func metadataDictionary() -> [String: Any] {
    guard let (meta, at) = lock.sync({ snapshotMetadata }) else { return ["metadata": NSNull()] }
    return ["metadata": Serialization.metadata(meta, timestamp: at)]
  }

  func diagnosticsArray() -> [[String: Any]] {
    lock.sync { diagnostics }.map(Serialization.diagnostic)
  }

  /// Lock-screen fields: app overrides > stream metadata > source metadata.
  func nowPlaying() -> NowPlayingInfo {
    let stream = options.useStreamMetadata ? lock.sync({ snapshotMetadata?.0 }) : nil
    let s = status
    let progress = progressReading()
    var info = NowPlayingInfo()
    info.title = overrides.title ?? stream?.title ?? sourceFields.title
    info.artist = overrides.artist ?? stream?.artist ?? sourceFields.artist
    info.album = overrides.album ?? stream?.album ?? sourceFields.album ?? stream?.station
    info.artwork = overrides.artwork ?? stream?.artworkUri ?? sourceFields.artwork
    info.isLive = s.isLive
    info.duration = s.duration
    info.position = progress.position
    info.rate = s.state == .playing ? s.rate : 0
    if let clock = trackClock {
      // The song, not the stream: a progress bar the OS advances at rate 1
      // (still not seekable — that follows the stream).
      info.isLive = false
      info.duration = clock.duration
      info.position = clock.elapsed(now: SystemClock.shared.monotonicMs)
      info.rate = s.state == .playing ? 1 : 0
    }
    return info
  }

  func emitRemoteCommand(_ command: String, position: Double?) {
    var payload: [String: Any] = ["command": command]
    if let position { payload["position"] = position }
    emit("remoteCommand", payload)
  }

  private func emit(_ type: String, _ payload: [String: Any]) {
    eventSeq += 1
    var event = payload
    event["playerId"] = id
    event["type"] = type
    event["seq"] = eventSeq
    emitEvent(event)
  }

  // MARK: - EngineDelegate (main)

  func engineRequestsAudioFocus() -> FocusResult { runtime.requestFocus(for: self) }

  func engine(statusChanged status: Status) {
    eventSeq += 1
    let seq = eventSeq
    lock.sync {
      snapshotStatus = status
      snapshotSeq = seq
    }
    var event = Serialization.status(status, seq: seq)
    event["playerId"] = id
    event["type"] = "status"
    emitEvent(event)
    // The song advances with the audio, not the wall clock.
    trackClock?.setRunning(status.state == .playing, now: SystemClock.shared.monotonicMs)
    runtime.statusChanged(self)
  }

  func engine(loadSettled loadId: Int, outcome: LoadOutcome) {
    guard let (resolve, reject) = pendingLoads.removeValue(forKey: loadId) else { return }
    DispatchQueue.main.async { [weak self] in
      switch outcome {
      case .ready, .superseded:
        resolve(self?.statusDictionary() ?? [:])
      case .failed(let error):
        reject(error.code.rawValue, error.message, Serialization.nsError(error))
      }
    }
  }

  func engine(error: PlayerError, fatal: Bool) {
    emit("error", ["error": Serialization.error(error), "fatal": fatal])
  }

  func engineDidEnd() {
    emit("ended", [:])
  }

  func engine(diagnostic: DiagnosticEntry) {
    let enabled = lock.sync { () -> Bool in
      diagnostics.append(diagnostic)
      if diagnostics.count > diagnosticsCapacity { diagnostics.removeFirst(diagnostics.count - diagnosticsCapacity) }
      return diagnosticsOn
    }
    if enabled {
      log.debug("[\(self.id, privacy: .public)] \(diagnostic.event, privacy: .public) \(diagnostic.details.description, privacy: .public)")
      emit("diagnostic", ["entry": Serialization.diagnostic(diagnostic)])
    }
  }

  func engine(wakeupAt: Int64?) {
    wakeup?.cancel()
    wakeup = nil
    if !released, let at = wakeupAt {
      let item = DispatchWorkItem { [weak self] in self?.engine.onWakeup() }
      wakeup = item
      let delay = max(0, Double(at - SystemClock.shared.monotonicMs) / 1000)
      DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    }
    // Every engine entry ends here: refresh the progress snapshot JS reads.
    let reading = driver.progress()
    let clock = SystemClock.shared
    lock.sync { snapshotProgress = (reading, clock.monotonicMs, clock.wallMs) }
    runtime.keepaliveCheck()
  }

  // MARK: - DriverObserver (main)

  func driverReady(generation: Int, info: ReadyInfo) { engine.onReady(generation: generation, info: info) }
  func driverPlaying(generation: Int) { engine.onPlaying(generation: generation) }
  func driverBuffering(generation: Int) { engine.onBuffering(generation: generation) }
  func driverEnded(generation: Int) { engine.onEnded(generation: generation) }
  func driverFailed(generation: Int, error: PlayerError) { engine.onFailed(generation: generation, error: error) }

  func driverMetadata(generation: Int, metadata: StreamMetadata) {
    guard engine.accepts(generation) else { return }
    let at = SystemClock.shared.wallMs
    lock.sync { snapshotMetadata = (metadata, at) }
    emit("metadata", ["metadata": Serialization.metadata(metadata, timestamp: at)])
    runtime.nowPlayingChanged(self)
  }

  func driverPositionChanged() {
    let reading = driver.progress()
    let clock = SystemClock.shared
    lock.sync { snapshotProgress = (reading, clock.monotonicMs, clock.wallMs) }
    runtime.nowPlayingChanged(self)
  }

  func driverNote(generation: Int, event: String, details: [String: String]) {
    guard engine.accepts(generation) else { return }
    engine(
      diagnostic: DiagnosticEntry(
        wallTime: SystemClock.shared.wallMs, generation: generation, state: engine.state, event: event,
        details: details))
  }

  var isOffline: Bool { runtime.networkState == .offline }
}

enum Serialization {
  static func optional(_ value: Any?) -> Any { value ?? NSNull() }

  static func status(_ s: Status, seq: Int64) -> [String: Any] {
    var dict: [String: Any] = [
      "seq": seq,
      "state": s.state.rawValue,
      "playWhenReady": s.playWhenReady,
      "loadId": s.loadId,
      "isLive": s.isLive,
      "duration": optional(s.duration),
      "seekable": s.seekable,
      "network": s.network.rawValue,
      "volume": s.volume,
      "muted": s.muted,
      "rate": s.rate,
    ]
    if let i = s.interruption {
      dict["interruption"] = ["reason": i.reason.rawValue, "resumable": i.resumable, "since": i.since]
    } else {
      dict["interruption"] = NSNull()
    }
    dict["error"] = s.error.map(error) ?? NSNull()
    if let r = s.reconnect {
      dict["reconnect"] = ["attempt": r.attempt, "nextAttemptAt": optional(r.nextAttemptAt), "reason": r.reason]
    } else {
      dict["reconnect"] = NSNull()
    }
    return dict
  }

  static func error(_ e: PlayerError) -> [String: Any] {
    var dict: [String: Any] = [
      "code": e.code.rawValue, "message": e.message, "recoverable": e.recoverable, "platform": "ios",
    ]
    if let v = e.httpStatus { dict["httpStatus"] = v }
    if let v = e.platformDomain { dict["platformDomain"] = v }
    if let v = e.platformCode { dict["platformCode"] = v }
    if let v = e.cause { dict["cause"] = v }
    return dict
  }

  static func nsError(_ e: PlayerError) -> NSError {
    NSError(domain: "Airwave", code: e.platformCode ?? 0, userInfo: error(e).merging([NSLocalizedDescriptionKey: e.message]) { a, _ in a })
  }

  static func metadata(_ m: StreamMetadata, timestamp: Int64) -> [String: Any] {
    [
      "title": optional(m.title), "artist": optional(m.artist), "album": optional(m.album),
      "station": optional(m.station), "genre": optional(m.genre),
      "artwork": m.artworkUri.map { ["uri": $0] } ?? NSNull(),
      "raw": m.raw, "timestamp": timestamp,
    ]
  }

  static func progress(_ r: ProgressReading, takenAt: Int64, now: Int64, wall: Int64) -> [String: Any] {
    var position = r.position
    if r.isPlaying { position += Double(max(0, now - takenAt)) / 1000 * r.rate }
    if let d = r.duration { position = min(position, d) }
    return [
      "position": position, "duration": optional(r.duration), "buffered": max(r.buffered, position),
      "bufferedAhead": max(0, r.buffered - position), "liveOffset": optional(r.liveOffset), "timestamp": wall,
    ]
  }

  static func diagnostic(_ d: DiagnosticEntry) -> [String: Any] {
    ["time": d.wallTime, "generation": d.generation, "state": d.state.rawValue, "event": d.event, "details": d.details]
  }
}
