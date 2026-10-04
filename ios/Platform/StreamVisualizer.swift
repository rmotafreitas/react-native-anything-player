import AVFoundation
import AudioToolbox
import os

private let visualizerLog = Logger(subsystem: "com.radioanimu.airwave", category: "audio-tap")

/// Decodes a stream's compressed audio (MP3, AAC / HE-AAC in ADTS) to mono
/// float PCM with AudioToolbox. Fed the bytes the proxy relays to AVPlayer.
///
/// Not thread-safe: one instance is fed from one queue.
final class StreamDecoder {
  /// `(mono frames, sample rate)` for every decoded packet.
  var onPCM: (([Float], Double) -> Void)?
  /// Parse only: count the stream's duration, decode nothing (cheap).
  var countOnly = false
  /// Seconds of audio in the packets parsed so far.
  private(set) var parsedSeconds = 0.0

  private var stream: AudioFileStreamID?
  private var converter: AudioConverterRef?
  private var source = AudioStreamBasicDescription()
  private var output = AudioStreamBasicDescription()
  // The packet the converter's input callback hands over.
  fileprivate var packet: UnsafeRawPointer?
  fileprivate var packetBytes: UInt32 = 0
  fileprivate var packetDescription = AudioStreamPacketDescription()
  fileprivate var packetConsumed = true
  private var pcm = [Float](repeating: 0, count: 8192)

  init(contentType: String?) {
    let type = Self.fileType(contentType)
    let status = AudioFileStreamOpen(
      Unmanaged.passUnretained(self).toOpaque(), streamProperty, streamPackets, type, &stream)
    if status != noErr { visualizerLog.error("AudioFileStreamOpen failed: \(status)") }
  }

  deinit {
    if let stream { AudioFileStreamClose(stream) }
    if let converter { AudioConverterDispose(converter) }
  }

  func feed(_ data: Data) {
    guard let stream, !data.isEmpty else { return }
    data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress else { return }
      // A spliced upstream starts mid-frame: the parser resynchronizes itself.
      _ = AudioFileStreamParseBytes(stream, UInt32(raw.count), base, [])
    }
  }

  private static func fileType(_ contentType: String?) -> AudioFileTypeID {
    let type = contentType?.lowercased() ?? ""
    if type.contains("aac") || type.contains("mp4a") { return kAudioFileAAC_ADTSType }
    return kAudioFileMP3Type
  }

  fileprivate func readyToProducePackets() {
    guard let stream else { return }
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    guard AudioFileStreamGetProperty(stream, kAudioFileStreamProperty_DataFormat, &size, &source) == noErr else { return }
    let channels = max(1, source.mChannelsPerFrame)
    output = AudioStreamBasicDescription(
      mSampleRate: source.mSampleRate, mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
      mBytesPerPacket: 4 * channels, mFramesPerPacket: 1, mBytesPerFrame: 4 * channels,
      mChannelsPerFrame: channels, mBitsPerChannel: 32, mReserved: 0)
    if let converter { AudioConverterDispose(converter) }
    converter = nil
    if countOnly { return }
    guard AudioConverterNew(&source, &output, &converter) == noErr, let converter else {
      visualizerLog.error("AudioConverterNew failed for format \(self.source.mFormatID)")
      return
    }
    var cookieSize: UInt32 = 0
    if AudioFileStreamGetPropertyInfo(stream, kAudioFileStreamProperty_MagicCookieData, &cookieSize, nil) == noErr,
      cookieSize > 0
    {
      var cookie = [UInt8](repeating: 0, count: Int(cookieSize))
      if AudioFileStreamGetProperty(stream, kAudioFileStreamProperty_MagicCookieData, &cookieSize, &cookie) == noErr {
        AudioConverterSetProperty(converter, kAudioConverterDecompressionMagicCookie, cookieSize, cookie)
      }
    }
    visualizerLog.debug("decoding \(self.source.mSampleRate) Hz × \(channels)")
  }

  fileprivate func packets(
    _ bytes: UInt32, _ count: UInt32, _ data: UnsafeRawPointer,
    _ descriptions: UnsafeMutablePointer<AudioStreamPacketDescription>?
  ) {
    guard let descriptions, source.mSampleRate > 0 else { return }
    for i in 0..<Int(count) {
      let frames = descriptions[i].mVariableFramesInPacket > 0 ? descriptions[i].mVariableFramesInPacket : source.mFramesPerPacket
      parsedSeconds += Double(frames) / source.mSampleRate
    }
    guard !countOnly, let converter else { return }
    let channels = Int(max(1, output.mChannelsPerFrame))
    for i in 0..<Int(count) {
      let description = descriptions[i]
      packet = data.advanced(by: Int(description.mStartOffset))
      packetBytes = description.mDataByteSize
      packetDescription = AudioStreamPacketDescription(
        mStartOffset: 0, mVariableFramesInPacket: description.mVariableFramesInPacket,
        mDataByteSize: description.mDataByteSize)
      packetConsumed = false
      let capacity = pcm.count / channels
      var frames = UInt32(capacity)
      let produced: Int = pcm.withUnsafeMutableBytes { raw -> Int in
        var list = AudioBufferList(
          mNumberBuffers: 1,
          mBuffers: AudioBuffer(
            mNumberChannels: UInt32(channels), mDataByteSize: UInt32(raw.count), mData: raw.baseAddress))
        let status = AudioConverterFillComplexBuffer(
          converter, converterInput, Unmanaged.passUnretained(self).toOpaque(), &frames, &list, nil)
        // "No more input" (our own sentinel) still yields the frames decoded so far.
        return status == noErr || status == noMoreInput ? Int(frames) : 0
      }
      guard produced > 0 else { continue }
      var mono = [Float](repeating: 0, count: produced)
      for f in 0..<produced {
        var sum: Float = 0
        for c in 0..<channels { sum += pcm[f * channels + c] }
        mono[f] = sum / Float(channels)
      }
      onPCM?(mono, output.mSampleRate)
    }
  }
}

private let noMoreInput: OSStatus = 0x6E6F_6D6F  // 'nomo'

private let streamProperty: AudioFileStream_PropertyListenerProc = { client, _, property, _ in
  guard property == kAudioFileStreamProperty_ReadyToProducePackets else { return }
  Unmanaged<StreamDecoder>.fromOpaque(client).takeUnretainedValue().readyToProducePackets()
}

private let streamPackets: AudioFileStream_PacketsProc = { client, bytes, count, data, descriptions in
  Unmanaged<StreamDecoder>.fromOpaque(client).takeUnretainedValue().packets(bytes, count, data, descriptions)
}

private let converterInput: AudioConverterComplexInputDataProc = { _, ioPackets, ioData, outDescription, client in
  let decoder = Unmanaged<StreamDecoder>.fromOpaque(client!).takeUnretainedValue()
  guard !decoder.packetConsumed, let packet = decoder.packet else {
    ioPackets.pointee = 0
    return noMoreInput
  }
  decoder.packetConsumed = true
  ioPackets.pointee = 1
  ioData.pointee.mNumberBuffers = 1
  ioData.pointee.mBuffers.mData = UnsafeMutableRawPointer(mutating: packet)
  ioData.pointee.mBuffers.mDataByteSize = decoder.packetBytes
  ioData.pointee.mBuffers.mNumberChannels = 0
  if let outDescription {
    withUnsafeMutablePointer(to: &decoder.packetDescription) { outDescription.pointee = $0 }
  }
  return noErr
}

/// Turns decoded stream PCM into visualizer windows and releases each one
/// when it is *heard*: windows are stamped with their position in the stream
/// and emitted when the player item's timebase (the clock of the audio being
/// rendered) reaches it. The decoder runs seconds ahead of the speaker (the
/// player's buffer); the queue absorbs that lead.
final class StreamVisualizer {
  private struct Window {
    let time: Double
    let waveform: [Float]
    let level: Double
    let duration: Double
  }

  /// Seconds per window (~43 windows/s, the cadence of a decoded buffer).
  private static let windowSeconds = 1024.0 / 44_100
  /// Windows further ahead than this are dropped (bounded memory).
  private static let maxQueueSeconds = 40.0

  /// Set from any thread; applied on the visualizer queue.
  var points: Int {
    get { queue.sync { size } }
    set { queue.async { self.size = newValue } }
  }
  var onWindow: ((AudioWindow) -> Void)? {
    get { queue.sync { handler } }
    set { queue.async { self.handler = newValue } }
  }
  private var size = 1024
  private var handler: ((AudioWindow) -> Void)?

  private let queue = DispatchQueue(label: "airwave.visualizer")
  private var decoder: StreamDecoder?
  private var pending: [Float] = []
  private var framesDecoded: Int64 = 0
  private var originSeconds = 0.0
  private var windows: [Window] = []
  private var timebase: CMTimebase?
  private var timer: DispatchSourceTimer?

  /// Restarts the timeline for a new item: the next bytes fed start at 0 s.
  func reset() {
    queue.async { [self] in
      decoder = nil
      pending.removeAll()
      originSeconds = 0
      framesDecoded = 0
      windows.removeAll()
    }
  }

  /// Starts mid-stream from the audio the proxy relayed most recently.
  ///
  /// `recent` starts at `recentStart` seconds of the stream (stamped by a
  /// packet clock as it was relayed). Decoding it lets windows start at once —
  /// from the playhead — instead of after the whole buffer (seconds) has
  /// played out.
  func prime(recent: Data, recentStart: Double, contentType: String?, playhead: Double) {
    queue.async { [self] in
      let decoder = StreamDecoder(contentType: contentType)
      var decoded: [Float] = []
      var rate = 44_100.0
      decoder.onPCM = { mono, r in
        decoded.append(contentsOf: mono)
        rate = r
      }
      decoder.feed(recent)
      decoder.onPCM = { [weak self] mono, r in self?.append(mono, rate: r) }
      self.decoder = decoder
      pending.removeAll()
      windows.removeAll()
      framesDecoded = 0
      let start = recentStart
      // Skip what was already heard.
      let skip = min(decoded.count, max(0, Int(((playhead - start) * rate).rounded(.down))))
      originSeconds = start + Double(skip) / rate
      if skip < decoded.count { append(Array(decoded[skip...]), rate: rate) }
      visualizerLog.debug(
        "primed \(decoded.count) frames from \(recentStart)s, playhead=\(playhead)")
    }
  }

  /// Proxy queue → visualizer queue: compressed audio bytes of the main response.
  func feed(_ data: Data, contentType: String?) {
    queue.async { [self] in
      if decoder == nil {
        decoder = StreamDecoder(contentType: contentType)
        decoder?.onPCM = { [weak self] mono, rate in self?.append(mono, rate: rate) }
      }
      decoder?.feed(data)
    }
  }

  /// The ready item's clock; windows are released against it.
  func start(timebase: CMTimebase?) {
    queue.async { [self] in
      self.timebase = timebase
      guard timer == nil else { return }
      let source = DispatchSource.makeTimerSource(queue: queue)
      source.schedule(deadline: .now(), repeating: .milliseconds(8))
      source.setEventHandler { [weak self] in self?.tick() }
      source.resume()
      timer = source
    }
  }

  func stop() {
    queue.async { [self] in
      timer?.cancel()
      timer = nil
      decoder = nil
      windows.removeAll()
      pending.removeAll()
      timebase = nil
    }
  }

  private func append(_ mono: [Float], rate: Double) {
    pending.append(contentsOf: mono)
    let hop = max(64, Int(rate * Self.windowSeconds))
    while pending.count >= hop {
      let frames = Array(pending.prefix(hop))
      pending.removeFirst(hop)
      var sum = 0.0
      for v in frames { sum += Double(v * v) }
      windows.append(
        Window(
          time: originSeconds + Double(framesDecoded) / rate,
          waveform: AudioTap.resample(frames, count: frames.count, to: size),
          level: min(1, (sum / Double(frames.count)).squareRoot()),
          duration: Double(hop) / rate))
      framesDecoded += Int64(hop)
    }
    if let first = windows.first, let last = windows.last, last.time - first.time > Self.maxQueueSeconds {
      windows.removeFirst(windows.count / 2)
    }
  }

  private func tick() {
    guard let timebase, let callback = handler, !windows.isEmpty else { return }
    let now = CMTimebaseGetTime(timebase).seconds
    guard now.isFinite else { return }
    // Everything at or before the playhead is due; only the newest is drawn.
    guard let index = windows.lastIndex(where: { $0.time <= now }) else { return }
    let window = windows[index]
    windows.removeFirst(index + 1)
    callback(
      AudioWindow(
        waveform: window.waveform, level: window.level, duration: window.duration,
        outputLatency: 0, timestampMs: Int64(Date().timeIntervalSince1970 * 1000)))
  }
}
