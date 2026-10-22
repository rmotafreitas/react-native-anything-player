package com.anythingplayer.sound

/** Where a sound's bytes are: how the SoundPool backend reads a `uri` the JS side passed. */
internal sealed class SoundUri {
  data class LocalFile(val path: String) : SoundUri()

  data class Content(val uri: String) : SoundUri()

  data class Remote(val url: String) : SoundUri()

  /** A React Native release asset (`require('./a.wav')`): the name of a raw resource. */
  data class RawResource(val name: String) : SoundUri()

  companion object {
    fun parse(uri: String): SoundUri {
      val trimmed = uri.trim()
      val lower = trimmed.lowercase()
      return when {
        lower.startsWith("http://") || lower.startsWith("https://") -> Remote(trimmed)
        lower.startsWith("content://") -> Content(trimmed)
        lower.startsWith("file://") -> LocalFile(trimmed.substring("file://".length).substringBefore('?').substringBefore('#').let(::decode))
        lower.startsWith("/") -> LocalFile(trimmed)
        // `android.resource://pkg/raw/name` and the like: let the content resolver open it.
        lower.contains("://") -> Content(trimmed)
        else -> RawResource(trimmed.substringBeforeLast('.'))
      }
    }

    private fun decode(path: String): String =
      try {
        java.net.URLDecoder.decode(path.replace("+", "%2B"), "UTF-8")
      } catch (_: IllegalArgumentException) {
        path
      }
  }
}
