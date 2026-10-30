#if RNAP_VIDEO
import AVFoundation
import AVKit
import UIKit

/// While cues are on, the overlay checks the clock at least this often (rate changes, drift).
private let cueRecheck: TimeInterval = 1

/// The `<VideoView>`s: each finds its player's output by id.
enum VideoHosts {
  /// Views whose player does not exist yet (mounted before `new Player`, or after a release).
  private static let waiting = NSHashTable<RNAPVideoHostView>.weakObjects()

  /// Main thread. A view's props, window or size changed.
  static func changed(_ host: RNAPVideoHostView) {
    let attached = host.attachment as? VideoOutput
    let wanted: VideoOutput? =
      host.window == nil || host.playerId.isEmpty
      ? nil : AnythingPlayerRuntime.shared.player(host.playerId)?.picture as? VideoOutput
    if attached !== wanted {
      attached?.detach(host)
      host.attachment = wanted
      wanted?.attach(host)
    } else {
      attached?.hostChanged(host)
    }
    if wanted == nil && host.window != nil && !host.playerId.isEmpty {
      waiting.add(host)
    } else {
      waiting.remove(host)
    }
  }

  static func playerRegistered() {
    waiting.allObjects.forEach(changed)
  }
}

/// What the picture goes in: the AVPlayerLayers (the one on screen above the
/// one a switch prepares), the poster until the first frame, and the
/// subtitles over the visible picture. Moved between `<VideoView>`s whole,
/// so the layers keep their frame.
private final class PictureStage: UIView {
  let overlay = SubtitleOverlayView()
  let poster = UIImageView()
  /// The layer on screen (the overlay sits on its picture).
  weak var front: AVPlayerLayer?
  var gravity: AVLayerVideoGravity = .resizeAspect {
    didSet { layer.sublayers?.compactMap { $0 as? AVPlayerLayer }.forEach { $0.videoGravity = gravity } }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    clipsToBounds = true
    isUserInteractionEnabled = false
    poster.isHidden = true
    poster.contentMode = .scaleAspectFit
    addSubview(poster)
    addSubview(overlay)
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
  }

  func add(_ playerLayer: AVPlayerLayer) {
    guard playerLayer.superlayer !== layer else { return }
    playerLayer.videoGravity = gravity
    layer.insertSublayer(playerLayer, at: 0)
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.sublayers?.compactMap { $0 as? AVPlayerLayer }.forEach { $0.frame = bounds }
    CATransaction.commit()
    poster.frame = bounds
    // Subtitles sit on the visible part of the picture.
    let picture = front.map { $0.videoRect.intersection(bounds) } ?? .null
    overlay.frame = picture.isNull || picture.isEmpty ? bounds : picture
    bringSubviewToFront(poster)
    bringSubviewToFront(overlay)
  }
}

/// `presentFullscreen()`: AVKit's player, modal, optionally held in landscape or portrait.
private final class FullscreenController: AVPlayerViewController {
  var orientations: UIInterfaceOrientationMask = .all
  var onDismiss: (() -> Void)?
  let overlay = SubtitleOverlayView()

  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { orientations }

  override func viewDidLoad() {
    super.viewDidLoad()
    if let content = contentOverlayView {
      overlay.frame = content.bounds
      overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      content.addSubview(overlay)
    }
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    if isBeingDismissed || presentingViewController == nil { onDismiss?() }
  }
}

/// A video player's picture side on iOS: its two AVPlayers
/// ([SwapDriver]), an AVPlayerLayer each in a stage that moves to the
/// newest `<VideoView>`, AVKit's controls inline (`nativeControls`) and in
/// fullscreen, Picture in Picture, and the subtitle overlay (the app's files
/// on the cue schedule, the source's from the legible output). Tells the
/// engine about the view and emits `cues`. Main thread.
final class VideoOutput: NSObject, VideoPicture, SwapStage, AVPictureInPictureControllerDelegate,
  AVPlayerViewControllerDelegate
{
  private weak var controller: PlayerController?
  private let swap: SwapDriver
  private var layers: [ObjectIdentifier: AVPlayerLayer] = [:]
  private var readiness: [ObjectIdentifier: NSKeyValueObservation] = [:]
  private let stage = PictureStage()
  /// Attached `<VideoView>`s, the newest last (it shows the picture).
  private var inline: [RNAPVideoHostView] = []
  private var host: RNAPVideoHostView? { inline.last }
  /// AVKit's controls inline (`nativeControls`).
  private var embedded: AVPlayerViewController?
  private let embeddedOverlay = SubtitleOverlayView()
  private var fullscreen: FullscreenController?
  private var pip: AVPictureInPictureController?
  private var pipActive = false
  private var videoOn = true
  private var status = Status()
  private var reportedView = ViewState()
  private var released = false

  // Subtitles
  private struct AppTrack {
    var times: [CueTime]
    var cues: [OverlayCue]
  }
  private var session: String?
  private var appCues: [String: AppTrack] = [:]
  private var sourceCueList: [OverlayCue] = []
  private var shownCues: [OverlayCue] = []
  private var shownTrack: String?
  private var cueTimer: DispatchWorkItem?

  // Poster
  private var posterImage: UIImage?
  private var posterTask: URLSessionDataTask?

  init(titleFormat: StreamTitleFormat) {
    swap = SwapDriver { AVPlayerDriver(titleFormat: titleFormat, video: true) }
    super.init()
    swap.stage = self
    show(current: swap.current, hidden: nil)
  }

  // MARK: - VideoPicture

  func attach(to controller: PlayerController) {
    self.controller = controller
    swap.observer = controller
  }

  var output: LocalOutput { swap }
  var primary: AVPlayerDriver { swap.current }
  var drivers: [AVPlayerDriver] { swap.drivers }

  private var engine: PlaybackEngine? { controller?.engine }

  func load(_ parts: VideoLoadParts) {
    session = parts.session
    appCues = [:]
    sourceCueList = []
    loadPoster(parts.poster)
    applyCues()
  }

  func statusChanged(_ status: Status) {
    self.status = status
    if status.video?.firstFrame == true { stage.poster.isHidden = true }
    if [.idle, .ended, .stopped, .error].contains(status.state) { sourceCueList = [] }
    updateLayers()
    applyCues()
    updatePip()
    AnythingPlayerRuntime.shared.updateScreenAwake()
  }

  func sourceCues(_ cues: [OverlayCue]) {
    sourceCueList = cues
    applyCues()
  }

  func positionJumped() { applyCues() }

  func castSubtitles(_ status: VideoStatus) -> [CastSubtitle] {
    status.tracks.compactMap { track in
      guard track.kind != .audio, !track.id.hasPrefix("track:"), let app = appCues[track.id] else { return nil }
      return CastSubtitle(
        id: track.id, captions: track.kind == .captions, language: track.language, label: track.label,
        vtt: CueWriter.vtt(app.cues, delay: status.subtitleDelay))
    }
  }

  func command(_ op: String, _ command: NSDictionary) throws {
    switch op {
    case "cues":
      setCues(command["session"] as? String, command["trackId"] as? String, command["cues"] as? [NSDictionary])
    case "fullscreen":
      if command["active"] as? Bool == true {
        try enterFullscreen(lock: command["lockOrientation"] as? String)
      } else {
        fullscreen?.dismiss(animated: true)
      }
    case "pictureInPicture":
      if command["active"] as? Bool == true { try startPictureInPicture() } else { pip?.stopPictureInPicture() }
    default:
      throw PlayerError.code(.invalidArgument, "Unknown video command \"\(op)\".", recoverable: false)
    }
  }

  func appBackgrounded() { reportView() }
  func appForegrounded() { reportView() }

  func destroy() {
    guard !released else { return }
    released = true
    cueTimer?.cancel()
    posterTask?.cancel()
    pip?.delegate = nil
    pip = nil
    fullscreen?.onDismiss = nil
    fullscreen?.dismiss(animated: false)
    fullscreen = nil
    removeEmbedded()
    stage.removeFromSuperview()
    inline.forEach { $0.attachment = nil }
    inline = []
    readiness.values.forEach { $0.invalidate() }
    readiness = [:]
    layers.values.forEach {
      $0.player = nil
      $0.removeFromSuperlayer()
    }
    layers = [:]
    swap.destroy()
  }

  // MARK: - SwapStage

  func show(current: AVPlayerDriver, hidden: AVPlayerDriver?) {
    let currentLayer = layer(for: current)
    if pipActive, let pipLayer = pip?.playerLayer, pipLayer !== currentLayer {
      // Picture in Picture shows one layer: it shows the new player now.
      let previous = layers.first { $0.value === pipLayer }?.key
      layers[ObjectIdentifier(current)] = pipLayer
      if let previous { layers[previous] = currentLayer }
    }
    let front = layer(for: current)
    front.zPosition = 1
    if let hidden { layer(for: hidden).zPosition = 0 }
    stage.front = front
    updateLayers()
    fullscreen?.player = videoOn ? current.player : nil
    embedded?.player = videoOn ? current.player : nil
    if !pipActive { rebindPip() }
    stage.setNeedsLayout()
  }

  func videoEnabled(_ enabled: Bool) {
    videoOn = enabled
    updateLayers()
    fullscreen?.player = enabled ? swap.current.player : nil
    embedded?.player = enabled ? swap.current.player : nil
  }

  /// A layer per driver, made on first use; it plays that driver's AVPlayer
  /// while the picture is wanted (QA1668: detached, the sound plays on in
  /// the background).
  private func layer(for driver: AVPlayerDriver) -> AVPlayerLayer {
    let key = ObjectIdentifier(driver)
    if let existing = layers[key] { return existing }
    let made = AVPlayerLayer()
    layers[key] = made
    stage.add(made)
    readiness[key] = made.observe(\.isReadyForDisplay, options: [.new]) { [weak self, weak driver] layer, _ in
      DispatchQueue.main.async {
        guard let self, let driver, layer.isReadyForDisplay, layer.player === driver.player else { return }
        self.controller?.driverFirstFrame(generation: driver.currentGeneration)
      }
    }
    return made
  }

  private func updateLayers() {
    for driver in swap.drivers {
      let playerLayer = layer(for: driver)
      let wanted = videoOn || pipActive ? driver.player : nil
      if playerLayer.player !== wanted { playerLayer.player = wanted }
    }
  }

  // MARK: - Views

  func attach(_ view: RNAPVideoHostView) {
    guard !released else { return }
    inline.removeAll { $0 === view }
    inline.append(view)
    placeStage()
  }

  func detach(_ view: RNAPVideoHostView) {
    guard inline.contains(where: { $0 === view }) else { return }
    inline.removeAll { $0 === view }
    if stage.superview === view { stage.removeFromSuperview() }
    if embedded?.view.superview === view { removeEmbedded() }
    placeStage()
  }

  /// A view moved, resized or changed its props.
  func hostChanged(_ view: RNAPVideoHostView) {
    guard view === host else { return }
    applyProps(view)
    stage.frame = view.bounds
    embedded?.view.frame = view.bounds
    reportView()
  }

  private func placeStage() {
    guard let view = host else {
      reportView()
      return
    }
    if stage.superview !== view {
      stage.frame = view.bounds
      stage.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      view.insertSubview(stage, at: 0)
    }
    applyProps(view)
    stage.overlay.show(shownCues)
    stage.poster.image = posterImage
    stage.poster.isHidden = posterImage == nil || status.video?.firstFrame == true
    reportView()
    updatePip()
  }

  private func applyProps(_ view: RNAPVideoHostView) {
    stage.gravity =
      view.contentFit == "cover" ? .resizeAspectFill : view.contentFit == "fill" ? .resize : .resizeAspect
    stage.poster.contentMode =
      view.contentFit == "cover" ? .scaleAspectFill : view.contentFit == "fill" ? .scaleToFill : .scaleAspectFit
    if view.nativeControls {
      if embedded == nil || embedded?.view.superview !== view { embed(in: view) }
    } else if embedded != nil {
      removeEmbedded()
    }
  }

  /// AVKit's controls over the picture (`nativeControls`): its own player view, our subtitles in it.
  private func embed(in view: RNAPVideoHostView) {
    removeEmbedded()
    let avkit = AVPlayerViewController()
    avkit.player = videoOn ? swap.current.player : nil
    avkit.showsPlaybackControls = true
    avkit.delegate = self
    avkit.allowsPictureInPicturePlayback = true
    avkit.canStartPictureInPictureAutomaticallyFromInline = wantsAutoPip
    avkit.view.frame = view.bounds
    avkit.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    avkit.view.backgroundColor = .clear
    if let parent = Self.viewController(of: view) {
      parent.addChild(avkit)
      view.addSubview(avkit.view)
      avkit.didMove(toParent: parent)
    } else {
      view.addSubview(avkit.view)
    }
    if let content = avkit.contentOverlayView {
      embeddedOverlay.frame = content.bounds
      embeddedOverlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      content.addSubview(embeddedOverlay)
    }
    embedded = avkit
  }

  private func removeEmbedded() {
    guard let avkit = embedded else { return }
    embedded = nil
    // Its player taken first: AVKit may pause a player whose view goes away,
    // and a view going away must not stop the sound.
    avkit.player = nil
    avkit.willMove(toParent: nil)
    avkit.view.removeFromSuperview()
    avkit.removeFromParent()
  }

  private static func viewController(of view: UIView) -> UIViewController? {
    var responder: UIResponder? = view
    while let next = responder?.next {
      if let vc = next as? UIViewController { return vc }
      responder = next
    }
    return nil
  }

  private func reportView() {
    guard !released, let engine else { return }
    let next: ViewState
    if let full = fullscreen, let view = full.viewIfLoaded, view.window != nil {
      let scale = view.window?.screen.scale ?? UIScreen.main.scale
      next = ViewState(
        attached: true, visible: true, width: Int(view.bounds.width * scale), height: Int(view.bounds.height * scale))
    } else if let view = host, view.window != nil {
      let scale = view.window?.screen.scale ?? UIScreen.main.scale
      let onScreen =
        !view.isHidden && view.alpha > 0 && view.convert(view.bounds, to: nil).intersects(view.window!.bounds)
      next = ViewState(
        attached: true, visible: onScreen && UIApplication.shared.applicationState != .background,
        width: Int(view.bounds.width * scale), height: Int(view.bounds.height * scale))
    } else if pipActive {
      next = ViewState(attached: true, visible: true, width: reportedView.width, height: reportedView.height)
    } else {
      next = ViewState()
    }
    guard next != reportedView else { return }
    reportedView = next
    engine.viewChanged(next)
    AnythingPlayerRuntime.shared.updateScreenAwake()
  }

  // MARK: - Fullscreen

  private func enterFullscreen(lock: String?) throws {
    guard fullscreen == nil else { return }
    guard let presenter = Self.topViewController() else {
      throw PlayerError.code(.invalidArgument, "Fullscreen needs the app on screen.", recoverable: false)
    }
    let avkit = FullscreenController()
    avkit.player = videoOn ? swap.current.player : nil
    avkit.delegate = self
    avkit.modalPresentationStyle = .fullScreen
    avkit.allowsPictureInPicturePlayback = true
    switch lock {
    case "landscape": avkit.orientations = .landscape
    case "portrait": avkit.orientations = .portrait
    default: avkit.orientations = .all
    }
    avkit.onDismiss = { [weak self] in self?.fullscreenDismissed() }
    fullscreen = avkit
    engine?.fullscreenChanged(true)
    presenter.present(avkit, animated: true) { [weak self] in
      guard let self else { return }
      avkit.overlay.show(self.shownCues)
      if #available(iOS 16.0, *), lock == "landscape" || lock == "portrait" {
        avkit.setNeedsUpdateOfSupportedInterfaceOrientations()
        avkit.view.window?.windowScene?.requestGeometryUpdate(.iOS(interfaceOrientations: avkit.orientations)) { _ in }
      }
      self.reportView()
    }
  }

  private func fullscreenDismissed() {
    guard fullscreen != nil else { return }
    fullscreen = nil
    guard !released else { return }
    engine?.fullscreenChanged(false)
    reportView()
  }

  private static func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let window = scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? scenes.first?.windows.first
    var top = window?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }

  // MARK: - Picture in Picture

  /// `whenBackgrounded: 'pip'`: leaving the app takes the picture into Picture in Picture.
  private var wantsAutoPip: Bool {
    guard let v = controller?.options.engine.video else { return false }
    return v.whenBackgrounded == .pip && !v.ambient
  }

  /// A controller on the layer on screen (made again when that layer changes).
  private func rebindPip() {
    guard AVPictureInPictureController.isPictureInPictureSupported() else { return }
    let front = layer(for: swap.current)
    if pip?.playerLayer !== front {
      pip?.delegate = nil
      let made = AVPictureInPictureController(playerLayer: front)
      made?.delegate = self
      pip = made
    }
    updatePip()
  }

  private func updatePip() {
    guard let pip else { return }
    if pip.canStartPictureInPictureAutomaticallyFromInline != wantsAutoPip {
      pip.canStartPictureInPictureAutomaticallyFromInline = wantsAutoPip
    }
    embedded?.canStartPictureInPictureAutomaticallyFromInline = wantsAutoPip
  }

  private func startPictureInPicture() throws {
    guard AVPictureInPictureController.isPictureInPictureSupported() else {
      throw PlayerError.code(.invalidArgument, "This device has no Picture in Picture.", recoverable: false)
    }
    if pip == nil { rebindPip() }
    guard let pip, pip.isPictureInPicturePossible else {
      throw PlayerError.code(
        .invalidArgument,
        "Picture in Picture is not possible now: the video must be in a <VideoView> on screen, and the app "
          + "needs the \"Audio, AirPlay, and Picture in Picture\" background mode.",
        recoverable: false)
    }
    pip.startPictureInPicture()
  }

  private func pictureInPicture(_ active: Bool) {
    guard active != pipActive else { return }
    if active {
      // The engine first: the quality cap freezes at the view's.
      engine?.pictureInPictureChanged(true)
      pipActive = true
    } else {
      pipActive = false
      engine?.pictureInPictureChanged(false)
    }
    updateLayers()
    reportView()
  }

  func pictureInPictureControllerWillStartPictureInPicture(_ controller: AVPictureInPictureController) {
    pictureInPicture(true)
  }

  func pictureInPictureControllerDidStopPictureInPicture(_ controller: AVPictureInPictureController) {
    pictureInPicture(false)
    if !pipActive { rebindPip() }
  }

  func pictureInPictureController(
    _ controller: AVPictureInPictureController, failedToStartPictureInPictureWithError error: Error
  ) {
    pictureInPicture(false)
  }

  func pictureInPictureController(
    _ controller: AVPictureInPictureController,
    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
  ) {
    // The picture returns to its view, which never left.
    completionHandler(true)
  }

  // MARK: AVPlayerViewControllerDelegate (AVKit's own Picture in Picture)

  func playerViewControllerWillStartPictureInPicture(_ playerViewController: AVPlayerViewController) {
    pictureInPicture(true)
  }

  func playerViewControllerDidStopPictureInPicture(_ playerViewController: AVPlayerViewController) {
    pictureInPicture(false)
  }

  func playerViewController(
    _ playerViewController: AVPlayerViewController,
    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
  ) {
    completionHandler(true)
  }

  // MARK: - Subtitles

  private func setCues(_ session: String?, _ trackId: String?, _ list: [NSDictionary]?) {
    guard let session, session == self.session, let trackId else { return }
    let parsed = (list ?? []).map(Self.cue)
    appCues[trackId] = AppTrack(times: parsed.map { CueTime(start: $0.start, end: $0.end) }, cues: parsed)
    applyCues()
  }

  /// Draws the cues on screen now, emits `cues` when they change, and plans the next change.
  private func applyCues() {
    cueTimer?.cancel()
    cueTimer = nil
    guard !released else { return }
    let video = status.video
    let track = video?.textTrack
    var next: [OverlayCue] = []
    if let track, let app = appCues[track] {
      let reading = swap.current.progress()
      let delay = video?.subtitleDelay ?? 0
      next = CueSchedule.active(app.times, at: reading.position, delay: delay).map { app.cues[$0] }
      if reading.isPlaying {
        let rate = reading.rate > 0 ? reading.rate : 1
        let change = CueSchedule.nextChange(app.times, after: reading.position, delay: delay)
        let wait = change.map { ($0 - reading.position) / rate } ?? cueRecheck
        let item = DispatchWorkItem { [weak self] in self?.applyCues() }
        cueTimer = item
        DispatchQueue.main.asyncAfter(deadline: .now() + min(max(wait, 0.01), cueRecheck), execute: item)
      }
    } else if let track, track.hasPrefix("track:") {
      next = sourceCueList
    }
    guard next != shownCues || track != shownTrack else { return }
    shownCues = next
    shownTrack = track
    stage.overlay.show(next)
    embeddedOverlay.show(next)
    fullscreen?.overlay.show(next)
    controller?.emitEvent("cues", ["cues": next.map(Self.dictionary)])
  }

  private static func cue(_ map: NSDictionary) -> OverlayCue {
    let spans = (map["spans"] as? [NSDictionary])?.map { s in
      OverlaySpan(
        text: s["text"] as? String ?? "", bold: s["bold"] as? Bool ?? false, italic: s["italic"] as? Bool ?? false,
        underline: s["underline"] as? Bool ?? false, color: (s["color"] as? String).flatMap(color))
    }
    return OverlayCue(
      start: (map["start"] as? NSNumber)?.doubleValue ?? 0, end: (map["end"] as? NSNumber)?.doubleValue ?? 0,
      spans: spans ?? [OverlaySpan(text: map["text"] as? String ?? "")], align: map["align"] as? String ?? "center",
      vertical: map["vertical"] as? String ?? "bottom", x: (map["x"] as? NSNumber)?.doubleValue,
      y: (map["y"] as? NSNumber)?.doubleValue)
  }

  /// `#rrggbb`.
  private static func color(_ hex: String) -> UIColor? {
    guard hex.hasPrefix("#"), hex.count == 7, let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
    return UIColor(
      red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
      blue: CGFloat(value & 0xff) / 255, alpha: 1)
  }

  private static func hex(_ color: UIColor) -> String {
    var r: CGFloat = 0
    var g: CGFloat = 0
    var b: CGFloat = 0
    var a: CGFloat = 0
    color.getRed(&r, green: &g, blue: &b, alpha: &a)
    return String(format: "#%02x%02x%02x", Int(r * 255), Int(g * 255), Int(b * 255))
  }

  /// A cue as `SubtitleCue` (src/core/subtitles/types.ts) for the `cues` event.
  private static func dictionary(_ cue: OverlayCue) -> [String: Any] {
    [
      "start": cue.start, "end": max(cue.end, cue.start), "text": cue.text,
      "spans": cue.spans.map { span -> [String: Any] in
        var out: [String: Any] = ["text": span.text]
        if span.bold { out["bold"] = true }
        if span.italic { out["italic"] = true }
        if span.underline { out["underline"] = true }
        if let color = span.color { out["color"] = hex(color) }
        return out
      },
      "align": cue.align, "vertical": cue.vertical, "x": Serialization.optional(cue.x),
      "y": Serialization.optional(cue.y),
    ]
  }

  // MARK: - Poster

  private func loadPoster(_ uri: String?) {
    posterTask?.cancel()
    posterTask = nil
    posterImage = nil
    stage.poster.image = nil
    stage.poster.isHidden = true
    guard let uri, !uri.isEmpty, let url = uri.hasPrefix("/") ? URL(fileURLWithPath: uri) : URL(string: uri) else {
      return
    }
    let show: (UIImage?) -> Void = { [weak self] image in
      guard let self, !self.released, let image else { return }
      self.posterImage = image
      self.stage.poster.image = image
      self.stage.poster.isHidden = self.status.video?.firstFrame == true
    }
    if url.isFileURL {
      show(UIImage(contentsOfFile: url.path))
      return
    }
    let task = URLSession.shared.dataTask(with: url) { data, _, _ in
      let image = data.flatMap(UIImage.init(data:))
      DispatchQueue.main.async { show(image) }
    }
    posterTask = task
    task.resume()
  }
}
#endif
