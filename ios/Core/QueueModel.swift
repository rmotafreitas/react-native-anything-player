import Foundation

// A player's queue: which item is current, what comes next and before, in
// list or shuffled order, and how edits move the current item. Pure state:
// the engine loads what it decides. Twins: `src/web/engine/QueueModel.ts`,
// `android/.../core/QueueModel.kt`; held to `conformance/queue`.

enum RepeatMode: String, Equatable {
  case off, one, all
}

/// What the model needs to know of an item.
protocol QueueEntry {
  var id: String { get }
  /// A live stream: never ends on its own, `previous` never restarts it.
  var live: Bool { get }
}

/// What `previous` does.
enum PreviousAction: Equatable {
  case restart
  case item(String)
  case none
}

/// `previous` more than this far into a finite item restarts it, seconds.
let restartThresholdSeconds = 3.0

/// xorshift32: the shuffle's generator, the same in every twin.
struct QueueRandom {
  private var state: UInt32

  init(seed: UInt64) {
    let s = UInt32(truncatingIfNeeded: seed)
    state = s == 0 ? 0x9E37_79B9 : s
  }

  /// The next value, 0 ≤ n < 2³².
  mutating func next() -> UInt32 {
    var x = state
    x ^= x << 13
    x ^= x >> 17
    x ^= x << 5
    state = x
    return x
  }

  /// 0 ≤ n < bound.
  mutating func below(_ bound: Int) -> Int {
    Int(next() % UInt32(bound))
  }
}

final class QueueModel<T: QueueEntry> {
  private var list: [T] = []
  private var playOrder: [String] = []
  private var currentId: String?
  private var random: QueueRandom
  private(set) var repeatMode: RepeatMode = .off
  private(set) var shuffle = false

  init(seed: UInt64 = UInt64(Date().timeIntervalSince1970 * 1000)) {
    random = QueueRandom(seed: seed)
  }

  var items: [T] { list }
  var order: [String] { playOrder }
  var current: T? { currentId.flatMap { find($0) } }
  var index: Int? {
    guard let id = currentId else { return nil }
    let i = indexOf(id)
    return i >= 0 ? i : nil
  }
  var count: Int { list.count }

  func find(_ id: String) -> T? { list.first { $0.id == id } }

  func indexOf(_ id: String) -> Int { list.firstIndex { $0.id == id } ?? -1 }

  // MARK: - Edits

  func set(_ items: [T], startIndex: Int = 0) {
    list = items
    currentId = items.isEmpty ? nil : items[min(max(0, startIndex), items.count - 1)].id
    reorder()
  }

  func add(_ items: [T], at index: Int? = nil) {
    guard !items.isEmpty else { return }
    let at = min(max(0, index ?? list.count), list.count)
    list.insert(contentsOf: items, at: at)
    if !shuffle {
      playOrder = list.map(\.id)
    } else {
      for item in items {
        let pos = currentId.flatMap { playOrder.firstIndex(of: $0) } ?? -1
        let slots = playOrder.count - pos
        playOrder.insert(item.id, at: pos + 1 + random.below(slots))
      }
    }
    if currentId == nil { currentId = playOrder.first }
  }

  /// Returns whether the current item changed.
  @discardableResult
  func remove(_ ids: [String]) -> Bool {
    let gone = Set(ids)
    let before = currentId
    var replacement = before
    if let before, gone.contains(before), let pos = playOrder.firstIndex(of: before) {
      let after = playOrder[(pos + 1)...].first { !gone.contains($0) }
      let earlier = playOrder[..<pos].reversed().first { !gone.contains($0) }
      replacement = after ?? earlier
    }
    list.removeAll { gone.contains($0.id) }
    playOrder.removeAll { gone.contains($0) }
    currentId = replacement
    return currentId != before
  }

  func move(from: Int, to: Int) {
    guard from >= 0, from < list.count else { return }
    let target = min(max(0, to), list.count - 1)
    let item = list.remove(at: from)
    list.insert(item, at: target)
    if !shuffle { playOrder = list.map(\.id) }
  }

  func clear() {
    if let current {
      list = [current]
      playOrder = [current.id]
    } else {
      list = []
      playOrder = []
    }
  }

  @discardableResult
  func skipTo(_ id: String) -> Bool {
    guard find(id) != nil else { return false }
    currentId = id
    return true
  }

  func setRepeat(_ mode: RepeatMode) {
    repeatMode = mode
  }

  func setShuffle(_ on: Bool, seed: UInt64? = nil) {
    if let seed { random = QueueRandom(seed: seed) }
    shuffle = on
    reorder()
  }

  // MARK: - Navigation

  func peekNext(auto: Bool) -> T? {
    guard let currentId else { return nil }
    if auto && repeatMode == .one { return current }
    guard let pos = playOrder.firstIndex(of: currentId) else { return nil }
    let id: String?
    if pos + 1 < playOrder.count {
      id = playOrder[pos + 1]
    } else if repeatMode != .off {
      id = playOrder.first
    } else {
      id = nil
    }
    return id.flatMap { find($0) }
  }

  func peekPrevious() -> T? {
    guard let currentId, let pos = playOrder.firstIndex(of: currentId) else { return nil }
    let id: String?
    if pos > 0 {
      id = playOrder[pos - 1]
    } else if repeatMode != .off {
      id = playOrder.last
    } else {
      id = nil
    }
    return id.flatMap { find($0) }
  }

  @discardableResult
  func next(auto: Bool) -> T? {
    guard let item = peekNext(auto: auto) else { return nil }
    currentId = item.id
    return item
  }

  func previous(position: Double) -> PreviousAction {
    guard let current else { return .none }
    if !current.live && position > restartThresholdSeconds { return .restart }
    guard let before = peekPrevious(), before.id != current.id else {
      return current.live ? .none : .restart
    }
    currentId = before.id
    return .item(before.id)
  }

  private func reorder() {
    let ids = list.map(\.id)
    guard shuffle else {
      playOrder = ids
      return
    }
    var rest = ids.filter { $0 != currentId }
    var i = rest.count - 1
    while i > 0 {
      let j = random.below(i + 1)
      rest.swapAt(i, j)
      i -= 1
    }
    playOrder = currentId.map { [$0] + rest } ?? rest
  }
}
