import Foundation

// What the MP4 sample entries need from each codec: the configuration boxes,
// the RFC 6381 codec strings, and the frame headers that give an audio
// frame's length and duration. The TypeScript twin is src/web/remux/codecs.ts.

enum Codecs {
  // MARK: - Annex B (MPEG-TS video)

  /// The NAL units of an Annex B access unit (start codes removed).
  static func splitAnnexB(_ data: [UInt8]) -> [[UInt8]] {
    var units: [[UInt8]] = []
    var start = -1
    var i = 0
    while i + 2 < data.count {
      if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
        if start >= 0 { units.append(trimZeros(data, start, i)) }
        i += 3
        start = i
      } else {
        i += 1
      }
    }
    if start >= 0 && start < data.count { units.append(trimZeros(data, start, data.count)) }
    return units.filter { !$0.isEmpty }
  }

  private static func trimZeros(_ data: [UInt8], _ from: Int, _ to: Int) -> [UInt8] {
    var end = to
    while end > from && data[end - 1] == 0 { end -= 1 }
    return Array(data[from..<end])
  }

  /// NAL units with 4-byte big-endian lengths, as MP4 samples carry them.
  static func lengthPrefixed(_ units: [[UInt8]]) -> [UInt8] {
    var out: [UInt8] = []
    out.reserveCapacity(units.reduce(0) { $0 + 4 + $1.count })
    for unit in units {
      let n = unit.count
      out.append(UInt8((n >> 24) & 0xFF))
      out.append(UInt8((n >> 16) & 0xFF))
      out.append(UInt8((n >> 8) & 0xFF))
      out.append(UInt8(n & 0xFF))
      out.append(contentsOf: unit)
    }
    return out
  }

  // MARK: - H.264

  struct AvcSps {
    var width: Int
    var height: Int
    var sarWidth: Int
    var sarHeight: Int
    var profile: Int
    var chromaFormat: Int
    var bitDepthLuma: Int
    var bitDepthChroma: Int
  }

  private static func skipScalingList(_ r: inout BitReader, _ size: Int) {
    var last = 8
    var next = 8
    for _ in 0..<size {
      if next != 0 { next = (last + r.se() + 256) % 256 }
      if next != 0 { last = next }
    }
  }

  /// aspect_ratio_idc 1–16 → the sample aspect ratio.
  private static let avcSars: [(Int, Int)] = [
    (1, 1), (12, 11), (10, 11), (16, 11), (40, 33), (24, 11), (20, 11), (32, 11),
    (80, 33), (18, 11), (15, 11), (64, 33), (160, 99), (4, 3), (3, 2), (2, 1),
  ]

  private static let highProfiles: Set<Int> = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]

  /// An H.264 sequence parameter set (with its NAL header byte).
  static func parseAvcSps(_ nal: [UInt8]) -> AvcSps {
    var r = BitReader(Bytes.unescapeRbsp(Array(nal.dropFirst())))
    let profile = r.bits(8)
    r.skip(16)
    _ = r.ue()
    var chromaFormat = 1
    var bitDepthLuma = 8
    var bitDepthChroma = 8
    var separatePlanes = false
    if highProfiles.contains(profile) {
      chromaFormat = r.ue()
      if chromaFormat == 3 { separatePlanes = r.bit() }
      bitDepthLuma = r.ue() + 8
      bitDepthChroma = r.ue() + 8
      r.skip(1)
      if r.bit() {
        let lists = chromaFormat == 3 ? 12 : 8
        for i in 0..<lists where r.bit() { skipScalingList(&r, i < 6 ? 16 : 64) }
      }
    }
    _ = r.ue()
    let pocType = r.ue()
    if pocType == 0 {
      _ = r.ue()
    } else if pocType == 1 {
      r.skip(1)
      _ = r.se()
      _ = r.se()
      let cycle = r.ue()
      for _ in 0..<cycle { _ = r.se() }
    }
    _ = r.ue()
    r.skip(1)
    let widthMbs = r.ue() + 1
    let heightUnits = r.ue() + 1
    let frameMbsOnly = r.bit()
    if !frameMbsOnly { r.skip(1) }
    r.skip(1)
    var crop = [0, 0, 0, 0]
    if r.bit() {
      let left = r.ue()
      let right = r.ue()
      let top = r.ue()
      let bottom = r.ue()
      crop = [left, right, top, bottom]
    }
    var sar = (1, 1)
    if r.bit() && r.bit() {
      let idc = r.bits(8)
      if idc == 255 {
        let w = r.bits(16)
        let h = r.bits(16)
        sar = (w, h)
      } else {
        sar = idc >= 1 && idc <= avcSars.count ? avcSars[idc - 1] : (1, 1)
      }
      if sar.0 == 0 || sar.1 == 0 { sar = (1, 1) }
    }
    let chroma = separatePlanes ? 0 : chromaFormat
    let unitX = chroma == 1 || chroma == 2 ? 2 : 1
    let unitY = (chroma == 1 ? 2 : 1) * (frameMbsOnly ? 1 : 2)
    return AvcSps(
      width: widthMbs * 16 - unitX * (crop[0] + crop[1]),
      height: (frameMbsOnly ? 1 : 2) * heightUnits * 16 - unitY * (crop[2] + crop[3]),
      sarWidth: sar.0, sarHeight: sar.1, profile: profile, chromaFormat: chromaFormat,
      bitDepthLuma: bitDepthLuma, bitDepthChroma: bitDepthChroma)
  }

  /// The `avcC` payload for these parameter sets (NAL header bytes included).
  static func avcConfig(sps: [[UInt8]], pps: [[UInt8]]) -> [UInt8] {
    let first = sps[0]
    let w = BoxWriter(capacity: 64)
    w.u8(1).u8(Int(first[1])).u8(Int(first[2])).u8(Int(first[3]))
    w.u8(0xFF)
    w.u8(0xE0 | sps.count)
    for unit in sps { w.u16(unit.count).raw(unit) }
    w.u8(pps.count)
    for unit in pps { w.u16(unit.count).raw(unit) }
    if [100, 110, 122, 144].contains(Int(first[1])) {
      let info = parseAvcSps(first)
      w.u8(0xFC | info.chromaFormat)
      w.u8(0xF8 | (info.bitDepthLuma - 8))
      w.u8(0xF8 | (info.bitDepthChroma - 8))
      w.u8(0)
    }
    return w.finish()
  }

  /// `avc1.PPCCLL` from an `avcC`.
  static func avcCodec(_ avcC: [UInt8]) -> String {
    "avc1.\(Bytes.hex2(Int(avcC[1])))\(Bytes.hex2(Int(avcC[2])))\(Bytes.hex2(Int(avcC[3])))"
  }

  /// The first SPS of an `avcC`.
  static func avcConfigSps(_ avcC: [UInt8]) -> [UInt8]? {
    guard avcC.count >= 8, Int(avcC[5]) & 0x1F != 0 else { return nil }
    let n = Bytes.readUint(avcC, 6, 2)
    return Bytes.slice(avcC, 8, 8 + n)
  }

  // MARK: - HEVC

  struct HevcSps {
    var profileSpace: Int
    var tier: Int
    var profileIdc: Int
    var compatibility: Int
    var constraints: [UInt8]
    var level: Int
    var chromaFormat: Int
    var width: Int
    var height: Int
    var bitDepthLuma: Int
    var bitDepthChroma: Int
    var subLayers: Int
    var temporalIdNested: Bool
  }

  /// An HEVC sequence parameter set (with its 2-byte NAL header).
  static func parseHevcSps(_ nal: [UInt8]) -> HevcSps {
    var r = BitReader(Bytes.unescapeRbsp(Array(nal.dropFirst(2))))
    r.skip(4)
    let maxSubLayers = r.bits(3)
    let temporalIdNested = r.bit()
    let profileSpace = r.bits(2)
    let tier = r.bits(1)
    let profileIdc = r.bits(5)
    let compatibility = r.bits(32)
    var constraints: [UInt8] = []
    for _ in 0..<6 { constraints.append(UInt8(r.bits(8))) }
    let level = r.bits(8)
    var present: [(Bool, Bool)] = []
    for _ in 0..<maxSubLayers {
      let profilePresent = r.bit()
      let levelPresent = r.bit()
      present.append((profilePresent, levelPresent))
    }
    if maxSubLayers > 0 { for _ in maxSubLayers..<8 { r.skip(2) } }
    for (profilePresent, levelPresent) in present {
      if profilePresent { r.skip(88) }
      if levelPresent { r.skip(8) }
    }
    _ = r.ue()
    let chromaFormat = r.ue()
    var separatePlanes = false
    if chromaFormat == 3 { separatePlanes = r.bit() }
    var width = r.ue()
    var height = r.ue()
    if r.bit() {
      let chroma = separatePlanes ? 0 : chromaFormat
      let unitX = chroma == 1 || chroma == 2 ? 2 : 1
      let unitY = chroma == 1 ? 2 : 1
      let left = r.ue()
      let right = r.ue()
      width -= unitX * (left + right)
      let top = r.ue()
      let bottom = r.ue()
      height -= unitY * (top + bottom)
    }
    let bitDepthLuma = r.ue() + 8
    let bitDepthChroma = r.ue() + 8
    return HevcSps(
      profileSpace: profileSpace, tier: tier, profileIdc: profileIdc, compatibility: compatibility,
      constraints: constraints, level: level, chromaFormat: chromaFormat, width: width, height: height,
      bitDepthLuma: bitDepthLuma, bitDepthChroma: bitDepthChroma, subLayers: maxSubLayers + 1,
      temporalIdNested: temporalIdNested)
  }

  /// The `hvcC` payload for these parameter sets (NAL headers included).
  static func hevcConfig(vps: [[UInt8]], sps: [[UInt8]], pps: [[UInt8]]) -> [UInt8] {
    let info = parseHevcSps(sps[0])
    let w = BoxWriter(capacity: 128)
    w.u8(1)
    w.u8((info.profileSpace << 6) | (info.tier << 5) | info.profileIdc)
    w.u32(info.compatibility).raw(info.constraints).u8(info.level)
    w.u16(0xF000)
    w.u8(0xFC)
    w.u8(0xFC | info.chromaFormat)
    w.u8(0xF8 | (info.bitDepthLuma - 8))
    w.u8(0xF8 | (info.bitDepthChroma - 8))
    w.u16(0)
    w.u8((info.subLayers << 3) | ((info.temporalIdNested ? 1 : 0) << 2) | 3)
    let arrays: [(Int, [[UInt8]])] = [(32, vps), (33, sps), (34, pps)]
    let present = arrays.filter { !$0.1.isEmpty }
    w.u8(present.count)
    for (type, units) in present {
      w.u8(0x80 | type).u16(units.count)
      for unit in units { w.u16(unit.count).raw(unit) }
    }
    return w.finish()
  }

  private static func reverseBits32(_ value: Int) -> Int {
    var out = 0
    for i in 0..<32 { out = out * 2 + ((value >> i) & 1) }
    return out
  }

  /// `hvc1.<space><profile>.<compat>.<tier><level>.<constraints>` from an `hvcC`.
  static func hevcCodec(_ hvcC: [UInt8]) -> String {
    let b = hvcC.count > 1 ? Int(hvcC[1]) : 0
    let space = ["", "A", "B", "C"][b >> 6]
    let compat = String(reverseBits32(Bytes.readUint(hvcC, 2, 4)), radix: 16).uppercased()
    let tier = (b >> 5) & 1 == 1 ? "H" : "L"
    var constraints = Array(Bytes.slice(hvcC, 6, 12))
    while let last = constraints.last, last == 0 { constraints.removeLast() }
    let tail = constraints.map { ".\(Bytes.hex2(Int($0)))" }.joined()
    let level = hvcC.count > 12 ? Int(hvcC[12]) : 0
    return "hvc1.\(space)\(b & 31).\(compat).\(tier)\(level)\(tail)"
  }

  /// The first SPS of an `hvcC`.
  static func hevcConfigSps(_ hvcC: [UInt8]) -> [UInt8]? {
    var at = 23
    let arrays = hvcC.count > 22 ? Int(hvcC[22]) : 0
    for _ in 0..<arrays {
      guard at + 3 <= hvcC.count else { break }
      let type = Int(hvcC[at]) & 0x3F
      let count = Bytes.readUint(hvcC, at + 1, 2)
      at += 3
      for _ in 0..<count {
        guard at + 2 <= hvcC.count else { break }
        let n = Bytes.readUint(hvcC, at, 2)
        if type == 33 { return Bytes.slice(hvcC, at + 2, at + 2 + n) }
        at += 2 + n
      }
    }
    return nil
  }

  // MARK: - VP8, VP9

  struct VpxInfo {
    var profile: Int
    var bitDepth: Int
    /// vpcC: 0 4:2:0, 2 4:2:2, 3 4:4:4.
    var chroma: Int
    var fullRange: Bool
    /// VP9 color_space (0: unknown).
    var colorSpace: Int
  }

  /// A VP9 keyframe's uncompressed header; `nil` for anything else.
  static func vp9Keyframe(_ frame: [UInt8]) -> VpxInfo? {
    var r = BitReader(frame)
    guard r.bits(2) == 2 else { return nil }
    let low = r.bits(1)
    let profile = (r.bits(1) << 1) | low
    if profile == 3 { r.skip(1) }
    if r.bit() { return nil }
    if r.bit() { return nil }
    r.skip(2)
    guard r.bits(24) == 0x498342 else { return nil }
    var bitDepth = 8
    if profile >= 2 { bitDepth = r.bit() ? 12 : 10 }
    let colorSpace = r.bits(3)
    var fullRange = true
    var ssX = 1
    var ssY = 1
    if colorSpace != 7 {
      fullRange = r.bit()
      if profile == 1 || profile == 3 {
        ssX = r.bits(1)
        ssY = r.bits(1)
      }
    } else if profile == 1 || profile == 3 {
      ssX = 0
      ssY = 0
    }
    var chroma = 3
    if ssX == 1 && ssY == 1 {
      chroma = 0
    } else if ssX == 1 {
      chroma = 2
    }
    return VpxInfo(profile: profile, bitDepth: bitDepth, chroma: chroma, fullRange: fullRange, colorSpace: colorSpace)
  }

  /// VP9 color_space → colour primaries, transfer characteristics, matrix coefficients.
  private static let vp9Colours: [Int: (Int, Int, Int)] = [
    1: (6, 6, 6), 2: (1, 1, 1), 3: (6, 6, 6), 4: (7, 7, 7), 5: (9, 1, 9), 7: (2, 2, 0),
  ]

  /// A level for a picture's size, when the file does not say (30 fps assumed).
  static func vp9Level(width: Int, height: Int) -> Int {
    let size = width * height
    let levels: [(Int, Int)] = [
      (36864, 10), (73728, 11), (122880, 20), (245760, 21), (552960, 30), (983040, 31),
      (2_228_224, 40), (8_912_896, 50),
    ]
    for (limit, level) in levels where size <= limit { return level }
    return 60
  }

  /// The `vpcC` payload (version 1; the full box header is the writer's).
  static func vpcConfig(_ info: VpxInfo, level: Int) -> [UInt8] {
    let (primaries, transfer, matrix) = vp9Colours[info.colorSpace] ?? (2, 2, 2)
    let w = BoxWriter(capacity: 16)
    w.u8(info.profile).u8(level)
    w.u8((info.bitDepth << 4) | (info.chroma << 1) | (info.fullRange ? 1 : 0))
    w.u8(primaries).u8(transfer).u8(matrix)
    w.u16(0)
    return w.finish()
  }

  /// `vp09.PP.LL.DD` / `vp08.PP.LL.DD`.
  static func vpxCodec(_ entry: String, _ vpcC: [UInt8]) -> String {
    let profile = vpcC.count > 0 ? Int(vpcC[0]) : 0
    let level = vpcC.count > 1 ? Int(vpcC[1]) : 10
    let depth = (vpcC.count > 2 ? Int(vpcC[2]) : 0x80) >> 4
    return "\(entry).\(Bytes.pad2(profile)).\(Bytes.pad2(level)).\(Bytes.pad2(depth))"
  }

  /// Matroska's VP9 CodecPrivate (ID, length, value triples): profile 1, level 2, bit depth 3, chroma 4.
  static func vp9CodecFeatures(_ data: [UInt8]) -> [Int: Int] {
    var out: [Int: Int] = [:]
    var at = 0
    while at + 2 <= data.count {
      let id = Int(data[at])
      let length = Int(data[at + 1])
      if length == 1 && at + 2 < data.count { out[id] = Int(data[at + 2]) }
      at += 2 + length
    }
    return out
  }

  // MARK: - AV1

  /// `av01.P.LLT.DD` from an `av1C`.
  static func av1Codec(_ av1C: [UInt8]) -> String {
    let b1 = av1C.count > 1 ? Int(av1C[1]) : 0
    let flags = av1C.count > 2 ? Int(av1C[2]) : 0
    let tier = flags & 0x80 != 0 ? "H" : "M"
    var depth = 8
    if flags & 0x40 != 0 { depth = flags & 0x20 != 0 ? 12 : 10 }
    return "av01.\(b1 >> 5).\(Bytes.pad2(b1 & 31))\(tier).\(Bytes.pad2(depth))"
  }

  // MARK: - AAC

  static let aacRates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

  /// An AudioSpecificConfig's object type, core sample rate and channels.
  static func parseAsc(_ asc: [UInt8]) -> (objectType: Int, sampleRate: Int, channels: Int) {
    var r = BitReader(asc)
    var objectType = r.bits(5)
    if objectType == 31 { objectType = 32 + r.bits(6) }
    let index = r.bits(4)
    let sampleRate = index == 15 ? r.bits(24) : (index < aacRates.count ? aacRates[index] : 0)
    let channels = r.bits(4)
    return (objectType, sampleRate, channels)
  }

  /// A 2-byte AudioSpecificConfig (5-byte with an explicit rate).
  static func makeAsc(objectType: Int, sampleRate: Int, channels: Int) -> [UInt8] {
    if let index = aacRates.firstIndex(of: sampleRate) {
      return [UInt8((objectType << 3) | (index >> 1)), UInt8(((index & 1) << 7) | (channels << 3))]
    }
    let fields: [(Int, Int)] = [(objectType, 5), (15, 4), (sampleRate, 24), (channels, 4), (0, 3)]
    var out = [UInt8](repeating: 0, count: 5)
    var pos = 0
    for (value, count) in fields {
      for i in stride(from: count - 1, through: 0, by: -1) {
        if (value >> i) & 1 == 1 { out[pos >> 3] |= UInt8(0x80 >> (pos & 7)) }
        pos += 1
      }
    }
    return out
  }

  struct AdtsHeader {
    var length: Int
    var headerLength: Int
    var objectType: Int
    var sampleRate: Int
    var channels: Int
    var blocks: Int
  }

  /// The ADTS header at `at`; `nil` when there is none (or it is cut).
  static func adtsHeader(_ data: [UInt8], _ at: Int) -> AdtsHeader? {
    guard at + 7 <= data.count, data[at] == 0xFF, data[at + 1] & 0xF6 == 0xF0 else { return nil }
    let index = Int(data[at + 2] >> 2) & 0x0F
    guard index < aacRates.count else { return nil }
    let length = ((Int(data[at + 3]) & 3) << 11) | (Int(data[at + 4]) << 3) | (Int(data[at + 5]) >> 5)
    let headerLength = data[at + 1] & 1 == 1 ? 7 : 9
    guard length >= headerLength else { return nil }
    return AdtsHeader(
      length: length, headerLength: headerLength, objectType: Int(data[at + 2] >> 6) + 1,
      sampleRate: aacRates[index], channels: ((Int(data[at + 2]) & 1) << 2) | (Int(data[at + 3]) >> 6),
      blocks: (Int(data[at + 6]) & 3) + 1)
  }

  // MARK: - MPEG audio (MP3)

  private static let mp3BitratesV1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
  private static let mp3BitratesV2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  private static let mpegRates: [Int: [Int]] = [3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]]

  struct MpegAudioHeader {
    var length: Int
    var sampleRate: Int
    var channels: Int
    var samples: Int
    /// 3: Layer III; 2: Layer II; 1: Layer I.
    var layer: Int
  }

  /// The MPEG audio frame header at `at`; `nil` when there is none. Only Layer III has a length.
  static func mpegAudioHeader(_ data: [UInt8], _ at: Int) -> MpegAudioHeader? {
    guard at + 4 <= data.count, data[at] == 0xFF, data[at + 1] & 0xE0 == 0xE0 else { return nil }
    let version = Int(data[at + 1] >> 3) & 3
    let layerBits = Int(data[at + 1] >> 1) & 3
    let bitrateIndex = Int(data[at + 2] >> 4)
    let rateIndex = Int(data[at + 2] >> 2) & 3
    guard version != 1, layerBits != 0, rateIndex != 3, bitrateIndex != 0, bitrateIndex != 15 else { return nil }
    let sampleRate = mpegRates[version]![rateIndex]
    let channels = data[at + 3] >> 6 == 3 ? 1 : 2
    let layer = 4 - layerBits
    if layer != 3 { return MpegAudioHeader(length: 0, sampleRate: sampleRate, channels: channels, samples: 1152, layer: layer) }
    let v1 = version == 3
    let bitrate = (v1 ? mp3BitratesV1 : mp3BitratesV2)[bitrateIndex] * 1000
    let padding = Int(data[at + 2] >> 1) & 1
    let length = ((v1 ? 144 : 72) * bitrate) / sampleRate + padding
    return MpegAudioHeader(length: length, sampleRate: sampleRate, channels: channels, samples: v1 ? 1152 : 576, layer: 3)
  }

  // MARK: - AC-3, E-AC-3

  private static let ac3Bitrates = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640]
  private static let ac3Rates = [48000, 44100, 32000]
  private static let ac3Channels = [2, 1, 2, 3, 3, 4, 4, 5]

  struct Ac3Header {
    var length: Int
    var sampleRate: Int
    var channels: Int
    var samples: Int
    /// The `dac3` (AC-3) or `dec3` (E-AC-3) payload.
    var config: [UInt8]
    /// E-AC-3: an independent substream's frame.
    var independent: Bool
    /// E-AC-3 (`ec-3`), not AC-3 (`ac-3`).
    var extended: Bool
  }

  /// An AC-3 or E-AC-3 sync frame's header at `at`; `nil` when there is none.
  static func ac3Header(_ data: [UInt8], _ at: Int) -> Ac3Header? {
    guard at + 8 <= data.count, data[at] == 0x0B, data[at + 1] == 0x77 else { return nil }
    let bsid = Int(data[at + 5]) >> 3
    return bsid > 10 ? eac3Frame(data, at) : ac3Frame(data, at)
  }

  private static func ac3Frame(_ data: [UInt8], _ at: Int) -> Ac3Header? {
    var r = BitReader(Bytes.slice(data, at + 4, at + 8))
    let fscod = r.bits(2)
    let frmsizecod = r.bits(6)
    let bsid = r.bits(5)
    let bsmod = r.bits(3)
    let acmod = r.bits(3)
    guard fscod != 3, frmsizecod <= 37 else { return nil }
    if acmod & 1 != 0 && acmod != 1 { r.skip(2) }
    if acmod & 4 != 0 { r.skip(2) }
    if acmod == 2 { r.skip(2) }
    let lfeon = r.bits(1)
    let kbps = ac3Bitrates[frmsizecod >> 1]
    var words = kbps * 2
    if fscod == 1 {
      words = (kbps * 320) / 147 + (frmsizecod & 1)
    } else if fscod == 2 {
      words = kbps * 3
    }
    let rateCode = frmsizecod >> 1
    let w = BoxWriter(capacity: 3)
    w.u8((fscod << 6) | (bsid << 1) | (bsmod >> 2))
    w.u8(((bsmod & 3) << 6) | (acmod << 3) | (lfeon << 2) | (rateCode >> 3))
    w.u8((rateCode & 7) << 5)
    return Ac3Header(
      length: words * 2, sampleRate: ac3Rates[fscod], channels: ac3Channels[acmod] + lfeon, samples: 1536,
      config: w.finish(), independent: true, extended: false)
  }

  private static func eac3Frame(_ data: [UInt8], _ at: Int) -> Ac3Header? {
    var r = BitReader(Bytes.slice(data, at + 2, at + 8))
    let strmtyp = r.bits(2)
    r.skip(3)
    let length = (r.bits(11) + 1) * 2
    let fscod = r.bits(2)
    var sampleRate: Int
    var blocks = 6
    if fscod == 3 {
      let fscod2 = r.bits(2)
      sampleRate = fscod2 < 3 ? [24000, 22050, 16000][fscod2] : 0
    } else {
      blocks = [1, 2, 3, 6][r.bits(2)]
      sampleRate = ac3Rates[fscod]
    }
    let acmod = r.bits(3)
    let lfeon = r.bits(1)
    let bsid = r.bits(5)
    guard sampleRate != 0 else { return nil }
    let samples = blocks * 256
    let dataRate = (length * 8 * sampleRate) / (samples * 1000)
    let w = BoxWriter(capacity: 5)
    w.u16(dataRate << 3)
    w.u8(((fscod == 3 ? 0 : fscod) << 6) | (bsid << 1))
    w.u8((acmod << 1) | lfeon)
    w.u8(0)
    return Ac3Header(
      length: length, sampleRate: sampleRate, channels: ac3Channels[acmod] + lfeon, samples: samples,
      config: w.finish(), independent: strmtyp != 1, extended: true)
  }

  // MARK: - Opus

  /// The `dOps` payload from an `OpusHead` (Matroska's CodecPrivate); `nil` when it is not one.
  static func opusConfig(_ head: [UInt8]) -> (config: [UInt8], channels: Int)? {
    guard head.count >= 19, head[0..<8].elementsEqual("OpusHead".utf8) else { return nil }
    let channels = Int(head[9])
    let family = Int(head[18])
    let w = BoxWriter(capacity: 32)
    w.u8(0).u8(channels)
    w.u16(Int(head[10]) | (Int(head[11]) << 8))
    w.u32(Int(head[12]) | (Int(head[13]) << 8) | (Int(head[14]) << 16) | (Int(head[15]) << 24))
    w.u16(Int(head[16]) | (Int(head[17]) << 8))
    w.u8(family)
    if family != 0 {
      guard head.count >= 21 + channels else { return nil }
      w.raw(Array(head[19..<(21 + channels)]))
    }
    return (w.finish(), channels)
  }

  /// Samples (at 48 kHz) an Opus packet decodes to, from its TOC byte.
  static func opusSamples(_ packet: [UInt8]) -> Int {
    guard let toc = packet.first.map(Int.init) else { return 0 }
    let config = toc >> 3
    let size: Int
    if config < 12 {
      size = [480, 960, 1920, 2880][config & 3]
    } else if config < 16 {
      size = config & 1 == 1 ? 960 : 480
    } else {
      size = [120, 240, 480, 960][config & 3]
    }
    let code = toc & 3
    var frames = 1
    if code == 1 || code == 2 {
      frames = 2
    } else if code == 3 {
      frames = packet.count > 1 ? Int(packet[1]) & 0x3F : 0
    }
    return size * frames
  }

  // MARK: - FLAC

  /// The `dfLa` payload (STREAMINFO only) from Matroska's CodecPrivate (`fLaC` + metadata blocks).
  static func flacConfig(_ codecPrivate: [UInt8]) -> (config: [UInt8], sampleRate: Int, channels: Int)? {
    var at = codecPrivate.count >= 4 && Bytes.readUint(codecPrivate, 0, 4) == 0x664C_6143 ? 4 : 0
    while at + 4 <= codecPrivate.count {
      let type = Int(codecPrivate[at]) & 0x7F
      let length = Bytes.readUint(codecPrivate, at + 1, 3)
      if type == 0 && length >= 18 && at + 4 + length <= codecPrivate.count {
        let info = Array(codecPrivate[(at + 4)..<(at + 4 + length)])
        let w = BoxWriter(capacity: 4 + length)
        w.u8(0x80).u24(length).raw(info)
        let sampleRate = (Int(info[10]) << 12) | (Int(info[11]) << 4) | (Int(info[12]) >> 4)
        let channels = ((Int(info[12]) >> 1) & 7) + 1
        return (w.finish(), sampleRate, channels)
      }
      at += 4 + length
    }
    return nil
  }

  /// Samples in a FLAC frame, from its header; `nil` when it is not one.
  static func flacSamples(_ frame: [UInt8]) -> Int? {
    guard frame.count >= 5, frame[0] == 0xFF, frame[1] & 0xFE == 0xF8 else { return nil }
    let code = Int(frame[2]) >> 4
    if code == 1 { return 192 }
    if code >= 2 && code <= 5 { return 576 << (code - 2) }
    if code >= 8 { return 256 << (code - 8) }
    guard code == 6 || code == 7 else { return nil }
    let lead = Int(frame[4])
    var extra = 0
    while extra < 7 && lead & (0x80 >> extra) != 0 { extra += 1 }
    let at = 4 + max(1, extra)
    if code == 6 { return at < frame.count ? Int(frame[at]) + 1 : nil }
    return at + 1 < frame.count ? Bytes.readUint(frame, at, 2) + 1 : nil
  }
}
