package com.anythingplayer.platform

import android.content.Context
import android.os.Bundle
import android.provider.MediaStore
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture

/**
 * The catalog as the assistants' media library sees it: one flat folder of
 * playable items, and the one resolver that turns what a controller asks for
 * (a search, or an id it got from browsing) into catalog items. Resolving
 * never starts playback — the session player does, when Media3 sets the items.
 */
@OptIn(UnstableApi::class)
internal object MediaLibrary {
  const val ROOT_ID = "rnap:root"
  /** `Bundle.putStringArray`: the other names people say for an item. */
  const val KEYWORDS_EXTRA = "com.anythingplayer.KEYWORDS"

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
    entry.artwork?.takeIf { it.startsWith("http://") || it.startsWith("https://") }?.let { metadata.setArtworkUri(android.net.Uri.parse(it)) }
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
