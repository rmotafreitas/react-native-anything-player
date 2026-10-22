package com.anythingplayer.platform

import android.app.SearchManager
import android.content.Intent
import android.provider.MediaStore

/**
 * `MEDIA_PLAY_FROM_SEARCH`: how an assistant hands a spoken request to an
 * activity ("play Jazz FM on MyRadio").
 */
internal object AssistantIntents {
  /** Set on an intent once it was acted on, so an activity recreated with it does not play it again. */
  const val EXTRA_HANDLED = "com.anythingplayer.HANDLED"

  /** What the assistant understood the request to be about (`EXTRA_MEDIA_FOCUS`) → the public `focus`. */
  fun focus(mediaFocus: String?): String? =
    when (mediaFocus) {
      null, "" -> null
      MediaStore.Audio.Media.ENTRY_CONTENT_TYPE -> "song"
      MediaStore.Audio.Artists.ENTRY_CONTENT_TYPE -> "artist"
      MediaStore.Audio.Albums.ENTRY_CONTENT_TYPE -> "album"
      MediaStore.Audio.Genres.ENTRY_CONTENT_TYPE -> "genre"
      MediaStore.Audio.Playlists.ENTRY_CONTENT_TYPE -> "playlist"
      // "vnd.android.cursor.item/*": unstructured, anything goes.
      else -> "any"
    }

  /** The request in the intent's fields (see [fromIntent]). */
  fun request(query: String?, mediaFocus: String?, title: String?, artist: String?, album: String?, genre: String?): SearchRequest =
    SearchRequest(
      query = query?.trim() ?: "",
      title = title?.trim()?.ifEmpty { null },
      artist = artist?.trim()?.ifEmpty { null },
      album = album?.trim()?.ifEmpty { null },
      genre = genre?.trim()?.ifEmpty { null },
      focus = focus(mediaFocus),
      origin = "assistant",
    )

  /** Whether [intent] is a play-from-search request that was not acted on yet. */
  fun isPending(intent: Intent?): Boolean =
    intent != null && intent.action == MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH && !intent.getBooleanExtra(EXTRA_HANDLED, false)

  fun fromIntent(intent: Intent): SearchRequest =
    request(
      intent.getStringExtra(SearchManager.QUERY),
      intent.getStringExtra(MediaStore.EXTRA_MEDIA_FOCUS),
      intent.getStringExtra(MediaStore.EXTRA_MEDIA_TITLE),
      intent.getStringExtra(MediaStore.EXTRA_MEDIA_ARTIST),
      intent.getStringExtra(MediaStore.EXTRA_MEDIA_ALBUM),
      intent.getStringExtra(MediaStore.EXTRA_MEDIA_GENRE),
    )
}
