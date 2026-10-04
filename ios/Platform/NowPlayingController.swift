import Foundation
import MediaPlayer
import UIKit
import os

private let nowPlayingLog = Logger(subsystem: "com.radioanimu.airwave", category: "now-playing")

/// What the lock screen / Control Center / CarPlay / AirPods show.
struct NowPlayingInfo: Equatable {
  var title: String?
  var artist: String?
  var album: String?
  var artwork: String?
  var isLive = false
  var duration: Double?
  var position: Double = 0
  var rate: Double = 0
}

/// Downloads artwork off the main thread with a deadline. Artwork never
/// blocks playback or metadata: the info is published without it and the
/// image is attached when (and if) it arrives for the *current* URL.
final class ArtworkLoader {
  static let timeout: TimeInterval = 10
  private let cache = NSCache<NSString, UIImage>()
  private var inFlight: [String: [(UIImage?) -> Void]] = [:]
  private let session: URLSession = {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = ArtworkLoader.timeout
    config.timeoutIntervalForResource = ArtworkLoader.timeout
    config.urlCache = URLCache(memoryCapacity: 0, diskCapacity: 20 * 1024 * 1024)
    config.requestCachePolicy = .returnCacheDataElseLoad
    return URLSession(configuration: config)
  }()

  init() {
    cache.countLimit = 8
  }

  func cached(_ uri: String) -> UIImage? { cache.object(forKey: uri as NSString) }

  /// Main thread in, main thread out.
  func load(_ uri: String, completion: @escaping (UIImage?) -> Void) {
    if let image = cached(uri) { return completion(image) }
    if inFlight[uri] != nil {
      inFlight[uri]?.append(completion)
      return
    }
    inFlight[uri] = [completion]
    let finish: (UIImage?) -> Void = { [weak self] image in
      DispatchQueue.main.async {
        guard let self else { return }
        if let image { self.cache.setObject(image, forKey: uri as NSString) }
        let waiters = self.inFlight.removeValue(forKey: uri) ?? []
        waiters.forEach { $0(image) }
      }
    }
    guard let url = AVPlayerDriver.resolveURL(uri) else { return finish(nil) }
    if url.isFileURL {
      DispatchQueue.global(qos: .utility).async { finish(UIImage(contentsOfFile: url.path)) }
      return
    }
    session.dataTask(with: url) { data, response, _ in
      let ok = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? true
      finish(ok ? data.flatMap(UIImage.init(data:)) : nil)
    }.resume()
  }
}

protocol RemoteCommandTarget: AnyObject {
  func remote(_ command: String, position: Double?)
}

/// `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter` (both app-global).
/// Main thread only. Updated on state/metadata changes, never per tick — the
/// system extrapolates the position from `elapsed` + `rate`.
final class NowPlayingController {
  weak var target: RemoteCommandTarget?
  private let artwork = ArtworkLoader()
  private var current: NowPlayingInfo?
  private var currentImage: (uri: String, image: UIImage)?
  private var targets: [(MPRemoteCommand, Any)] = []
  private var enabledCommands: Set<String> = []

  /// Commands handled natively for every player; others are opt-in.
  private static let builtIn: Set<String> = ["play", "pause", "togglePlayPause", "stop"]

  func configureCommands(forwarded: Set<String>, seekable: Bool) {
    let wanted = Self.builtIn.union(forwarded).union(seekable ? ["seek"] : [])
    guard wanted != enabledCommands || targets.isEmpty else { return }
    enabledCommands = wanted
    let center = MPRemoteCommandCenter.shared()
    targets.forEach { $0.0.removeTarget($0.1) }
    targets = []
    func bind(_ command: MPRemoteCommand, _ name: String, enabled: Bool) {
      command.isEnabled = enabled
      guard enabled else { return }
      let token = command.addTarget { [weak self] event in
        var position: Double?
        if let e = event as? MPChangePlaybackPositionCommandEvent { position = e.positionTime }
        nowPlayingLog.debug("remote command \(name, privacy: .public)")
        self?.target?.remote(name, position: position)
        return .success
      }
      targets.append((command, token))
    }
    bind(center.playCommand, "play", enabled: true)
    bind(center.pauseCommand, "pause", enabled: true)
    bind(center.togglePlayPauseCommand, "togglePlayPause", enabled: true)
    bind(center.stopCommand, "stop", enabled: true)
    bind(center.changePlaybackPositionCommand, "seek", enabled: seekable)
    bind(center.nextTrackCommand, "next", enabled: forwarded.contains("next"))
    bind(center.previousTrackCommand, "previous", enabled: forwarded.contains("previous"))
    center.skipForwardCommand.preferredIntervals = [15]
    center.skipBackwardCommand.preferredIntervals = [15]
    bind(center.skipForwardCommand, "skipForward", enabled: forwarded.contains("skipForward"))
    bind(center.skipBackwardCommand, "skipBackward", enabled: forwarded.contains("skipBackward"))
  }

  func update(_ info: NowPlayingInfo?) {
    guard info != current else { return }
    current = info
    guard let info else {
      MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
      return
    }
    publish(info)
    if let uri = info.artwork, currentImage?.uri != uri {
      if let image = artwork.cached(uri) {
        currentImage = (uri, image)
        publish(info)
      } else {
        artwork.load(uri) { [weak self] image in
          guard let self, let image, self.current?.artwork == uri, let latest = self.current else {
            return
          }
          self.currentImage = (uri, image)
          self.publish(latest)
        }
      }
    }
  }

  func clear() {
    update(nil)
    let center = MPRemoteCommandCenter.shared()
    targets.forEach { $0.0.removeTarget($0.1) }
    targets = []
    enabledCommands = []
    _ = center
  }

  private func publish(_ info: NowPlayingInfo) {
    var dict: [String: Any] = [
      MPNowPlayingInfoPropertyIsLiveStream: info.isLive,
      MPNowPlayingInfoPropertyElapsedPlaybackTime: info.isLive ? 0 : info.position,
      MPNowPlayingInfoPropertyPlaybackRate: info.rate,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0,
      MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
    ]
    if let title = info.title { dict[MPMediaItemPropertyTitle] = title }
    if let artist = info.artist { dict[MPMediaItemPropertyArtist] = artist }
    if let album = info.album { dict[MPMediaItemPropertyAlbumTitle] = album }
    if !info.isLive, let duration = info.duration { dict[MPMediaItemPropertyPlaybackDuration] = duration }
    if let image = currentImage, image.uri == info.artwork {
      let picture = image.image
      dict[MPMediaItemPropertyArtwork] = MPMediaItemArtwork(boundsSize: picture.size) { _ in picture }
    }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = dict
    nowPlayingLog.debug(
      "published title=\(info.title ?? "-", privacy: .public) artist=\(info.artist ?? "-", privacy: .public) live=\(info.isLive) elapsed=\(info.position) duration=\(info.duration ?? -1) rate=\(info.rate) artwork=\(dict[MPMediaItemPropertyArtwork] != nil)")
  }
}
