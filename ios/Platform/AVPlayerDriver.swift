import AVFoundation
import Foundation

/// What a driver (the AVPlayer adapter, a Cast receiver) reports, always
/// tagged with its generation.
protocol DriverObserver: AnyObject {
  func driverReady(generation: Int, info: ReadyInfo)
  func driverPlaying(generation: Int)
  func driverBuffering(generation: Int)
  func driverEnded(generation: Int)
  func driverFailed(generation: Int, error: PlayerError)
  /// The output paused on its own (a Cast receiver paused by another sender).
  func driverPausedExternally(generation: Int)
  func driverMetadata(generation: Int, metadata: StreamMetadata)
  /// A position change the progress snapshot must pick up (seek completed).
  func driverPositionChanged()
  /// Something the driver handled on its own, for the diagnostics trace.
  func driverNote(generation: Int, event: String, details: [String: String])
  /// A live stream's audio jumped, now audible: the proxy spliced a fresh
  /// upstream in, whose connect burst replays recent audio. `position` is
  /// the media time (s) the new upstream's audio starts at.
  func driverDiscontinuity(generation: Int, position: Double)
  var isOffline: Bool { get }
}

/// Readings for the progress snapshot (not needed by the engine).
struct ProgressReading {
  var position: Double = 0
  var buffered: Double = 0
  var duration: Double?
  /// Seconds behind the live edge when the stream carries wall-clock dates.
  var liveOffset: Double?
  var isPlaying = false
  var rate: Double = 1
}

/// `EngineDriver` over one AVPlayer. Main thread only.
///
/// Production lessons encoded here:
/// - Every item gets fresh observers that capture the generation; callbacks
///   from a replaced item are dropped (the engine re-checks the generation).
/// - `playImmediately` before the item is ready is silently ignored by
///   AVPlayer. The play intent is latched and applied on `readyToPlay`.
/// - `automaticallyWaitsToMinimizeStalling` is off for live streams (start as
///   soon as there is audio); a stall then may NOT flip `timeControlStatus`,
///   which is why the engine also watches the playhead itself.
/// - `preferredForwardBufferDuration` stays at the system default: capping it
///   makes AVPlayer download progressive streams in bursts and keeps a deep
///   internal buffer that `loadedTimeRanges` does not show.
/// - `AVPlayerItemMetadataOutput` (not the deprecated `timedMetadata` KVO,
///   which misses repeated ICY updates) delivers metadata when it is *heard*.
/// - Progressive HTTP(S) sources are played through `StreamProxy`, so the
///   app owns every connection (see there for what that fixes).
final class AVPlayerDriver: NSObject, EngineDriver, AVPlayerItemMetadataOutputPushDelegate {
  private(set) var player = AVPlayer()
  /// Decoded-PCM tap for visualizers; attached to each item while sampling is on.
  let tap = AudioTap()
  /// Live streams: AVPlayer never runs a tap on them, so the proxied bytes are
  /// decoded in parallel and released against the item's clock.
  let streamVisualizer = StreamVisualizer()
  private var samplingEnabled = false
  /// Generation whose proxied bytes feed the visualizer (-1: none). Read on the proxy queue.
  private let feedLock = NSLock()
  private var feedGeneration = -1
  /// The most recent relayed audio of the current item, to start a visualizer
  /// mid-stream without waiting for the buffer to play out (guarded by `feedLock`).
  /// Relayed chunks with the stream time (s) each one starts at, from `packetClock`.
  private var recentAudio: [(start: Double, data: Data)] = []
  private var recentBytes = 0
  private var recentContentType: String?
  /// Parses (never decodes) the relayed audio: the stream time of every byte.
  private var packetClock: StreamDecoder?
  /// When relayed audio last arrived (monotonic ms; guarded by `feedLock`).
  private var packetClockFedAt: Int64 = 0
  private static let recentAudioLimit = 512 * 1024
  private var itemIsLive = false
  weak var observer: DriverObserver?
  private let titleFormat: StreamTitleFormat

  private var generation = 0
  private var item: AVPlayerItem?
  private var itemObservers: [NSKeyValueObservation] = []
  private var itemNotifications: [NSObjectProtocol] = []
  private var playerObservers: [NSKeyValueObservation] = []
  private var metadataOutput: AVPlayerItemMetadataOutput?
  private var playWanted = false
  private var pendingStart: Double?
  private var readyGeneration = -1
  private var playedGeneration = -1
  private var ended = false
  private var lastHTTPStatus: Int?
  private var rate: Float = 1
  private var volume: Float = 1
  private var liveHint = false
  /// The app said `live: false`: a file even without a content length or with
  /// an indefinite duration (never spliced, never reported live).
  private var finiteHint = false
  private var lastMetadata: StreamMetadata?
  private var pendingSeek: Double?
  /// The proxied URL of the current item (see StreamProxy), retired on teardown.
  private var proxied: URL?
  /// The upstream response had no length (or ICY): a live stream.
  private var unbounded = false
  /// The proxy found an HLS playlist and redirected AVPlayer to it: the
  /// proxy relays no audio for this item (no stream visualizer).
  private var redirected = false
  private var station: (name: String?, genre: String?) = (nil, nil)
  /// The real network error behind an item failure (offline vs DNS vs refused).
  private var upstreamError: Error?
  /// New audio played past a splice before it counts as heard (s).
  private static let spliceHeardAfter = 0.1
  /// Media times (s) where a spliced upstream's audio starts, not heard yet.
  private var pendingSplices: [Double] = []

  init(titleFormat: StreamTitleFormat) {
    self.titleFormat = titleFormat
    super.init()
    configurePlayer()
  }

  private func configurePlayer() {
    player.automaticallyWaitsToMinimizeStalling = true
    player.volume = volume
    playerObservers = [
      player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
        DispatchQueue.main.async { self?.timeControlChanged(player.timeControlStatus) }
      }
    ]
  }

  /// Media services were reset: every AVPlayer is dead. Build a new one.
  func rebuild() {
    tearDownItem()
    playerObservers.forEach { $0.invalidate() }
    playerObservers = []
    player = AVPlayer()
    configurePlayer()
  }

  // MARK: - EngineDriver

  func open(_ request: OpenRequest) {
    tearDownItem()
    generation = request.generation
    pendingSeek = nil
    readyGeneration = -1
    ended = false
    lastHTTPStatus = nil
    lastMetadata = nil
    liveHint = request.source.liveHint ?? false
    finiteHint = request.source.liveHint == false
    playWanted = request.playWhenReady
    pendingStart = request.startPosition.flatMap { $0 > 0 ? $0 : nil }

    guard let url = Self.resolveURL(request.source.uri) else {
      let gen = generation
      DispatchQueue.main.async { [weak self] in
        self?.observer?.driverFailed(
          generation: gen,
          error: PlayerError(
            code: .invalidSource, message: "The source URI is not valid: \(request.source.uri)",
            recoverable: false))
      }
      return
    }
    unbounded = false
    redirected = false
    station = (nil, nil)
    upstreamError = nil
    let asset: AVURLAsset
    if Self.proxies(url) {
      let gen = generation
      proxied = StreamProxy.shared.register(
        StreamProxy.Route(
          url: url, headers: request.source.headers,
          onResponse: { [weak self] status, headers in
            DispatchQueue.main.async { self?.upstreamResponse(status, headers, gen) }
          },
          onError: { [weak self] error in
            DispatchQueue.main.async { if self?.generation == gen { self?.upstreamError = error } }
          },
          onSplice: { [weak self] details in
            guard let self else { return }
            // Proxy queue, before any of the new upstream's audio is relayed:
            // everything parsed so far is the old one's, so this is where the
            // new audio starts on the item's timeline.
            let at: Double? = self.feedLock.sync { self.packetClock?.parsedSeconds }
            DispatchQueue.main.async { [weak self] in
              guard let self else { return }
              self.observer?.driverNote(generation: gen, event: "upstream spliced", details: details)
              if self.generation == gen, let at { self.pendingSplices.append(at) }
            }
          },
          onAudio: { [weak self] data, contentType in
            guard let self else { return }
            // Enqueued under the lock: a teardown (which stops the visualizer
            // under it too) can then never run before a feed it should drop.
            self.feedLock.sync {
              guard self.generation == gen else { return }
              if self.packetClock == nil {
                let clock = StreamDecoder(contentType: contentType)
                clock.countOnly = true
                self.packetClock = clock
              }
              // Every packet before this chunk is parsed: this is its start time.
              self.recentAudio.append((self.packetClock?.parsedSeconds ?? 0, data))
              self.recentBytes += data.count
              self.packetClock?.feed(data)
              self.packetClockFedAt = SystemClock.shared.monotonicMs
              while self.recentBytes > Self.recentAudioLimit, self.recentAudio.count > 1 {
                self.recentBytes -= self.recentAudio.removeFirst().data.count
              }
              self.recentContentType = contentType
              if self.feedGeneration == gen { self.streamVisualizer.feed(data, contentType: contentType) }
            }
          },
          live: request.source.liveHint,
          reconnect: request.allowReconnect,
          onRedirect: { [weak self] _ in
            DispatchQueue.main.async { self?.upstreamRedirected(gen) }
          }))
    }
    itemIsLive = false
    feedLock.sync {
      recentAudio = []
      recentBytes = 0
      recentContentType = nil
      packetClock = nil
    }
    if samplingEnabled { startStreamFeed() }
    // The headers go to AVFoundation even when proxied: it sends them itself
    // if the proxy redirects it to an HLS playlist (the proxy also sets them).
    var options: [String: Any] = [:]
    if !request.source.headers.isEmpty { options["AVURLAssetHTTPHeaderFieldsKey"] = request.source.headers }
    asset = AVURLAsset(url: proxied ?? url, options: options)
    let newItem = AVPlayerItem(asset: asset)
    let output = AVPlayerItemMetadataOutput(identifiers: nil)
    output.setDelegate(self, queue: .main)
    newItem.add(output)
    metadataOutput = output
    observe(newItem, generation: generation)
    item = newItem
    player.automaticallyWaitsToMinimizeStalling = !liveHint
    player.replaceCurrentItem(with: newItem)
    if playWanted { player.play() }
  }

  func play() {
    playWanted = true
    guard let item else { return }
    if item.status == .readyToPlay {
      player.playImmediately(atRate: rate)
    } else {
      // Applied on readyToPlay (see `itemStatusChanged`).
      player.play()
    }
  }

  func pause() {
    playWanted = false
    player.pause()
  }

  func seek(to seconds: Double) {
    // `seek` is asynchronous: until it lands, report the target (not the old
    // position) so progress readings never jump back.
    pendingSeek = seconds
    let time = CMTime(seconds: seconds, preferredTimescale: 1000)
    player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
      DispatchQueue.main.async {
        guard let self, self.pendingSeek == seconds else { return }
        self.pendingSeek = nil
        self.observer?.driverPositionChanged()
      }
    }
  }

  func releaseConnection() {
    playWanted = false
    player.pause()
    tearDownItem()
    player.replaceCurrentItem(with: nil)
  }

  func unload() {
    releaseConnection()
  }

  /// The local player is one output; a routing driver is what switches outputs.
  func switchOutput(_ outputId: String) {}

  func setVolume(_ effective: Double) {
    volume = Float(min(max(effective, 0), 1))
    player.volume = volume
  }

  func setRate(_ rate: Double) {
    self.rate = Float(rate)
    if player.timeControlStatus != .paused { player.rate = self.rate }
  }

  func sample() -> PlaybackSample {
    PlaybackSample(position: currentPosition, bufferedPosition: bufferedEnd)
  }

  func progress() -> ProgressReading {
    var reading = ProgressReading()
    reading.position = currentPosition
    reading.buffered = max(bufferedEnd, reading.position)
    if let item, item.duration.isNumeric, !item.duration.isIndefinite {
      let d = item.duration.seconds
      reading.duration = d.isFinite && d > 0 ? d : nil
    }
    if let date = item?.currentDate() {
      let offset = Date().timeIntervalSince(date)
      reading.liveOffset = offset.isFinite && offset >= 0 && offset < 3600 ? offset : nil
    } else if itemIsLive, let edge = liveEdge {
      // A live progressive stream (no program dates): how much audio the proxy
      // has handed AVPlayer past the playhead. `loadedTimeRanges` alone
      // under-reads it right after connecting: it covers what AVPlayer has
      // parsed, not the whole connect burst it already holds (measured on a
      // 64 kbps AAC+ station: 11.6 s reported, 17 s heard behind the edge).
      let offset = max(edge - reading.position, reading.buffered - reading.position)
      reading.liveOffset = offset.isFinite && offset >= 0 && offset < 3600 ? offset : nil
    }
    reading.isPlaying = player.timeControlStatus == .playing
    reading.rate = Double(rate)
    return reading
  }

  /// Turns the decoded-PCM tap on/off (the controller owns `tap.onWindow`).
  func setSampling(_ enabled: Bool) {
    guard enabled != samplingEnabled else { return }
    samplingEnabled = enabled
    guard enabled else {
      feedLock.sync {
        feedGeneration = -1
        streamVisualizer.stop()
      }
      return
    }
    if let item, item.status == .readyToPlay, relaysAudio {
      // Mid-stream: prime from the recently relayed audio, which ends where
      // the player's loaded range ends.
      let playhead = item.currentTime().seconds
      let gen = generation
      feedLock.sync {
        streamVisualizer.prime(
          recent: recentAudio.reduce(into: Data()) { $0.append($1.data) },
          recentStart: recentAudio.first?.start ?? 0, contentType: recentContentType,
          playhead: playhead.isFinite ? playhead : 0)
        feedGeneration = gen
      }
    } else {
      startStreamFeed()
    }
    if let item, item.status == .readyToPlay { attachSampling(item) }
  }

  /// The proxy relays this item's audio (what the stream visualizer decodes).
  private var relaysAudio: Bool { proxied != nil && !redirected }

  private func startStreamFeed() {
    guard relaysAudio else { return }
    streamVisualizer.reset()
    let gen = generation
    feedLock.sync { feedGeneration = gen }
  }

  /// Live: decoded proxy bytes against the item clock. Finite: the PCM tap.
  private func attachSampling(_ item: AVPlayerItem) {
    if itemIsLive && relaysAudio {
      streamVisualizer.start(timebase: item.timebase)
    } else {
      feedLock.sync { feedGeneration = -1 }
      tap.attach(to: item)
    }
  }

  func destroy() {
    feedLock.sync {
      feedGeneration = -1
      streamVisualizer.stop()
    }
    releaseConnection()
    playerObservers.forEach { $0.invalidate() }
    playerObservers = []
  }

  // MARK: - Readings

  private var currentPosition: Double {
    if let pendingSeek { return pendingSeek }
    let t = player.currentTime().seconds
    return t.isFinite && t >= 0 ? t : 0
  }

  /// Stream time of the newest relayed audio, while it is still arriving
  /// (a stalled or released connection says nothing about the live edge).
  private var liveEdge: Double? {
    feedLock.sync {
      guard let clock = packetClock, SystemClock.shared.monotonicMs - packetClockFedAt < 3_000 else { return nil }
      return clock.parsedSeconds
    }
  }

  private var bufferedEnd: Double {
    guard let item else { return 0 }
    var end = 0.0
    for range in item.loadedTimeRanges {
      let e = CMTimeRangeGetEnd(range.timeRangeValue).seconds
      if e.isFinite && e > end { end = e }
    }
    return end
  }

  // MARK: - Observation

  private func observe(_ item: AVPlayerItem, generation gen: Int) {
    itemObservers = [
      item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
        DispatchQueue.main.async { self?.itemStatusChanged(item, gen) }
      },
      // After an underrun AVPlayer stays paused (auto-wait is off for live).
      // Restart as soon as there is enough data again.
      item.observe(\.isPlaybackLikelyToKeepUp, options: [.new]) { [weak self] item, _ in
        DispatchQueue.main.async {
          guard let self, self.isCurrent(item, gen), item.isPlaybackLikelyToKeepUp, self.playWanted,
            !self.ended, self.readyGeneration == gen, self.player.timeControlStatus == .paused
          else { return }
          self.player.playImmediately(atRate: self.rate)
        }
      },
    ]
    let center = NotificationCenter.default
    itemNotifications = [
      center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) {
        [weak self] _ in
        guard let self, self.isCurrent(item, gen) else { return }
        self.ended = true
        self.observer?.driverEnded(generation: gen)
      },
      center.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main) {
        [weak self] note in
        guard let self, self.isCurrent(item, gen) else { return }
        let error = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
        self.fail(gen, error)
      },
      center.addObserver(forName: .AVPlayerItemPlaybackStalled, object: item, queue: .main) {
        [weak self] _ in
        guard let self, self.isCurrent(item, gen), self.readyGeneration == gen else { return }
        self.observer?.driverBuffering(generation: gen)
      },
      center.addObserver(forName: .AVPlayerItemNewErrorLogEntry, object: item, queue: .main) {
        [weak self] _ in
        guard let self, self.isCurrent(item, gen),
          let event = item.errorLog()?.events.last
        else { return }
        if event.errorStatusCode >= 400 && event.errorStatusCode < 600 {
          self.lastHTTPStatus = event.errorStatusCode
        }
      },
    ]
  }

  /// Reports the splices whose audio is playing (called on each progress tick).
  /// An outage longer than the buffer stalls the playhead right at a splice,
  /// before any of the new upstream's audio has arrived: it is not heard
  /// until playback runs past it.
  func reportHeardSplices() {
    guard !pendingSplices.isEmpty, player.timeControlStatus == .playing else { return }
    let position = currentPosition
    let heard = pendingSplices.filter { $0 + Self.spliceHeardAfter <= position }
    guard !heard.isEmpty else { return }
    pendingSplices.removeAll { $0 + Self.spliceHeardAfter <= position }
    for at in heard { observer?.driverDiscontinuity(generation: generation, position: at) }
  }

  private func tearDownItem() {
    pendingSplices = []
    // The stream visualizer (decoder, queued windows, its timer) belongs to
    // the item: the next item restarts it while sampling is on (`open`,
    // then `attachSampling` on readiness).
    feedLock.sync {
      feedGeneration = -1
      streamVisualizer.stop()
    }
    redirected = false
    // Closes every HTTP connection of the item, whatever AVFoundation does.
    if let proxied { StreamProxy.shared.retire(proxied) }
    proxied = nil
    // Abort the asset's loading now: otherwise AVFoundation can keep the
    // stream's HTTP connection open (and downloading) after the item is gone.
    item?.cancelPendingSeeks()
    item?.asset.cancelLoading()
    itemObservers.forEach { $0.invalidate() }
    itemObservers = []
    itemNotifications.forEach { NotificationCenter.default.removeObserver($0) }
    itemNotifications = []
    if let output = metadataOutput, let item {
      output.setDelegate(nil, queue: nil)
      item.remove(output)
    }
    metadataOutput = nil
    item = nil
  }

  private func isCurrent(_ candidate: AVPlayerItem, _ gen: Int) -> Bool {
    gen == generation && candidate === item && candidate === player.currentItem
  }

  private func itemStatusChanged(_ changed: AVPlayerItem, _ gen: Int) {
    guard isCurrent(changed, gen) else { return }
    switch changed.status {
    case .readyToPlay:
      guard readyGeneration != gen else { return }
      readyGeneration = gen
      let duration = changed.duration
      let indefinite = duration.isIndefinite || !duration.isNumeric
      let seconds = indefinite ? nil : duration.seconds
      // `live: false` wins, as in the engine (`liveHint ?? info.isLive`).
      let isLive = !finiteHint && (indefinite || liveHint || unbounded)
      if isLive { player.automaticallyWaitsToMinimizeStalling = false }
      let seekable = !isLive && !changed.seekableTimeRanges.isEmpty
      observer?.driverReady(
        generation: gen,
        info: ReadyInfo(duration: seconds.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }, isLive: isLive, seekable: seekable))
      // Static tags only for finite sources. On a live progressive URL the
      // asset-metadata load opens its own HTTP connection that never
      // completes (the stream never ends) and outlives the item — a phantom
      // listener on the station's server. Live metadata is timed anyway.
      if !isLive { loadAssetMetadata(changed.asset, gen) }
      itemIsLive = isLive
      if samplingEnabled { attachSampling(changed) }
      if let start = pendingStart, !isLive {
        pendingStart = nil
        player.seek(to: CMTime(seconds: start, preferredTimescale: 1000), toleranceBefore: .zero, toleranceAfter: .zero) {
          [weak self] _ in
          DispatchQueue.main.async {
            guard let self, self.generation == gen, self.playWanted else { return }
            self.player.playImmediately(atRate: self.rate)
          }
        }
      } else if playWanted && player.timeControlStatus != .playing {
        player.playImmediately(atRate: rate)
      } else if playWanted && player.timeControlStatus == .playing {
        // It was already "playing" (rate set before readiness): now it is real.
        playedGeneration = gen
        observer?.driverPlaying(generation: gen)
      }
    case .failed:
      fail(gen, changed.error)
    default:
      break
    }
  }

  private func fail(_ gen: Int, _ error: Error?) {
    // An upstream failure is the real cause: the status AVPlayer logged is
    // then the proxy's synthetic 502, not the station's.
    let mapped = ErrorMapping.map(
      upstreamError ?? error, httpStatus: upstreamError == nil ? lastHTTPStatus : nil,
      offline: observer?.isOffline ?? false, hadPlayed: playedGeneration == gen)
    observer?.driverFailed(generation: gen, error: mapped)
  }

  private func timeControlChanged(_ status: AVPlayer.TimeControlStatus) {
    guard let item, item === player.currentItem else { return }
    let gen = generation
    switch status {
    case .playing:
      // With auto-wait off, AVPlayer claims `.playing` as soon as the rate is
      // set — before the item is even ready. Only a ready item plays audio
      // (readiness re-reports playing, see `itemStatusChanged`).
      guard item.status == .readyToPlay, readyGeneration == gen else { return }
      playedGeneration = gen
      // The item's track list can still be empty at readiness: retry here.
      if samplingEnabled && !itemIsLive { tap.attach(to: item) }
      observer?.driverPlaying(generation: gen)
    case .waitingToPlayAtSpecifiedRate:
      if readyGeneration == gen && player.reasonForWaitingToPlay != .noItemToPlay {
        observer?.driverBuffering(generation: gen)
      }
    case .paused:
      // Paused without our say-so (we clear `playWanted` before pausing).
      // With `automaticallyWaitsToMinimizeStalling` off, AVPlayer drops to
      // `.paused` when its buffer runs dry — that is a STALL, not a system
      // pause. Interruptions and route losses are reported separately by the
      // session coordinator (which pauses the engine properly), so treating
      // an unexplained pause as a stall is safe; treating a stall as a pause
      // would silently end a radio. The engine's stall policy recovers it.
      guard playWanted, !ended, item.status == .readyToPlay, readyGeneration == gen else { return }
      observer?.driverBuffering(generation: gen)
    @unknown default:
      break
    }
  }

  // MARK: - Upstream (main)

  /// HTTP(S) except HLS (playlists and segments stay with AVFoundation).
  static func proxies(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
    return url.pathExtension.lowercased() != "m3u8"
  }

  private func upstreamResponse(_ status: Int, _ headers: [String: String], _ gen: Int) {
    guard gen == generation else { return }
    if status >= 400 {
      lastHTTPStatus = status
      return
    }
    if status == 200 && !finiteHint && (headers["content-length"] == nil || headers["icy-metaint"] != nil) {
      unbounded = true
      player.automaticallyWaitsToMinimizeStalling = false
    }
    let name = headers["icy-name"].flatMap { $0.isEmpty ? nil : $0 }
    let genre = headers["icy-genre"].flatMap { $0.isEmpty ? nil : $0 }
    guard name != nil || genre != nil, station.name != name || station.genre != genre else { return }
    station = (name, genre)
    var meta = lastMetadata ?? StreamMetadata()
    meta.station = name
    meta.genre = genre
    if let name { meta.raw["icy-name"] = name }
    if let genre { meta.raw["icy-genre"] = genre }
    publish(meta, gen)
  }

  /// The proxy found an HLS playlist behind the URL and redirected AVPlayer
  /// to it: AVFoundation plays it like any `.m3u8`, nothing is relayed.
  private func upstreamRedirected(_ gen: Int) {
    guard gen == generation, !redirected else { return }
    redirected = true
    feedLock.sync {
      feedGeneration = -1
      streamVisualizer.stop()
    }
    observer?.driverNote(generation: gen, event: "HLS redirect", details: [:])
  }

  // MARK: - Metadata

  func metadataOutput(
    _ output: AVPlayerItemMetadataOutput, didOutputTimedMetadataGroups groups: [AVTimedMetadataGroup],
    from track: AVPlayerItemTrack?
  ) {
    guard output === metadataOutput else { return }
    let items = groups.flatMap { $0.items }
    guard !items.isEmpty else { return }
    var meta = Self.metadata(from: items, format: titleFormat)
    if meta.station == nil { meta.station = station.name }
    if meta.genre == nil { meta.genre = station.genre }
    publish(meta, generation)
  }

  private func loadAssetMetadata(_ asset: AVAsset, _ gen: Int) {
    // Static tags of files (ID3 / iTunes). Live streams report theirs as timed metadata.
    Task { @MainActor [weak self] in
      guard let items = try? await asset.load(.commonMetadata), !items.isEmpty else { return }
      guard let self, self.generation == gen else { return }
      let meta = Self.metadata(from: items, format: self.titleFormat)
      if self.lastMetadata == nil { self.publish(meta, gen) }
    }
  }

  private func publish(_ metadata: StreamMetadata, _ gen: Int) {
    guard gen == generation, !metadata.isEmpty, metadata != lastMetadata else { return }
    lastMetadata = metadata
    observer?.driverMetadata(generation: gen, metadata: metadata)
  }

  /// ICY fields come as `icy/StreamTitle`, `icy/StreamUrl`; ID3/iTunes tags
  /// as common keys. AVFoundation may decode ICY bytes as Latin-1; the parser
  /// repairs mojibake.
  static func metadata(from items: [AVMetadataItem], format: StreamTitleFormat) -> StreamMetadata {
    var icy: [String: String] = [:]
    var common = StreamMetadata()
    for item in items {
      let identifier = item.identifier?.rawValue ?? ""
      let value: String? = item.stringValue ?? item.dataValue.map { IcyParser.decode(Array($0)) }
      if identifier.hasPrefix("icy/"), let value {
        icy[String(identifier.dropFirst(4))] = value
        continue
      }
      guard let value, let key = item.commonKey else { continue }
      common.raw[key.rawValue] = value
      switch key {
      case .commonKeyTitle: common.title = value
      case .commonKeyArtist: common.artist = value
      case .commonKeyAlbumName: common.album = value
      default: break
      }
    }
    if !icy.isEmpty {
      var meta = IcyParser.metadata(fromFields: icy, format: format)
      if meta.album == nil { meta.album = common.album }
      return meta
    }
    return common
  }

  static func resolveURL(_ uri: String) -> URL? {
    if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
    guard let url = URL(string: uri), url.scheme != nil else { return nil }
    return url
  }
}
