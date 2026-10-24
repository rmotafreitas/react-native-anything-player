import Foundation

/// A remote output's driver (a Google Cast receiver). Reports to the same
/// observer as the local driver, tagged with the engine's generation.
protocol RemoteOutputDriver: EngineDriver {
  var observer: DriverObserver? { get set }
  /// What the receiver shows for the item it opens (title, artist, artwork).
  var describe: (() -> NowPlayingInfo)? { get set }
  func progress() -> ProgressReading
  /// Stops listening to the receiver. Does not stop its media (`unload` does).
  func destroy()
}

/// The engine's driver: the local AVPlayer driver, or a remote output while
/// the engine has handed the player off to one (`switchOutput`). Every
/// command goes to the current target; volume and rate follow a switch.
/// Main thread only.
final class RoutingDriver: EngineDriver {
  static let localOutput = "local"

  let local: AVPlayerDriver
  /// Builds the driver for a remote output id (`cast:<device>`); `nil` when
  /// remote outputs are not compiled in.
  var makeRemote: ((String) -> RemoteOutputDriver?)?
  weak var observer: DriverObserver? {
    didSet { remote?.observer = observer }
  }
  var describe: (() -> NowPlayingInfo)? {
    didSet { remote?.describe = describe }
  }
  private(set) var outputId = RoutingDriver.localOutput
  private var remote: RemoteOutputDriver?
  private var volume = 1.0
  private var rate = 1.0
  /// Whether the last item that became ready was live: a receiver must be
  /// told up front, and the source rarely says.
  private var knownLive: (uri: String, live: Bool)?

  init(local: AVPlayerDriver) {
    self.local = local
  }

  /// The audio plays on another device.
  var isRemote: Bool { outputId != Self.localOutput }

  private var current: EngineDriver { remote ?? local }

  func noteReady(uri: String?, live: Bool) {
    if let uri { knownLive = (uri, live) }
  }

  func progress() -> ProgressReading {
    remote?.progress() ?? local.progress()
  }

  func destroy() {
    remote?.destroy()
    remote = nil
    local.destroy()
  }

  // MARK: - EngineDriver

  func open(_ request: OpenRequest) {
    guard let remote else { return local.open(request) }
    var source = request.source
    if source.liveHint == nil, let known = knownLive, known.uri == source.uri {
      source.liveHint = known.live
    }
    remote.open(
      OpenRequest(
        generation: request.generation, source: source, startPosition: request.startPosition,
        playWhenReady: request.playWhenReady, allowReconnect: request.allowReconnect))
  }

  func play() { current.play() }
  func pause() { current.pause() }
  func seek(to seconds: Double) { current.seek(to: seconds) }
  func seek(to seconds: Double, exact: Bool) { current.seek(to: seconds, exact: exact) }
  func setVideoEnabled(_ enabled: Bool) { current.setVideoEnabled(enabled) }
  func setQuality(_ constraints: QualityConstraints) { current.setQuality(constraints) }
  func setLoop(_ loop: Bool) { current.setLoop(loop) }
  func cancelSwap(generation: Int) { current.cancelSwap(generation: generation) }
  func releaseConnection() { current.releaseConnection() }
  func unload() { current.unload() }

  func setVolume(_ effective: Double) {
    volume = effective
    current.setVolume(effective)
  }

  func setRate(_ rate: Double) {
    self.rate = rate
    current.setRate(rate)
  }

  /// The engine has already unloaded the item from the previous output.
  func switchOutput(_ outputId: String) {
    guard outputId != self.outputId else { return }
    remote?.destroy()
    remote = nil
    self.outputId = outputId
    if isRemote, let next = makeRemote?(outputId) {
      next.observer = observer
      next.describe = describe
      remote = next
    }
    current.setVolume(volume)
    current.setRate(rate)
  }

  func sample() -> PlaybackSample { current.sample() }
}
