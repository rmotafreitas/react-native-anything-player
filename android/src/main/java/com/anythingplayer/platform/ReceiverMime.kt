package com.anythingplayer.platform

import androidx.media3.common.MimeTypes

/**
 * What a Cast receiver needs to pick a decoder, from the URL's extension; else
 * `audio/mpeg` (most radio streams are MP3, and receivers sniff the rest).
 */
internal fun receiverMimeType(uri: String): String {
  val path = uri.substringBefore('#').substringBefore('?').lowercase()
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
