import Foundation

// Byte and bit helpers of the remuxer. The TypeScript twin is
// src/web/remux/bytes.ts.

/// Reads big-endian bit fields, and Exp-Golomb codes (H.264, HEVC).
struct BitReader {
  private let data: [UInt8]
  private var pos = 0

  init(_ data: [UInt8]) {
    self.data = data
  }

  /// Bits left.
  var left: Int { data.count * 8 - pos }

  /// The next `count` bits (at most 32) as an unsigned number; zeros past the end.
  mutating func bits(_ count: Int) -> Int {
    var value = 0
    for _ in 0..<max(0, count) {
      let index = pos >> 3
      let byte = index < data.count ? Int(data[index]) : 0
      value = value * 2 + ((byte >> (7 - (pos & 7))) & 1)
      pos += 1
    }
    return value
  }

  mutating func bit() -> Bool { bits(1) == 1 }

  mutating func skip(_ count: Int) { pos += count }

  /// ue(v).
  mutating func ue() -> Int {
    var zeros = 0
    while left > 0 && !bit() { zeros += 1 }
    if zeros > 31 { return 0 }
    return (1 << zeros) - 1 + bits(zeros)
  }

  /// se(v).
  mutating func se() -> Int {
    let value = ue()
    return value % 2 == 1 ? (value + 1) / 2 : -(value / 2)
  }
}

enum Bytes {
  /// A NAL unit's payload without its emulation prevention bytes (`00 00 03`).
  static func unescapeRbsp(_ nal: [UInt8]) -> [UInt8] {
    var out: [UInt8] = []
    out.reserveCapacity(nal.count)
    var zeros = 0
    for byte in nal {
      if zeros >= 2 && byte == 3 {
        zeros = 0
        continue
      }
      out.append(byte)
      zeros = byte == 0 ? zeros + 1 : 0
    }
    return out
  }

  static func hex2(_ value: Int) -> String { String(format: "%02X", value) }

  static func pad2(_ value: Int) -> String { value < 10 && value >= 0 ? "0\(value)" : "\(value)" }

  /// Big-endian unsigned integer of `length` bytes at `at` (zeros past the end).
  static func readUint(_ data: [UInt8], _ at: Int, _ length: Int) -> Int {
    var value = 0
    for i in 0..<length {
      let index = at + i
      value = value * 256 + (index >= 0 && index < data.count ? Int(data[index]) : 0)
    }
    return value
  }

  /// `value × num / den`, rounded half up, in integers (`value` ≥ 0).
  static func rescale(_ value: Int, _ num: Int, _ den: Int) -> Int {
    if num == den { return value }
    return (2 * value * num + den) / (2 * den)
  }

  /// `rescale` for a value that may be negative (symmetric rounding).
  static func signedRescale(_ value: Int, _ num: Int, _ den: Int) -> Int {
    value < 0 ? -rescale(-value, num, den) : rescale(value, num, den)
  }

  /// `bytes[from..<to]`, clamped, as an array.
  static func slice(_ bytes: [UInt8], _ from: Int, _ to: Int) -> [UInt8] {
    let start = max(0, min(from, bytes.count))
    let end = max(start, min(to, bytes.count))
    return Array(bytes[start..<end])
  }

  /// UTF-8 text without trailing NULs (and without a leading BOM, as `TextDecoder` drops it).
  static func utf8(_ bytes: [UInt8]) -> String {
    var end = bytes.count
    while end > 0 && bytes[end - 1] == 0 { end -= 1 }
    var start = 0
    if end >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF { start = 3 }
    return String(decoding: bytes[start..<end], as: UTF8.self)
  }
}

/// Writes MP4 boxes into one growing buffer; `end` patches the size of the box `begin` opened.
final class BoxWriter {
  private(set) var bytes: [UInt8] = []
  private var open: [Int] = []

  init(capacity: Int = 512) {
    bytes.reserveCapacity(capacity)
  }

  /// Opens a box (a full box when `version` is given).
  @discardableResult
  func begin(_ type: String, _ version: Int? = nil, flags: Int = 0) -> BoxWriter {
    open.append(bytes.count)
    u32(0).ascii(type)
    if let version { u32((version << 24) | flags) }
    return self
  }

  @discardableResult
  func end() -> BoxWriter {
    let start = open.removeLast()
    let size = UInt32(truncatingIfNeeded: bytes.count - start)
    bytes[start] = UInt8(size >> 24)
    bytes[start + 1] = UInt8((size >> 16) & 0xFF)
    bytes[start + 2] = UInt8((size >> 8) & 0xFF)
    bytes[start + 3] = UInt8(size & 0xFF)
    return self
  }

  @discardableResult
  func u8(_ value: Int) -> BoxWriter {
    bytes.append(UInt8(truncatingIfNeeded: value))
    return self
  }

  @discardableResult
  func u16(_ value: Int) -> BoxWriter {
    u8(value >> 8).u8(value)
  }

  @discardableResult
  func u24(_ value: Int) -> BoxWriter {
    u8(value >> 16).u16(value & 0xFFFF)
  }

  @discardableResult
  func u32(_ value: Int) -> BoxWriter {
    let v = UInt32(truncatingIfNeeded: value)
    return u8(Int(v >> 24)).u8(Int((v >> 16) & 0xFF)).u8(Int((v >> 8) & 0xFF)).u8(Int(v & 0xFF))
  }

  /// A signed 32-bit integer.
  @discardableResult
  func i32(_ value: Int) -> BoxWriter { u32(value) }

  @discardableResult
  func u64(_ value: Int) -> BoxWriter {
    u32(value >> 32).u32(value & 0xFFFF_FFFF)
  }

  @discardableResult
  func zeros(_ count: Int) -> BoxWriter {
    bytes.append(contentsOf: repeatElement(0, count: count))
    return self
  }

  @discardableResult
  func ascii(_ text: String) -> BoxWriter {
    bytes.append(contentsOf: Array(text.utf8))
    return self
  }

  @discardableResult
  func raw(_ data: [UInt8]) -> BoxWriter {
    bytes.append(contentsOf: data)
    return self
  }

  func finish() -> [UInt8] { bytes }
}
