import Foundation

/// The catalog voice requests search, persisted in Application Support
/// (`rnap/catalog.json`) so that Siri finds it when JavaScript is not running.
/// Items are kept as JS serialized them (src/core/system.ts) and searched with
/// the shared matcher (`CatalogSearch`). Twins: `src/web/platform/WebCatalog.ts`,
/// `android/.../CatalogStore.kt`. Main thread only; writes are atomic and off
/// the main thread.
final class CatalogStore {
  private static let schemaVersion = 1

  private(set) var items: [[String: Any]] = []
  /// The player voice requests use when the app has none.
  private(set) var playerId = "default"
  private(set) var playerOptions: [String: Any] = [:]
  private var lastPlayedId: String?
  private var loaded = false
  private let writes = DispatchQueue(label: "anythingplayer.catalog", qos: .utility)

  private static var fileURL: URL? {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("rnap", isDirectory: true)
      .appendingPathComponent("catalog.json", isDirectory: false)
  }

  func set(items: [[String: Any]], playerId: String, playerOptions: [String: Any]) {
    loadIfNeeded()
    self.items = items
    self.playerId = playerId
    self.playerOptions = playerOptions
    save()
  }

  /// Ranked matches, best first.
  func search(_ query: CatalogQuery) -> [[String: Any]] {
    loadIfNeeded()
    return CatalogSearch.search(searchable, query).matches.map { items[$0] }
  }

  /// The best match; for a request with nothing in it, the last item played
  /// (else the first).
  func resolve(_ query: CatalogQuery) -> [String: Any]? {
    loadIfNeeded()
    let outcome = CatalogSearch.search(searchable, query)
    if let best = outcome.matches.first { return items[best] }
    guard outcome.emptyQuery else { return nil }
    return items.first { $0["id"] as? String == lastPlayedId } ?? items.first
  }

  func played(_ item: [String: Any]) {
    loadIfNeeded()
    lastPlayedId = item["id"] as? String
    save()
  }

  /// Titles and keywords: what Siri should learn to recognize.
  var vocabulary: [String] {
    loadIfNeeded()
    var seen = Set<String>()
    var out: [String] = []
    for item in items {
      let texts = [item["title"] as? String].compactMap { $0 } + (item["keywords"] as? [String] ?? [])
      for text in texts where !text.isEmpty && seen.insert(text).inserted {
        out.append(text)
      }
    }
    return out
  }

  private var searchable: [SearchableItem] {
    items.map { item in
      SearchableItem(
        title: item["title"] as? String ?? "", artist: item["artist"] as? String,
        album: item["album"] as? String, genre: item["genre"] as? String,
        keywords: item["keywords"] as? [String], kind: item["kind"] as? String)
    }
  }

  // MARK: - Persistence

  private func loadIfNeeded() {
    guard !loaded else { return }
    loaded = true
    guard let url = Self.fileURL, let data = try? Data(contentsOf: url),
      let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      root["version"] as? Int == Self.schemaVersion
    else { return }
    items = root["items"] as? [[String: Any]] ?? []
    playerId = root["playerId"] as? String ?? "default"
    playerOptions = root["playerOptions"] as? [String: Any] ?? [:]
    lastPlayedId = root["lastPlayedId"] as? String
  }

  private func save() {
    let root: [String: Any] = [
      "version": Self.schemaVersion, "playerId": playerId, "playerOptions": playerOptions,
      "items": items, "lastPlayedId": lastPlayedId ?? NSNull(),
    ]
    guard let url = Self.fileURL, JSONSerialization.isValidJSONObject(root),
      let data = try? JSONSerialization.data(withJSONObject: root)
    else { return }
    writes.async {
      do {
        try FileManager.default.createDirectory(
          at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Readable after the first unlock: Siri may start the app while the device is locked.
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      } catch {
        // Best effort: the in-memory catalog still serves this run.
      }
    }
  }
}
