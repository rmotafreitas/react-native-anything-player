import Foundation

/// A streaming MPEG-TS demuxer (also M2TS's 192-byte packets): bytes in, in
/// chunks of any size; the first program's video and audio out. Video access
/// units leave as MP4 samples (4-byte NAL lengths, the parameter sets moved
/// to the track's configuration), audio as single frames. Times stay on the
/// stream's 90 kHz clock, unwrapped past the 33-bit rollover; the remuxer
/// moves them to zero. Packets that lose sync are skipped up to the next sync.
///
/// The TypeScript twin is src/web/remux/MpegTs.ts.
final class TsDemuxer {
  private static let packet = 188
  private static let syncByte: UInt8 = 0x47
  private static let ptsWrap = 1 << 33

  /// `probe`: a private stream without a descriptor that says what it is (HDMV's AAC): its first frame does.
  private enum StreamKind {
    case h264, hevc, aac, mpeg, ac3, eac3, probe
  }

  private final class Stream {
    let track: RemuxTrack
    var kind: StreamKind
    var parts: [[UInt8]] = []
    var size = 0
    var expected = 0
    var carry: [UInt8] = []
    var held: (pts: Int?, data: [UInt8])?
    var params: [[[UInt8]]] = []
    init(track: RemuxTrack, kind: StreamKind) {
      self.track = track
      self.kind = kind
    }
  }

  let clock = 90000
  private(set) var tracks: [RemuxTrack] = []
  /// The program's streams are known (its PMT was read).
  private(set) var tracksKnown = false

  private var packetSize = 0
  private var carry: [UInt8] = []
  private var pmtPid = -1
  private var sections: [Int: [UInt8]] = [:]
  private var streams: [Int: Stream] = [:]
  /// PIDs in the PMT's order (`streams` is unordered).
  private var order: [Int] = []
  private var reference: Int?

  func push(_ chunk: [UInt8], _ sink: DemuxSink) {
    let data = carry.isEmpty ? chunk : carry + chunk
    var at = 0
    if packetSize == 0 {
      guard let found = Self.findSync(data, from: 0) else {
        carry = Array(data[max(0, data.count - 3 * 192)...])
        return
      }
      packetSize = found.size
      at = found.at
    }
    let size = packetSize
    let lead = size - Self.packet
    while at + size <= data.count {
      if data[at + lead] != Self.syncByte {
        guard let found = Self.findSync(data, from: at + 1, only: size) else {
          at = max(at + 1, data.count - 2 * size)
          break
        }
        at = found.at
        continue
      }
      packet(Array(data[(at + lead)..<(at + lead + Self.packet)]), sink)
      at += size
    }
    carry = at < data.count ? Array(data[at...]) : []
  }

  /// The stream ended: the PES being assembled is complete.
  func end(_ sink: DemuxSink) {
    for pid in order {
      guard let stream = streams[pid] else { continue }
      flushPes(stream, sink)
      release(stream, sink)
    }
  }

  /// The next bytes pushed come from elsewhere in the file (a seek).
  func seek() {
    carry = []
    sections = [:]
    for stream in streams.values {
      stream.parts = []
      stream.size = 0
      stream.carry = []
      stream.held = nil
    }
  }

  private func packet(_ p: [UInt8], _ sink: DemuxSink) {
    let start = p[1] & 0x40 != 0
    let pid = (Int(p[1]) & 0x1F) << 8 | Int(p[2])
    let control = Int(p[3] >> 4) & 3
    guard control & 1 != 0 else { return }
    var at = 4
    if control & 2 != 0 { at += 1 + Int(p[4]) }
    guard at < Self.packet else { return }
    let payload = Array(p[at...])
    if pid == 0 || pid == pmtPid {
      section(pid, payload, start)
      return
    }
    if let stream = streams[pid] { pes(stream, payload, start, sink) }
  }

  // MARK: - Program tables

  private func section(_ pid: Int, _ payload: [UInt8], _ start: Bool) {
    var data: [UInt8]
    if start {
      data = Bytes.slice(payload, 1 + Int(payload[0]), payload.count)
    } else {
      guard let previous = sections[pid] else { return }
      data = previous + payload
    }
    if data.count < 3 {
      sections[pid] = data
      return
    }
    let length = 3 + ((Int(data[1]) & 0x0F) << 8 | Int(data[2]))
    if data.count < length {
      sections[pid] = data
      return
    }
    sections[pid] = nil
    let section = Array(data[0..<length])
    if pid == 0 && section[0] == 0x00 {
      pat(section)
    } else if section[0] == 0x02 {
      pmt(section)
    }
  }

  private func pat(_ section: [UInt8]) {
    var at = 8
    while at + 4 <= section.count - 4 {
      let program = Bytes.readUint(section, at, 2)
      if program != 0 {
        if pmtPid < 0 { pmtPid = Bytes.readUint(section, at + 2, 2) & 0x1FFF }
        return
      }
      at += 4
    }
  }

  private func pmt(_ section: [UInt8]) {
    guard !tracksKnown else { return }
    let infoLength = Bytes.readUint(section, 10, 2) & 0x0FFF
    var at = 12 + infoLength
    while at + 5 <= section.count - 4 {
      let type = Int(section[at])
      let pid = Bytes.readUint(section, at + 1, 2) & 0x1FFF
      let esLength = Bytes.readUint(section, at + 3, 2) & 0x0FFF
      let descriptors = Bytes.slice(section, at + 5, at + 5 + esLength)
      at += 5 + esLength
      guard let known = Self.streamKind(type, descriptors), streams[pid] == nil else { continue }
      let track = RemuxTrack(id: pid, kind: known.track)
      track.language = Self.languageOf(descriptors)
      track.unsupported = known.reason
      if known.track == .video { track.timescale = clock }
      tracks.append(track)
      guard let kind = known.kind else { continue }
      streams[pid] = Stream(track: track, kind: kind)
      order.append(pid)
    }
    tracksKnown = true
  }

  /// The stream type (and descriptors) → what RNAP makes of it.
  private static func streamKind(
    _ type: Int, _ descriptors: [UInt8]
  ) -> (kind: StreamKind?, track: RemuxTrackKind, reason: String?)? {
    switch type {
    case 0x1B: return (.h264, .video, nil)
    case 0x24: return (.hevc, .video, nil)
    case 0x0F: return (.aac, .audio, nil)
    case 0x03, 0x04: return (.mpeg, .audio, nil)
    case 0x81: return (.ac3, .audio, nil)
    case 0x87, 0x84: return (.eac3, .audio, nil)
    case 0x80: return (nil, .audio, "LPCM")
    case 0x82, 0x85, 0x86: return (nil, .audio, "DTS")
    case 0x83: return (nil, .audio, "TrueHD")
    case 0x90: return (nil, .text, "PGS subtitles")
    case 0xEA: return (nil, .video, "VC-1")
    case 0x01, 0x02: return (nil, .video, "MPEG-2 video")
    case 0x10: return (nil, .video, "MPEG-4 Visual")
    case 0x11: return (nil, .audio, "AAC in LATM")
    case 0x06: return privateStream(descriptors)
    default: return nil
    }
  }

  /// A DVB private stream: AC-3, E-AC-3 or subtitles, by its descriptors.
  private static func privateStream(_ descriptors: [UInt8]) -> (kind: StreamKind?, track: RemuxTrackKind, reason: String?) {
    var at = 0
    while at + 2 <= descriptors.count {
      let tag = descriptors[at]
      let length = Int(descriptors[at + 1])
      let body = Bytes.slice(descriptors, at + 2, at + 2 + length)
      let registration = tag == 0x05 ? String(decoding: body.prefix(4), as: UTF8.self) : ""
      if tag == 0x6A || registration == "AC-3" { return (.ac3, .audio, nil) }
      if tag == 0x7A || registration == "EAC3" { return (.eac3, .audio, nil) }
      if tag == 0x59 { return (nil, .text, "DVB subtitles") }
      if tag == 0x56 { return (nil, .text, "teletext") }
      at += 2 + length
    }
    return (.probe, .audio, nil)
  }

  /// The ISO 639 language descriptor's code, if any.
  private static func languageOf(_ descriptors: [UInt8]) -> String? {
    var at = 0
    while at + 2 <= descriptors.count {
      let length = Int(descriptors[at + 1])
      if descriptors[at] == 0x0A && length >= 3 {
        guard at + 5 <= descriptors.count else { return nil }
        let code = String(decoding: descriptors[(at + 2)..<(at + 5)], as: UTF8.self)
        let letters = code.unicodeScalars.allSatisfy {
          ($0.value >= 65 && $0.value <= 90) || ($0.value >= 97 && $0.value <= 122)
        }
        return code.unicodeScalars.count == 3 && letters ? code.lowercased() : nil
      }
      at += 2 + length
    }
    return nil
  }

  /// A 33-bit timestamp from the 5 bytes at `at`.
  private static func timestamp(_ data: [UInt8], _ at: Int) -> Int {
    (Int(data[at] >> 1) & 7) << 30 | Int(data[at + 1]) << 22 | Int(data[at + 2] >> 1) << 15 | Int(data[at + 3]) << 7
      | Int(data[at + 4] >> 1)
  }

  // MARK: - PES

  private func pes(_ stream: Stream, _ payload: [UInt8], _ start: Bool, _ sink: DemuxSink) {
    if start {
      flushPes(stream, sink)
      if payload.count >= 6 && payload[0] == 0 && payload[1] == 0 && payload[2] == 1 {
        stream.expected = Bytes.readUint(payload, 4, 2)
      } else {
        stream.expected = 0
      }
    } else if stream.parts.isEmpty {
      return
    }
    stream.parts.append(payload)
    stream.size += payload.count
    if stream.expected > 0 && stream.size >= 6 + stream.expected { flushPes(stream, sink) }
  }

  private func flushPes(_ stream: Stream, _ sink: DemuxSink) {
    guard !stream.parts.isEmpty else { return }
    let pes = Array(stream.parts.joined())
    stream.parts = []
    stream.size = 0
    guard pes.count >= 9, pes[0] == 0, pes[1] == 0, pes[2] == 1 else { return }
    let flags = Int(pes[7])
    let headerEnd = 9 + Int(pes[8])
    guard headerEnd <= pes.count else { return }
    let pts = flags & 0x80 != 0 && headerEnd >= 14 ? unwrap(Self.timestamp(pes, 9)) : nil
    var body = Array(pes[headerEnd...])
    if stream.expected > 0 { body = Array(body.prefix(max(0, 6 + stream.expected - headerEnd))) }
    if stream.kind == .h264 || stream.kind == .hevc {
      video(stream, pts, body, sink)
    } else {
      audio(stream, pts, body, sink)
    }
  }

  private func unwrap(_ raw: Int) -> Int {
    guard let reference else {
      self.reference = raw
      return raw
    }
    // The nearest: round((reference − raw) / 2³³), half up.
    let k = Self.floorDiv(reference - raw + Self.ptsWrap / 2, Self.ptsWrap)
    let value = raw + k * Self.ptsWrap
    self.reference = value
    return value
  }

  private static func floorDiv(_ a: Int, _ b: Int) -> Int {
    a >= 0 ? a / b : -((-a + b - 1) / b)
  }

  // MARK: - Video

  private func video(_ stream: Stream, _ pts: Int?, _ body: [UInt8], _ sink: DemuxSink) {
    let hevc = stream.kind == .hevc
    var params: [[[UInt8]]] = hevc ? [[], [], []] : [[], []]
    var kept: [[UInt8]] = []
    var key = false
    for unit in Codecs.splitAnnexB(body) {
      let type = hevc ? Int(unit[0] >> 1) & 0x3F : Int(unit[0]) & 0x1F
      if hevc {
        if type >= 32 && type <= 34 {
          params[type - 32].append(unit)
        } else if type >= 35 && type <= 38 {
          continue
        } else {
          if type >= 16 && type <= 23 { key = true }
          kept.append(unit)
        }
      } else if type == 7 {
        params[0].append(unit)
      } else if type == 8 {
        params[1].append(unit)
      } else if type >= 9 && type <= 12 {
        continue
      } else {
        // An IDR, or a recovery point (SEI payload 6: broadcast streams
        // with open GOPs and no IDR).
        if type == 5 || (type == 6 && unit.count > 1 && unit[1] == 6) { key = true }
        kept.append(unit)
      }
    }
    if params.allSatisfy({ !$0.isEmpty }) { configureVideo(stream, params) }
    guard !kept.isEmpty, let pts else { return }
    sink.frame(DemuxFrame(track: stream.track.id, pts: pts, key: key, data: Codecs.lengthPrefixed(kept)))
  }

  private func configureVideo(_ stream: Stream, _ params: [[[UInt8]]]) {
    if stream.params == params { return }
    let track = stream.track
    if stream.kind == .hevc {
      let config = Codecs.hevcConfig(vps: params[0], sps: params[1], pps: params[2])
      let info = Codecs.parseHevcSps(params[1][0])
      track.entry = "hvc1"
      track.config = config
      track.codec = Codecs.hevcCodec(config)
      track.width = info.width
      track.height = info.height
    } else {
      guard params[0][0].count >= 4 else { return }
      let config = Codecs.avcConfig(sps: params[0], pps: params[1])
      let info = Codecs.parseAvcSps(params[0][0])
      track.entry = "avc1"
      track.config = config
      track.codec = Codecs.avcCodec(config)
      track.width = info.width
      track.height = info.height
      track.sarWidth = info.sarWidth
      track.sarHeight = info.sarHeight
    }
    stream.params = params
  }

  // MARK: - Audio

  private func audio(_ stream: Stream, _ pts: Int?, _ body: [UInt8], _ sink: DemuxSink) {
    if stream.kind == .probe { probe(stream, body) }
    guard stream.track.unsupported == nil else { return }
    let carried = stream.carry.count
    let data = carried > 0 ? stream.carry + body : body
    var ptsUsed = pts == nil
    var at = 0
    while at < data.count {
      guard let frame = audioFrame(stream, data, at) else {
        at += 1
        continue
      }
      if frame.short { break }
      if at + frame.length > data.count { break }
      var framePts: Int?
      if !ptsUsed && at >= carried {
        framePts = pts
        ptsUsed = true
      }
      let bytes = Array(data[(at + frame.skip)..<(at + frame.length)])
      if stream.kind == .eac3 {
        eac3(stream, framePts, bytes, frame.independent, sink)
      } else {
        sink.frame(DemuxFrame(track: stream.track.id, pts: framePts, key: true, data: bytes))
      }
      at += frame.length
    }
    stream.carry = at < data.count ? Array(data[at...]) : []
  }

  /// A private stream's first PES says what it carries.
  private func probe(_ stream: Stream, _ body: [UInt8]) {
    if Codecs.adtsHeader(body, 0) != nil {
      stream.kind = .aac
    } else if Codecs.ac3Header(body, 0) != nil {
      stream.kind = .ac3
    } else if Codecs.mpegAudioHeader(body, 0)?.layer == 3 {
      stream.kind = .mpeg
    } else {
      stream.track.unsupported = "unknown private stream"
    }
  }

  /// The audio frame at `at`: its length and header bytes to drop; `short` when the header is cut.
  private func audioFrame(
    _ stream: Stream, _ data: [UInt8], _ at: Int
  ) -> (length: Int, skip: Int, independent: Bool, short: Bool)? {
    let track = stream.track
    if data.count - at < 8 { return (0, 0, true, true) }
    if stream.kind == .aac {
      guard let h = Codecs.adtsHeader(data, at) else { return nil }
      let asc = Codecs.makeAsc(objectType: h.objectType, sampleRate: h.sampleRate, channels: h.channels)
      if track.config != asc {
        track.entry = "mp4a"
        track.objectType = 0x40
        track.config = asc
        track.codec = "mp4a.40.\(h.objectType)"
        track.sampleRate = h.sampleRate
        track.channels = h.channels
        track.timescale = h.sampleRate
      }
      return (h.length, h.headerLength, true, false)
    }
    if stream.kind == .mpeg {
      guard let h = Codecs.mpegAudioHeader(data, at) else { return nil }
      if h.layer != 3 {
        track.unsupported = "MPEG audio layer \(h.layer)"
        return nil
      }
      if track.codec == nil || track.sampleRate != h.sampleRate || track.channels != h.channels {
        track.entry = "mp4a"
        track.objectType = 0x6B
        track.codec = "mp4a.6B"
        track.sampleRate = h.sampleRate
        track.channels = h.channels
        track.timescale = h.sampleRate
      }
      return (h.length, 0, true, false)
    }
    guard let h = Codecs.ac3Header(data, at) else { return nil }
    if h.independent && track.config != h.config {
      track.entry = h.extended ? "ec-3" : "ac-3"
      track.config = h.config
      track.codec = track.entry
      track.sampleRate = h.sampleRate
      track.channels = h.channels
      track.timescale = h.sampleRate
    }
    return (h.length, 0, h.independent, false)
  }

  /// E-AC-3: a dependent substream joins the independent frame before it.
  private func eac3(_ stream: Stream, _ pts: Int?, _ bytes: [UInt8], _ independent: Bool, _ sink: DemuxSink) {
    if !independent, stream.held != nil {
      stream.held!.data += bytes
      return
    }
    release(stream, sink)
    stream.held = (pts, bytes)
  }

  private func release(_ stream: Stream, _ sink: DemuxSink) {
    guard let held = stream.held else { return }
    stream.held = nil
    sink.frame(DemuxFrame(track: stream.track.id, pts: held.pts, key: true, data: held.data))
  }

  /// The first offset from `from` where packets of `size` (or either size) line up three times.
  private static func findSync(_ data: [UInt8], from: Int, only: Int? = nil) -> (at: Int, size: Int)? {
    let sizes = only.map { [$0] } ?? [packet, 192]
    var i = from
    while i < data.count {
      for size in sizes {
        let p = i + size - packet
        if p + 2 * size >= data.count { continue }
        if data[p] == syncByte && data[p + size] == syncByte && data[p + 2 * size] == syncByte { return (i, size) }
      }
      if i + 3 * 192 >= data.count { break }
      i += 1
    }
    return nil
  }

  /// The last PTS in the tail of a TS file (for its duration), on the 90 kHz clock; `nil` when there is none.
  static func lastTimestamp(_ tail: [UInt8], pid: Int?) -> Int? {
    guard let found = findSync(tail, from: 0) else { return nil }
    let lead = found.size - packet
    var last: Int?
    var at = found.at
    while at + found.size <= tail.count {
      defer { at += found.size }
      let p = Array(tail[(at + lead)..<(at + lead + packet)])
      guard p[0] == syncByte, p[1] & 0x40 != 0 else { continue }
      let packetPid = (Int(p[1]) & 0x1F) << 8 | Int(p[2])
      if let pid, packetPid != pid { continue }
      let control = Int(p[3] >> 4) & 3
      var off = 4
      if control & 2 != 0 { off += 1 + Int(p[4]) }
      guard control & 1 != 0, off + 14 <= packet else { continue }
      guard p[off] == 0, p[off + 1] == 0, p[off + 2] == 1 else { continue }
      if p[off + 7] & 0x80 != 0 { last = timestamp(p, off + 9) }
    }
    return last
  }
}
