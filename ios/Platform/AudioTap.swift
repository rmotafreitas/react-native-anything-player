import AVFoundation
import MediaToolbox
import os

private let tapLog = Logger(subsystem: "com.anythingplayer", category: "audio-tap")

/// One decoded window, downmixed to mono and resampled to the requested size.
struct AudioWindow {
  let waveform: [Float]
  let level: Double
  let duration: Double
  let outputLatency: Double
  let timestampMs: Int64
}

/// Decoded-PCM tap for visualizers: an `MTAudioProcessingTap` on the item's
/// audio track, fed by AVPlayer's render pipeline.
///
/// Attached to the *player item's* audio track once the item is ready (the
/// asset's own track list can be empty for an HTTP stream at that point).
///
/// The render thread only downmixes to mono and measures the level, into a
/// buffer allocated in the tap's `prepare` (each attached tap has its own,
/// see `TapContext`), and hands a copy (≤ 125 windows/s) to `delivery`. The
/// resampling, the timestamp, the output latency (cached off the render
/// thread: querying `AVAudioSession` can block, QA1715) and the callback run
/// there, so JS still gets a ready-to-draw waveform.
final class AudioTap {
  static let isSupported = true

  /// Called on the tap's delivery queue (never on the render thread).
  var onWindow: ((AudioWindow) -> Void)? {
    get { withState { handler } }
    set {
      withState { () -> Void in
        handler = newValue
        emitting = newValue != nil
      }
    }
  }
  var points: Int {
    get { withState { size } }
    set { withState { size = newValue } }
  }

  /// Guards `handler`, `size` and `emitting`. An unfair lock, held only for a
  /// few field reads or writes: the render thread takes it too.
  private let stateLock: UnsafeMutablePointer<os_unfair_lock>
  private var handler: ((AudioWindow) -> Void)?
  private var size = 1024
  /// `handler != nil`, read on the render thread (no closure copied there).
  private var emitting = false
  private let delivery = DispatchQueue(label: "anythingplayer.audio-tap", qos: .userInitiated)
  private weak var attachedItem: AVPlayerItem?

  init() {
    stateLock = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
    stateLock.initialize(to: os_unfair_lock())
  }

  deinit {
    stateLock.deinitialize(count: 1)
    stateLock.deallocate()
  }

  private func withState<T>(_ body: () -> T) -> T {
    os_unfair_lock_lock(stateLock)
    defer { os_unfair_lock_unlock(stateLock) }
    return body()
  }

  // MARK: - Output latency (cached off the render thread)

  private static let latencyLock = NSLock()
  private static var cachedLatency = 0.0

  /// Output latency + IO buffer duration, as the session reports them now.
  /// Main thread: when the session activates, the route changes, a tap attaches.
  static func refreshOutputLatency() {
    let session = AVAudioSession.sharedInstance()
    let latency = session.outputLatency + session.ioBufferDuration
    latencyLock.sync { cachedLatency = latency }
  }

  private static var outputLatency: Double { latencyLock.sync { cachedLatency } }

  /// Installs the tap on `item` (once per item). False when it has no audio track yet.
  @discardableResult
  func attach(to item: AVPlayerItem) -> Bool {
    if attachedItem === item { return true }
    guard let track = item.tracks.first(where: { $0.assetTrack?.mediaType == .audio })?.assetTrack else {
      return false
    }
    Self.refreshOutputLatency()
    // The tap owns its context (released in `tapFinalize`); the context keeps this tap alive.
    let context = Unmanaged.passRetained(TapContext(owner: self))
    var callbacks = MTAudioProcessingTapCallbacks(
      version: kMTAudioProcessingTapCallbacksVersion_0,
      clientInfo: UnsafeMutableRawPointer(context.toOpaque()),
      init: tapInit, finalize: tapFinalize, prepare: tapPrepare, unprepare: tapUnprepare, process: tapProcess)
    var tap: MTAudioProcessingTap?
    let status = MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap)
    guard status == noErr, let tap else {
      tapLog.error("MTAudioProcessingTapCreate failed: \(status)")
      context.release()
      return false
    }
    let parameters = AVMutableAudioMixInputParameters(track: track)
    parameters.audioTapProcessor = tap
    let mix = AVMutableAudioMix()
    mix.inputParameters = [parameters]
    item.audioMix = mix
    attachedItem = item
    tapLog.debug("tap attached")
    return true
  }

  /// Render thread: whether anyone wants windows.
  fileprivate var isEmitting: Bool { withState { emitting } }

  /// Render thread → `delivery`: one downmixed window.
  fileprivate func deliver(_ mono: [Float], level: Double, duration: Double) {
    delivery.async { [weak self] in
      guard let self else { return }
      let (callback, points) = self.withState { (self.handler, self.size) }
      guard let callback else { return }
      callback(
        AudioWindow(
          waveform: AudioTap.resample(mono, count: mono.count, to: points),
          level: level,
          duration: duration,
          outputLatency: AudioTap.outputLatency,
          timestampMs: Int64(Date().timeIntervalSince1970 * 1000)))
    }
  }

  static func resample(_ source: [Float], count: Int, to size: Int) -> [Float] {
    guard count > 1, size > 1 else { return [Float](repeating: source.first ?? 0, count: size) }
    var out = [Float](repeating: 0, count: size)
    let step = Double(count - 1) / Double(size - 1)
    for i in 0..<size {
      let x = Double(i) * step
      let i0 = min(Int(x), count - 1)
      let i1 = min(i0 + 1, count - 1)
      let t = Float(x - Double(i0))
      out[i] = source[i0] + (source[i1] - source[i0]) * t
    }
    return out
  }
}

/// The state of one attached `MTAudioProcessingTap` (one per item). Its
/// `prepare`, `process` and `unprepare` callbacks never run concurrently, so
/// these fields need no lock; two items' taps never share a buffer.
private final class TapContext {
  let owner: AudioTap
  private var format = AudioStreamBasicDescription()
  /// Mono scratch buffer, `capacity` frames (the tap's maxFrames).
  private var mono: UnsafeMutablePointer<Float>?
  private var capacity = 0
  private var lastEmit: UInt64 = 0

  init(owner: AudioTap) { self.owner = owner }

  deinit { freeBuffer() }

  /// Not the render thread: allocates for the largest render the tap will see.
  func prepare(maxFrames: Int, format description: AudioStreamBasicDescription) {
    freeBuffer()
    format = description
    let frames = max(0, maxFrames)
    guard frames > 0 else { return }
    let buffer = UnsafeMutablePointer<Float>.allocate(capacity: frames)
    buffer.initialize(repeating: 0, count: frames)
    mono = buffer
    capacity = frames
  }

  func unprepare() { freeBuffer() }

  private func freeBuffer() {
    guard let mono else { return }
    mono.deinitialize(count: capacity)
    mono.deallocate()
    self.mono = nil
    capacity = 0
  }

  /// Render thread: no allocation but the one copy handed to `delivery`
  /// (rate-limited to one window per 8 ms), no blocking calls.
  func process(_ buffers: UnsafeMutableAudioBufferListPointer, frames: Int) {
    guard frames > 0, let mono, frames <= capacity, owner.isEmitting else { return }
    let now = DispatchTime.now().uptimeNanoseconds
    guard now - lastEmit >= 8_000_000 else { return }
    lastEmit = now
    let fmt = format
    // AVPlayer's tap format is 32-bit float; interleaved or one buffer per channel.
    guard fmt.mFormatID == kAudioFormatLinearPCM, fmt.mFormatFlags & kAudioFormatFlagIsFloat != 0 else { return }
    let channels = max(1, Int(fmt.mChannelsPerFrame))
    let interleaved = fmt.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    var sumSquares = 0.0
    for f in 0..<frames {
      var sum: Float = 0
      if interleaved {
        guard let data = buffers.first?.mData?.assumingMemoryBound(to: Float.self) else { return }
        for c in 0..<channels { sum += data[f * channels + c] }
      } else {
        for c in 0..<min(channels, buffers.count) {
          guard let data = buffers[c].mData?.assumingMemoryBound(to: Float.self) else { continue }
          sum += data[f]
        }
      }
      let v = sum / Float(channels)
      mono[f] = v
      sumSquares += Double(v * v)
    }
    owner.deliver(
      Array(UnsafeBufferPointer(start: mono, count: frames)),
      level: min(1, (sumSquares / Double(frames)).squareRoot()),
      duration: Double(frames) / max(1, fmt.mSampleRate))
  }
}

// MARK: - C callbacks

private func context(of tap: MTAudioProcessingTap) -> TapContext {
  Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
}

private let tapInit: MTAudioProcessingTapInitCallback = { _, clientInfo, storageOut in
  storageOut.pointee = clientInfo
}

private let tapFinalize: MTAudioProcessingTapFinalizeCallback = { tap in
  Unmanaged<TapContext>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
}

private let tapPrepare: MTAudioProcessingTapPrepareCallback = { tap, maxFrames, format in
  context(of: tap).prepare(maxFrames: Int(maxFrames), format: format.pointee)
}

private let tapUnprepare: MTAudioProcessingTapUnprepareCallback = { tap in
  context(of: tap).unprepare()
}

private let tapProcess: MTAudioProcessingTapProcessCallback = {
  tap, frames, _, bufferList, framesOut, flagsOut in
  guard MTAudioProcessingTapGetSourceAudio(tap, frames, bufferList, flagsOut, nil, framesOut) == noErr else { return }
  context(of: tap).process(UnsafeMutableAudioBufferListPointer(bufferList), frames: Int(framesOut.pointee))
}
