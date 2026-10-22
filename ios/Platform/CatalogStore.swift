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
  /// What `setCatalog`'s `browse` option said (`recent` count, `favorites`, `rootOrder`, `titles`).
  private var browse: [String: Any] = [:]
  /// The last items played, newest first (kept while `browse.recent` > 0).
  private(set) var recentIds: [String] = []
  /// Changes with everything the browse tree is built from.
  private(set) var revision = 0
  private var loaded = false
  private let writes = DispatchQueue(label: "anythingplayer.catalog", qos: .utility)

  private static var fileURL: URL? {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
      .appendingPathComponent("rnap", isDirectory: true)
      .appendingPathComponent("catalog.json", isDirectory: false)
  }

  func set(items: [[String: Any]], playerId: String, playerOptions: [String: Any], browse: [String: Any] = [:]) {
    loadIfNeeded()
    self.items = items
    self.playerId = playerId
    self.playerOptions = playerOptions
    self.browse = browse
    let limit = browseOptions().recentLimit
    let ids = Set(items.compactMap { $0["id"] as? String })
    recentIds = Array(recentIds.filter { ids.contains($0) }.prefix(limit))
    if let last = lastPlayedId, !ids.contains(last) { lastPlayedId = nil }
    revision += 1
    save()
  }

  /// Replaces the Favorites folder's ids and keeps the rest (`setFavorites`).
  func setFavorites(_ ids: [String]) {
    loadIfNeeded()
    let known = Set(items.compactMap { $0["id"] as? String })
    var seen = Set<String>()
    browse["favorites"] = ids.filter { known.contains($0) && seen.insert($0).inserted }
    revision += 1
    save()
  }

  /// The browse tree's options as the tree reads them (`foldersOnly` and `rootLimit` are the browser's to set).
  func browseOptions() -> BrowseOptions {
    loadIfNeeded()
    var options = BrowseOptions()
    options.recentLimit = min(max(browse["recent"] as? Int ?? 0, 0), 50)
    options.favorites = browse["favorites"] as? [String] ?? []
    options.rootOrder = browse["rootOrder"] as? [String] ?? []
    let titles = browse["titles"] as? [String: String] ?? [:]
    let defaults = BrowseTitles()
    options.titles = BrowseTitles(
      recent: titles["recent"].flatMap { $0.isEmpty ? nil : $0 } ?? defaults.recent,
      favorites: titles["favorites"].flatMap { $0.isEmpty ? nil : $0 } ?? defaults.favorites,
      more: titles["more"].flatMap { $0.isEmpty ? nil : $0 } ?? defaults.more)
    return options
  }

  /// The tree cars and watches browse, derived from the catalog.
  func browseTree(rootLimit: Int = BrowseTree.defaultRootLimit, foldersOnly: Bool = true) -> BrowseTree {
    loadIfNeeded()
    var options = browseOptions()
    options.rootLimit = rootLimit
    options.foldersOnly = foldersOnly
    let browseItems = items.map { item in
      BrowseItem(
        id: item["id"] as? String ?? "", title: item["title"] as? String ?? "",
        kind: item["kind"] as? String ?? "station", group: item["group"] as? String,
        artwork: item["artwork"] as? String, subtitle: item["artist"] as? String)
    }
    return BrowseTree(browseItems, options: options, recentIds: recentIds)
  }

  /// Every item, in the order the app gave them.
  func all() -> [[String: Any]] {
    loadIfNeeded()
    return items
  }

  func item(id: String) -> [String: Any]? {
    loadIfNeeded()
    return items.first { $0["id"] as? String == id }
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
    let limit = browseOptions().recentLimit
    if limit > 0, let id = lastPlayedId {
      recentIds = Array(([id] + recentIds.filter { $0 != id }).prefix(limit))
    }
    revision += 1
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
        keywords: item["keywords"] as? [String], kind: item["kind"] as? String,
        group: item["group"] as? String)
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
    browse = root["browse"] as? [String: Any] ?? [:]
    recentIds = root["recentIds"] as? [String] ?? []
  }

  private func save() {
    let root: [String: Any] = [
      "version": Self.schemaVersion, "playerId": playerId, "playerOptions": playerOptions,
      "items": items, "lastPlayedId": lastPlayedId ?? NSNull(), "browse": browse,
      "recentIds": recentIds,
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
