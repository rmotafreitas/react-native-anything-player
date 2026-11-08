import Foundation

/// A player's queue commands (`queueCommand`), and what the host keeps for
/// each queue item besides its source: its lock-screen fields and video
/// parts. The queue itself is the engine's. Twin of Android's `QueueHost.kt`
/// and the web's `WebQueue.ts`. Main thread, except `snapshot`.
final class QueueHost {
  struct Parts {
    let fields: NowPlayingFields
    let video: VideoLoadParts
  }

  private let engine: PlaybackEngine
  private var parts: [String: Parts] = [:]
  private let lock = NSLock()
  private var snapshotState = QueueState.empty

  init(engine: PlaybackEngine) {
    self.engine = engine
  }

  /// The engine's snapshot, readable from any thread (`getQueue`).
  var snapshot: QueueState { lock.sync { snapshotState } }

  subscript(id: String) -> Parts? { parts[id] }

  func command(_ command: NSDictionary) throws {
    defer { changed() }
    let op = command["op"] as? String ?? ""
    switch op {
    case "set":
      let (items, added) = try Self.items(command["items"])
      // Before the engine loads the first item: it asks for its parts.
      let previous = parts
      parts.merge(added) { $1 }
      do {
        try engine.queueSet(
          items, startIndex: (command["startIndex"] as? NSNumber)?.intValue ?? 0,
          startPosition: (command["startPosition"] as? NSNumber)?.doubleValue, autoplay: command["autoplay"] as? Bool)
      } catch {
        parts = previous
        throw error
      }
    case "add":
      let (items, added) = try Self.items(command["items"])
      if let clash = added.keys.first(where: { snapshot.ids.contains($0) }) {
        throw Self.invalid("Two queue items have the id \"\(clash)\".")
      }
      parts.merge(added) { $1 }
      try engine.queueAdd(items, at: (command["index"] as? NSNumber)?.intValue)
    case "remove":
      guard let ids = command["ids"] as? [String] else { throw Self.invalid("`ids` must be an array.") }
      try engine.queueRemove(ids)
    case "move":
      try engine.queueMove(
        from: (command["from"] as? NSNumber)?.intValue ?? -1, to: (command["to"] as? NSNumber)?.intValue ?? -1)
    case "clear": try engine.queueClear()
    case "skipTo":
      try engine.queueSkipTo(command["id"] as? String ?? "", position: (command["position"] as? NSNumber)?.doubleValue)
    case "next": try engine.queueNext()
    case "previous": try engine.queuePrevious()
    case "repeat":
      let mode = command["mode"] as? String ?? ""
      guard let repeatMode = RepeatMode(rawValue: mode) else { throw Self.invalid("Unknown repeat mode \"\(mode)\".") }
      try engine.setRepeat(repeatMode)
    case "shuffle": try engine.setShuffle(command["enabled"] as? Bool ?? false)
    default: throw Self.invalid("Unknown queue command \"\(op)\".")
    }
  }

  /// The engine made a loaded source the queue's first item (`loaded-…`): it keeps the fields it had.
  func adoptLoaded(_ fields: NowPlayingFields) {
    guard let id = engine.queueState.ids.first(where: { $0.hasPrefix("loaded-") && parts[$0] == nil }) else { return }
    parts[id] = Parts(fields: fields, video: VideoLoadParts())
  }

  /// The engine's queue changed: the snapshot follows, and items that left let go of their parts.
  func changed() {
    let state = engine.queueState
    lock.sync { snapshotState = state }
    let kept = Set(state.ids)
    parts = parts.filter { kept.contains($0.key) }
  }

  func dictionary() -> [String: Any] { Self.dictionary(snapshot) }

  /// `{ ids, order, index, currentId, repeat, shuffle }`.
  static func dictionary(_ q: QueueState) -> [String: Any] {
    [
      "ids": q.ids, "order": q.order, "index": q.index.map { $0 as Any } ?? NSNull(),
      "currentId": q.currentId.map { $0 as Any } ?? NSNull(), "repeat": q.repeatMode.rawValue, "shuffle": q.shuffle,
    ]
  }

  private static func items(_ value: Any?) throws -> ([EngineQueueItem], [String: Parts]) {
    guard let list = value as? [NSDictionary] else { throw invalid("Queue items must be an array.") }
    var added: [String: Parts] = [:]
    let items = try list.map { map -> EngineQueueItem in
      guard let id = map["id"] as? String, !id.isEmpty else { throw invalid("Every queue item needs an id.") }
      let (source, fields) = SourceDescriptor.parse(map)
      added[id] = Parts(fields: fields, video: VideoLoadParts(map))
      return EngineQueueItem(id: id, live: source.liveHint == true, source: source)
    }
    return (items, added)
  }

  private static func invalid(_ message: String) -> PlayerError {
    PlayerError.code(.invalidArgument, message, recoverable: false)
  }
}
