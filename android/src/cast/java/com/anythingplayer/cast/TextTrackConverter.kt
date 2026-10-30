package com.anythingplayer.cast

import androidx.annotation.OptIn
import androidx.media3.cast.DefaultMediaItemConverter
import androidx.media3.cast.MediaItemConverter
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import com.google.android.gms.cast.MediaQueueItem
import com.google.android.gms.cast.MediaTrack

/**
 * Media3's item conversion, plus the item's subtitle configurations as the
 * receiver's text tracks (a video player's subtitle files, as WebVTT): ids 1,
 * 2… in order, the default one on from the start.
 */
@OptIn(UnstableApi::class)
internal class TextTrackConverter(private val base: MediaItemConverter = DefaultMediaItemConverter()) :
  MediaItemConverter {
  override fun toMediaQueueItem(mediaItem: MediaItem): MediaQueueItem {
    val item = base.toMediaQueueItem(mediaItem)
    val subtitles = mediaItem.localConfiguration?.subtitleConfigurations.orEmpty()
    val info = item.media
    if (subtitles.isEmpty() || info == null) return item
    val tracks =
      subtitles.mapIndexed { i, s ->
        MediaTrack.Builder((i + 1).toLong(), MediaTrack.TYPE_TEXT)
          .setContentId(s.uri.toString())
          .setContentType(s.mimeType ?: "text/vtt")
          .setSubtype(if (s.roleFlags and C.ROLE_FLAG_CAPTION != 0) MediaTrack.SUBTYPE_CAPTIONS else MediaTrack.SUBTYPE_SUBTITLES)
          .setName(s.label)
          .setLanguage(s.language)
          .build()
      }
    info.writer.setMediaTracks(tracks)
    val active = subtitles.indexOfFirst { it.selectionFlags and C.SELECTION_FLAG_DEFAULT != 0 }
    return MediaQueueItem.Builder(item)
      .setActiveTrackIds(if (active >= 0) longArrayOf((active + 1).toLong()) else LongArray(0))
      .build()
  }

  override fun toMediaItem(mediaQueueItem: MediaQueueItem): MediaItem = base.toMediaItem(mediaQueueItem)
}
