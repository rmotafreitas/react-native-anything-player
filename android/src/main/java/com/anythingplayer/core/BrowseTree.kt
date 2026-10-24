package com.anythingplayer.core

// The browse tree cars and watches show (Android Auto, Android Automotive,
// Wear OS, CarPlay), derived from the catalog. Pure and deterministic. Twins:
// `ios/Core/BrowseTree.swift`; both run `conformance/catalog/browse.json`
// (the fixtures are the specification; `src/core/catalog.ts` holds the
// group helpers the web shares).
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
// `foldersOnly` (a browser that asked for browsable children only) turns a
// flat root into a "More" folder.
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
// split; a flat root (not `foldersOnly`) is.
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

/** What the tree reads of a catalog item. */
data class BrowseItem(
  val id: String,
  val title: String,
  val kind: String = "station",
  val group: String? = null,
  val artwork: String? = null,
  val subtitle: String? = null,
)

/** Names of the folders the tree adds. */
data class BrowseTitles(
  val recent: String = "Recently played",
  val favorites: String = "Favorites",
  val more: String = "More",
)

data class BrowseOptions(
  /** How many recent items to show (0: no such folder). */
  val recentLimit: Int = 0,
  /** Ids, in the app's order. */
  val favorites: List<String> = emptyList(),
  /** Top-level group names, in the order the tabs should have. */
  val rootOrder: List<String> = emptyList(),
  val titles: BrowseTitles = BrowseTitles(),
  /** How many tabs the car shows (Android Auto and CarPlay audio: 4). */
  val rootLimit: Int = BrowseTree.DEFAULT_ROOT_LIMIT,
  /** The browser lists only folders in the root. */
  val foldersOnly: Boolean = false,
  /** The most children a folder shows before it is split into slices (0: never; a browser that cannot page). */
  val folderLimit: Int = 0,
)

/** A folder or an item in the tree. [itemId] is set for items. */
data class BrowseNode(
  val id: String,
  val title: String,
  val isFolder: Boolean,
  val kind: String? = null,
  val artwork: String? = null,
  val subtitle: String? = null,
) {
  val itemId: String? get() = if (isFolder) null else id
}

enum class BrowseStyle { LIST, GRID }

class BrowseTree(items: List<BrowseItem>, private val options: BrowseOptions = BrowseOptions(), recentIds: List<String> = emptyList()) {
  private class Entry(val item: BrowseItem, val segments: List<String>)

  private class Folder(val id: String, val title: String, val children: List<Child>)

  private sealed class Child {
    class Sub(val folderId: String) : Child()
    class Leaf(val entry: Entry) : Child()
  }

  private val entries = items.filterNot { it.id.startsWith(RESERVED_PREFIX) }.map { Entry(it, groupSegments(it.group)) }
  private val byId = HashMap<String, Entry>().also { map -> entries.forEach { map.putIfAbsent(it.item.id, it) } }
  private val folders = LinkedHashMap<String, Folder>()
  private val rootChildren: List<Child>
  private val folderLimit = if (options.folderLimit > 0) options.folderLimit.coerceAtLeast(MIN_FOLDER_LIMIT) else 0

  init {
    val limit = options.rootLimit.coerceAtLeast(MIN_ROOT_LIMIT)
    val recent =
      if (options.recentLimit > 0) {
        recentIds.distinct().mapNotNull { byId[it] }.take(options.recentLimit)
      } else {
        emptyList()
      }
    val favorites = options.favorites.distinct().mapNotNull { byId[it] }
    val tops = orderedTopLevel()
    val ungrouped = entries.filter { it.segments.isEmpty() }
    val tabs = ArrayList<Folder>()
    if (recent.isNotEmpty()) tabs += folder(RECENT_ID, options.titles.recent, recent.map { Child.Leaf(it) })
    if (favorites.isNotEmpty()) tabs += folder(FAVORITES_ID, options.titles.favorites, favorites.map { Child.Leaf(it) })
    for (name in tops) tabs += groupFolder(listOf(name))
    rootChildren =
      if (tabs.isEmpty() && !options.foldersOnly) {
        fit(ROOT_ID, ungrouped.map { Child.Leaf(it) }, 0)
      } else {
        val fits = tabs.size + (if (ungrouped.isEmpty()) 0 else 1) <= limit
        val kept = if (fits) tabs else tabs.take(limit - 1)
        val overflow = if (fits) emptyList() else tabs.drop(limit - 1)
        val more =
          if (overflow.isEmpty() && ungrouped.isEmpty()) {
            null
          } else {
            folder(MORE_ID, options.titles.more, overflow.map { Child.Sub(it.id) } + ungrouped.map { Child.Leaf(it) })
          }
        kept.map { Child.Sub(it.id) } + listOfNotNull(more?.let { Child.Sub(it.id) })
      }
  }

  private fun folder(id: String, title: String, children: List<Child>, offset: Int = 0): Folder =
    Folder(id, title, fit(id, children, offset)).also { folders[id] = it }

  /** [children] as they are shown in folder [parentId]: all of them, or slices of [folderLimit] (the first child is number [offset] + 1). */
  private fun fit(parentId: String, children: List<Child>, offset: Int): List<Child> {
    if (folderLimit == 0 || children.size <= folderLimit) return children
    var size = folderLimit.toLong()
    while ((children.size + size - 1) / size > folderLimit) size *= folderLimit
    return children.chunked(size.toInt()).mapIndexed { index, part ->
      val from = offset + index * size.toInt() + 1
      val to = from + part.size - 1
      Child.Sub(folder("$PART_PREFIX$from-$to:$parentId", if (from == to) "$from" else "$from–$to", part, from - 1).id)
    }
  }

  private fun orderedTopLevel(): List<String> {
    val present = LinkedHashSet<String>()
    entries.forEach { e -> e.segments.firstOrNull()?.let { present += it } }
    val ordered = LinkedHashSet<String>()
    options.rootOrder.mapNotNull { groupSegments(it).firstOrNull() }.filter { it in present }.forEach { ordered += it }
    ordered += present
    return ordered.toList()
  }

  /** A group's folder and, recursively, its subgroups'. */
  private fun groupFolder(path: List<String>): Folder {
    val subs = LinkedHashSet<String>()
    val own = ArrayList<Entry>()
    for (e in entries) {
      if (e.segments.size < path.size || e.segments.subList(0, path.size) != path) continue
      if (e.segments.size == path.size) own += e else subs += e.segments[path.size]
    }
    val children = subs.map { Child.Sub(groupFolder(path + it).id) } + own.map { Child.Leaf(it) }
    return folder(GROUP_PREFIX + path.joinToString("/"), path.last(), children)
  }

  /** The children of a folder (`rnap:root` included); null when there is no such folder. */
  fun children(id: String): List<BrowseNode>? {
    val kids = if (id == ROOT_ID) rootChildren else folders[id]?.children ?: return null
    return kids.map { node(it) }
  }

  /** A folder or an item by id; null when there is none. */
  fun node(id: String): BrowseNode? =
    when {
      id == ROOT_ID -> BrowseNode(ROOT_ID, options.titles.more, isFolder = true)
      folders.containsKey(id) -> folderNode(folders.getValue(id))
      else -> byId[id]?.let { leaf(it) }
    }

  /** How a folder's items should be laid out. */
  fun style(id: String): BrowseStyle {
    val kids = if (id == ROOT_ID) rootChildren else folders[id]?.children ?: return BrowseStyle.LIST
    val leaves = kids.filterIsInstance<Child.Leaf>()
    val grid = leaves.isNotEmpty() && leaves.all { it.entry.item.kind == "station" || it.entry.item.kind == "album" }
    return if (grid) BrowseStyle.GRID else BrowseStyle.LIST
  }

  private fun node(child: Child): BrowseNode =
    when (child) {
      is Child.Sub -> folderNode(folders.getValue(child.folderId))
      is Child.Leaf -> leaf(child.entry)
    }

  private fun leaf(entry: Entry) =
    BrowseNode(entry.item.id, entry.item.title, isFolder = false, kind = entry.item.kind, artwork = entry.item.artwork, subtitle = entry.item.subtitle)

  private fun folderNode(folder: Folder) = BrowseNode(folder.id, folder.title, isFolder = true, artwork = firstArtwork(folder, 0))

  /** The artwork of the first item inside, as a tile for the folder. */
  private fun firstArtwork(folder: Folder, depth: Int): String? {
    if (depth > MAX_DEPTH) return null
    for (child in folder.children) {
      val art =
        when (child) {
          is Child.Leaf -> child.entry.item.artwork
          is Child.Sub -> firstArtwork(folders.getValue(child.folderId), depth + 1)
        }
      if (art != null) return art
    }
    return null
  }

  companion object {
    const val ROOT_ID = "rnap:root"
    const val RECENT_ID = "rnap:recent"
    const val FAVORITES_ID = "rnap:favorites"
    const val MORE_ID = "rnap:more"
    const val GROUP_PREFIX = "rnap:group:"
    const val PART_PREFIX = "rnap:part:"
    /** Folder ids start with this; catalog ids must not. */
    const val RESERVED_PREFIX = "rnap:"
    /** The most children RNAP shows in one folder of a browser that cannot page (Android Auto, Automotive). */
    const val DEFAULT_FOLDER_LIMIT = 100
    /** Android Auto's and CarPlay audio's tab limit. */
    const val DEFAULT_ROOT_LIMIT = 4
    private const val MIN_ROOT_LIMIT = 2
    private const val MIN_FOLDER_LIMIT = 2
    private const val MAX_DEPTH = 8

    /** `"Podcasts/Daily"` → `["Podcasts", "Daily"]`; blank segments are dropped. */
    fun groupSegments(group: String?): List<String> = group?.split('/')?.map { it.trim() }?.filter { it.isNotEmpty() } ?: emptyList()

    /** Whether an item filed under [itemGroup] is in [group] or one of its subgroups (no [group]: everything). */
    fun isInGroup(itemGroup: String?, group: String?): Boolean {
      val wanted = groupSegments(group)
      if (wanted.isEmpty()) return true
      val own = groupSegments(itemGroup)
      return own.size >= wanted.size && own.subList(0, wanted.size) == wanted
    }
  }
}
