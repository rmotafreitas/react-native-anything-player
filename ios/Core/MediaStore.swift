import Foundation

/// Byte ranges held for one key: sorted, merged half-open intervals.
struct RangeSet: Equatable {
  private(set) var ranges: [Range<Int64>] = []

  var count: Int64 { ranges.reduce(0) { $0 + ($1.upperBound - $1.lowerBound) } }

  mutating func insert(_ range: Range<Int64>) {
    guard !range.isEmpty else { return }
    var merged = range
    var kept: [Range<Int64>] = []
    for existing in ranges {
      if existing.upperBound < merged.lowerBound || existing.lowerBound > merged.upperBound {
        kept.append(existing)
      } else {
        merged = min(existing.lowerBound, merged.lowerBound)..<max(existing.upperBound, merged.upperBound)
      }
    }
    kept.append(merged)
    ranges = kept.sorted { $0.lowerBound < $1.lowerBound }
  }

  func contains(_ range: Range<Int64>) -> Bool {
    range.isEmpty || ranges.contains { $0.lowerBound <= range.lowerBound && $0.upperBound >= range.upperBound }
  }

  /// How far from `offset` the held bytes run without a gap (0: none at `offset`).
  func run(from offset: Int64) -> Int64 {
    guard let range = ranges.first(where: { $0.lowerBound <= offset && $0.upperBound > offset }) else { return 0 }
    return range.upperBound - offset
  }
}

/// Media bytes on disk, by key: one sparse file per key and an index of the
/// ranges it holds, the whole length and content type, and when it was last
/// used. A store with `maxBytes` drops the least recently used keys past it
/// (the cache written as items play); one without keeps everything (downloads).
/// The stream proxy serves a range from it when the range is held, and writes
/// what it relays. Foundation only (tested on Linux). Thread-safe.
final class MediaStore {
  struct Entry: Codable, Equatable {
    var ranges: [ClosedRangeCodable] = []
    var totalLength: Int64?
    var contentType: String?
    var lastUsed: Double = 0
    /// The original file's extension (AVFoundation reads the container by it).
    var pathExtension: String?
  }

  /// `Range<Int64>` as stored.
  struct ClosedRangeCodable: Codable, Equatable {
    let start: Int64
    let end: Int64
  }

  let directory: URL
  private let lock = NSLock()
  private var index: [String: Entry] = [:]
  private var maxBytesValue: Int64?
  private let now: () -> Double

  init(directory: URL, maxBytes: Int64?, now: @escaping () -> Double = { Date().timeIntervalSince1970 }) {
    self.directory = directory
    self.maxBytesValue = maxBytes
    self.now = now
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if let data = try? Data(contentsOf: indexURL),
      let saved = try? JSONDecoder().decode([String: Entry].self, from: data)
    {
      index = saved
    }
  }

  var maxBytes: Int64? {
    get { locked { maxBytesValue } }
    set {
      locked { maxBytesValue = newValue }
      evict(keeping: nil)
    }
  }

  /// Bytes held across every key.
  var totalBytes: Int64 { locked { index.values.reduce(0) { $0 + Self.ranges($1).count } } }

  var keys: [String] { locked { Array(index.keys) } }

  func entry(_ key: String) -> Entry? { locked { index[key] } }

  /// The whole length and content type, from a response.
  func describe(_ key: String, totalLength: Int64?, contentType: String?, pathExtension: String? = nil) {
    locked {
      var entry = index[key] ?? Entry()
      if let totalLength, totalLength > 0 { entry.totalLength = totalLength }
      if let contentType { entry.contentType = contentType }
      // The file's name holds its extension: fixed once bytes are written.
      if let pathExtension, !pathExtension.isEmpty, entry.ranges.isEmpty { entry.pathExtension = pathExtension }
      entry.lastUsed = now()
      index[key] = entry
    }
    save()
  }

  /// Writes bytes at `offset`.
  func write(_ key: String, offset: Int64, data: Data) {
    guard !data.isEmpty else { return }
    let url = fileURL(key)
    locked {
      if !FileManager.default.fileExists(atPath: url.path) {
        FileManager.default.createFile(atPath: url.path, contents: nil)
      }
      guard let handle = try? FileHandle(forWritingTo: url) else { return }
      defer { try? handle.close() }
      do {
        try handle.seek(toOffset: UInt64(offset))
        try handle.write(contentsOf: data)
      } catch {
        return
      }
      var entry = index[key] ?? Entry()
      var set = Self.ranges(entry)
      set.insert(offset..<(offset + Int64(data.count)))
      entry.ranges = set.ranges.map { ClosedRangeCodable(start: $0.lowerBound, end: $0.upperBound) }
      entry.lastUsed = now()
      index[key] = entry
    }
    evict(keeping: key)
    saveSoon()
  }

  /// Whether `range` is held.
  func contains(_ key: String, _ range: Range<Int64>) -> Bool {
    locked { index[key].map { Self.ranges($0).contains(range) } ?? false }
  }

  /// How many bytes from `offset` are held without a gap.
  func run(_ key: String, from offset: Int64) -> Int64 {
    locked { index[key].map { Self.ranges($0).run(from: offset) } ?? 0 }
  }

  /// Every byte of a known length is held.
  func isComplete(_ key: String) -> Bool {
    locked {
      guard let entry = index[key], let total = entry.totalLength else { return false }
      return Self.ranges(entry).contains(0..<total)
    }
  }

  func heldBytes(_ key: String) -> Int64 { locked { index[key].map { Self.ranges($0).count } ?? 0 } }

  /// Reads held bytes (`nil` when any of them is not held).
  func read(_ key: String, offset: Int64, length: Int) -> Data? {
    guard contains(key, offset..<(offset + Int64(length))) else { return nil }
    guard let handle = try? FileHandle(forReadingFrom: fileURL(key)) else { return nil }
    defer { try? handle.close() }
    do {
      try handle.seek(toOffset: UInt64(offset))
      return try handle.read(upToCount: length)
    } catch {
      return nil
    }
  }

  /// Marks a key used now (it plays): the last to be evicted.
  func touch(_ key: String) {
    locked { index[key]?.lastUsed = now() }
    saveSoon()
  }

  /// The key's bytes as a file (a complete download played directly): a
  /// 128-bit hash of the key, so two long keys never share a file.
  func fileURL(_ key: String) -> URL {
    let ext = locked { index[key]?.pathExtension } ?? "bin"
    return directory.appendingPathComponent(Self.fileName(key)).appendingPathExtension(ext)
  }

  /// Two 64-bit FNV-1a hashes (different offset bases) of the key, in hex.
  static func fileName(_ key: String) -> String {
    func fnv(_ basis: UInt64) -> UInt64 {
      var hash = basis
      for byte in key.utf8 {
        hash ^= UInt64(byte)
        hash = hash &* 0x0000_0100_0000_01B3
      }
      return hash
    }
    let a = fnv(0xCBF2_9CE4_8422_2325)
    let b = fnv(0x84222325_CBF29CE4)
    return String(format: "%016llx%016llx", a, b)
  }

  /// The file is there (an index can outlive it: storage cleared by the system).
  func fileExists(_ key: String) -> Bool {
    FileManager.default.fileExists(atPath: fileURL(key).path)
  }

  /// Kept from eviction: the files players opened last (one may be playing).
  func protect(_ key: String) {
    locked {
      protected.removeAll { $0 == key }
      protected.append(key)
      if protected.count > 3 { protected.removeFirst() }
    }
  }

  func remove(_ key: String) {
    let url = fileURL(key)
    locked { _ = index.removeValue(forKey: key) }
    try? FileManager.default.removeItem(at: url)
    save()
  }

  func clear() {
    for key in keys { remove(key) }
  }

  /// Moves a finished file in whole (a download made by URLSession).
  func adopt(_ key: String, file: URL, contentType: String?, pathExtension: String?) throws {
    describe(key, totalLength: nil, contentType: contentType, pathExtension: pathExtension)
    let target = fileURL(key)
    try? FileManager.default.removeItem(at: target)
    try FileManager.default.moveItem(at: file, to: target)
    let size = (try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.int64Value ?? 0
    locked {
      var entry = index[key] ?? Entry()
      entry.totalLength = size
      entry.ranges = size > 0 ? [ClosedRangeCodable(start: 0, end: size)] : []
      entry.lastUsed = now()
      index[key] = entry
    }
    save()
  }

  // MARK: - Internals

  private var indexURL: URL { directory.appendingPathComponent("index.json") }
  private var savePending = false
  private var protected: [String] = []

  private func locked<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }

  private static func ranges(_ entry: Entry) -> RangeSet {
    var set = RangeSet()
    for r in entry.ranges { set.insert(r.start..<r.end) }
    return set
  }

  /// The least recently used keys go until the store fits (never `keeping`).
  private func evict(keeping: String?) {
    let victims: [String] = locked {
      guard let max = maxBytesValue else { return [] }
      var total = index.values.reduce(0) { $0 + Self.ranges($1).count }
      var out: [String] = []
      for (key, entry) in index.sorted(by: { $0.value.lastUsed < $1.value.lastUsed }) where total > max {
        if key == keeping || protected.contains(key) { continue }
        total -= Self.ranges(entry).count
        out.append(key)
      }
      return out
    }
    victims.forEach(remove)
  }

  private func saveSoon() {
    let schedule: Bool = locked {
      if savePending { return false }
      savePending = true
      return true
    }
    guard schedule else { return }
    DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.5) { [weak self] in
      self?.save()
    }
  }

  /// Writes the index now (also after every structural change).
  func save() {
    let data: Data? = locked {
      savePending = false
      return try? JSONEncoder().encode(index)
    }
    if let data { try? data.write(to: indexURL, options: .atomic) }
  }
}

/// How the stream proxy answers a request from a store: the bytes to send
/// and the response head, or `nil` (not all held: the request goes upstream).
struct StoredResponse: Equatable {
  let status: Int
  let offset: Int64
  let length: Int64
  let headers: [String: String]
}

extension MediaStore {
  /// A request for `range` (its `Range` header, `nil`: the whole file), when
  /// the store holds every byte it asks for and knows the file's length.
  func plan(_ key: String, range: String?) -> StoredResponse? {
    guard let entry = entry(key), let total = entry.totalLength, total > 0 else { return nil }
    var start: Int64 = 0
    var end: Int64 = total - 1
    if let range {
      guard let parsed = Self.parseRange(range, total: total) else { return nil }
      (start, end) = parsed
    }
    guard start <= end, contains(key, start..<(end + 1)) else { return nil }
    var headers = [
      "content-length": "\(end - start + 1)",
      "accept-ranges": "bytes",
      "content-type": entry.contentType ?? "application/octet-stream",
    ]
    if range != nil { headers["content-range"] = "bytes \(start)-\(end)/\(total)" }
    return StoredResponse(status: range == nil ? 200 : 206, offset: start, length: end - start + 1, headers: headers)
  }

  /// `bytes=a-b`, `bytes=a-` and `bytes=-n` (one range; several are not served from the store).
  static func parseRange(_ header: String, total: Int64) -> (Int64, Int64)? {
    let value = header.trimmingCharacters(in: .whitespaces).lowercased()
    guard value.hasPrefix("bytes="), !value.contains(",") else { return nil }
    let parts = value.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
    guard parts.count == 2 else { return nil }
    let first = Int64(parts[0].trimmingCharacters(in: .whitespaces))
    let second = Int64(parts[1].trimmingCharacters(in: .whitespaces))
    switch (first, second) {
    case let (a?, b?): return a <= b ? (a, min(b, total - 1)) : nil
    case let (a?, nil): return a < total ? (a, total - 1) : nil
    case let (nil, n?): return n > 0 ? (max(0, total - n), total - 1) : nil
    default: return nil
    }
  }
}
