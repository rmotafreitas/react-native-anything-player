package com.radioanimu.airwave.core

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

// Normalization of in-stream metadata (ICY / Shoutcast / Icecast, ID3, HLS
// timed metadata) into one shape. Byte-level ICY framing is done by Media3
// (IcyDataSource); only the payload is handled here. Swift twin:
// `ios/Core/StreamMetadata.swift`; both run `conformance/metadata/icy.json`.

data class StreamMetadata(
  val title: String? = null,
  val artist: String? = null,
  val album: String? = null,
  /** Station name (ICY `icy-name` header). */
  val station: String? = null,
  val genre: String? = null,
  /** Artwork URL carried by the stream (ICY `StreamUrl` when it is an image). */
  val artworkUri: String? = null,
  /** Every raw field, untouched. */
  val raw: Map<String, String> = emptyMap(),
) {
  val isEmpty: Boolean
    get() =
      title == null && artist == null && album == null && station == null && genre == null &&
        artworkUri == null && raw.isEmpty()
}

/** How a station formats ICY `StreamTitle`. */
enum class StreamTitleFormat(val wire: String) {
  ARTIST_TITLE("artist-title"),
  TITLE_ARTIST("title-artist"),
  TITLE("title");

  companion object {
    fun fromWire(value: String?): StreamTitleFormat = entries.firstOrNull { it.wire == value } ?: ARTIST_TITLE
  }
}

object IcyParser {
  private val separators = listOf(" - ", " – ", " — ", " ~ ")
  private const val SEPARATOR_CHARS = "-–—~ "

  /** Windows-1252 0x80–0x9F → Unicode (undefined bytes map to C1 controls). */
  private val cp1252High =
    intArrayOf(
      0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
      0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
      0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
      0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
    )

  /** Decodes a raw block: NUL padding stripped, UTF-8 if valid, else Windows-1252. */
  fun decode(bytes: ByteArray): String {
    var end = bytes.size
    while (end > 0 && bytes[end - 1] == 0.toByte()) end -= 1
    val trimmed = bytes.copyOfRange(0, end)
    strictUtf8(trimmed)?.let { return it }
    val sb = StringBuilder(trimmed.size)
    for (b in trimmed) sb.appendCodePoint(cp1252CodePoint(b.toInt() and 0xFF))
    return sb.toString()
  }

  /** Repairs UTF-8 text a platform decoded as Latin-1/Windows-1252 ("CafÃ©" → "Café"). */
  fun repairMojibake(text: String): String {
    val out = ByteArray(text.length)
    var sawHigh = false
    var index = 0
    var i = 0
    while (i < text.length) {
      val cp = text.codePointAt(i)
      val byte = cp1252Byte(cp) ?: return text
      if (byte >= 0x80) sawHigh = true
      out[index++] = byte.toByte()
      i += Character.charCount(cp)
    }
    if (!sawHigh) return text
    return strictUtf8(out.copyOfRange(0, index)) ?: text
  }

  /** Parses `StreamTitle='…';StreamUrl='…';` into fields (quotes/semicolons in values allowed). */
  fun parseFields(block: String): Map<String, String> {
    val result = LinkedHashMap<String, String>()
    val chars = block.toCharArray()
    var i = 0
    while (i < chars.size) {
      val eq = find(chars, "='", i) ?: break
      val key = String(chars, i, eq - i).trim()
      var valueStart = eq + 2
      var end = chars.size
      var next = chars.size
      var search = valueStart
      while (true) {
        val candidate = find(chars, "';", search) ?: break
        val after = candidate + 2
        if (after >= chars.size || startsKey(chars, after)) {
          end = candidate
          next = after
          break
        }
        search = candidate + 1
      }
      if (end == chars.size) {
        var stop = chars.size
        while (stop > valueStart && (chars[stop - 1] == '\'' || chars[stop - 1] == ';')) stop -= 1
        end = stop
      }
      if (valueStart > end) valueStart = end
      if (key.isNotEmpty() && !result.containsKey(key)) result[key] = String(chars, valueStart, end - valueStart)
      i = next
    }
    return result
  }

  /** Splits a StreamTitle per [format]. Returns (artist, title). */
  fun splitStreamTitle(raw: String, format: StreamTitleFormat): Pair<String?, String?> {
    val trimmed = raw.trim()
    if (trimmed.all { it in SEPARATOR_CHARS }) return null to null
    if (format == StreamTitleFormat.TITLE) return null to trimmed
    for (separator in separators) {
      val at = trimmed.indexOf(separator)
      if (at >= 0) {
        val left = nonEmpty(trimmed.substring(0, at))
        val right = nonEmpty(trimmed.substring(at + separator.length))
        if (left == null && right == null) return null to null
        return if (format == StreamTitleFormat.ARTIST_TITLE) left to right else right to left
      }
    }
    return null to trimmed
  }

  fun metadataFromFields(rawFields: Map<String, String>, format: StreamTitleFormat): StreamMetadata {
    val fields = LinkedHashMap<String, String>()
    for ((key, value) in rawFields) fields[key] = repairMojibake(value)
    val lower = HashMap<String, String>()
    for ((key, value) in fields) lower.putIfAbsent(key.lowercase(), value)
    var artist: String? = null
    var title: String? = null
    lower["streamtitle"]?.let {
      val (a, t) = splitStreamTitle(it, format)
      artist = a
      title = t
    }
    return StreamMetadata(
      title = title,
      artist = artist,
      station = lower["icy-name"]?.let(::nonEmpty),
      genre = lower["icy-genre"]?.let(::nonEmpty),
      artworkUri = lower["streamurl"]?.takeIf(::looksLikeImage),
      raw = fields,
    )
  }

  /** A block without `StreamTitle`/`StreamUrl` (corrupted framing, garbage) yields empty metadata. */
  fun metadataFromBlock(bytes: ByteArray, format: StreamTitleFormat): StreamMetadata {
    val fields = parseFields(decode(bytes))
    if (fields.keys.none { it.lowercase() == "streamtitle" || it.lowercase() == "streamurl" }) return StreamMetadata()
    return metadataFromFields(fields, format)
  }

  fun looksLikeImage(url: String): Boolean {
    val lower = url.lowercase()
    if (!lower.startsWith("http://") && !lower.startsWith("https://")) return false
    val path = lower.substringBefore('?')
    return listOf(".jpg", ".jpeg", ".png", ".webp", ".gif").any { path.endsWith(it) }
  }

  // ── Helpers ──

  private fun nonEmpty(s: String): String? = s.trim().ifEmpty { null }

  private fun strictUtf8(bytes: ByteArray): String? =
    try {
      StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()
    } catch (_: CharacterCodingException) {
      null
    }

  private fun find(chars: CharArray, needle: String, from: Int): Int? {
    var i = from
    while (i <= chars.size - needle.length) {
      var match = true
      for (k in needle.indices) {
        if (chars[i + k] != needle[k]) {
          match = false
          break
        }
      }
      if (match) return i
      i += 1
    }
    return null
  }

  private fun startsKey(chars: CharArray, index: Int): Boolean {
    var i = index
    while (i < chars.size && (chars[i].isLetterOrDigit() || chars[i] == '_' || chars[i] == '-')) i += 1
    return i > index && i + 1 < chars.size && chars[i] == '=' && chars[i + 1] == '\''
  }

  private fun cp1252CodePoint(byte: Int): Int = if (byte in 0x80..0x9F) cp1252High[byte - 0x80] else byte

  private fun cp1252Byte(codePoint: Int): Int? {
    if (codePoint < 0x80 || codePoint in 0xA0..0xFF) return codePoint
    val index = cp1252High.indexOf(codePoint)
    return if (index >= 0) 0x80 + index else null
  }
}
