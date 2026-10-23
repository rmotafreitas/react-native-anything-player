/// The voices of one sound: a fixed number of slots (one audio player node
/// each), and which voice id plays in which. When every slot is busy a new
/// voice takes the slot of the one that started first. Pure bookkeeping, so it
/// is unit-tested on macOS (`swift test`); the Sound API's engine
/// (`Sound/SoundEngine.swift`) owns the nodes.
struct VoiceSlots {
  private var owners: [Int?]
  private var order: [Int]
  private var counter = 0

  init(capacity: Int) {
    owners = Array(repeating: nil, count: max(1, capacity))
    order = Array(repeating: 0, count: max(1, capacity))
  }

  var capacity: Int { owners.count }

  /// The slot for a new voice and, when none was free, the voice that lost it.
  mutating func acquire(voiceId: Int) -> (slot: Int, stolen: Int?) {
    counter += 1
    if let free = owners.firstIndex(where: { $0 == nil }) {
      owners[free] = voiceId
      order[free] = counter
      return (free, nil)
    }
    var oldest = 0
    for index in owners.indices where order[index] < order[oldest] { oldest = index }
    let stolen = owners[oldest]
    owners[oldest] = voiceId
    order[oldest] = counter
    return (oldest, stolen)
  }

  /// The slot a voice plays in, `nil` once it ended or lost it.
  func slot(of voiceId: Int) -> Int? {
    owners.firstIndex(where: { $0 == voiceId })
  }

  /// Frees `slot` if `voiceId` still owns it (a voice that was stolen does not free the new owner's slot).
  mutating func release(slot: Int, ownedBy voiceId: Int) {
    guard owners.indices.contains(slot), owners[slot] == voiceId else { return }
    owners[slot] = nil
  }

  /// Frees every slot; returns the voices that were playing.
  mutating func releaseAll() -> [Int] {
    let playing = owners.compactMap { $0 }
    owners = Array(repeating: nil, count: owners.count)
    return playing
  }

  var busy: Int { owners.filter { $0 != nil }.count }
}
