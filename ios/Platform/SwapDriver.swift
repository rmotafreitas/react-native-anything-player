import Foundation

/// Where the drivers show: a video's pictures (the one on screen above the
/// one a switch prepares); a sound has none.
protocol SwapStage: AnyObject {
  func show(current: AVPlayerDriver, hidden: AVPlayerDriver?)
  /// Decode and show the picture, or not (the sound plays on; QA1668).
  func videoEnabled(_ enabled: Bool)
}

/// How far ahead of the picture the new file opens, seconds.
private let lookaheadSeconds = 1.5

/// How often the rendezvous checks the picture's position.
private let rendezvousTick: DispatchTimeInterval = .milliseconds(40)

/// A player's local output: the AVPlayer heard (and on screen), and a second
/// one that prepares a quality switch behind it (`open(swap: true)`,
/// separate files of one video or one sound). The second one opens a little
/// ahead, muted, waits until the first reaches that point, plays, and takes
/// over: no spinner, no gap, no jump. The second AVPlayer is only made at the
/// first switch. Twin of the Android and web `SwapDriver`. Main thread.
final class SwapDriver: LocalOutput {
  private final class Pending {
    let generation: Int
    var target: Double?
    var ready = false

    init(generation: Int, target: Double?) {
      self.generation = generation
      self.target = target
    }
  }

  private let make: () -> AVPlayerDriver
  /// `nil`: a sound, nothing to show.
  weak var stage: SwapStage?
  /// Where both drivers' events go (the player controller).
  weak var observer: DriverObserver?
  private let proxy = Proxy()
  /// The driver on screen.
  private(set) var current: AVPlayerDriver
  private var spare: AVPlayerDriver?
  private var pending: Pending?
  private var volume = 1.0
  private var rate = 1.0
  private var loop = false
  private var quality: QualityConstraints?
  private var videoOn = true
  /// The engine's track picks: a switch's file plays the same ones.
  private var tracks: (audio: String?, text: String?)?
  private var tick: DispatchWorkItem?

  init(make: @escaping () -> AVPlayerDriver) {
    self.make = make
    current = make()
    proxy.owner = self
    current.observer = proxy
  }

  /// Both drivers, the one on screen first.
  var drivers: [AVPlayerDriver] { [current] + [spare].compactMap { $0 } }

  // MARK: - EngineDriver

  func open(_ request: OpenRequest) {
    if request.swap { return prepare(request) }
    drop()
    current.open(request)
  }

  func play() { current.play() }
  func pause() { current.pause() }
  func seek(to seconds: Double) { current.seek(to: seconds) }
  func seek(to seconds: Double, exact: Bool) { current.seek(to: seconds, exact: exact) }

  func releaseConnection() {
    drop()
    current.releaseConnection()
  }

  func unload() {
    drop()
    current.unload()
  }

  func setVolume(_ effective: Double) {
    volume = effective
    current.setVolume(effective)
  }

  func setRate(_ rate: Double) {
    self.rate = rate
    current.setRate(rate)
    spare?.setRate(rate)
  }

  func setLoop(_ loop: Bool) {
    self.loop = loop
    current.setLoop(loop)
    spare?.setLoop(loop)
  }

  func setQuality(_ constraints: QualityConstraints) {
    quality = constraints
    current.setQuality(constraints)
  }

  func setVideoEnabled(_ enabled: Bool) {
    videoOn = enabled
    current.setVideoEnabled(enabled)
    spare?.setVideoEnabled(enabled)
    stage?.videoEnabled(enabled)
  }

  func selectTracks(audio: String?, text: String?) {
    tracks = (audio, text)
    current.selectTracks(audio: audio, text: text)
  }

  func cancelSwap(generation: Int) {
    if pending?.generation == generation { drop() }
  }

  /// The routing driver switches outputs.
  func switchOutput(_ outputId: String) {}

  func sample() -> PlaybackSample { current.sample() }
  func progress() -> ProgressReading { current.progress() }

  func destroy() {
    drop()
    current.destroy()
    spare?.destroy()
    spare = nil
  }

  // MARK: - The switch

  private func prepare(_ request: OpenRequest) {
    drop()
    let next: AVPlayerDriver
    if let spare {
      next = spare
    } else {
      next = make()
      next.observer = proxy
      spare = next
    }
    // It samples as the one heard does, from when it is heard: until then
    // its muted windows would mix with the real ones.
    next.copySampling(from: current)
    next.setSampling(false)
    let position = current.sample().position
    let target = request.startPosition != nil ? position + lookaheadSeconds : nil
    pending = Pending(generation: request.generation, target: target)
    next.setVolume(0)
    next.setRate(rate)
    next.setLoop(loop)
    next.setVideoEnabled(videoOn)
    if let quality { next.setQuality(quality) }
    if let tracks { next.selectTracks(audio: tracks.audio, text: tracks.text) }
    stage?.show(current: current, hidden: next)
    next.open(
      OpenRequest(
        generation: request.generation, source: request.source, startPosition: target, playWhenReady: false,
        allowReconnect: request.allowReconnect, swap: false, rendition: request.rendition))
  }

  /// Plays the new file once the picture reaches where it waits.
  private func rendezvous() {
    tick = nil
    guard let waiting = pending, let next = spare, waiting.ready else { return }
    let reading = current.progress()
    // Live, a stalled picture, or one already at the point: no reason to wait.
    if let target = waiting.target, reading.isPlaying {
      if reading.position > target + 0.3 {
        // Too slow to open: try again a little further ahead.
        waiting.target = reading.position + lookaheadSeconds
        next.seek(to: waiting.target!, exact: true)
      } else if reading.position < target - 0.04 {
        schedule()
        return
      } else {
        next.play()
        return
      }
      schedule()
      return
    }
    next.play()
  }

  private func schedule() {
    let item = DispatchWorkItem { [weak self] in self?.rendezvous() }
    tick = item
    DispatchQueue.main.asyncAfter(deadline: .now() + rendezvousTick, execute: item)
  }

  /// The new file plays: it is the picture and the sound now.
  private func takeOver() {
    guard let next = spare else { return }
    let old = current
    tick?.cancel()
    tick = nil
    pending = nil
    next.setVolume(volume)
    next.setSampling(old.samplingEnabled)
    old.setSampling(false)
    current = next
    spare = old
    stage?.show(current: next, hidden: old)
    old.releaseConnection()
  }

  private func drop() {
    guard pending != nil else { return }
    tick?.cancel()
    tick = nil
    pending = nil
    spare?.releaseConnection()
  }

  private func switching(_ generation: Int) -> Bool { pending?.generation == generation }

  /// Forwards both drivers' events; the switch's ready starts the rendezvous, its playing takes over first.
  private final class Proxy: DriverObserver {
    weak var owner: SwapDriver?
    private var target: DriverObserver? { owner?.observer }

    func driverReady(generation: Int, info: ReadyInfo) {
      target?.driverReady(generation: generation, info: info)
      guard let owner, owner.switching(generation) else { return }
      owner.pending?.ready = true
      owner.rendezvous()
    }

    func driverPlaying(generation: Int) {
      let switched = owner?.switching(generation) ?? false
      if switched { owner?.takeOver() }
      target?.driverPlaying(generation: generation)
      // The engine took the switch's generation: the new file's tracks are the ones now.
      if switched, let media = owner?.current.mapped {
        target?.driverTracks(generation: generation, tracks: media.tracks, variants: media.variants)
      }
    }

    func driverBuffering(generation: Int) { target?.driverBuffering(generation: generation) }
    func driverEnded(generation: Int) { target?.driverEnded(generation: generation) }
    func driverFailed(generation: Int, error: PlayerError) { target?.driverFailed(generation: generation, error: error) }
    func driverPausedExternally(generation: Int) { target?.driverPausedExternally(generation: generation) }
    func driverMetadata(generation: Int, metadata: StreamMetadata) {
      target?.driverMetadata(generation: generation, metadata: metadata)
    }
    func driverPositionChanged() { target?.driverPositionChanged() }
    func driverNote(generation: Int, event: String, details: [String: String]) {
      target?.driverNote(generation: generation, event: event, details: details)
    }
    func driverDiscontinuity(generation: Int, position: Double) {
      target?.driverDiscontinuity(generation: generation, position: position)
    }
    var isOffline: Bool { target?.isOffline ?? false }
    func driverVideoInfo(generation: Int, info: VideoInfo) { target?.driverVideoInfo(generation: generation, info: info) }
    func driverTracks(generation: Int, tracks: [MediaTrack], variants: [VideoVariant]) {
      target?.driverTracks(generation: generation, tracks: tracks, variants: variants)
    }
    func driverSourceCues(generation: Int, cues: [OverlayCue]) {
      target?.driverSourceCues(generation: generation, cues: cues)
    }
    func driverAccessLog(generation: Int, bitsPerSecond: Double?, droppedFrames: Int?) {
      target?.driverAccessLog(generation: generation, bitsPerSecond: bitsPerSecond, droppedFrames: droppedFrames)
    }
    func driverLicenseRequest(generation: Int, request: LicenseAsk) {
      guard let target else {
        return LicenseRequests.shared.cancel(request.requestId, "The player was released.")
      }
      target.driverLicenseRequest(generation: generation, request: request)
    }
  }
}
