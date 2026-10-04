import AVFoundation
import Foundation

/// Keeps the app *rendering* audio while a backgrounded player wants playback
/// but has none to play (loading, stalled, reconnecting).
///
/// Why: iOS suspends a background app a few seconds after it stops producing
/// audio. Suspension freezes everything — timers, network callbacks, the
/// reconnect chain — and nothing wakes the app when the network comes back,
/// so a tunnel outage ends in silence until the user reopens the app. A
/// near-silent signal (±1 LSB dither, ≈ −90 dBFS) keeps the session rendering
/// through the outage. It runs only while recovery is in progress, so it is
/// bounded by the engine's give-up limit, and never while audio flows.
///
/// AVAudioEngine instead of a looping AVPlayer: no bundled asset, and no
/// item-queue looping that can run dry (the original keepalive stopped after
/// ~10 loops in production).
final class BackgroundKeepalive {
  private var engine: AVAudioEngine?
  private var configObserver: NSObjectProtocol?
  private(set) var running = false

  func start() {
    guard !running else { return }
    let engine = AVAudioEngine()
    let format = engine.outputNode.inputFormat(forBus: 0)
    let sampleRate = format.sampleRate > 0 ? format.sampleRate : 44_100
    guard
      let mono = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 1)
    else { return }
    var state: UInt32 = 0x1234_5678
    let lsb: Float = 1.0 / 32_768
    let source = AVAudioSourceNode(format: mono) { _, _, frameCount, bufferList -> OSStatus in
      let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
      for buffer in buffers {
        guard let data = buffer.mData?.assumingMemoryBound(to: Float.self) else { continue }
        for i in 0..<Int(frameCount) {
          // xorshift dither: never exactly zero, so no stage can elide it.
          state ^= state << 13
          state ^= state >> 17
          state ^= state << 5
          data[i] = (state & 1) == 0 ? lsb : -lsb
        }
      }
      return noErr
    }
    engine.attach(source)
    engine.connect(source, to: engine.mainMixerNode, format: mono)
    engine.mainMixerNode.outputVolume = 1
    do {
      try engine.start()
    } catch {
      return
    }
    self.engine = engine
    running = true
    // Route changes stop the engine; restart it while it is still wanted.
    configObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
    ) { [weak self] _ in
      guard let self, self.running else { return }
      self.stop()
      self.start()
    }
  }

  func stop() {
    guard running else { return }
    running = false
    if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
    configObserver = nil
    engine?.stop()
    engine = nil
  }
}
