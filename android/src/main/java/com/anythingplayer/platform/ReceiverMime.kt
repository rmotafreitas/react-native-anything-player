package com.anythingplayer.platform

import androidx.media3.common.MimeTypes

/**
 * What a Cast receiver needs to pick a decoder, from the URL's extension; else
 * `audio/mpeg` (most radio streams are MP3, and receivers sniff the rest). A
 * video player's files are video containers (else `video/mp4`).
 */
internal fun receiverMimeType(uri: String, video: Boolean = false): String {
  val path = uri.substringBefore('#').substringBefore('?').lowercase()
  if (video) {
    return when {
      path.endsWith(".m3u8") -> MimeTypes.APPLICATION_M3U8
      path.endsWith(".mpd") -> MimeTypes.APPLICATION_MPD
      path.endsWith(".webm") -> "video/webm"
      path.endsWith(".ts") || path.endsWith(".m2ts") -> "video/mp2t"
      path.endsWith(".mkv") -> "video/x-matroska"
      path.endsWith(".mov") -> "video/quicktime"
      path.endsWith(".m4a") || path.endsWith(".aac") -> "audio/mp4"
      else -> "video/mp4"
    }
  }
  return when {
    path.endsWith(".m3u8") -> MimeTypes.APPLICATION_M3U8
    path.endsWith(".mpd") -> MimeTypes.APPLICATION_MPD
    path.endsWith(".aac") -> "audio/aac"
    path.endsWith(".m4a") || path.endsWith(".mp4") -> "audio/mp4"
    path.endsWith(".ogg") || path.endsWith(".oga") || path.endsWith(".opus") -> "audio/ogg"
    path.endsWith(".flac") -> "audio/flac"
    path.endsWith(".wav") -> "audio/wav"
    else -> MimeTypes.AUDIO_MPEG
  }
}
