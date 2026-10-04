import Foundation

// Normalization of in-stream metadata (ICY / Shoutcast / Icecast, ID3, HLS
// timed metadata) into one shape. The byte-level ICY framing (`icy-metaint`
// interleaving) is done by the platform stacks — Media3's IcyDataSource and
// AVFoundation — so only the payload is handled here: charset, `key='value';`
// fields, "Artist - Title" splitting. Kotlin twin: `core/StreamMetadata.kt`.

struct StreamMetadata: Equatable {
  var title: String?
  var artist: String?
  var album: String?
  /// Station name (ICY `icy-name` header, where the platform exposes it).
  var station: String?
  var genre: String?
  /// Artwork URL carried by the stream (ICY `StreamUrl` when it is an image).
  var artworkUri: String?
  /// Every raw field, untouched (keys as sent, e.g. `StreamTitle`).
  var raw: [String: String] = [:]

  var isEmpty: Bool {
    title == nil && artist == nil && album == nil && station == nil && genre == nil
      && artworkUri == nil && raw.isEmpty
  }
}

/// How a station formats ICY `StreamTitle`. There is no standard; the
/// overwhelming convention is "Artist - Title".
enum StreamTitleFormat: String {
  case artistTitle = "artist-title"
  case titleArtist = "title-artist"
  /// Do not split: the whole StreamTitle is the title.
  case title
}

enum IcyParser {
  /// Separators tried in order when splitting a StreamTitle.
  private static let separators = [" - ", " – ", " — ", " ~ "]

  /// Decodes a raw ICY metadata block: trailing NUL padding stripped, UTF-8
  /// when valid, otherwise Windows-1252 (the de-facto Shoutcast legacy
  /// charset; a superset of ISO-8859-1's printable range).
  static func decode(_ bytes: [UInt8]) -> String {
    var end = bytes.count
    while end > 0 && bytes[end - 1] == 0 { end -= 1 }
    let trimmed = Array(bytes[0..<end])
    if let utf8 = String(bytes: trimmed, encoding: .utf8) { return utf8 }
    return String(trimmed.map { Character(cp1252Scalar($0)) })
  }

  /// Repairs UTF-8 text that a platform decoded as Latin-1/Windows-1252
  /// ("CafÃ©" → "Café"). Genuine Latin-1 text ("Café") is left alone because
  /// its bytes are not valid UTF-8.
  static func repairMojibake(_ text: String) -> String {
    var bytes: [UInt8] = []
    bytes.reserveCapacity(text.unicodeScalars.count)
    var sawHigh = false
    for scalar in text.unicodeScalars {
      guard let byte = cp1252Byte(scalar) else { return text }
      if byte >= 0x80 { sawHigh = true }
      bytes.append(byte)
    }
    guard sawHigh, let repaired = String(bytes: bytes, encoding: .utf8) else { return text }
    return repaired
  }

  /// Parses `StreamTitle='…';StreamUrl='…';` into fields. Values may contain
  /// quotes and semicolons ("Guns N' Roses"): a value ends at `';` that is
  /// followed by the end of the block or by the next `key='`.
  static func parseFields(_ block: String) -> [String: String] {
    var result: [String: String] = [:]
    let chars = Array(block)
    var i = 0
    while i < chars.count {
      // Key: up to `='`.
      guard let eq = find(chars, "='", from: i) else { break }
      let key = String(chars[i..<eq]).trimmingCharacters(in: .whitespacesAndNewlines)
      var valueStart = eq + 2
      var end = chars.count
      var next = chars.count
      var search = valueStart
      while let candidate = find(chars, "';", from: search) {
        let after = candidate + 2
        if after >= chars.count || startsKey(chars, at: after) {
          end = candidate
          next = after
          break
        }
        search = candidate + 1
      }
      if end == chars.count {
        // Unterminated (malformed): take the rest, minus a dangling quote.
        var stop = chars.count
        while stop > valueStart && (chars[stop - 1] == "'" || chars[stop - 1] == ";") {
          stop -= 1
        }
        end = stop
      }
      if valueStart > end { valueStart = end }
      if !key.isEmpty && result[key] == nil {
        result[key] = String(chars[valueStart..<end])
      }
      i = next
    }
    return result
  }

  /// Splits a StreamTitle per `format`. Returns (artist, title).
  static func splitStreamTitle(_ raw: String, format: StreamTitleFormat) -> (String?, String?) {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    // Empty, or nothing but separator characters (" - " placeholders).
    guard trimmed.contains(where: { !"-–—~ ".contains($0) }) else { return (nil, nil) }
    if format == .title { return (nil, trimmed) }
    for separator in separators {
      if let range = trimmed.range(of: separator) {
        let left = nonEmpty(String(trimmed[..<range.lowerBound]))
        let right = nonEmpty(String(trimmed[range.upperBound...]))
        if left == nil && right == nil { return (nil, nil) }
        return format == .artistTitle ? (left, right) : (right, left)
      }
    }
    return (nil, trimmed)
  }

  /// Builds normalized metadata from ICY fields.
  static func metadata(fromFields rawFields: [String: String], format: StreamTitleFormat)
    -> StreamMetadata
  {
    var fields: [String: String] = [:]
    for (key, value) in rawFields { fields[key] = repairMojibake(value) }
    var meta = StreamMetadata(raw: fields)
    let lower = Dictionary(fields.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { a, _ in a })
    if let streamTitle = lower["streamtitle"] {
      let (artist, title) = splitStreamTitle(streamTitle, format: format)
      meta.artist = artist
      meta.title = title
    }
    if let url = lower["streamurl"], looksLikeImage(url) { meta.artworkUri = url }
    if let name = lower["icy-name"] { meta.station = nonEmpty(name) }
    if let genre = lower["icy-genre"] { meta.genre = nonEmpty(genre) }
    return meta
  }

  /// Convenience: raw ICY block bytes → metadata.
  /// A block without `StreamTitle`/`StreamUrl` (corrupted framing, garbage)
  /// yields empty metadata, which is never published.
  static func metadata(fromBlock bytes: [UInt8], format: StreamTitleFormat) -> StreamMetadata {
    let fields = parseFields(decode(bytes))
    guard fields.keys.contains(where: { ["streamtitle", "streamurl"].contains($0.lowercased()) }) else {
      return StreamMetadata()
    }
    return metadata(fromFields: fields, format: format)
  }

  static func looksLikeImage(_ url: String) -> Bool {
    let lower = url.lowercased()
    guard lower.hasPrefix("http://") || lower.hasPrefix("https://") else { return false }
    let path = lower.split(separator: "?").first.map(String.init) ?? lower
    return [".jpg", ".jpeg", ".png", ".webp", ".gif"].contains { path.hasSuffix($0) }
  }

  // MARK: - Helpers

  private static func nonEmpty(_ s: String) -> String? {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : t
  }

  private static func find(_ chars: [Character], _ needle: String, from: Int) -> Int? {
    let n = Array(needle)
    guard from <= chars.count - n.count else { return nil }
    var i = from
    while i <= chars.count - n.count {
      if chars[i] == n[0] && Array(chars[i..<(i + n.count)]) == n { return i }
      i += 1
    }
    return nil
  }

  private static func startsKey(_ chars: [Character], at index: Int) -> Bool {
    var i = index
    while i < chars.count && (chars[i].isLetter || chars[i].isNumber || chars[i] == "_" || chars[i] == "-") {
      i += 1
    }
    return i > index && i + 1 < chars.count && chars[i] == "=" && chars[i + 1] == "'"
  }

  /// Windows-1252 0x80–0x9F → Unicode (undefined bytes map to C1 controls).
  private static let cp1252High: [UInt32] = [
    0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
    0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
  ]

  private static func cp1252Scalar(_ byte: UInt8) -> Unicode.Scalar {
    if byte >= 0x80 && byte <= 0x9F { return Unicode.Scalar(cp1252High[Int(byte - 0x80)])! }
    return Unicode.Scalar(byte)
  }

  private static func cp1252Byte(_ scalar: Unicode.Scalar) -> UInt8? {
    if scalar.value < 0x80 || (scalar.value >= 0xA0 && scalar.value <= 0xFF) {
      return UInt8(scalar.value)
    }
    if let index = cp1252High.firstIndex(of: scalar.value) { return UInt8(0x80 + index) }
    return nil
  }
}

/// Incremental de-interleaver for an ICY body: every `metaint` audio bytes are
/// followed by one length byte `L` and `L × 16` bytes of metadata (NUL-padded);
/// `L == 0` means "no change". Chunk boundaries may fall anywhere.
struct IcyDeinterleaver {
  struct Block: Equatable {
    /// Audio bytes delivered before this block (its position in the audio).
    let audioOffset: Int64
    let bytes: [UInt8]
  }

  private enum Phase: Equatable {
    case audio(remaining: Int)
    case length
    case metadata(remaining: Int)
  }

  let metaint: Int
  private var phase: Phase
  private var pending: [UInt8] = []
  private(set) var audioBytes: Int64 = 0

  /// `metaint <= 0` passes everything through as audio.
  init(metaint: Int) {
    self.metaint = metaint
    phase = .audio(remaining: max(metaint, 0))
  }

  mutating func consume(_ data: [UInt8]) -> (audio: [UInt8], blocks: [Block]) {
    guard metaint > 0 else {
      audioBytes += Int64(data.count)
      return (data, [])
    }
    var audio: [UInt8] = []
    audio.reserveCapacity(data.count)
    var blocks: [Block] = []
    var i = 0
    while i < data.count {
      switch phase {
      case .audio(let remaining):
        let take = min(remaining, data.count - i)
        audio.append(contentsOf: data[i..<(i + take)])
        audioBytes += Int64(take)
        i += take
        phase = remaining - take == 0 ? .length : .audio(remaining: remaining - take)
      case .length:
        let length = Int(data[i]) * 16
        i += 1
        if length == 0 {
          phase = .audio(remaining: metaint)
        } else {
          pending.removeAll(keepingCapacity: true)
          phase = .metadata(remaining: length)
        }
      case .metadata(let remaining):
        let take = min(remaining, data.count - i)
        pending.append(contentsOf: data[i..<(i + take)])
        i += take
        if remaining - take == 0 {
          blocks.append(Block(audioOffset: audioBytes, bytes: pending))
          pending.removeAll(keepingCapacity: true)
          phase = .audio(remaining: metaint)
        } else {
          phase = .metadata(remaining: remaining - take)
        }
      }
    }
    return (audio, blocks)
  }
}

/// Re-interleaves audio and ICY metadata at a fixed cadence. Used by the iOS
/// stream proxy to splice a fresh upstream connection into a response AVPlayer
/// is already parsing: the new connection restarts ICY framing at zero, but
/// AVPlayer keeps counting from the old one, so the proxy strips metadata from
/// each upstream and re-inserts it at the cadence it promised downstream.
struct IcyReframer {
  let metaint: Int
  private var sinceBlock = 0
  private var pendingBlock: [UInt8]?

  init(metaint: Int) { self.metaint = metaint }

  /// Queues metadata (raw block payload) for the next boundary; the latest wins.
  mutating func queue(_ payload: [UInt8]) {
    pendingBlock = payload
  }

  /// Frames audio. A boundary's block is written lazily, just before the
  /// audio that follows it, so a block queued exactly at a boundary lands
  /// there: an unspliced stream comes out byte-identical.
  mutating func frame<C: Collection>(_ audio: C) -> [UInt8] where C.Element == UInt8 {
    guard metaint > 0 else { return Array(audio) }
    var out: [UInt8] = []
    out.reserveCapacity(audio.count + 64)
    var i = audio.startIndex
    while i != audio.endIndex {
      if sinceBlock == metaint {
        writeBlock(into: &out)
        sinceBlock = 0
      }
      let take = min(metaint - sinceBlock, audio.distance(from: i, to: audio.endIndex))
      let end = audio.index(i, offsetBy: take)
      out.append(contentsOf: audio[i..<end])
      sinceBlock += take
      i = end
    }
    return out
  }

  /// Frames one de-interleaver output, re-inserting each block at the audio
  /// position it was found at. `audioEnd` is the de-interleaver's
  /// `audioBytes` after producing `chunk`.
  mutating func frame(_ chunk: (audio: [UInt8], blocks: [IcyDeinterleaver.Block]), audioEnd: Int64) -> [UInt8] {
    var out: [UInt8] = []
    var cursor = audioEnd - Int64(chunk.audio.count)
    var start = 0
    for block in chunk.blocks {
      let upTo = max(0, min(Int(block.audioOffset - cursor), chunk.audio.count - start))
      out += frame(chunk.audio[start..<(start + upTo)])
      start += upTo
      cursor += Int64(upTo)
      queue(block.bytes)
    }
    out += frame(chunk.audio[start...])
    return out
  }

  private mutating func writeBlock(into out: inout [UInt8]) {
    if var payload = pendingBlock, !payload.isEmpty {
      let blocks = min((payload.count + 15) / 16, 255)
      payload = Array(payload.prefix(blocks * 16))
      payload += [UInt8](repeating: 0, count: blocks * 16 - payload.count)
      out.append(UInt8(blocks))
      out.append(contentsOf: payload)
    } else {
      out.append(0)
    }
    pendingBlock = nil
  }
}
