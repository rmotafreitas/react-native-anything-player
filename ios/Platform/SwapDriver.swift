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

/// What a muted live AVPlayer can do while a switch lines up: not run faster
/// (the gate drops the burst's start instead, before AVPlayer reads it), a
/// little slower, and it takes a while to be ready and to start.
private let alignCaps = LiveAligner.Caps(maxRate: 1, minRate: 0.5, jump: .first, startLead: 0.4, jumpLead: 2)
/// HLS by program dates: AVPlayer seeks within the live window any time (it still cannot run a live item faster).
private let clockCaps = LiveAligner.Caps(maxRate: 1, minRate: 0.5, jump: .always, startLead: 0.4, jumpLead: 2)
/// How long a new HLS item may go without a program date before it is taken to have none.
private let clockWaitMs: Int64 = 3_000

/// A player's local output: the AVPlayer heard (and on screen), and a second
/// one that prepares a quality switch behind it (`open(swap: true)`,
/// separate files of one video or one sound). The second one opens a little
/// ahead, muted, waits until the first reaches that point, plays, and takes
/// over: no spinner, no gap, no jump. The second AVPlayer is only made at the
/// first switch. Twin of the Android and web `SwapDriver`. Main thread.
///
/// A live stream has no shared timeline: each connection starts with its
/// server's burst of recent audio. There the new player is lined up with
/// what is heard first (`LiveAligner`): the start of its burst dropped before
/// AVPlayer reads it (`BurstGate`), held, or run a little slower, muted,
/// until it plays what the old one plays; then it takes over by volume
/// alone. When it cannot be lined up, it takes over as before and the app
/// hears a `discontinuity`. Positions stay continuous across a live switch.
final class SwapDriver: LocalOutput {
  private final class Pending {
    let generation: Int
    var target: Double?
    var ready = false
    /// Live: lines the new audio up with what is heard (`nil`: not, or not any more).
    var aligner: LiveAligner?
    /// Gave up lining up: takes over on its first audio, reported as a discontinuity.
    var fallback = false
    /// The player needs it (the current item stalls): one that cannot be lined up switches anyway.
    var required = false
    /// What a fallback skips (+) or repeats (−), seconds, when the aligner knew.
    var jump: Double?
    /// The rate the aligner asked of the new driver (× the app's).
    var alignRate = 1.0
    /// Readings taken so far: a reading that goes away after the first breaks the mapping.
    var steps = 0
    /// Lined up on program dates (`clockCaps`).
    var clocked = false
    /// Since when it waits for the new item's program dates.
    var clockWaitSince: Int64?
    /// The latest metadata the new driver's audio reached: told again once it is heard.
    var metadata: StreamMetadata?
    /// When it came (`told`): told again only if after the old driver's latest.
    var metadataAt = 0

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
  private var alignTick: DispatchWorkItem?
  /// A start the aligner timed between two ticks.
  private var alignStart: DispatchWorkItem?
  /// Metadata told so far (either driver), and the count at the current driver's latest.
  private var told = 0
  private var toldCurrent = 0
  /// The current driver's generation (its events' positions are shifted).
  private var generation = -1
  /// Live: the current driver's time − the position reported (continuous across switches).
  private var shift = 0.0

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
    generation = request.generation
    shift = 0
    current.open(request)
  }

  func play() { current.play() }
  func pause() { current.pause() }
  func seek(to seconds: Double) { current.seek(to: seconds + shift) }
  func seek(to seconds: Double, exact: Bool) { current.seek(to: seconds + shift, exact: exact) }

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
    // A live switch lining up keeps running at its multiple of the app's rate.
    spare?.setRate(rate * (pending?.alignRate ?? 1))
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

  func sample() -> PlaybackSample {
    var sample = current.sample()
    sample.position = max(0, sample.position - shift)
    sample.bufferedPosition = max(0, sample.bufferedPosition - shift)
    return sample
  }

  func progress() -> ProgressReading {
    var reading = current.progress()
    reading.position = max(0, reading.position - shift)
    reading.buffered = max(0, reading.buffered - shift)
    reading.edge = reading.edge.map { $0 - shift }
    return reading
  }

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
    pending?.required = request.required
    next.setVolume(0)
    next.setRate(rate)
    next.setLoop(loop)
    next.setVideoEnabled(videoOn)
    if let quality { next.setQuality(quality) }
    if let tracks { next.selectTracks(audio: tracks.audio, text: tracks.text) }
    stage?.show(current: current, hidden: next)
    let live = request.startPosition == nil
    // Live: its burst waits in the proxy until the aligner knows where it starts.
    next.holdBurst = live
    next.open(
      OpenRequest(
        generation: request.generation, source: request.source, startPosition: target, playWhenReady: false,
        allowReconnect: request.allowReconnect, swap: false, rendition: request.rendition))
    if live, let waiting = pending {
      waiting.aligner = LiveAligner(caps: alignCaps)
      alignStep()
    }
  }

  /// Plays the new file once the picture reaches where it waits.
  private func rendezvous() {
    tick = nil
    guard let waiting = pending, let next = spare, waiting.ready else { return }
    // Live: lined up (the aligner starts it), or at once.
    if waiting.target == nil {
      if waiting.aligner == nil { next.play() }
      return
    }
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

  // MARK: - A live switch, lined up

  private var aligning: Bool {
    guard let waiting = pending else { return false }
    return waiting.aligner != nil && !waiting.fallback
  }

  private func alignStep() {
    alignTick = nil
    guard let waiting = pending, var aligner = waiting.aligner, !waiting.fallback, let next = spare else { return }
    let old = current.alignReading()
    let reading = next.alignReading()
    if waiting.steps == 0, waitsForClock(waiting, old: old, reading: reading, next: next) {
      return scheduleAlign(waiting)
    }
    let sameKind = waiting.steps > 0 || (old?.clock == nil) == (reading?.clock == nil)
    guard let old, let reading, sameKind else {
      // A reading that went away (an item that changed kind): as before, reported.
      if waiting.steps > 0 { return apply(aligner.interrupt()) }
      // Not a progressive stream on both sides, nor HLS with program dates
      // on both (HLS without them, a remux, renditions of different kinds): at once, as before.
      observer?.driverNote(
        generation: waiting.generation, event: "quality switch not aligned", details: ["reason": "adaptive"])
      waiting.aligner = nil
      next.openBurst(from: 0)
      if waiting.ready { next.play() }
      return
    }
    // Both on the stream's clock: a seek any time.
    if waiting.steps == 0, reading.clock != nil, old.clock != nil {
      aligner = LiveAligner(caps: clockCaps)
      waiting.aligner = aligner
      waiting.clocked = true
    }
    // One that changed kind on the way (a clock come or gone): as before, reported.
    if waiting.steps > 0, (reading.clock != nil) != waiting.clocked || (old.clock != nil) != waiting.clocked {
      return apply(aligner.interrupt())
    }
    waiting.steps += 1
    let action = aligner.step(SystemClock.shared.monotonicMs, old: old, next: reading)
    if case .jump(let to) = action, reading.clock != nil {
      // HLS: moved by a seek.
      next.seek(to: to, exact: true)
    } else if case .jump(let to) = action {
      // AVPlayer gets its audio once the mapping is known: from where the aligner moved it, or all of it.
      next.openBurst(from: to)
    } else if aligner.offset != nil {
      next.openBurst(from: 0)
    }
    apply(action)
    scheduleAlign(waiting)
  }

  /// Whether a new item that may line up on program dates cannot say yet:
  /// still loading (as long as it takes), or, beside an old one on a clock,
  /// with the proxy not yet sure it is a playlist, or ready without a date
  /// (for `clockWaitMs`, counted once it has loaded).
  private func waitsForClock(
    _ waiting: Pending, old: LiveAligner.Reading?, reading: LiveAligner.Reading?, next: AVPlayerDriver
  ) -> Bool {
    if next.awaitsClock {
      waiting.clockWaitSince = nil
      return true
    }
    guard old?.clock != nil, reading?.clock == nil, next.mayHaveClock || next.unclassified else { return false }
    let now = SystemClock.shared.monotonicMs
    if waiting.clockWaitSince == nil { waiting.clockWaitSince = now }
    return now - waiting.clockWaitSince! < clockWaitMs
  }

  private func scheduleAlign(_ waiting: Pending) {
    guard pending === waiting, aligning else { return }
    let item = DispatchWorkItem { [weak self] in self?.alignStep() }
    alignTick = item
    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(LiveAligner.tickMs)), execute: item)
  }

  private func apply(_ action: LiveAligner.Action) {
    guard let waiting = pending, let next = spare else { return }
    switch action {
    case .wait, .jump:
      return
    case .rate(let r, let afterMs):
      waiting.alignRate = r == 0 ? 1 : r
      if r == 0 { return next.pause() }
      next.setRate(r * rate)
      guard afterMs > 0 else { return next.play() }
      // Due between two ticks: started on time.
      let item = DispatchWorkItem { [weak self] in
        guard let self, self.pending === waiting, self.aligning else { return }
        self.spare?.play()
      }
      alignStart = item
      DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(Int(afterMs)), execute: item)
    case .takeOver(let residual):
      observer?.driverNote(
        generation: waiting.generation, event: "quality switch aligned",
        details: [
          "residual": String(format: "%.3f", residual),
          "offset": String(format: "%.3f", waiting.aligner?.offset ?? 0),
        ])
      switched()
    case .fallback(let reason):
      // The old one stalls: the player needs the switch now.
      if reason == "stalled" { waiting.required = true }
      waiting.jump = waiting.aligner?.gap
      unaligned(waiting, next, reason: reason)
    }
  }

  /// A live switch that cannot be lined up: switched anyway, as a
  /// `discontinuity`, when the player needs it; else dropped, the current one
  /// playing on (`QUALITY_SWITCH_FAILED`).
  private func unaligned(_ waiting: Pending, _ next: AVPlayerDriver, reason: String) {
    var details = ["reason": reason]
    if let gap = waiting.aligner?.gap { details["gap"] = String(format: "%.3f", gap) }
    observer?.driverNote(generation: waiting.generation, event: "quality switch not aligned", details: details)
    alignTick?.cancel()
    alignTick = nil
    alignStart?.cancel()
    alignStart = nil
    guard waiting.required else {
      // The engine drops it (cancelSwap) and the app hears why.
      observer?.driverFailed(
        generation: waiting.generation,
        error: PlayerError(
          code: .qualitySwitchFailed,
          message: "The live switch could not be lined up with what is heard (\(reason)).", recoverable: true))
      return
    }
    waiting.fallback = true
    waiting.alignRate = 1
    next.openBurst(from: 0)
    next.setRate(rate)
    // Already playing (it was running): at once.
    if next.progress().isPlaying { return switched() }
    next.play()
  }

  /// The new driver takes over (its first audio, or lined up): the engine
  /// hears it play, its tracks, and a fallback's jump.
  private func switched() {
    guard let waiting = pending else { return }
    takeOver(generation: waiting.generation, live: waiting.target == nil)
    observer?.driverPlaying(generation: waiting.generation)
    // The engine took the switch's generation: the new file's tracks are the ones now.
    let media = current.mapped
    observer?.driverTracks(generation: waiting.generation, tracks: media.tracks, variants: media.variants)
    // What it reached while it lined up was the pending generation's: told now.
    if let metadata = waiting.metadata, waiting.metadataAt > toldCurrent {
      observer?.driverMetadata(generation: waiting.generation, metadata: metadata)
    }
    if waiting.fallback {
      observer?.driverDiscontinuity(
        generation: waiting.generation, position: sample().position, reason: "switch", jump: waiting.jump)
    }
  }

  /// The new file plays: it is the picture and the sound now.
  private func takeOver(generation: Int, live: Bool) {
    guard let next = spare else { return }
    let old = current
    tick?.cancel()
    tick = nil
    alignTick?.cancel()
    alignTick = nil
    alignStart?.cancel()
    alignStart = nil
    pending = nil
    // Live: the position goes on from where the old one was.
    shift = live ? next.sample().position - (old.sample().position - shift) : 0
    self.generation = generation
    next.setRate(rate)
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
    alignTick?.cancel()
    alignTick = nil
    alignStart?.cancel()
    alignStart = nil
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
      guard let owner, owner.switching(generation), let waiting = owner.pending, !waiting.ready else { return }
      waiting.ready = true
      owner.rendezvous()
    }

    func driverPlaying(generation: Int) {
      guard let owner, owner.switching(generation) else {
        target?.driverPlaying(generation: generation)
        return
      }
      // Lining up: the new driver plays muted, and takes over later.
      if !owner.aligning { owner.switched() }
    }

    func driverBuffering(generation: Int) { target?.driverBuffering(generation: generation) }
    func driverEnded(generation: Int) { target?.driverEnded(generation: generation) }
    func driverFailed(generation: Int, error: PlayerError) { target?.driverFailed(generation: generation, error: error) }
    func driverPausedExternally(generation: Int) { target?.driverPausedExternally(generation: generation) }
    func driverMetadata(generation: Int, metadata: StreamMetadata) {
      // The new driver's, while it lines up: told again once it is heard
      // (unless the old one told a later title since).
      if let owner {
        owner.told += 1
        if owner.switching(generation), let waiting = owner.pending {
          waiting.metadata = metadata
          waiting.metadataAt = owner.told
        } else if generation == owner.generation {
          owner.toldCurrent = owner.told
        }
      }
      target?.driverMetadata(generation: generation, metadata: metadata)
    }
    func driverPositionChanged() { target?.driverPositionChanged() }
    func driverNote(generation: Int, event: String, details: [String: String]) {
      target?.driverNote(generation: generation, event: event, details: details)
      // Either connection was replaced (the proxy spliced a fresh upstream):
      // its edge, and the mapping, no longer hold.
      if event == "upstream spliced", let owner, owner.aligning, let aligner = owner.pending?.aligner {
        owner.apply(aligner.interrupt())
      }
    }
    func driverDiscontinuity(generation: Int, position: Double, reason: String, jump: Double?) {
      guard let owner else { return }
      let shifted = generation == owner.generation ? position - owner.shift : position
      target?.driverDiscontinuity(generation: generation, position: shifted, reason: reason, jump: jump)
      // Either connection jumped: the two no longer line up.
      if owner.aligning, let aligner = owner.pending?.aligner { owner.apply(aligner.interrupt()) }
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
