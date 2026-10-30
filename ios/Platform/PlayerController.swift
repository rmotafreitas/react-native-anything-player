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
/// How a `load()` settles: the status after it, or why it failed.
typealias LoadCompletion = (Result<[String: Any], PlayerError>) -> Void

/// Parsed `PlayerOptions` (src/types.ts).
struct PlayerOptions {
  var engine = EngineOptions()
  var mediaSession = true
  var remoteCommands: Set<String> = []
  var speech = false
  var mixWithOthers = false
  var titleFormat: StreamTitleFormat = .artistTitle
  var useStreamMetadata = true
  /// `progress` events while playing, this often (ms); 0 = off.
  var progressIntervalMs: Int64 = 0

  init(_ dict: NSDictionary) {
    if let v = (dict["progressInterval"] as? NSNumber)?.doubleValue, v.isFinite, v > 0 {
      progressIntervalMs = Int64(v)
    }
    if let recovery = dict["recovery"] as? NSDictionary {
      if let v = recovery["reconnect"] as? Bool { engine.reconnect = v }
      if recovery["giveUpAfterMs"] is NSNull {
        engine.giveUpAfterMs = nil
      } else if let v = recovery["giveUpAfterMs"] as? NSNumber {
        engine.giveUpAfterMs = v.int64Value
      }
      if let v = recovery["liveMaxDriftMs"] as? NSNumber { engine.liveMaxDriftMs = v.int64Value }
    }
    let fade = Self.fadeMs(dict["fade"] as? NSDictionary)
    engine.fadeInMs = fade.inMs
    engine.fadeOutMs = fade.outMs
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
    // Without the video module there is no video player: JS sees
    // `status.video == null` and throws VIDEO_UNAVAILABLE.
    if VideoSupport.available { engine.video = Self.video(dict["video"]) }
  }

  /// `PlayerOptions.video`: `true` takes every default; absent or `false`, an audio player.
  static func video(_ value: Any?) -> VideoEngineOptions? {
    if let on = value as? Bool { return on ? VideoEngineOptions() : nil }
    guard let map = value as? NSDictionary else { return nil }
    var v = VideoEngineOptions()
    v.whenBackgrounded = BackgroundMode(rawValue: map["whenBackgrounded"] as? String ?? "") ?? .pause
    v.ambient = map["ambient"] as? Bool ?? false
    v.keepAwake = map["keepAwake"] as? Bool ?? true
    v.focusWhenMuted = map["focusWhenMuted"] as? Bool ?? false
    if let on = map["fallbackToAudio"] as? Bool {
      v.fallback = on ? FallbackPolicy() : nil
    } else if let f = map["fallbackToAudio"] as? NSDictionary {
      var policy = FallbackPolicy()
      if let x = (f["dropBelowRatio"] as? NSNumber)?.doubleValue { policy.dropBelowRatio = x }
      if let x = (f["dropAfterMs"] as? NSNumber)?.int64Value { policy.dropAfterMs = x }
      if let x = (f["dropAfterStalls"] as? NSNumber)?.intValue { policy.dropAfterStalls = x }
      if let x = (f["stallWindowMs"] as? NSNumber)?.int64Value { policy.stallWindowMs = x }
      if let x = (f["returnAboveRatio"] as? NSNumber)?.doubleValue { policy.returnAboveRatio = x }
      if let x = (f["returnAfterMs"] as? NSNumber)?.int64Value { policy.returnAfterMs = x }
      v.fallback = policy
    }
    if let q = map["quality"] as? NSDictionary {
      v.quality.maxHeight = (q["maxResolution"] as? NSNumber)?.intValue
      v.quality.maxBitrate = (q["maxBitrate"] as? NSNumber)?.int64Value
      let cellular = q["cellular"] as? NSDictionary
      v.quality.cellularMaxHeight = (cellular?["maxResolution"] as? NSNumber)?.intValue
      v.quality.cellularMaxBitrate = (cellular?["maxBitrate"] as? NSNumber)?.int64Value
      switch q["startQuality"] {
      case let name as String where name == "lowest": v.quality.startQuality = .lowest
      case let name as String where name == "highest": v.quality.startQuality = .highest
      case let height as NSNumber: v.quality.startQuality = .height(height.intValue)
      default: v.quality.startQuality = .auto
      }
      v.quality.followDataSaver = q["followDataSaver"] as? Bool ?? true
      v.quality.capToView = q["capToView"] as? Bool ?? true
    }
    if let t = map["tracks"] as? NSDictionary {
      v.tracks.languages = t["languages"] as? [String] ?? []
      v.tracks.followSystem = t["followSystem"] as? Bool ?? true
    }
    return v
  }
}

extension PlayerOptions {
  /// `{ in?, out? }` in seconds (`PlayerOptions.fade`, `setFade`) → ms; absent or ≤ 0 = no fade.
  static func fadeMs(_ fade: NSDictionary?) -> (inMs: Int64, outMs: Int64) {
    func ms(_ key: String) -> Int64 {
      guard let seconds = (fade?[key] as? NSNumber)?.doubleValue, seconds.isFinite, seconds > 0 else {
        return 0
      }
      return Int64((seconds * 1000).rounded())
    }
    return (ms("in"), ms("out"))
  }
}

extension SourceDescriptor {
  /// A serialized `Source` (src/core/Player.ts `normalizeSource`) and its lock-screen fields.
  static func parse(_ source: NSDictionary) -> (SourceDescriptor, NowPlayingFields) {
    let headers = strings(source["headers"])
    let renditions = (source["renditions"] as? [NSDictionary]).flatMap { list -> [Rendition]? in
      guard !list.isEmpty else { return nil }
      return list.map { r in
        var rh: [String: String]?
        if let h = r["headers"] as? NSDictionary {
          var parsed: [String: String] = [:]
          h.forEach { key, value in
            if let k = key as? String, let v = value as? String { parsed[k] = v }
          }
          rh = parsed
        }
        return Rendition(
          uri: r["uri"] as? String ?? "", headers: rh, height: (r["height"] as? NSNumber)?.intValue,
          bitrate: (r["bitrate"] as? NSNumber)?.int64Value, label: r["label"] as? String,
          audioOnly: r["audioOnly"] as? Bool ?? false, id: r["id"] as? String)
      }
    }
    let descriptor = SourceDescriptor(
      uri: source["uri"] as? String ?? "", headers: headers, liveHint: source["live"] as? Bool,
      renditions: renditions, refreshable: source["refreshable"] as? Bool ?? false,
      expiresAt: (source["expiresAt"] as? NSNumber)?.int64Value,
      drm: (source["drm"] as? NSDictionary).map(parseDrm))
    return (descriptor, NowPlayingFields(source["metadata"] as? NSDictionary))
  }

  private static func strings(_ value: Any?) -> [String: String] {
    var out: [String: String] = [:]
    (value as? NSDictionary)?.forEach { key, value in
      if let k = key as? String, let v = value as? String { out[k] = v }
    }
    return out
  }

  private static func parseDrm(_ drm: NSDictionary) -> DrmDescriptor {
    let fairplay = (drm["fairplay"] as? NSDictionary).flatMap { f -> FairPlayServer? in
      guard let license = f["licenseUrl"] as? String, let certificate = f["certificateUrl"] as? String else {
        return nil
      }
      return FairPlayServer(
        licenseUrl: license, certificateUrl: certificate, headers: strings(f["headers"]),
        contentId: f["contentId"] as? String)
    }
    return DrmDescriptor(
      fairplay: fairplay, others: ["widevine", "playready", "clearkey"].filter { drm[$0] is NSDictionary },
      hook: drm["hook"] as? Bool ?? false)
  }

  /// Whether a Cast receiver can fetch it itself (it gets no DRM keys).
  var isCastable: Bool { isNetwork && drm == nil }

  /// A progressive HTTP(S) stream that may interleave ICY metadata (not HLS).
  var mayCarryIcy: Bool {
    isNetwork && URL(string: uri)?.pathExtension.lowercased() != "m3u8"
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
  /// The "live" badge; nil follows the stream.
  var live: Bool?

  init(_ dict: NSDictionary?) {
    title = dict?["title"] as? String
    artist = dict?["artist"] as? String
    album = dict?["album"] as? String
    artwork = dict?["artwork"] as? String ?? (dict?["artwork"] as? NSDictionary)?["uri"] as? String
    duration = (dict?["duration"] as? NSNumber)?.doubleValue
    elapsed = (dict?["elapsed"] as? NSNumber)?.doubleValue
    live = (dict?["live"] as? NSNumber)?.boolValue
  }
}

private let diagnosticsCapacity = 300
private let log = Logger(subsystem: "com.anythingplayer", category: "player")

/// One player: the engine, its drivers and everything that crosses to JS.
/// Engine and drivers run on the main thread; the lock-protected snapshots
/// are what the synchronous JS getters read from the JS thread.
///
/// The engine drives a `RoutingDriver`: the local AVPlayer, or a Cast
/// receiver after a handoff. Events go to the runtime's event sink, so a
/// player outlives the JS that created it (see `detachable`).
final class PlayerController: EngineDelegate, DriverObserver {
  let id: String
  let options: PlayerOptions
  /// The app chose the id: the player survives a JS reload and JS re-attaches
  /// to it (`createPlayer` with the same id). Otherwise a reload releases it.
  let detachable: Bool
  /// A video player's picture side (`nil`: an audio player).
  private(set) var picture: VideoPicture?
  /// An audio player's AVPlayer driver.
  /// An audio player's AVPlayers: the one heard, and one that prepares a quality switch (renditions).
  private let audioOutput: SwapDriver?
  /// The AVPlayer the sound (and the picture) plays from now (visualizer
  /// taps, media-services rebuilds).
  var driver: AVPlayerDriver { picture?.primary ?? audioOutput!.current }
  let routing: RoutingDriver
  let engine: PlaybackEngine
  private unowned let runtime: AnythingPlayerRuntime

  private let lock = NSLock()
  private var snapshotStatus = Status()
  private var snapshotSeq: Int64 = 0
  private var snapshotProgress = (ProgressReading(), Int64(0), Int64(0))
  /// The engine's counters as of its last entry (read from the JS thread).
  private var snapshotStats = EngineStats()
  private var snapshotMetadata: (StreamMetadata, Int64)?
  private var diagnostics: [DiagnosticEntry] = []
  private var diagnosticsOn = false

  private var eventSeq: Int64 = 0
  private var sourceFields = NowPlayingFields(nil)
  private var overrides = NowPlayingFields(nil)
  /// Song progress set by the app (`updateNowPlaying` with a duration).
  private var trackClock: TrackClock?
  private var pendingLoads: [Int: LoadCompletion] = [:]
  private var wakeup: DispatchWorkItem?
  /// `progress` events while playing (`progressInterval`): a native timer, so
  /// JS hears about the audio's progress even while its own timers are frozen.
  private var progressTimer: DispatchSourceTimer?
  /// Titles of a live stream playing on a Cast receiver (see `updateIcyReader`).
  private var icyReader: IcyMetadataReader?
  private var icyReaderLoadId = -1
  /// The load whose source a Cast receiver cannot reach (reported once).
  private var uncastableLoadId = -1
  private var released = false
  /// Whether `audioSample` windows may still be emitted (guarded by `lock`):
  /// read on the tap's and the visualizer's queues, cleared by `release`.
  private var samplesWanted = false

  init(id: String, options: PlayerOptions, detachable: Bool, runtime: AnythingPlayerRuntime) {
    self.id = id
    self.options = options
    self.detachable = detachable
    self.runtime = runtime
    // The picture side first (the routing driver plays through it), told
    // about this controller once it exists.
    let video = options.engine.video != nil ? VideoSupport.create(titleFormat: options.titleFormat) : nil
    let titleFormat = options.titleFormat
    audioOutput = video == nil ? SwapDriver { AVPlayerDriver(titleFormat: titleFormat) } : nil
    routing = RoutingDriver(local: video?.output ?? audioOutput!)
    engine = PlaybackEngine(driver: routing, clock: SystemClock.shared, options: options.engine)
    picture = video
    audioOutput?.observer = self
    routing.observer = self
    routing.describe = { [weak self] in self?.nowPlaying() ?? NowPlayingInfo() }
    routing.media = { [weak self] in self?.castMedia() ?? CastMedia() }
    engine.delegate = self
    picture?.attach(to: self)
    // JS reads the status right after creating the player, before the engine
    // published one: a video player's starts with its `video` part.
    snapshotStatus = engine.status
  }

  /// Whether the audio plays on another device (Cast). Main thread.
  var isRemote: Bool { routing.isRemote }

  // MARK: - Commands (main)

  /// `completion` runs once the load settles (ready, superseded or failed).
  func load(_ source: SourceDescriptor, fields: NowPlayingFields, autoplay: Bool?, start: Double?,
            parts: VideoLoadParts = VideoLoadParts(), qualityGiven: Bool = false, quality: String? = nil,
            completion: @escaping LoadCompletion) throws {
    sourceFields = fields
    overrides = NowPlayingFields(nil)
    trackClock = nil
    lock.sync {
      snapshotMetadata = nil
      lastBandwidth = nil
      droppedFrames = nil
    }
    picture?.load(parts)
    try engine.load(source, autoplay: autoplay, startPosition: start, qualityGiven: qualityGiven, quality: quality)
    // The app's subtitle files are tracks from the start (their cues follow).
    if picture != nil && !parts.subtitles.isEmpty { engine.setAppTracks(parts.subtitles) }
    pendingLoads[engine.loadId] = completion
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

  /// Decoded-audio windows as `audioSample` events, emitted from the tap's
  /// (or the stream visualizer's) own queue, never the render thread, and
  /// outside the status sequence (a stream, not a state).
  func setAudioSampling(enabled: Bool, points: Int) {
    lock.sync { samplesWanted = enabled && !released }
    let emitWindow: ((AudioWindow) -> Void)? =
      enabled
      ? { [weak self] window in
        guard let self, self.lock.sync({ self.samplesWanted }) else { return }
        self.runtime.emit([
          "playerId": self.id, "type": "audioSample",
          "waveform": window.waveform.map { Double($0) },
          "level": window.level, "duration": window.duration,
          "outputLatency": window.outputLatency, "timestamp": Double(window.timestampMs),
        ])
      } : nil
    for d in drivers {
      d.tap.points = points
      d.tap.onWindow = emitWindow
      d.streamVisualizer.points = points
      d.streamVisualizer.onWindow = emitWindow
      // Only the one heard: a switch's muted windows would mix in (SwapDriver
      // turns it on once it takes over).
      d.setSampling(enabled && d === driver)
    }
  }

  /// Every AVPlayer driver: the audio player's one, or a video player's two.
  private var drivers: [AVPlayerDriver] { picture?.drivers ?? audioOutput!.drivers }

  func release() {
    guard !released else { return }
    released = true
    lock.sync { samplesWanted = false }
    for d in drivers {
      d.tap.onWindow = nil
      d.streamVisualizer.onWindow = nil
    }
    wakeup?.cancel()
    progressTimer?.cancel()
    progressTimer = nil
    icyReader?.stop()
    icyReader = nil
    engine.release()
    routing.destroy()
    picture?.destroy()
    pendingLoads.removeAll()
  }

  /// The app returned to the foreground.
  func appForegrounded() {
    picture?.appForegrounded()
    engine.appForegrounded()
    icyReader?.reconnectNow()
  }

  /// The app went to the background (`whenBackgrounded`, video players).
  func appBackgrounded() {
    guard let picture else { return }
    picture.appBackgrounded()
    engine.appBackgrounded()
  }

  /// Media services were reset: rebuild the AVPlayers and re-open.
  func mediaServicesReset() {
    drivers.forEach { $0.rebuild() }
    engine.platformReset()
  }

  /// What a Cast receiver gets besides the source: a video player's subtitle files as WebVTT.
  func castMedia() -> CastMedia {
    guard let video = status.video else { return CastMedia() }
    return CastMedia(video: true, subtitles: picture?.castSubtitles(video) ?? [], textTrack: video.textTrack)
  }

  /// Emits a player event with a payload of its own (`cues`), ordered like every other.
  func emitEvent(_ type: String, _ payload: [String: Any]) {
    emit(type, payload)
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
    info.isLive = overrides.live ?? sourceFields.live ?? s.isLive
    info.duration = s.duration
    info.position = progress.position
    info.rate = s.state == .playing ? s.rate : 0
    if s.isLive && !info.isLive {
      // Badge turned off on a live stream (a radio between songs): plain
      // metadata, no stream position posing as elapsed time.
      info.position = 0
    }
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

  /// A voice or app search started `item` on this player.
  func emitSearchPlay(request: [String: Any], item: [String: Any]) {
    emit("searchPlay", ["request": request, "item": item])
  }

  /// The current source cannot reach a Cast receiver: it keeps playing here.
  /// A non-fatal error, once per load.
  func reportUncastable() {
    guard uncastableLoadId != engine.loadId else { return }
    uncastableLoadId = engine.loadId
    emit(
      "error",
      [
        "error": Serialization.error(
          .code(
            .castUnsupportedSource,
            engine.source?.drm != nil
              ? "A Cast receiver cannot decrypt the source (DRM); it keeps playing on the device."
              : "A Cast receiver cannot fetch this source (it is not an http(s) URL); it keeps playing on the device.",
            recoverable: false)),
        "fatal": false,
      ])
  }

  /// A diagnostics line from the platform layer.
  func note(_ event: String, _ details: [String: String] = [:]) {
    engine(
      diagnostic: DiagnosticEntry(
        wallTime: SystemClock.shared.wallMs, generation: engine.generation, state: engine.state, event: event,
        details: details))
  }

  private func emit(_ type: String, _ payload: [String: Any]) {
    eventSeq += 1
    var event = payload
    event["playerId"] = id
    event["type"] = type
    event["seq"] = eventSeq
    runtime.emit(event)
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
    runtime.emit(event)
    // The song advances with the audio, not the wall clock.
    trackClock?.setRunning(status.state == .playing, now: SystemClock.shared.monotonicMs)
    updateProgressTicks(status.state)
    updateIcyReader(status)
    picture?.statusChanged(status)
    runtime.statusChanged(self)
  }

  /// While a Cast receiver plays a live HTTP stream, the phone reads the
  /// stream's ICY titles on a connection of its own (the audio is
  /// discarded), so `metadata` and the lock screen keep updating.
  private func updateIcyReader(_ status: Status) {
    let source = engine.source
    let wanted =
      !released && routing.isRemote && (source?.mayCarryIcy ?? false)
      && (status.isLive || source?.liveHint == true)
      && [.loading, .buffering, .playing, .reconnecting].contains(status.state)
    if wanted && icyReader != nil && icyReaderLoadId == status.loadId { return }
    icyReader?.stop()
    icyReader = nil
    guard wanted, let source, let url = URL(string: source.uri) else { return }
    icyReaderLoadId = status.loadId
    let reader = IcyMetadataReader(url: url, headers: source.headers, format: options.titleFormat) {
      [weak self] metadata in
      guard let self, !self.released else { return }
      // Titles go out at once, through the normal metadata path.
      self.driverMetadata(generation: self.engine.generation, metadata: metadata)
    }
    icyReader = reader
    reader.start()
  }

  private func updateProgressTicks(_ state: PlaybackState) {
    let wanted = options.progressIntervalMs > 0 && state == .playing && !released
    guard wanted != (progressTimer != nil) else { return }
    progressTimer?.cancel()
    progressTimer = nil
    guard wanted else { return }
    let timer = DispatchSource.makeTimerSource(queue: .main)
    let interval = DispatchTimeInterval.milliseconds(Int(options.progressIntervalMs))
    timer.schedule(deadline: .now(), repeating: interval, leeway: .milliseconds(50))
    timer.setEventHandler { [weak self] in
      guard let self, !self.released else { return }
      self.driver.reportHeardSplices()
      let reading = self.routing.progress()
      let clock = SystemClock.shared
      self.lock.sync { self.snapshotProgress = (reading, clock.monotonicMs, clock.wallMs) }
      self.emit("progress", self.progressDictionary())
    }
    progressTimer = timer
    timer.resume()
  }

  func engine(loadSettled loadId: Int, outcome: LoadOutcome) {
    guard let completion = pendingLoads.removeValue(forKey: loadId) else { return }
    DispatchQueue.main.async { [weak self] in
      switch outcome {
      case .ready, .superseded:
        completion(.success(self?.statusDictionary() ?? [:]))
      case .failed(let error):
        completion(.failure(error))
      }
    }
  }

  func engine(error: PlayerError, fatal: Bool) {
    emit("error", ["error": Serialization.error(error), "fatal": fatal])
  }

  func engine(warning: PlayerError) {
    engine(error: warning, fatal: false)
  }

  func engineDidEnd() {
    emit("ended", [:])
  }

  func engineSleepFired() {
    emit("sleep", ["reason": "fired", "timestamp": SystemClock.shared.wallMs])
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

  func engine(refreshRequested loadId: Int, reason: RefreshReason) {
    emit("refreshRequest", ["loadId": loadId, "reason": reason.rawValue])
  }

  /// `getStats()`: the engine's counters (any thread).
  func statsDictionary() -> [String: Any] {
    let s = lock.sync { snapshotStats }
    return [
      "startupMs": Serialization.optional(s.startupMs),
      "rebufferCount": s.rebufferCount,
      "rebufferMs": s.rebufferMs,
      "qualitySwitches": s.qualitySwitches,
      "audioOnlySwitches": s.audioOnlySwitches,
      "droppedFrames": Serialization.optional(lock.sync { droppedFrames }),
      "bandwidth": Serialization.optional(lock.sync { lastBandwidth }),
    ]
  }

  /// The access log's last bandwidth and dropped frames (guarded by `lock`).
  private var lastBandwidth: Double?
  private var droppedFrames: Int?

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
    let reading = routing.progress()
    let clock = SystemClock.shared
    let stats = engine.stats
    lock.sync {
      snapshotProgress = (reading, clock.monotonicMs, clock.wallMs)
      snapshotStats = stats
    }
    runtime.keepaliveCheck()
  }

  // MARK: - DriverObserver (main)

  func driverReady(generation: Int, info: ReadyInfo) {
    if engine.accepts(generation) { routing.noteReady(uri: engine.source?.uri, live: info.isLive) }
    engine.onReady(generation: generation, info: info)
  }
  func driverPlaying(generation: Int) { engine.onPlaying(generation: generation) }
  func driverBuffering(generation: Int) { engine.onBuffering(generation: generation) }
  func driverEnded(generation: Int) { engine.onEnded(generation: generation) }
  func driverFailed(generation: Int, error: PlayerError) { engine.onFailed(generation: generation, error: error) }
  func driverPausedExternally(generation: Int) { engine.onPausedExternally(generation: generation, reason: .system) }

  func driverMetadata(generation: Int, metadata: StreamMetadata) {
    guard engine.accepts(generation) else { return }
    let at = SystemClock.shared.wallMs
    lock.sync { snapshotMetadata = (metadata, at) }
    emit("metadata", ["metadata": Serialization.metadata(metadata, timestamp: at)])
    runtime.nowPlayingChanged(self)
  }

  func driverPositionChanged() {
    let reading = routing.progress()
    let clock = SystemClock.shared
    lock.sync { snapshotProgress = (reading, clock.monotonicMs, clock.wallMs) }
    picture?.positionJumped()
    runtime.nowPlayingChanged(self)
  }

  func driverVideoInfo(generation: Int, info: VideoInfo) { engine.onVideoInfo(generation: generation, info: info) }

  /// The picture's first frame is on screen (the video module's layer says so).
  func driverFirstFrame(generation: Int) { engine.onFirstFrame(generation: generation) }

  func driverTracks(generation: Int, tracks: [MediaTrack], variants: [VideoVariant]) {
    engine.onTracks(generation: generation, tracks: tracks)
    engine.onVariants(generation: generation, variants: variants)
  }

  func driverSourceCues(generation: Int, cues: [OverlayCue]) {
    if engine.accepts(generation) { picture?.sourceCues(cues) }
  }

  func driverLicenseRequest(generation: Int, request: LicenseAsk) {
    guard engine.accepts(generation) else {
      return LicenseRequests.shared.cancel(request.requestId, "The source was replaced.")
    }
    emit(
      "licenseRequest",
      [
        "requestId": request.requestId, "keySystem": request.keySystem,
        "challenge": request.challenge.base64EncodedString(),
        "contentId": Serialization.optional(request.contentId),
        "licenseUrl": Serialization.optional(request.licenseUrl),
        "headers": request.headers,
      ])
  }

  func driverAccessLog(generation: Int, bitsPerSecond: Double?, droppedFrames: Int?) {
    lock.sync {
      if let bitsPerSecond { lastBandwidth = bitsPerSecond }
      if let droppedFrames { self.droppedFrames = droppedFrames }
    }
    if let bitsPerSecond { engine.onBandwidth(generation: generation, bitsPerSecond: bitsPerSecond) }
  }

  func driverNote(generation: Int, event: String, details: [String: String]) {
    guard engine.accepts(generation) else { return }
    note(event, details)
  }

  func driverDiscontinuity(generation: Int, position: Double) {
    guard engine.accepts(generation) else { return }
    emit("discontinuity", ["position": position, "timestamp": SystemClock.shared.wallMs])
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
      "route": ["kind": s.route.kind.rawValue, "name": optional(s.route.name)],
      "sleepAt": optional(s.sleepAt),
      "qualities": s.qualities.map { q in
        [
          "id": q.id, "height": optional(q.height), "bitrate": optional(q.bitrate), "audioOnly": q.audioOnly,
          "label": optional(q.label),
        ] as [String: Any]
      },
      "quality": optional(s.quality), "selectedQuality": optional(s.selectedQuality),
      "video": s.video.map(video) ?? NSNull(),
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

  static func video(_ v: VideoStatus) -> [String: Any] {
    [
      "width": optional(v.width), "height": optional(v.height), "hdr": v.hdr, "firstFrame": v.firstFrame,
      "audioOnly": optional(v.audioOnly?.rawValue), "pictureInPicture": v.pictureInPicture,
      "tracks": v.tracks.map { t in
        [
          "id": t.id, "kind": t.kind.rawValue, "language": optional(t.language), "label": optional(t.label),
          "forced": t.forced, "default": t.isDefault, "sdh": t.sdh, "describesVideo": t.describesVideo,
        ] as [String: Any]
      },
      "audioTrack": optional(v.audioTrack), "textTrack": optional(v.textTrack), "subtitleDelay": v.subtitleDelay,
      "fullscreen": v.fullscreen,
    ]
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
    NSError(domain: "AnythingPlayer", code: e.platformCode ?? 0, userInfo: error(e).merging([NSLocalizedDescriptionKey: e.message]) { a, _ in a })
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
