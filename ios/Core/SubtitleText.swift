import Foundation

// The two subtitle pieces native code needs itself: the text encoding of a
// file nobody declared (fansub and DVD-rip SubRip files are often
// Windows-1252, Windows-1251 or Shift-JIS), and which cues are on screen at a
// position with the subtitle delay. Parsing is the TypeScript layer's
// (`src/core/subtitles/`). Twins: `charset.ts` and `schedule.ts` there,
// `android/.../core/SubtitleText.kt`; held to `conformance/subtitles/`.

enum SubtitleCharset {
  /// Length of a UTF-8 sequence from its lead byte (0: not a lead byte).
  private static func sequenceLength(_ lead: UInt8) -> Int {
    switch lead {
    case 0..<0x80: return 1
    case 0xc2...0xdf: return 2
    case 0xe0...0xef: return 3
    case 0xf0...0xf4: return 4
    default: return 0
    }
  }

  static func isValidUtf8(_ bytes: [UInt8]) -> Bool {
    var i = 0
    while i < bytes.count {
      let length = sequenceLength(bytes[i])
      if length == 0 || i + length > bytes.count { return false }
      for k in 1..<max(1, length) where bytes[i + k] & 0xc0 != 0x80 { return false }
      i += length
    }
    return true
  }

  /// UTF-16 without a byte-order mark: ASCII text leaves every other byte zero.
  private static func utf16Without(_ bytes: [UInt8]) -> String? {
    guard bytes.count >= 4 else { return nil }
    var even = 0
    var odd = 0
    var i = 0
    while i + 1 < bytes.count {
      if bytes[i] == 0 { even += 1 }
      if bytes[i + 1] == 0 { odd += 1 }
      i += 2
    }
    let pairs = Double(bytes.count / 2)
    if Double(odd) > pairs * 0.4 && Double(even) < pairs * 0.05 { return "utf-16le" }
    if Double(even) > pairs * 0.4 && Double(odd) < pairs * 0.05 { return "utf-16be" }
    return nil
  }

  private static func isTrail(_ b: UInt8) -> Bool { (0x40...0x7e).contains(b) || (0x80...0xfc).contains(b) }

  /// Whether the bytes are valid Shift-JIS with the lead bytes of Japanese text.
  private static func looksShiftJis(_ bytes: [UInt8]) -> Bool {
    var pairs = 0
    var kana = 0
    var i = 0
    while i < bytes.count {
      let b = bytes[i]
      // ASCII and half-width katakana are one byte.
      if b < 0x80 || (0xa1...0xdf).contains(b) {
        i += 1
        continue
      }
      let lead = (0x81...0x9f).contains(b) || (0xe0...0xfc).contains(b)
      guard lead, i + 1 < bytes.count, isTrail(bytes[i + 1]) else { return false }
      // Hiragana, katakana and most kanji lead with 0x81–0x9F: Cyrillic in
      // Windows-1251 almost never does.
      if b <= 0x9f { kana += 1 }
      pairs += 1
      i += 2
    }
    return pairs > 0 && Double(kana) >= Double(pairs) * 0.5
  }

  /// Cyrillic text is mostly non-ASCII letters; Western text mostly ASCII ones.
  private static func singleByte(_ bytes: [UInt8]) -> String {
    var ascii = 0
    var high = 0
    for b in bytes {
      if (0x41...0x5a).contains(b) || (0x61...0x7a).contains(b) {
        ascii += 1
      } else if b >= 0xc0 {
        high += 1
      }
    }
    return Double(high) > Double(ascii + high) * 0.4 ? "windows-1251" : "windows-1252"
  }

  /// The encoding the bytes are most likely in (a WHATWG label).
  static func detect(_ bytes: [UInt8]) -> String {
    if bytes.starts(with: [0xef, 0xbb, 0xbf]) { return "utf-8" }
    if bytes.starts(with: [0xff, 0xfe]) { return "utf-16le" }
    if bytes.starts(with: [0xfe, 0xff]) { return "utf-16be" }
    if let wide = utf16Without(bytes) { return wide }
    if isValidUtf8(bytes) { return "utf-8" }
    if looksShiftJis(bytes) { return "shift_jis" }
    return singleByte(bytes)
  }

  /// The Foundation encoding for a label `detect` returns.
  static func encoding(_ label: String) -> String.Encoding {
    switch label {
    case "utf-16le": return .utf16LittleEndian
    case "utf-16be": return .utf16BigEndian
    case "shift_jis": return .shiftJIS
    case "windows-1251": return .windowsCP1251
    case "windows-1252": return .windowsCP1252
    default: return .utf8
    }
  }
}

/// A cue's time on the media timeline, seconds.
struct CueTime: Equatable {
  let start: Double
  let end: Double
}

enum CueSchedule {
  /// The indices of the cues (sorted by start) showing at `position`, in
  /// order. A positive `delay` shows every cue later.
  static func active(_ cues: [CueTime], at position: Double, delay: Double = 0) -> [Int] {
    let t = position - delay
    var active: [Int] = []
    for (i, cue) in cues.enumerated() {
      if cue.start > t { break }
      if t < cue.end { active.append(i) }
    }
    return active
  }

  /// The next position at which the active set changes, after `position`; `nil`: never again.
  static func nextChange(_ cues: [CueTime], after position: Double, delay: Double = 0) -> Double? {
    let t = position - delay
    var next = Double.infinity
    for cue in cues {
      if cue.start > t {
        next = min(next, cue.start)
        break
      }
      if cue.end > t { next = min(next, cue.end) }
    }
    return next == .infinity ? nil : next + delay
  }
}
