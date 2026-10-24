import Foundation

/// A streaming Matroska / WebM demuxer: bytes in, in chunks of any size;
/// tracks, frames and subtitle cues out. It reads what the remuxer needs and
/// skips the rest (attachments, tags, chapters) without buffering it. A live
/// WebM (a segment and clusters of unknown size) streams the same way. After
/// corrupt bytes it resynchronises on the next cluster.
///
/// The TypeScript twin is src/web/remux/Matroska.ts.
final class MatroskaDemuxer {
  enum ID {
    static let ebml = 0x1A45_DFA3
    static let docType = 0x4282
    static let segment = 0x1853_8067
    static let seekHead = 0x114D_9B74
    static let seek = 0x4DBB
    static let seekID = 0x53AB
    static let seekPosition = 0x53AC
    static let info = 0x1549_A966
    static let timestampScale = 0x2AD7B1
    static let duration = 0x4489
    static let tracks = 0x1654_AE6B
    static let trackEntry = 0xAE
    static let trackNumber = 0xD7
    static let trackType = 0x83
    static let flagEnabled = 0xB9
    static let flagDefault = 0x88
    static let flagForced = 0x55AA
    static let defaultDuration = 0x23E383
    static let name = 0x536E
    static let language = 0x22B59C
    static let languageBCP47 = 0x22B59D
    static let codecID = 0x86
    static let codecPrivate = 0x63A2
    static let video = 0xE0
    static let pixelWidth = 0xB0
    static let pixelHeight = 0xBA
    static let displayWidth = 0x54B0
    static let displayHeight = 0x54BA
    static let displayUnit = 0x54B2
    static let audio = 0xE1
    static let samplingFrequency = 0xB5
    static let channels = 0x9F
    static let contentEncodings = 0x6D80
    static let contentEncoding = 0x6240
    static let contentCompression = 0x5034
    static let contentCompAlgo = 0x4254
    static let contentCompSettings = 0x4255
    static let contentEncryption = 0x5035
    static let cluster = 0x1F43_B675
    static let timestamp = 0xE7
    static let simpleBlock = 0xA3
    static let blockGroup = 0xA0
    static let block = 0xA1
    static let blockDuration = 0x9B
    static let referenceBlock = 0xFB
    static let cues = 0x1C53_BB6B
    static let cuePoint = 0xBB
    static let cueTime = 0xB3
    static let cueTrackPositions = 0xB7
    static let cueTrack = 0xF7
    static let cueClusterPosition = 0xF1
    static let tags = 0x1254_C367
    static let chapters = 0x1043_A770
    static let attachments = 0x1941_A469
  }

  /// Level-1 elements: one of them ends a cluster of unknown size.
  private static let topLevel: Set<Int> = [
    ID.cluster, ID.cues, ID.tags, ID.chapters, ID.attachments, ID.seekHead, ID.info, ID.tracks,
  ]
  /// Read whole (they are small, or needed whole).
  private static let whole: Set<Int> = [
    ID.ebml, ID.seekHead, ID.info, ID.tracks, ID.cues, ID.simpleBlock, ID.block, ID.timestamp,
    ID.blockDuration, ID.referenceBlock,
  ]
  private static let maxWhole = 64 * 1024 * 1024
  private static let nsPerSecond = 1_000_000_000

  private struct Header {
    let id: Int
    /// `nil`: unknown size (live).
    let size: Int?
    let length: Int
  }

  private enum HeaderResult {
    case header(Header)
    case invalid
    case short
  }

  private struct Element {
    let id: Int
    let start: Int
    let size: Int
  }

  private final class TrackState {
    let track: RemuxTrack
    var prefix: [UInt8]?
    var frameDuration: Int?
    var features: [Int: Int]?
    init(track: RemuxTrack) { self.track = track }
  }

  /// Clock units per second of the frames' `pts`.
  private(set) var clock = 1000
  private var unit = 1
  private var scale = 1_000_000
  private(set) var tracks: [RemuxTrack] = []
  /// The track list is complete (the Tracks element was read).
  private(set) var tracksKnown = false
  /// Milliseconds, from the Info element.
  private(set) var duration: Int?
  private(set) var docType = ""
  /// Where the segment's data starts (positions are relative to it).
  private(set) var segmentStart: Int?
  /// Byte offset of the Cues element, from the SeekHead.
  private(set) var cuesOffset: Int?
  /// Byte offset of the first cluster read.
  private(set) var firstCluster: Int?
  private(set) var cues: [CuePoint] = []

  private var states: [Int: TrackState] = [:]
  private var buf: [UInt8] = []
  /// File offset of `buf[0]`.
  private var bufStart = 0
  /// File offset of the next byte to parse.
  private var pos = 0
  private var stack: [(id: Int, end: Int?)] = []
  private var skip = 0
  private var clusterTime = 0
  private var group: (block: [UInt8]?, duration: Int?, reference: Bool)?
  private var segmentEnd: Int?

  /// Clock units between a video track's frames (its DefaultDuration); `nil` when the file does not say.
  func frameDuration(_ track: Int) -> Int? { states[track]?.frameDuration }

  func push(_ chunk: [UInt8], _ sink: DemuxSink) {
    let keep = pos - bufStart
    if keep >= buf.count {
      buf = chunk
    } else {
      buf = Array(buf[keep...]) + chunk
    }
    bufStart = pos
    parse(sink)
  }

  /// The stream ended: closes what is open.
  func end(_ sink: DemuxSink) {
    while let master = stack.popLast() { close(master, sink) }
  }

  /// Reads the Cues element at the start of `bytes` (fetched on its own from
  /// `cuesOffset`); `false` when they do not hold it whole.
  func readCuesElement(_ bytes: [UInt8]) -> Bool {
    guard case .header(let h) = Self.header(bytes, 0), h.id == ID.cues, let size = h.size,
      h.length + size <= bytes.count
    else { return false }
    readCues(bytes, Element(id: ID.cues, start: h.length, size: size))
    return true
  }

  /// The next bytes pushed start at `offset`, a cluster's (from the Cues).
  func seek(_ offset: Int) {
    buf = []
    bufStart = offset
    pos = offset
    skip = 0
    group = nil
    clusterTime = 0
    stack = segmentStart == nil ? [] : [(ID.segment, segmentEnd)]
  }

  // MARK: - Elements

  /// The variable-length integer at `at`: its value and length; `nil` when cut or invalid.
  private static func vint(_ data: [UInt8], _ at: Int, keepMarker: Bool) -> (value: Int, length: Int, unknown: Bool)? {
    guard at < data.count else { return nil }
    let first = Int(data[at])
    guard first != 0 else { return nil }
    var length = 1
    while first & (0x80 >> (length - 1)) == 0 { length += 1 }
    guard at + length <= data.count else { return nil }
    var value = keepMarker ? first : first & (0xFF >> length)
    var ones = value == (0xFF >> length)
    for i in 1..<max(1, length) {
      value = value * 256 + Int(data[at + i])
      if data[at + i] != 0xFF { ones = false }
    }
    if length == 1 { ones = value == (0xFF >> length) }
    return (value, length, !keepMarker && ones)
  }

  private static func header(_ data: [UInt8], _ at: Int) -> HeaderResult {
    guard at < data.count else { return .short }
    if data[at] < 0x10 { return .invalid }
    guard let id = vint(data, at, keepMarker: true) else { return .short }
    guard let size = vint(data, at + id.length, keepMarker: false) else {
      return at + id.length + 8 <= data.count ? .invalid : .short
    }
    return .header(Header(id: id.value, size: size.unknown ? nil : size.value, length: id.length + size.length))
  }

  /// The child elements of `data[start..<end]` (a master read whole).
  private static func children(_ data: [UInt8], _ start: Int, _ end: Int) -> [Element] {
    var out: [Element] = []
    var at = start
    while at < end {
      guard case .header(let h) = header(data, at), let size = h.size else { break }
      let begin = at + h.length
      if begin + size > end { break }
      out.append(Element(id: h.id, start: begin, size: size))
      at = begin + size
    }
    return out
  }

  private static func uint(_ data: [UInt8], _ e: Element) -> Int {
    Bytes.readUint(data, e.start, min(e.size, 7))
  }

  private static func float(_ data: [UInt8], _ e: Element) -> Double {
    if e.size == 4 { return Double(Float(bitPattern: UInt32(Bytes.readUint(data, e.start, 4)))) }
    if e.size == 8 {
      var bits: UInt64 = 0
      for i in 0..<8 { bits = bits << 8 | UInt64(data[e.start + i]) }
      return Double(bitPattern: bits)
    }
    return 0
  }

  private static func text(_ data: [UInt8], _ e: Element) -> String {
    Bytes.utf8(Array(data[e.start..<(e.start + e.size)]))
  }

  private static func gcd(_ a: Int, _ b: Int) -> Int {
    var (a, b) = (a, b)
    while b != 0 { (a, b) = (b, a % b) }
    return a
  }

  private func parse(_ sink: DemuxSink) {
    while true {
      if let top = stack.last, let end = top.end, pos >= end {
        close(stack.removeLast(), sink)
        continue
      }
      let available = bufStart + buf.count - pos
      if skip > 0 {
        let n = min(skip, available)
        pos += n
        skip -= n
        if skip > 0 { return }
        continue
      }
      let at = pos - bufStart
      switch Self.header(buf, at) {
      case .short:
        return
      case .invalid:
        if !resync() { return }
      case .header(let h):
        if let top = stack.last, top.id == ID.cluster, top.end == nil, Self.topLevel.contains(h.id) {
          close(stack.removeLast(), sink)
          continue
        }
        if !element(h, at, sink) { return }
      }
    }
  }

  /// Handles the element at `at`; `false` while more bytes are needed.
  private func element(_ h: Header, _ at: Int, _ sink: DemuxSink) -> Bool {
    let dataStart = pos + h.length
    let end = h.size.map { dataStart + $0 }
    if h.id == ID.segment || h.id == ID.cluster || h.id == ID.blockGroup {
      if h.id == ID.segment {
        segmentStart = dataStart
        segmentEnd = end
      } else if h.id == ID.cluster {
        clusterTime = 0
        if firstCluster == nil { firstCluster = pos }
      } else {
        group = (nil, nil, false)
      }
      stack.append((h.id, end))
      pos = dataStart
      return true
    }
    if Self.whole.contains(h.id) {
      guard let size = h.size, size <= Self.maxWhole else { return resync() }
      if at + h.length + size > buf.count { return false }
      wholeElement(h.id, buf, at + h.length, size, sink)
      pos = dataStart + size
      return true
    }
    guard let size = h.size else { return resync() }
    pos = dataStart
    skip = size
    return true
  }

  /// Moves to the next cluster in the buffer; `false` when there is none yet.
  private func resync() -> Bool {
    let from = pos - bufStart + 1
    if from + 4 <= buf.count {
      for i in from...(buf.count - 4) where Bytes.readUint(buf, i, 4) == ID.cluster {
        pos = bufStart + i
        group = nil
        while let top = stack.last, top.id != ID.segment { stack.removeLast() }
        return true
      }
    }
    pos = max(pos, bufStart + buf.count - 3)
    return false
  }

  private func close(_ master: (id: Int, end: Int?), _ sink: DemuxSink) {
    guard master.id == ID.blockGroup else { return }
    let current = group
    group = nil
    if let current, let block = current.block {
      self.block(block, key: !current.reference, duration: current.duration, sink)
    }
  }

  private func wholeElement(_ id: Int, _ data: [UInt8], _ start: Int, _ size: Int, _ sink: DemuxSink) {
    let e = Element(id: id, start: start, size: size)
    switch id {
    case ID.ebml:
      for c in Self.children(data, start, start + size) where c.id == ID.docType { docType = Self.text(data, c) }
    case ID.info: info(data, e)
    case ID.seekHead: seekHead(data, e)
    case ID.tracks: readTracks(data, e)
    case ID.cues: readCues(data, e)
    case ID.timestamp: clusterTime = Self.uint(data, e)
    case ID.blockDuration: if group != nil { group?.duration = Self.uint(data, e) }
    case ID.referenceBlock: if group != nil { group?.reference = true }
    case ID.block: if group != nil { group?.block = Array(data[start..<(start + size)]) }
    case ID.simpleBlock:
      let block = Array(data[start..<(start + size)])
      let flagsAt = (Self.vint(block, 0, keepMarker: false)?.length ?? 1) + 2
      let flags = flagsAt < block.count ? Int(block[flagsAt]) : 0
      self.block(block, key: flags & 0x80 != 0, duration: nil, sink)
    default: break
    }
  }

  private func info(_ data: [UInt8], _ e: Element) {
    var duration: Double?
    for c in Self.children(data, e.start, e.start + e.size) {
      if c.id == ID.timestampScale {
        let value = Self.uint(data, c)
        scale = value == 0 ? 1_000_000 : value
      } else if c.id == ID.duration {
        duration = Self.float(data, c)
      }
    }
    let g = Self.gcd(Self.nsPerSecond, scale)
    clock = Self.nsPerSecond / g
    unit = scale / g
    if let duration, duration.isFinite, duration > 0 {
      self.duration = Int(((duration * Double(scale)) / 1_000_000).rounded())
    }
  }

  private func seekHead(_ data: [UInt8], _ e: Element) {
    for seek in Self.children(data, e.start, e.start + e.size) where seek.id == ID.seek {
      var target = 0
      var position: Int?
      for c in Self.children(data, seek.start, seek.start + seek.size) {
        if c.id == ID.seekID {
          target = Self.uint(data, c)
        } else if c.id == ID.seekPosition {
          position = Self.uint(data, c)
        }
      }
      if target == ID.cues, let position, let segmentStart { cuesOffset = segmentStart + position }
    }
  }

  /// Milliseconds of a time in TimestampScale units.
  private func ms(_ time: Int) -> Int {
    Bytes.rescale(max(0, time) * unit, 1000, clock)
  }

  private func readCues(_ data: [UInt8], _ e: Element) {
    guard let segmentStart else { return }
    let video = tracks.first { $0.kind == .video }?.id
    var points: [CuePoint] = []
    for point in Self.children(data, e.start, e.start + e.size) where point.id == ID.cuePoint {
      var time = 0
      var offset: Int?
      for c in Self.children(data, point.start, point.start + point.size) {
        if c.id == ID.cueTime { time = Self.uint(data, c) }
        guard c.id == ID.cueTrackPositions else { continue }
        var track = 0
        var position: Int?
        for p in Self.children(data, c.start, c.start + c.size) {
          if p.id == ID.cueTrack {
            track = Self.uint(data, p)
          } else if p.id == ID.cueClusterPosition {
            position = Self.uint(data, p)
          }
        }
        if let position, video == nil || track == video, offset == nil { offset = segmentStart + position }
      }
      if let offset { points.append(CuePoint(time: ms(time), offset: offset)) }
    }
    points.sort { $0.time != $1.time ? $0.time < $1.time : $0.offset < $1.offset }
    cues = points.enumerated().filter { $0.offset == 0 || $0.element.offset != points[$0.offset - 1].offset }.map(\.element)
  }

  // MARK: - Tracks

  private func readTracks(_ data: [UInt8], _ e: Element) {
    guard !tracksKnown else { return }
    for entry in Self.children(data, e.start, e.start + e.size) where entry.id == ID.trackEntry {
      guard let state = trackEntry(data, entry) else { continue }
      tracks.append(state.track)
      states[state.track.id] = state
    }
    tracksKnown = true
  }

  private func trackEntry(_ data: [UInt8], _ entry: Element) -> TrackState? {
    var fields: [Int: Element] = [:]
    for c in Self.children(data, entry.start, entry.start + entry.size) where fields[c.id] == nil { fields[c.id] = c }
    let num = { (id: Int, fallback: Int) -> Int in fields[id].map { Self.uint(data, $0) } ?? fallback }
    let str = { (id: Int) -> String? in fields[id].map { Self.text(data, $0) } }
    let number = num(ID.trackNumber, 0)
    let kind: RemuxTrackKind?
    switch num(ID.trackType, 0) {
    case 1: kind = .video
    case 2: kind = .audio
    case 17: kind = .text
    default: kind = nil
    }
    guard number != 0, let kind else { return nil }
    let track = RemuxTrack(id: number, kind: kind)
    track.name = str(ID.name)
    track.language = str(ID.languageBCP47) ?? str(ID.language) ?? "eng"
    track.isDefault = num(ID.flagDefault, 1) == 1
    track.forced = num(ID.flagForced, 0) == 1
    let codecId = str(ID.codecID) ?? ""
    let codecPrivate = fields[ID.codecPrivate].map { Array(data[$0.start..<($0.start + $0.size)]) }
    let state = TrackState(track: track)
    let defaultDuration = num(ID.defaultDuration, 0)
    if defaultDuration > 0 { state.frameDuration = Bytes.rescale(defaultDuration, clock, Self.nsPerSecond) }
    if num(ID.flagEnabled, 1) == 0 { track.unsupported = "disabled" }
    if let encodings = fields[ID.contentEncodings] { self.encodings(data, encodings, state) }
    if kind == .video {
      track.timescale = clock
      videoTrack(data, fields[ID.video], state)
    } else if kind == .audio {
      audioTrack(data, fields[ID.audio], state)
    }
    if track.unsupported == nil { configure(state, codecId, codecPrivate) }
    return state
  }

  private func encodings(_ data: [UInt8], _ e: Element, _ state: TrackState) {
    for encoding in Self.children(data, e.start, e.start + e.size) where encoding.id == ID.contentEncoding {
      for c in Self.children(data, encoding.start, encoding.start + encoding.size) {
        if c.id == ID.contentEncryption {
          state.track.unsupported = "encrypted"
        } else if c.id == ID.contentCompression {
          var algo = 0
          var settings: [UInt8]?
          for s in Self.children(data, c.start, c.start + c.size) {
            if s.id == ID.contentCompAlgo {
              algo = Self.uint(data, s)
            } else if s.id == ID.contentCompSettings {
              settings = Array(data[s.start..<(s.start + s.size)])
            }
          }
          if algo == 3 { state.prefix = settings } else { state.track.unsupported = "compressed" }
        }
      }
    }
  }

  private func videoTrack(_ data: [UInt8], _ video: Element?, _ state: TrackState) {
    guard let video else { return }
    var f: [Int: Element] = [:]
    for c in Self.children(data, video.start, video.start + video.size) { f[c.id] = c }
    let value = { (id: Int) -> Int in f[id].map { Self.uint(data, $0) } ?? 0 }
    let track = state.track
    track.width = value(ID.pixelWidth)
    track.height = value(ID.pixelHeight)
    let dw = value(ID.displayWidth)
    let dh = value(ID.displayHeight)
    if value(ID.displayUnit) == 0 && dw > 0 && dh > 0 && track.width > 0 && track.height > 0 {
      let w = dw * track.height
      let h = dh * track.width
      let g = Self.gcd(w, h)
      track.sarWidth = w / g
      track.sarHeight = h / g
    }
  }

  private func audioTrack(_ data: [UInt8], _ audio: Element?, _ state: TrackState) {
    let track = state.track
    track.sampleRate = 8000
    track.channels = 1
    guard let audio else { return }
    for c in Self.children(data, audio.start, audio.start + audio.size) {
      if c.id == ID.samplingFrequency {
        track.sampleRate = Int(Self.float(data, c).rounded())
      } else if c.id == ID.channels {
        track.channels = Self.uint(data, c)
      }
    }
    track.timescale = track.sampleRate
  }

  /// The MP4 form of a track's codec; marks the track unsupported when there is none.
  private func configure(_ state: TrackState, _ codecId: String, _ codecPrivate: [UInt8]?) {
    let track = state.track
    if track.kind == .text {
      if codecId == "S_TEXT/UTF8" || codecId == "S_TEXT/ASCII" {
        track.codec = "srt"
      } else if ["S_TEXT/ASS", "S_TEXT/SSA", "S_ASS", "S_SSA"].contains(codecId) {
        track.codec = "ass"
      } else if codecId == "S_TEXT/WEBVTT" {
        track.codec = "vtt"
      } else {
        track.unsupported = codecId
      }
      if track.codec == "ass", let codecPrivate { track.header = Bytes.utf8(codecPrivate) }
      return
    }
    if codecId == "V_MPEG4/ISO/AVC", let codecPrivate, codecPrivate.count > 6 {
      track.entry = "avc1"
      track.config = codecPrivate
      track.codec = Codecs.avcCodec(codecPrivate)
      if let sps = Codecs.avcConfigSps(codecPrivate) {
        let info = Codecs.parseAvcSps(sps)
        track.width = info.width
        track.height = info.height
        if track.sarWidth == 1 && track.sarHeight == 1 {
          track.sarWidth = info.sarWidth
          track.sarHeight = info.sarHeight
        }
      }
    } else if codecId == "V_MPEGH/ISO/HEVC", let codecPrivate, codecPrivate.count > 22 {
      track.entry = "hvc1"
      track.config = codecPrivate
      track.codec = Codecs.hevcCodec(codecPrivate)
      if let sps = Codecs.hevcConfigSps(codecPrivate) {
        let info = Codecs.parseHevcSps(sps)
        track.width = info.width
        track.height = info.height
      }
    } else if codecId == "V_AV1", let codecPrivate, codecPrivate.count >= 4 {
      track.entry = "av01"
      track.config = codecPrivate
      track.codec = Codecs.av1Codec(codecPrivate)
    } else if codecId == "V_VP9" {
      track.entry = "vp09"
      state.features = codecPrivate.map(Codecs.vp9CodecFeatures) ?? [:]
    } else if codecId == "V_VP8" {
      track.entry = "vp08"
      let info = Codecs.VpxInfo(profile: 0, bitDepth: 8, chroma: 0, fullRange: false, colorSpace: 0)
      let config = Codecs.vpcConfig(info, level: Codecs.vp9Level(width: track.width, height: track.height))
      track.config = config
      track.codec = Codecs.vpxCodec("vp08", config)
    } else if codecId.hasPrefix("A_AAC") {
      aac(track, codecId, codecPrivate)
    } else if codecId == "A_MPEG/L3" {
      track.entry = "mp4a"
      track.objectType = 0x6B
      track.codec = "mp4a.6B"
    } else if codecId == "A_AC3" || codecId == "A_EAC3" {
      track.entry = codecId == "A_AC3" ? "ac-3" : "ec-3"
    } else if codecId == "A_OPUS", let codecPrivate {
      guard let opus = Codecs.opusConfig(codecPrivate) else {
        track.unsupported = codecId
        return
      }
      track.entry = "Opus"
      track.config = opus.config
      track.codec = "opus"
      track.channels = opus.channels
      track.sampleRate = 48000
      track.timescale = 48000
    } else if codecId == "A_FLAC", let codecPrivate {
      guard let flac = Codecs.flacConfig(codecPrivate) else {
        track.unsupported = codecId
        return
      }
      track.entry = "fLaC"
      track.config = flac.config
      track.codec = "flac"
      track.sampleRate = flac.sampleRate
      track.channels = flac.channels
      track.timescale = flac.sampleRate
    } else {
      track.unsupported = codecId.isEmpty ? "no codec" : codecId
    }
  }

  private func aac(_ track: RemuxTrack, _ codecId: String, _ codecPrivate: [UInt8]?) {
    var asc = codecPrivate.flatMap { $0.count >= 2 ? $0 : nil }
    if asc == nil {
      var objectType = 2
      for (name, type) in [("MAIN", 1), ("LC", 2), ("SSR", 3), ("LTP", 4)] where codecId.contains("/\(name)") {
        objectType = type
        break
      }
      asc = Codecs.makeAsc(objectType: objectType, sampleRate: track.sampleRate, channels: track.channels)
    }
    let info = Codecs.parseAsc(asc!)
    guard info.sampleRate != 0 else {
      track.unsupported = "AAC without a sample rate"
      return
    }
    track.entry = "mp4a"
    track.objectType = 0x40
    track.config = asc
    track.codec = "mp4a.40.\(info.objectType)"
    track.sampleRate = info.sampleRate
    track.timescale = info.sampleRate
    if info.channels > 0 { track.channels = info.channels }
  }

  /// A configuration only a frame can give (VP9, AC-3, E-AC-3).
  private func configureFromFrame(_ state: TrackState, _ frame: [UInt8]) {
    let track = state.track
    if track.entry == "vp09" {
      guard var info = Codecs.vp9Keyframe(frame) else { return }
      let f = state.features ?? [:]
      if let profile = f[1] { info.profile = profile }
      if let depth = f[3] { info.bitDepth = depth }
      let level = f[2] ?? Codecs.vp9Level(width: track.width, height: track.height)
      let config = Codecs.vpcConfig(info, level: level)
      track.config = config
      track.codec = Codecs.vpxCodec("vp09", config)
    } else if track.entry == "ac-3" || track.entry == "ec-3" {
      guard let h = Codecs.ac3Header(frame, 0) else { return }
      track.entry = h.extended ? "ec-3" : "ac-3"
      track.config = h.config
      track.codec = track.entry
      track.sampleRate = h.sampleRate
      track.timescale = h.sampleRate
      track.channels = h.channels
    }
  }

  // MARK: - Blocks

  private func block(_ block: [UInt8], key: Bool, duration: Int?, _ sink: DemuxSink) {
    guard let number = Self.vint(block, 0, keepMarker: false), block.count >= number.length + 3 else { return }
    guard let state = states[number.value], state.track.unsupported == nil else { return }
    let at = number.length
    let relative = Int(Int16(bitPattern: UInt16(block[at]) << 8 | UInt16(block[at + 1])))
    let flags = Int(block[at + 2])
    let time = clusterTime + relative
    guard let frames = Self.delace(block, at + 3, (flags >> 1) & 3) else { return }
    let track = state.track
    if track.kind == .text {
      for frame in frames {
        sink.cue(
          RemuxCue(
            track: track.id, start: ms(time), end: duration.map { ms(time + $0) }, text: Bytes.utf8(frame)))
      }
      return
    }
    let pts = max(0, time) * unit
    for (i, raw) in frames.enumerated() {
      let data = state.prefix.map { $0 + raw } ?? raw
      if track.codec == nil { configureFromFrame(state, data) }
      var framePts: Int?
      if i == 0 {
        framePts = pts
      } else if track.kind == .video, let frameDuration = state.frameDuration {
        framePts = pts + i * frameDuration
      }
      sink.frame(DemuxFrame(track: track.id, pts: framePts, key: key, data: data))
    }
  }

  /// The frames of a block's payload at `at`, by its lacing (0 none, 1 Xiph, 2 fixed, 3 EBML).
  static func delace(_ block: [UInt8], _ at: Int, _ lacing: Int) -> [[UInt8]]? {
    if lacing == 0 { return [Bytes.slice(block, at, block.count)] }
    guard at < block.count else { return nil }
    let count = Int(block[at]) + 1
    var pos = at + 1
    var sizes: [Int] = []
    if lacing == 1 {
      for _ in 0..<(count - 1) {
        var size = 0
        var byte = 255
        while byte == 255 {
          guard pos < block.count else { return nil }
          byte = Int(block[pos])
          pos += 1
          size += byte
        }
        sizes.append(size)
      }
    } else if lacing == 3 {
      guard let first = vint(block, pos, keepMarker: false) else { return nil }
      pos += first.length
      sizes.append(first.value)
      if count > 2 {
        for i in 1..<(count - 1) {
          guard let raw = vint(block, pos, keepMarker: false) else { return nil }
          pos += raw.length
          let delta = raw.value - ((1 << (7 * raw.length - 1)) - 1)
          sizes.append(sizes[i - 1] + delta)
        }
      }
    } else {
      let rest = block.count - pos
      guard rest % count == 0 else { return nil }
      for _ in 0..<(count - 1) { sizes.append(rest / count) }
    }
    let used = sizes.reduce(0, +)
    if used > block.count - pos || sizes.contains(where: { $0 < 0 }) { return nil }
    sizes.append(block.count - pos - used)
    var frames: [[UInt8]] = []
    for size in sizes {
      frames.append(Array(block[pos..<(pos + size)]))
      pos += size
    }
    return frames
  }
}
