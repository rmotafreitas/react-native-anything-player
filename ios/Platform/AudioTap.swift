import AVFoundation
import MediaToolbox
import os

private let tapLog = Logger(subsystem: "com.radioanimu.airwave", category: "audio-tap")

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
/// Windows are downmixed and resampled on the render thread, so JS gets a
/// ready-to-draw waveform.
final class AudioTap {
  static let isSupported = true

  /// Called on the audio render thread.
  var onWindow: ((AudioWindow) -> Void)? {
    get { state.sync { handler } }
    set { state.sync { handler = newValue } }
  }
  var points: Int {
    get { state.sync { size } }
    set { state.sync { size = newValue } }
  }

  private let state = NSLock()
  private var handler: ((AudioWindow) -> Void)?
  private var size = 1024
  fileprivate var format = AudioStreamBasicDescription()
  private var lastEmit: UInt64 = 0
  private var mono: [Float] = []
  private weak var attachedItem: AVPlayerItem?

  /// Installs the tap on `item` (once per item). False when it has no audio track yet.
  @discardableResult
  func attach(to item: AVPlayerItem) -> Bool {
    if attachedItem === item { return true }
    guard let track = item.tracks.first(where: { $0.assetTrack?.mediaType == .audio })?.assetTrack else {
      return false
    }
    var callbacks = MTAudioProcessingTapCallbacks(
      version: kMTAudioProcessingTapCallbacksVersion_0,
      clientInfo: UnsafeMutableRawPointer(Unmanaged.passRetained(self).toOpaque()),
      init: tapInit, finalize: tapFinalize, prepare: tapPrepare, unprepare: nil, process: tapProcess)
    var tap: MTAudioProcessingTap?
    let status = MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PostEffects, &tap)
    guard status == noErr, let tap else {
      tapLog.error("MTAudioProcessingTapCreate failed: \(status)")
      Unmanaged.passUnretained(self).release()
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

  fileprivate func prepare(_ description: AudioStreamBasicDescription) {
    state.sync { format = description }
  }

  /// Render thread.
  fileprivate func process(_ buffers: UnsafeMutableAudioBufferListPointer, frames: Int) {
    let (callback, points, fmt) = state.sync { (handler, size, format) }
    guard let callback, frames > 0 else { return }
    let now = DispatchTime.now().uptimeNanoseconds
    guard now - lastEmit >= 8_000_000 else { return }
    lastEmit = now
    // AVPlayer's tap format is 32-bit float; interleaved or one buffer per channel.
    guard fmt.mFormatID == kAudioFormatLinearPCM, fmt.mFormatFlags & kAudioFormatFlagIsFloat != 0 else { return }
    let channels = max(1, Int(fmt.mChannelsPerFrame))
    let interleaved = fmt.mFormatFlags & kAudioFormatFlagIsNonInterleaved == 0
    if mono.count < frames { mono = [Float](repeating: 0, count: frames) }
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
    let session = AVAudioSession.sharedInstance()
    callback(
      AudioWindow(
        waveform: Self.resample(mono, count: frames, to: points),
        level: min(1, (sumSquares / Double(frames)).squareRoot()),
        duration: Double(frames) / max(1, fmt.mSampleRate),
        outputLatency: session.outputLatency + session.ioBufferDuration,
        timestampMs: Int64(Date().timeIntervalSince1970 * 1000)))
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

// MARK: - C callbacks

private let tapInit: MTAudioProcessingTapInitCallback = { _, clientInfo, storageOut in
  storageOut.pointee = clientInfo
}

private let tapFinalize: MTAudioProcessingTapFinalizeCallback = { tap in
  Unmanaged<AudioTap>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).release()
}

private let tapPrepare: MTAudioProcessingTapPrepareCallback = { tap, _, format in
  Unmanaged<AudioTap>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue().prepare(format.pointee)
}

private let tapProcess: MTAudioProcessingTapProcessCallback = {
  tap, frames, _, bufferList, framesOut, flagsOut in
  guard MTAudioProcessingTapGetSourceAudio(tap, frames, bufferList, flagsOut, nil, framesOut) == noErr else { return }
  let owner = Unmanaged<AudioTap>.fromOpaque(MTAudioProcessingTapGetStorage(tap)).takeUnretainedValue()
  owner.process(UnsafeMutableAudioBufferListPointer(bufferList), frames: Int(framesOut.pointee))
}
