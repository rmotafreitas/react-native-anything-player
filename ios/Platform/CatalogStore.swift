import Foundation

/// The catalog voice requests search, persisted in Application Support
/// (`rnap/catalog.json`) so that Siri finds it when JavaScript is not running;
/// until the app sets one, the catalog it bundles (`rnap-catalog-seed.json`).
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
  /// The bundled catalog's id (`seed`) while the catalog in use is the
  /// bundled one, saved with it: an app update that bundles another one
  /// replaces it, until the app calls `set`.
  private var seedId: String?
  /// `setFavorites` ran since the last `set`: an updated bundled catalog keeps them.
  private var favoritesSet = false
  /// The stored file exists but cannot be read now (before the first unlock:
  /// the next access reads it again) or is a newer library's (left alone until
  /// `set`): nothing falls back to the bundled catalog or overwrites it.
  private var unreadable = false
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
    seedId = nil
    favoritesSet = false
    // The app's catalog from now on, whatever the file held.
    unreadable = false
    loaded = true
    revision += 1
    save()
  }

  /// Replaces the Favorites folder's ids and keeps the rest (`setFavorites`).
  func setFavorites(_ ids: [String]) {
    loadIfNeeded()
    let known = Set(items.compactMap { $0["id"] as? String })
    var seen = Set<String>()
    browse["favorites"] = ids.filter { known.contains($0) && seen.insert($0).inserted }
    favoritesSet = true
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
    var stored: [String: Any]?
    if let url = Self.fileURL, FileManager.default.fileExists(atPath: url.path) {
      guard let data = try? Data(contentsOf: url) else {
        unreadable = true
        loaded = false
        return
      }
      unreadable = false
      // A newer library's file: read as empty and left alone until the app sets a catalog.
      if let version = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["version"] as? Int,
        version > Self.schemaVersion
      {
        unreadable = true
        return
      }
      // A damaged one is nothing to keep: as if there were none.
      stored = Self.parse(data)
    }
    if let stored, (stored["seed"] as? String).map({ $0.isEmpty }) ?? true { return apply(stored) }
    // Nothing the app set: the bundled catalog, the newest one if an update brought another.
    guard let bundled = Self.seed().flatMap(Self.parse),
      stored == nil || (bundled["seed"] as? String ?? "bundled") != (stored?["seed"] as? String)
    else {
      if let stored { apply(stored) }
      return
    }
    apply(bundled)
    seedId = bundled["seed"] as? String ?? "bundled"
    guard let stored else { return }
    // What played, and the favorites the user set, stay for the items still there.
    let ids = Set(items.compactMap { $0["id"] as? String })
    lastPlayedId = (stored["lastPlayedId"] as? String).flatMap { ids.contains($0) ? $0 : nil }
    recentIds = (stored["recentIds"] as? [String] ?? []).filter { ids.contains($0) }
    if stored["favoritesSet"] as? Bool == true {
      favoritesSet = true
      let favorites = (stored["browse"] as? [String: Any])?["favorites"] as? [String] ?? []
      browse["favorites"] = favorites.filter { ids.contains($0) }
    }
  }

  /// A catalog file's root, or nil when it is damaged or from another format version.
  private static func parse(_ data: Data) -> [String: Any]? {
    guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
      root["version"] as? Int == schemaVersion
    else { return nil }
    return root
  }

  private func apply(_ root: [String: Any]) {
    items = root["items"] as? [[String: Any]] ?? []
    playerId = root["playerId"] as? String ?? "default"
    playerOptions = root["playerOptions"] as? [String: Any] ?? [:]
    lastPlayedId = root["lastPlayedId"] as? String
    browse = root["browse"] as? [String: Any] ?? [:]
    recentIds = root["recentIds"] as? [String] ?? []
    seedId = root["seed"] as? String
    favoritesSet = root["favoritesSet"] as? Bool ?? false
  }

  /// The catalog the app bundles (the Expo plugin's `catalog` option), used
  /// until the app stores its own: on a fresh install, CarPlay (and Siri where
  /// it matches without the app's vocabulary) before the app was ever opened.
  private static func seed() -> Data? {
    Bundle.main.url(forResource: "rnap-catalog-seed", withExtension: "json").flatMap { try? Data(contentsOf: $0) }
  }

  private func save() {
    let root: [String: Any] = [
      "version": Self.schemaVersion, "playerId": playerId, "playerOptions": playerOptions,
      "items": items, "lastPlayedId": lastPlayedId ?? NSNull(), "browse": browse,
      "recentIds": recentIds, "seed": seedId ?? NSNull(), "favoritesSet": favoritesSet,
    ]
    guard !unreadable else { return }
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
