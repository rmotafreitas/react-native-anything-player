import Foundation

/// Fragmented MP4 for remuxed tracks: one init segment (ftyp + moov) for the
/// tracks chosen, then a moof + mdat per fragment. The TypeScript twin
/// (src/web/remux/Mp4Writer.ts) writes the same bytes: both are compared with
/// conformance/remux/*.out/.
enum Mp4Writer {
  private static let identityMatrix = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000]
  /// tfhd: the base data offset is the start of the moof.
  private static let defaultBaseIsMoof = 0x020000
  /// trun: data offset, then a duration and a size per sample.
  private static let trunAudio = 0x000301
  /// trun: data offset, then a duration, size, flags and composition offset per sample.
  private static let trunVideo = 0x000F01
  private static let syncFlags = 0x0200_0000
  private static let nonSyncFlags = 0x0101_0000
  private static let languageUnd = 0x55C4

  /// mdhd's packed ISO 639-2 code (`und` for anything else).
  static func packedLanguage(_ language: String?) -> Int {
    guard let language, language.count == 3, language.unicodeScalars.allSatisfy({ $0.value >= 97 && $0.value <= 122 })
    else { return languageUnd }
    var packed = 0
    for scalar in language.unicodeScalars { packed = (packed << 5) | (Int(scalar.value) - 0x60) }
    return packed
  }

  /// The displayed width: the coded one stretched by the sample aspect ratio.
  static func displayWidth(_ track: RemuxTrack) -> Int {
    (track.width * track.sarWidth) / track.sarHeight
  }

  private static func matrix(_ w: BoxWriter) {
    for value in identityMatrix { w.u32(value) }
  }

  private static func visualEntry(_ w: BoxWriter, _ track: RemuxTrack) {
    let entry = track.entry ?? "avc1"
    w.begin(entry)
    w.zeros(6).u16(1)
    w.u16(0).u16(0).zeros(12)
    w.u16(track.width).u16(track.height)
    w.u32(0x0048_0000).u32(0x0048_0000)
    w.u32(0).u16(1)
    w.zeros(32)
    w.u16(0x0018).u16(0xFFFF)
    let config = track.config ?? []
    switch entry {
    case "avc1": w.begin("avcC").raw(config).end()
    case "hvc1": w.begin("hvcC").raw(config).end()
    case "av01": w.begin("av1C").raw(config).end()
    default: w.begin("vpcC", 1).raw(config).end()
    }
    if track.sarWidth != track.sarHeight { w.begin("pasp").u32(track.sarWidth).u32(track.sarHeight).end() }
    w.end()
  }

  private static func esds(_ w: BoxWriter, _ track: RemuxTrack) {
    let specific = (track.config?.isEmpty ?? true) ? nil : track.config
    let decoderConfig = 13 + (specific.map { 2 + $0.count } ?? 0)
    w.begin("esds", 0)
    w.u8(0x03).u8(3 + 2 + decoderConfig + 3)
    w.u16(0).u8(0)
    w.u8(0x04).u8(decoderConfig)
    w.u8(track.objectType).u8(0x15)
    w.zeros(3).u32(0).u32(0)
    if let specific { w.u8(0x05).u8(specific.count).raw(specific) }
    w.u8(0x06).u8(1).u8(0x02)
    w.end()
  }

  private static func audioEntry(_ w: BoxWriter, _ track: RemuxTrack) {
    let entry = track.entry ?? "mp4a"
    w.begin(entry)
    w.zeros(6).u16(1)
    w.zeros(8)
    w.u16(track.channels).u16(16).u16(0).u16(0)
    w.u32(track.sampleRate > 0xFFFF ? 0 : track.sampleRate * 65536)
    let config = track.config ?? []
    switch entry {
    case "mp4a": esds(w, track)
    case "Opus": w.begin("dOps").raw(config).end()
    case "fLaC": w.begin("dfLa", 0).raw(config).end()
    case "ac-3": w.begin("dac3").raw(config).end()
    default: w.begin("dec3").raw(config).end()
    }
    w.end()
  }

  private static func emptyTable(_ w: BoxWriter, _ type: String, extra: Int = 0) {
    w.begin(type, 0).zeros(extra).u32(0).end()
  }

  private static func trak(_ w: BoxWriter, _ track: RemuxTrack, id: Int) {
    let video = track.kind == .video
    w.begin("trak")
    w.begin("tkhd", 0, flags: 3).u32(0).u32(0).u32(id).u32(0).u32(0)
    w.zeros(8).u16(0).u16(0).u16(video ? 0 : 0x0100).u16(0)
    matrix(w)
    w.u32(video ? displayWidth(track) * 65536 : 0)
    w.u32(video ? track.height * 65536 : 0)
    w.end()
    w.begin("mdia")
    w.begin("mdhd", 0).u32(0).u32(0).u32(track.timescale).u32(0)
    w.u16(packedLanguage(track.language)).u16(0).end()
    w.begin("hdlr", 0).u32(0).ascii(video ? "vide" : "soun").zeros(12)
    w.ascii(video ? "VideoHandler" : "SoundHandler").u8(0).end()
    w.begin("minf")
    if video {
      w.begin("vmhd", 0, flags: 1).zeros(8).end()
    } else {
      w.begin("smhd", 0).u32(0).end()
    }
    w.begin("dinf").begin("dref", 0).u32(1)
    w.begin("url ", 0, flags: 1).end()
    w.end().end()
    w.begin("stbl")
    w.begin("stsd", 0).u32(1)
    if video {
      visualEntry(w, track)
    } else {
      audioEntry(w, track)
    }
    w.end()
    emptyTable(w, "stts")
    emptyTable(w, "stsc")
    emptyTable(w, "stsz", extra: 4)
    emptyTable(w, "stco")
    w.end()  // stbl
    w.end()  // minf
    w.end()  // mdia
    w.end()  // trak
  }

  /// `ftyp` + `moov` for these tracks (MP4 track ids 1, 2, … in this order).
  static func initSegment(_ tracks: [RemuxTrack]) -> [UInt8] {
    let w = BoxWriter(capacity: 1024)
    w.begin("ftyp").ascii("iso5").u32(1).ascii("iso5").ascii("iso6").ascii("mp41").end()
    w.begin("moov")
    w.begin("mvhd", 0).u32(0).u32(0).u32(1000).u32(0)
    w.u32(0x0001_0000).u16(0x0100).zeros(10)
    matrix(w)
    w.zeros(24).u32(tracks.count + 1)
    w.end()
    for (i, track) in tracks.enumerated() { trak(w, track, id: i + 1) }
    w.begin("mvex")
    for i in tracks.indices { w.begin("trex", 0).u32(i + 1).u32(1).u32(0).u32(0).u32(0).end() }
    w.end()
    w.end()
    return w.finish()
  }

  /// `moof` + `mdat` with each track's samples (in the init segment's order;
  /// an empty list leaves the track out of this fragment).
  static func fragment(sequence: Int, tracks: [RemuxTrack], samples: [[RemuxSample]]) -> [UInt8] {
    let parts = tracks.enumerated()
      .map { (track: $0.element, id: $0.offset + 1, samples: $0.offset < samples.count ? samples[$0.offset] : []) }
      .filter { !$0.samples.isEmpty }
    var moofSize = 8 + 16
    var payload = 0
    for p in parts {
      let perSample = p.track.kind == .video ? 16 : 8
      moofSize += 64 + p.samples.count * perSample
      for s in p.samples { payload += s.data.count }
    }
    let w = BoxWriter(capacity: moofSize + 8 + payload)
    w.begin("moof")
    w.begin("mfhd", 0).u32(sequence).end()
    var offset = moofSize + 8
    for p in parts {
      let video = p.track.kind == .video
      w.begin("traf")
      w.begin("tfhd", 0, flags: defaultBaseIsMoof).u32(p.id).end()
      w.begin("tfdt", 1).u64(p.samples[0].dts).end()
      let signed = video && p.samples.contains { $0.pts < $0.dts }
      w.begin("trun", signed ? 1 : 0, flags: video ? trunVideo : trunAudio)
      w.u32(p.samples.count).u32(offset)
      for s in p.samples {
        w.u32(s.duration).u32(s.data.count)
        if video {
          w.u32(s.key ? syncFlags : nonSyncFlags)
          if signed { w.i32(s.pts - s.dts) } else { w.u32(s.pts - s.dts) }
        }
        offset += s.data.count
      }
      w.end()  // trun
      w.end()  // traf
    }
    w.end()  // moof
    w.begin("mdat")
    for p in parts { for s in p.samples { w.raw(s.data) } }
    w.end()
    return w.finish()
  }
}
