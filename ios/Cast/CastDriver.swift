import Foundation
import GoogleCast

/// `EngineDriver` over a Cast receiver's media (`GCKRemoteMediaClient`), the
/// remote half of a player's `RoutingDriver`. Main thread only.
///
/// - `open` loads the source on the receiver (the receiver fetches it: the
///   URL must be http(s); headers cannot be sent) with the item's title,
///   artist, album and artwork, at the start position, autoplaying when the
///   engine wants playback.
/// - Media status is mapped to the engine's callbacks for the open's
///   generation: ready, playing, buffering, paused by someone else, ended,
///   and receiver errors as a recoverable `NETWORK_ERROR` (domain `cast`),
///   which the engine's backoff retries on the same receiver.
/// - Statuses are only trusted once the receiver accepted this driver's load,
///   and only for that media session: what another sender (or the previous
///   player) does to the receiver is not this item's state.
/// - Volume is the receiver's stream volume; the device volume stays the
///   system's.
class CastDriver: NSObject, RemoteOutputDriver {
  weak var observer: DriverObserver?
  var describe: (() -> NowPlayingInfo)?
  var media: (() -> CastMedia)?
  let outputId: String
  /// The receiver's text track ids of the app's files (`sub:<n>` → 1, 2…).
  private var castTracks: [String: Int] = [:]

  private var client: GCKRemoteMediaClient?
  private var generation = 0
  private var request: OpenRequest?
  private var loadRequest: GCKRequest?
  /// The receiver accepted the current load.
  private var loaded = false
  private var mediaSessionId: Int?
  private var readyGeneration = -1
  private var lastPlayerState: GCKMediaPlayerState = .unknown
  private var playWanted = false
  private var isLive = false
  private var duration: Double?
  private var volume: Float = 1
  private var rate: Float = 1
  /// The last position the receiver reported, and when (monotonic ms).
  private var reportedPosition: Double = 0
  private var reportedAt: Int64 = 0
  private var reportedPlaying = false

  init(outputId: String) {
    self.outputId = outputId
    super.init()
    CastObjC.adopt(CastDriver.self, "GCKRemoteMediaClientListener", "GCKRequestDelegate")
    CastManager.shared.register(self)
    bind(CastManager.shared.client)
  }

  /// The session's media client changed (session started, resumed, ended).
  func bind(_ client: GCKRemoteMediaClient?) {
    guard client !== self.client else { return }
    if let old = self.client { CastObjC.send(old, "removeListener:", self) }
    self.client = client
    guard let client else { return }
    CastObjC.send(client, "addListener:", self)
    if loaded { mediaStatusUpdated(client.mediaStatus) }
  }

  // MARK: - EngineDriver

  func open(_ request: OpenRequest) {
    resetItem()
    generation = request.generation
    self.request = request
    playWanted = request.playWhenReady
    isLive = request.source.liveHint ?? false
    let gen = generation
    guard request.source.isCastable, let url = URL(string: request.source.uri) else {
      // The runtime brings the player back to the device (CAST_UNSUPPORTED_SOURCE).
      observer?.driverNote(generation: gen, event: "cast skipped", details: ["reason": "source not http(s)"])
      return
    }
    guard let client else {
      return failSoon(gen, castError("No Cast session.", nil))
    }
    let extra = media?() ?? CastMedia()
    let builder = GCKMediaLoadRequestDataBuilder()
    builder.mediaInformation = mediaInformation(url, request.source, extra)
    builder.autoplay = NSNumber(value: request.playWhenReady)
    if !castTracks.isEmpty {
      // The track the engine shows is on from the start.
      builder.activeTrackIDs = extra.textTrack.flatMap { castTracks[$0] }.map { [NSNumber(value: $0)] } ?? []
    }
    if let start = request.startPosition, start > 0, !isLive { builder.startTime = start }
    guard let pending = CastObjC.call(client, "loadMediaWithLoadRequestData:", builder.build()) as? GCKRequest
    else {
      return failSoon(gen, castError("The Cast SDK did not accept the load.", nil))
    }
    pending.delegate = (self as AnyObject) as? GCKRequestDelegate
    loadRequest = pending
  }

  func play() {
    playWanted = true
    if loaded { client?.play() }
  }

  func pause() {
    playWanted = false
    if loaded { client?.pause() }
  }

  func seek(to seconds: Double) {
    report(position: seconds, playing: reportedPlaying)
    guard loaded else { return }
    let options = GCKMediaSeekOptions()
    options.interval = seconds
    options.resumeState = .unchanged
    if let client { CastObjC.send(client, "seekWithOptions:", options) }
  }

  func releaseConnection() {
    stopMedia()
  }

  func unload() {
    stopMedia()
  }

  func setVolume(_ effective: Double) {
    volume = Float(min(max(effective, 0), 1))
    if loaded { client?.setStreamVolume(volume) }
  }

  func setRate(_ rate: Double) {
    self.rate = Float(rate)
    if loaded && !isLive { client?.setPlaybackRate(self.rate) }
  }

  /// Not a routing driver: the engine never switches a receiver's output.
  func switchOutput(_ outputId: String) {}

  func sample() -> PlaybackSample {
    let position = currentPosition
    return PlaybackSample(position: position, bufferedPosition: position)
  }

  func progress() -> ProgressReading {
    var reading = ProgressReading()
    reading.position = currentPosition
    reading.buffered = reading.position
    reading.duration = duration
    reading.isPlaying = reportedPlaying
    reading.rate = Double(rate)
    return reading
  }

  func destroy() {
    resetItem()
    if let client { CastObjC.send(client, "removeListener:", self) }
    client = nil
  }

  // MARK: - Internals

  private var currentPosition: Double {
    if loaded, let client, client.mediaStatus != nil {
      let position = client.approximateStreamPosition()
      if position.isFinite && position >= 0 { return position }
    }
    return estimatedPosition
  }

  /// The last reported position, advanced while the receiver plays.
  private var estimatedPosition: Double {
    guard reportedPlaying else { return reportedPosition }
    return reportedPosition + Double(SystemClock.shared.monotonicMs - reportedAt) / 1000 * Double(rate)
  }

  private func report(position: Double, playing: Bool) {
    reportedPosition = position.isFinite ? max(0, position) : 0
    reportedAt = SystemClock.shared.monotonicMs
    reportedPlaying = playing
  }

  /// Stops the receiver's media (the engine unloads, stops or releases).
  private func stopMedia() {
    let wasActive = loaded || loadRequest != nil
    resetItem()
    if wasActive { client?.stop() }
  }

  /// Forgets the current item: its statuses and request callbacks are stale.
  private func resetItem() {
    loadRequest?.delegate = nil
    loadRequest = nil
    loaded = false
    mediaSessionId = nil
    readyGeneration = -1
    lastPlayerState = .unknown
    playWanted = false
    report(position: estimatedPosition, playing: false)
  }

  private func mediaInformation(_ url: URL, _ source: SourceDescriptor, _ extra: CastMedia) -> GCKMediaInformation {
    let info = describe?() ?? NowPlayingInfo()
    // A video: the receiver's movie layout (a title and a subtitle line).
    let metadata = GCKMediaMetadata(metadataType: extra.video ? .movie : .musicTrack)
    let fields =
      extra.video
      ? [(info.title, kGCKMetadataKeyTitle), (info.artist ?? info.album, kGCKMetadataKeySubtitle)]
      : [
        (info.title, kGCKMetadataKeyTitle), (info.artist, kGCKMetadataKeyArtist),
        (info.album, kGCKMetadataKeyAlbumTitle),
      ]
    for case let (value?, key) in fields {
      CastObjC.send(metadata, "setString:forKey:", value, key)
    }
    if let artwork = info.artwork, let image = URL(string: artwork),
      ["http", "https"].contains(image.scheme?.lowercased() ?? "")
    {
      CastObjC.send(metadata, "addImage:", GCKImage(url: image, width: 512, height: 512))
    }
    let builder = GCKMediaInformationBuilder(contentURL: url)
    builder.contentID = source.uri
    builder.streamType = isLive ? .live : .buffered
    if let type = Self.contentType(url, video: extra.video) { builder.contentType = type }
    builder.metadata = metadata
    // The app's subtitle files, as WebVTT the receiver fetches from a data: URL.
    castTracks = [:]
    if !extra.subtitles.isEmpty {
      builder.mediaTracks = extra.subtitles.enumerated().map { i, file in
        castTracks[file.id] = i + 1
        return GCKMediaTrack(
          identifier: i + 1, contentIdentifier: CastMedia.dataURL(file.vtt), contentType: "text/vtt", type: .text,
          textSubtype: file.captions ? .captions : .subtitles, name: file.label ?? file.language,
          languageCode: file.language, customData: nil)
      }
    }
    return builder.build()
  }

  /// What the receiver needs to pick a decoder (`nil`: let it sniff, an audio stream's way).
  static func contentType(_ url: URL, video: Bool) -> String? {
    switch url.pathExtension.lowercased() {
    case "m3u8": return "application/x-mpegurl"
    case "mpd": return "application/dash+xml"
    case "webm" where video: return "video/webm"
    case "ts" where video, "m2ts" where video: return "video/mp2t"
    case "mkv" where video: return "video/x-matroska"
    case "mov" where video: return "video/quicktime"
    default: return video ? "video/mp4" : nil
    }
  }

  /// The text track to show: one of the app's files the receiver was given, or none.
  func selectTracks(audio: String?, text: String?) {
    guard loaded, let client, !castTracks.isEmpty else { return }
    let ids = text.flatMap { castTracks[$0] }.map { [NSNumber(value: $0)] } ?? []
    CastObjC.send(client, "setActiveTrackIDs:", ids as NSArray)
  }

  private func castError(_ message: String, _ error: NSError?) -> PlayerError {
    var mapped = PlayerError.code(.networkError, message, recoverable: true)
    mapped.platformDomain = "cast"
    mapped.platformCode = error?.code
    mapped.cause = error?.localizedDescription
    return mapped
  }

  private func failSoon(_ gen: Int, _ error: PlayerError) {
    DispatchQueue.main.async { [weak self] in self?.observer?.driverFailed(generation: gen, error: error) }
  }

  private func mediaStatusUpdated(_ status: GCKMediaStatus?) {
    guard loaded, let status else { return }
    let ours = status.mediaInformation?.contentID == request?.source.uri
    if mediaSessionId == nil {
      // The first status of this load: one still describing the previous item is stale.
      guard ours else { return }
    } else if status.mediaSessionID != 0 && status.mediaSessionID != mediaSessionId {
      // Another sender (or app) replaced this item on the receiver, even with
      // the same URL: a new media session is not ours.
      if playWanted {
        playWanted = false
        observer?.driverPausedExternally(generation: generation)
      }
      loaded = false
      return
    }
    mediaSessionId = status.mediaSessionID
    report(position: status.streamPosition, playing: status.playerState == .playing)
    let gen = generation
    let state = status.playerState
    if [.playing, .paused, .buffering].contains(state) && readyGeneration != gen {
      readyGeneration = gen
      let reported = status.mediaInformation?.streamDuration ?? 0
      let finite = reported.isFinite && reported > 0
      isLive = isLive || status.mediaInformation?.streamType == .live || !finite
      duration = isLive ? nil : reported
      if !isLive && rate != 1 { client?.setPlaybackRate(rate) }
      observer?.driverReady(generation: gen, info: ReadyInfo(duration: duration, isLive: isLive, seekable: !isLive))
    }
    guard state != lastPlayerState else { return }
    lastPlayerState = state
    switch state {
    case .playing:
      observer?.driverPlaying(generation: gen)
    case .buffering:
      if playWanted { observer?.driverBuffering(generation: gen) }
    case .paused:
      // Paused without our say-so: the receiver's own controls, another sender.
      if playWanted {
        playWanted = false
        observer?.driverPausedExternally(generation: gen)
      }
    case .idle:
      switch status.idleReason {
      case .finished:
        observer?.driverEnded(generation: gen)
      case .error:
        loaded = false
        observer?.driverFailed(generation: gen, error: castError("The Cast receiver could not play the source.", nil))
      case .cancelled, .interrupted:
        // Stopped or replaced from elsewhere (our own stop resets first).
        loaded = false
        if playWanted {
          playWanted = false
          observer?.driverPausedExternally(generation: gen)
        }
      default:
        break
      }
    default:
      break
    }
  }

  // MARK: - GCKRemoteMediaClientListener / GCKRequestDelegate (by selector, see `CastObjC`)

  @objc(remoteMediaClient:didUpdateMediaStatus:)
  func remoteMediaStatusDidUpdate(_ client: GCKRemoteMediaClient, status: GCKMediaStatus?) {
    guard client === self.client else { return }
    mediaStatusUpdated(status)
  }

  @objc(requestDidComplete:)
  func castRequestDidComplete(_ request: GCKRequest) {
    guard request === loadRequest else { return }
    loadRequest = nil
    loaded = true
    mediaSessionId = nil
    client?.setStreamVolume(volume)
    // The intent may have changed while the receiver was loading.
    if let wanted = self.request?.playWhenReady, wanted != playWanted {
      if playWanted { client?.play() } else { client?.pause() }
    }
    mediaStatusUpdated(client?.mediaStatus)
  }

  @objc(request:didFailWithError:)
  func castRequestDidFail(_ request: GCKRequest, error: GCKError) {
    guard request === loadRequest else { return }
    loadRequest = nil
    observer?.driverFailed(generation: generation, error: castError("The Cast receiver refused the source.", error))
  }

  @objc(request:didAbortWithReason:)
  func castRequestDidAbort(_ request: GCKRequest, reason: GCKRequestAbortReason) {
    guard request === loadRequest else { return }
    loadRequest = nil
    observer?.driverFailed(generation: generation, error: castError("The Cast load was aborted.", nil))
  }
}
