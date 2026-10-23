package com.anythingplayer.platform

import android.content.Context
import android.os.Bundle
import android.provider.MediaStore
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaConstants
import androidx.media3.session.MediaLibraryService
import com.anythingplayer.core.BrowseItem
import com.anythingplayer.core.BrowseNode
import com.anythingplayer.core.BrowseOptions
import com.anythingplayer.core.BrowseStyle
import com.anythingplayer.core.BrowseTree
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture

/**
 * The catalog as a media library: the browse tree cars, watches and the
 * assistants list (folders from the items' groups, `BrowseTree`), and the one resolver that turns what a controller asks for
 * (a search, or an id it got from browsing) into catalog items. Resolving
 * never starts playback — the session player does, when Media3 sets the items.
 */
@OptIn(UnstableApi::class)
internal object MediaLibrary {
  const val ROOT_ID = BrowseTree.ROOT_ID
  /** The root a browser gets when it asks for what to resume ("recent"): only the last item played. */
  const val RESUME_ID = "rnap:resume"
  /** `Bundle.putStringArray`: the other names people say for an item. */
  const val KEYWORDS_EXTRA = "com.anythingplayer.KEYWORDS"
  /** Android Auto: the app uses content-style hints. */
  private const val CONTENT_STYLE_SUPPORTED = "android.media.browse.CONTENT_STYLE_SUPPORTED"
  /** Android Auto and Automotive show at most this many tabs, unless the browser's root hints say otherwise. */
  private const val CAR_TABS = BrowseTree.DEFAULT_ROOT_LIMIT
  /** Android Auto and Automotive do not page: a folder with more children than this is split into slices. */
  private const val CAR_FOLDER = BrowseTree.DEFAULT_FOLDER_LIMIT

  fun root(context: Context): MediaItem =
    MediaItem.Builder()
      .setMediaId(ROOT_ID)
      .setMediaMetadata(
        MediaMetadata.Builder()
          .setTitle(context.applicationInfo.loadLabel(context.packageManager).toString())
          .setIsBrowsable(true)
          .setIsPlayable(false)
          .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
          .build()
      )
      .build()

  /** A tree, and the catalog entries its leaves stand for. */
  class View(val tree: BrowseTree, val entries: Map<String, CatalogEntry>)

  private data class Key(val revision: Long, val rootLimit: Int, val foldersOnly: Boolean, val folderLimit: Int)

  private var cached: Pair<Key, View>? = null

  /**
   * What a browser can show: a car lists folders at the root (tabs, [carTabs] at most, else [CAR_TABS]) and
   * folders of at most [CAR_FOLDER] children (it cannot page); any other browser, everything.
   */
  @Synchronized
  fun view(snapshot: CatalogSnapshot, car: Boolean, carTabs: Int? = null): View {
    val key = Key(snapshot.revision, if (car) carTabs ?: CAR_TABS else Int.MAX_VALUE, car, if (car) CAR_FOLDER else 0)
    cached?.takeIf { it.first == key }?.let { return it.second }
    val options: BrowseOptions = snapshot.browse.copy(rootLimit = key.rootLimit, foldersOnly = key.foldersOnly, folderLimit = key.folderLimit)
    val items = snapshot.items.map { BrowseItem(it.id, it.title, it.kind, it.group, it.artwork, it.artist) }
    return View(BrowseTree(items, options, snapshot.recentIds), snapshot.items.associateBy { it.id }).also { cached = key to it }
  }

  /** A folder or an item of the tree as the library returns it; null for a leaf the catalog no longer has. */
  fun mediaItem(view: View, node: BrowseNode): MediaItem? {
    if (!node.isFolder) return view.entries[node.id]?.let(::item)
    val metadata =
      MediaMetadata.Builder()
        .setTitle(node.title)
        .setIsBrowsable(true)
        .setIsPlayable(false)
        .setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED)
        .setExtras(styleExtras(view.tree.style(node.id)))
    node.artwork?.takeIf(::isRemote)?.let { metadata.setArtworkUri(android.net.Uri.parse(it)) }
    return MediaItem.Builder().setMediaId(node.id).setMediaMetadata(metadata.build()).build()
  }

  /** The tabs a browser's root hints allow ([MediaConstants.EXTRAS_KEY_ROOT_CHILDREN_LIMIT]); [CAR_TABS] when it says nothing. */
  fun carTabs(hints: MediaLibraryService.LibraryParams?): Int =
    hints?.extras?.getInt(MediaConstants.EXTRAS_KEY_ROOT_CHILDREN_LIMIT, 0)?.takeIf { it > 0 } ?: CAR_TABS

  /** The children of a folder, one page, as media items. Null when there is no such folder. */
  fun children(view: View, id: String, page: Int, pageSize: Int): List<MediaItem>? {
    val nodes = view.tree.children(id) ?: return null
    val size = pageSize.coerceAtLeast(1)
    val from = (page.coerceAtLeast(0).toLong() * size).coerceAtMost(nodes.size.toLong()).toInt()
    return nodes.subList(from, minOf(from + size, nodes.size)).mapNotNull { mediaItem(view, it) }
  }

  /** The item a browser asked for by id: a folder, a catalog item, or null (`rnap:` ids are folders only). */
  fun itemById(view: View, id: String): MediaItem? =
    view.tree.node(id)?.let { mediaItem(view, it) } ?: if (id.startsWith(BrowseTree.RESERVED_PREFIX)) null else Voice.entry(id)?.let(::item)

  /**
   * How a browsable folder lays out its children in a car: items as a grid for
   * stations and albums, a list otherwise; subfolders as a list.
   */
  private fun styleExtras(style: BrowseStyle): Bundle =
    Bundle().apply {
      putInt(
        MediaConstants.EXTRAS_KEY_CONTENT_STYLE_PLAYABLE,
        if (style == BrowseStyle.GRID) MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_GRID_ITEM else MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM,
      )
      putInt(MediaConstants.EXTRAS_KEY_CONTENT_STYLE_BROWSABLE, MediaConstants.EXTRAS_VALUE_CONTENT_STYLE_LIST_ITEM)
    }

  /** The root's hints: this service sets a style per folder, so browsers that honor styles should read them. */
  fun rootParams(recent: Boolean): MediaLibraryService.LibraryParams =
    MediaLibraryService.LibraryParams.Builder()
      .setRecent(recent)
      .setExtras(
        styleExtras(BrowseStyle.LIST).apply { putBoolean(CONTENT_STYLE_SUPPORTED, true) }
      )
      .build()

  private fun isRemote(uri: String) = uri.startsWith("http://") || uri.startsWith("https://")

  /** Searchable metadata (title, artist, album, genre, keywords); the stream itself stays private. */
  fun item(entry: CatalogEntry): MediaItem {
    val metadata =
      MediaMetadata.Builder()
        .setTitle(entry.title)
        .setArtist(entry.artist)
        .setAlbumTitle(entry.album)
        .setGenre(entry.genre)
        .setIsPlayable(true)
        .setIsBrowsable(false)
        .setMediaType(mediaType(entry.kind))
        .setExtras(Bundle().apply { putStringArray(KEYWORDS_EXTRA, entry.keywords.toTypedArray()) })
    entry.artwork?.takeIf(::isRemote)?.let { metadata.setArtworkUri(android.net.Uri.parse(it)) }
    return MediaItem.Builder().setMediaId(entry.id).setMediaMetadata(metadata.build()).build()
  }

  private fun mediaType(kind: String): Int? =
    when (kind) {
      "station" -> MediaMetadata.MEDIA_TYPE_RADIO_STATION
      "song" -> MediaMetadata.MEDIA_TYPE_MUSIC
      "album" -> MediaMetadata.MEDIA_TYPE_ALBUM
      "podcast" -> MediaMetadata.MEDIA_TYPE_PODCAST
      "audiobook" -> MediaMetadata.MEDIA_TYPE_AUDIO_BOOK
      else -> null
    }

  /** The root for a "recent" request: the last item played is its only child. */
  fun resumeRoot(): MediaItem =
    MediaItem.Builder()
      .setMediaId(RESUME_ID)
      .setMediaMetadata(
        MediaMetadata.Builder().setIsBrowsable(true).setIsPlayable(false).setMediaType(MediaMetadata.MEDIA_TYPE_FOLDER_MIXED).build()
      )
      .build()

  /** The item the "recent" root holds: what played last, if the catalog still has it. */
  fun resumed(snapshot: CatalogSnapshot): MediaItem? = snapshot.items.firstOrNull { it.id == snapshot.lastPlayedId }?.let(::item)

  /** One page of media items already built. */
  fun pageOf(items: List<MediaItem>, page: Int, pageSize: Int): List<MediaItem> {
    val size = pageSize.coerceAtLeast(1)
    val from = (page.coerceAtLeast(0).toLong() * size).coerceAtMost(items.size.toLong()).toInt()
    return items.subList(from, minOf(from + size, items.size))
  }

  /** One page of a list, as the library paginates (zero-based pages). */
  fun page(entries: List<CatalogEntry>, page: Int, pageSize: Int): List<MediaItem> {
    val size = pageSize.coerceAtLeast(1)
    val from = (page.coerceAtLeast(0).toLong() * size).coerceAtMost(entries.size.toLong()).toInt()
    return entries.subList(from, minOf(from + size, entries.size)).map(::item)
  }

  /** The search a controller asked for: `requestMetadata.searchQuery` and the `MediaStore.EXTRA_MEDIA_*` extras beside it. */
  fun requestOf(item: MediaItem): SearchRequest? {
    val query = item.requestMetadata.searchQuery ?: return null
    val extras = item.requestMetadata.extras
    return AssistantIntents.request(
      query,
      extras?.getString(MediaStore.EXTRA_MEDIA_FOCUS),
      extras?.getString(MediaStore.EXTRA_MEDIA_TITLE),
      extras?.getString(MediaStore.EXTRA_MEDIA_ARTIST),
      extras?.getString(MediaStore.EXTRA_MEDIA_ALBUM),
      extras?.getString(MediaStore.EXTRA_MEDIA_GENRE),
    )
  }

  /**
   * Catalog items for what [requested] asks: a search resolves like a voice
   * request (the best match; an empty one is the last item played; no match
   * may ask the app's handler), an id resolves to its catalog item. Anything
   * else — a bare URI from some other app — is dropped: only the catalog is
   * playable from outside. Main thread.
   */
  fun resolve(requested: List<MediaItem>): ListenableFuture<List<MediaItem>> {
    val result = SettableFuture.create<List<MediaItem>>()
    val resolved = ArrayList<MediaItem>()
    fun next(index: Int) {
      if (index == requested.size) {
        result.set(resolved)
        return
      }
      val item = requested[index]
      val request = requestOf(item)
      val done = { entry: CatalogEntry? ->
        // The request travels with its item, so concurrent searches cannot
        // swap what `searchPlay` reports.
        entry?.let { resolved += item(it).buildUpon().setRequestMetadata(item.requestMetadata).build() }
        next(index + 1)
      }
      if (request != null) {
        Voice.resolveOrAsk(request, done)
      } else {
        done(Voice.entry(item.mediaId))
      }
    }
    next(0)
    return result
  }
}
