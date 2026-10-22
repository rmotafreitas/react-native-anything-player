import Foundation

// The browse tree cars and watches show (CarPlay, Android Auto, Android
// Automotive, Wear OS), derived from the catalog. Pure and deterministic.
// Twin: `android/.../core/BrowseTree.kt`; both run
// `conformance/catalog/browse.json` (the fixtures are the specification;
// `src/core/catalog.ts` holds the group helpers the web shares).
//
// Groups. `CatalogItem.group` is a path: "Jazz", "Podcasts/Daily". Segments
// are trimmed and empty ones dropped; they are compared exactly.
//
// The root. Its folders, in order: "Recently played" (when the app turned it
// on and something was played), "Favorites" (when the app named favorites in
// the catalog), then the top-level groups — the app's `rootOrder` first, the
// rest in the order the catalog first mentions them. A catalog with no
// groups, no recent and no favorites is flat: the root lists the items
// themselves. Otherwise ungrouped items go in a "More" folder. A car shows at
// most `rootLimit` tabs: when there would be more, the last tab is "More" and
// also holds the folders that did not fit (before the ungrouped items).
// `foldersOnly` (a browser that lists browsable children only) turns a flat
// root into a "More" folder.
//
// A group's folder lists its subfolders (first mention order), then its own
// items (catalog order). "Recently played" is newest first, "Favorites" in
// the app's order; both only hold items still in the catalog.
//
// Long folders. A browser that cannot page (Android Auto, Android Automotive)
// sets `folderLimit`: a folder with more children than that is split, in
// order, into subfolders titled by position ("1–100", "101–200"…), each
// holding at most `folderLimit` children; more than `folderLimit` of those
// are split again ("1–10000"…). 0 never splits. The root's tab bar is never
// split; a flat root (not `foldersOnly`) is. (CarPlay pages its lists itself.)
//
// Ids. Folders are `rnap:root`, `rnap:recent`, `rnap:favorites`, `rnap:more`,
// `rnap:group:<path>` and `rnap:part:<from>-<to>:<folder id>` (a slice of a
// long folder); an item's id is its catalog id. The prefix `rnap:` is
// reserved for folders: `setCatalog` rejects catalog ids that start with it,
// and the tree leaves out such an item (a catalog saved before that rule).
// So a media id is a folder or an item, never both.
//
// Style. A folder's items are shown as a grid when it directly holds items
// and all of them are stations or albums, else as a list.

/// What the tree reads of a catalog item.
struct BrowseItem: Equatable {
  let id: String
  let title: String
  var kind: String = "station"
  var group: String? = nil
  var artwork: String? = nil
  var subtitle: String? = nil
}

/// Names of the folders the tree adds.
struct BrowseTitles: Equatable {
  var recent = "Recently played"
  var favorites = "Favorites"
  var more = "More"
}

struct BrowseOptions: Equatable {
  /// How many recent items to show (0: no such folder).
  var recentLimit = 0
  /// Ids, in the app's order.
  var favorites: [String] = []
  /// Top-level group names, in the order the tabs should have.
  var rootOrder: [String] = []
  var titles = BrowseTitles()
  /// How many tabs the car shows (Android Auto and CarPlay audio: 4).
  var rootLimit = BrowseTree.defaultRootLimit
  /// The browser lists only folders in the root.
  var foldersOnly = false
  /// The most children a folder shows before it is split into slices (0: never; a browser that cannot page).
  var folderLimit = 0
}

/// A folder or an item in the tree. `itemId` is set for items.
struct BrowseNode: Equatable {
  let id: String
  let title: String
  let isFolder: Bool
  var kind: String? = nil
  var artwork: String? = nil
  var subtitle: String? = nil

  var itemId: String? { isFolder ? nil : id }
}

enum BrowseStyle: String {
  case list
  case grid
}

struct BrowseTree {
  static let rootId = "rnap:root"
  static let recentId = "rnap:recent"
  static let favoritesId = "rnap:favorites"
  static let moreId = "rnap:more"
  static let groupPrefix = "rnap:group:"
  static let partPrefix = "rnap:part:"
  /// Folder ids start with this; catalog ids must not.
  static let reservedPrefix = "rnap:"
  /// The most children RNAP shows in one folder of a browser that cannot page (Android Auto, Automotive).
  static let defaultFolderLimit = 100
  /// Android Auto's and CarPlay audio's tab limit.
  static let defaultRootLimit = 4
  private static let minRootLimit = 2
  private static let minFolderLimit = 2
  private static let maxDepth = 8

  private struct Entry {
    let item: BrowseItem
    let segments: [String]
  }

  private enum Child {
    case sub(String)
    case leaf(Entry)
  }

  private struct Folder {
    let id: String
    let title: String
    let children: [Child]
  }

  private let options: BrowseOptions
  private let folderLimit: Int
  private let entries: [Entry]
  private var byId: [String: Entry] = [:]
  private var folders: [String: Folder] = [:]
  private var rootChildren: [Child] = []

  init(_ items: [BrowseItem], options: BrowseOptions = BrowseOptions(), recentIds: [String] = []) {
    self.options = options
    folderLimit = options.folderLimit > 0 ? max(options.folderLimit, Self.minFolderLimit) : 0
    entries = items.filter { !$0.id.hasPrefix(Self.reservedPrefix) }
      .map { Entry(item: $0, segments: BrowseTree.groupSegments($0.group)) }
    for entry in entries where byId[entry.item.id] == nil { byId[entry.item.id] = entry }

    let limit = max(options.rootLimit, Self.minRootLimit)
    var recent: [Entry] = []
    if options.recentLimit > 0 {
      recent = Array(Self.unique(recentIds).compactMap { byId[$0] }.prefix(options.recentLimit))
    }
    let favorites = Self.unique(options.favorites).compactMap { byId[$0] }
    let ungrouped = entries.filter { $0.segments.isEmpty }

    var tabs: [Folder] = []
    if !recent.isEmpty {
      tabs.append(addFolder(Self.recentId, options.titles.recent, recent.map { Child.leaf($0) }))
    }
    if !favorites.isEmpty {
      tabs.append(addFolder(Self.favoritesId, options.titles.favorites, favorites.map { Child.leaf($0) }))
    }
    for name in orderedTopLevel() { tabs.append(addGroupFolder([name])) }

    if tabs.isEmpty && !options.foldersOnly {
      rootChildren = fit(Self.rootId, ungrouped.map { Child.leaf($0) }, offset: 0)
    } else {
      let fits = tabs.count + (ungrouped.isEmpty ? 0 : 1) <= limit
      let kept = fits ? tabs : Array(tabs.prefix(limit - 1))
      let overflow = fits ? [] : Array(tabs.dropFirst(limit - 1))
      var more: Folder?
      if !overflow.isEmpty || !ungrouped.isEmpty {
        let children: [Child] = overflow.map { Child.sub($0.id) } + ungrouped.map { Child.leaf($0) }
        more = addFolder(Self.moreId, options.titles.more, children)
      }
      var shown: [Child] = kept.map { Child.sub($0.id) }
      if let more { shown.append(Child.sub(more.id)) }
      rootChildren = shown
    }
  }

  /// `"Podcasts/Daily"` → `["Podcasts", "Daily"]`; blank segments are dropped.
  static func groupSegments(_ group: String?) -> [String] {
    guard let group else { return [] }
    return group.split(separator: "/", omittingEmptySubsequences: false)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }

  /// Whether an item filed under `itemGroup` is in `group` or one of its subgroups (no group: everything).
  static func isInGroup(_ itemGroup: String?, _ group: String?) -> Bool {
    let wanted = groupSegments(group)
    if wanted.isEmpty { return true }
    let own = groupSegments(itemGroup)
    return own.count >= wanted.count && Array(own.prefix(wanted.count)) == wanted
  }

  /// The children of a folder (`rnap:root` included); nil when there is no such folder.
  func children(_ id: String) -> [BrowseNode]? {
    let kids: [Child]?
    if id == Self.rootId { kids = rootChildren } else { kids = folders[id]?.children }
    return kids?.compactMap { childNode($0) }
  }

  /// A folder or an item by id; nil when there is none.
  func node(_ id: String) -> BrowseNode? {
    if id == Self.rootId { return BrowseNode(id: Self.rootId, title: options.titles.more, isFolder: true) }
    if let folder = folders[id] { return folderNode(folder) }
    return byId[id].map { leaf($0) }
  }

  /// How a folder's items should be laid out.
  func style(_ id: String) -> BrowseStyle {
    let kids: [Child]
    if id == Self.rootId {
      kids = rootChildren
    } else if let folder = folders[id] {
      kids = folder.children
    } else {
      return .list
    }
    var leaves: [Entry] = []
    for kid in kids { if case .leaf(let entry) = kid { leaves.append(entry) } }
    let grid = !leaves.isEmpty && leaves.allSatisfy { $0.item.kind == "station" || $0.item.kind == "album" }
    return grid ? .grid : .list
  }

  // MARK: - Building

  private static func unique(_ ids: [String]) -> [String] {
    var seen = Set<String>()
    return ids.filter { seen.insert($0).inserted }
  }

  private mutating func addFolder(_ id: String, _ title: String, _ children: [Child], offset: Int = 0) -> Folder {
    let folder = Folder(id: id, title: title, children: fit(id, children, offset: offset))
    folders[id] = folder
    return folder
  }

  /// `children` as they are shown in folder `parentId`: all of them, or slices of `folderLimit` (the first child is number `offset` + 1).
  private mutating func fit(_ parentId: String, _ children: [Child], offset: Int) -> [Child] {
    if folderLimit == 0 || children.count <= folderLimit { return children }
    var size = folderLimit
    while (children.count + size - 1) / size > folderLimit { size *= folderLimit }
    var slices: [Child] = []
    var index = 0
    while index < children.count {
      let part = Array(children[index..<min(index + size, children.count)])
      let from = offset + index + 1
      let to = from + part.count - 1
      slices.append(.sub(addFolder("\(Self.partPrefix)\(from)-\(to):\(parentId)", from == to ? "\(from)" : "\(from)–\(to)", part, offset: from - 1).id))
      index += size
    }
    return slices
  }

  private func orderedTopLevel() -> [String] {
    var present: [String] = []
    for entry in entries {
      if let first = entry.segments.first, !present.contains(first) { present.append(first) }
    }
    var ordered: [String] = []
    for name in options.rootOrder {
      if let first = Self.groupSegments(name).first, present.contains(first), !ordered.contains(first) {
        ordered.append(first)
      }
    }
    for name in present where !ordered.contains(name) { ordered.append(name) }
    return ordered
  }

  /// A group's folder and, recursively, its subgroups'.
  private mutating func addGroupFolder(_ path: [String]) -> Folder {
    var subs: [String] = []
    var own: [Entry] = []
    for entry in entries {
      if entry.segments.count < path.count || Array(entry.segments.prefix(path.count)) != path { continue }
      if entry.segments.count == path.count {
        own.append(entry)
      } else if !subs.contains(entry.segments[path.count]) {
        subs.append(entry.segments[path.count])
      }
    }
    var children: [Child] = []
    for sub in subs { children.append(.sub(addGroupFolder(path + [sub]).id)) }
    children.append(contentsOf: own.map { Child.leaf($0) })
    return addFolder(Self.groupPrefix + path.joined(separator: "/"), path[path.count - 1], children)
  }

  // MARK: - Nodes

  private func childNode(_ child: Child) -> BrowseNode? {
    switch child {
    case .sub(let id): return folders[id].map { folderNode($0) }
    case .leaf(let entry): return leaf(entry)
    }
  }

  private func leaf(_ entry: Entry) -> BrowseNode {
    BrowseNode(
      id: entry.item.id, title: entry.item.title, isFolder: false, kind: entry.item.kind,
      artwork: entry.item.artwork, subtitle: entry.item.subtitle)
  }

  private func folderNode(_ folder: Folder) -> BrowseNode {
    BrowseNode(id: folder.id, title: folder.title, isFolder: true, artwork: firstArtwork(folder, 0))
  }

  /// The artwork of the first item inside, as a tile for the folder.
  private func firstArtwork(_ folder: Folder, _ depth: Int) -> String? {
    if depth > Self.maxDepth { return nil }
    for child in folder.children {
      switch child {
      case .leaf(let entry):
        if let art = entry.item.artwork { return art }
      case .sub(let id):
        if let sub = folders[id], let art = firstArtwork(sub, depth + 1) { return art }
      }
    }
    return nil
  }
}
