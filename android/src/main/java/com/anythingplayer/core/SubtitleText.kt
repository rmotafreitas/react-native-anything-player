package com.anythingplayer.core

// The two subtitle pieces native code needs itself: the text encoding of a
// file nobody declared (fansub and DVD-rip SubRip files are often
// Windows-1252, Windows-1251 or Shift-JIS), and which cues are on screen at a
// position with the subtitle delay. Parsing is the TypeScript layer's
// (`src/core/subtitles/`). Twins: `charset.ts` and `schedule.ts` there,
// `ios/Core/SubtitleText.swift`; held to `conformance/subtitles/`.

object SubtitleCharset {
  /** Length of a UTF-8 sequence from its lead byte (0: not a lead byte). */
  private fun sequenceLength(lead: Int): Int =
    when {
      lead < 0x80 -> 1
      lead in 0xc2..0xdf -> 2
      lead in 0xe0..0xef -> 3
      lead in 0xf0..0xf4 -> 4
      else -> 0
    }

  fun isValidUtf8(bytes: ByteArray): Boolean {
    var i = 0
    while (i < bytes.size) {
      val length = sequenceLength(bytes[i].toInt() and 0xff)
      if (length == 0 || i + length > bytes.size) return false
      for (k in 1 until length) {
        if ((bytes[i + k].toInt() and 0xc0) != 0x80) return false
      }
      i += length
    }
    return true
  }

  /** UTF-16 without a byte-order mark: ASCII text leaves every other byte zero. */
  private fun utf16Without(bytes: ByteArray): String? {
    if (bytes.size < 4) return null
    var even = 0
    var odd = 0
    var i = 0
    while (i + 1 < bytes.size) {
      if (bytes[i].toInt() == 0) even += 1
      if (bytes[i + 1].toInt() == 0) odd += 1
      i += 2
    }
    val pairs = bytes.size / 2
    if (odd > pairs * 0.4 && even < pairs * 0.05) return "utf-16le"
    if (even > pairs * 0.4 && odd < pairs * 0.05) return "utf-16be"
    return null
  }

  private fun isTrail(b: Int): Boolean = b in 0x40..0x7e || b in 0x80..0xfc

  private fun isLead(b: Int): Boolean = b in 0x81..0x9f || b in 0xe0..0xfc

  /** Whether the bytes are valid Shift-JIS with the lead bytes of Japanese text. */
  private fun looksShiftJis(bytes: ByteArray): Boolean {
    var pairs = 0
    var kana = 0
    var i = 0
    while (i < bytes.size) {
      val b = bytes[i].toInt() and 0xff
      // ASCII and half-width katakana are one byte.
      if (b < 0x80 || b in 0xa1..0xdf) {
        i += 1
        continue
      }
      val trail = bytes.getOrNull(i + 1)?.toInt()?.and(0xff) ?: return false
      if (!isLead(b) || !isTrail(trail)) return false
      // Hiragana, katakana and most kanji lead with 0x81–0x9F: Cyrillic in
      // Windows-1251 almost never does.
      if (b <= 0x9f) kana += 1
      pairs += 1
      i += 2
    }
    return pairs > 0 && kana >= pairs * 0.5
  }

  /** Cyrillic text is mostly non-ASCII letters; Western text mostly ASCII ones. */
  private fun singleByte(bytes: ByteArray): String {
    var ascii = 0
    var high = 0
    for (byte in bytes) {
      val b = byte.toInt() and 0xff
      if (b in 0x41..0x5a || b in 0x61..0x7a) ascii += 1 else if (b >= 0xc0) high += 1
    }
    return if (high > (ascii + high) * 0.4) "windows-1251" else "windows-1252"
  }

  /** The encoding the bytes are most likely in (a WHATWG label). */
  fun detect(bytes: ByteArray): String {
    fun at(i: Int) = if (i < bytes.size) bytes[i].toInt() and 0xff else -1
    if (at(0) == 0xef && at(1) == 0xbb && at(2) == 0xbf) return "utf-8"
    if (at(0) == 0xff && at(1) == 0xfe) return "utf-16le"
    if (at(0) == 0xfe && at(1) == 0xff) return "utf-16be"
    utf16Without(bytes)?.let { return it }
    if (isValidUtf8(bytes)) return "utf-8"
    if (looksShiftJis(bytes)) return "shift_jis"
    return singleByte(bytes)
  }
}

/** A cue's time on the media timeline, seconds. */
data class CueTime(val start: Double, val end: Double)

object CueSchedule {
  /**
   * The indices of the cues (sorted by start) showing at `position`, in
   * order. A positive `delay` shows every cue later.
   */
  fun active(cues: List<CueTime>, position: Double, delay: Double = 0.0): List<Int> {
    val t = position - delay
    val active = mutableListOf<Int>()
    for ((i, cue) in cues.withIndex()) {
      if (cue.start > t) break
      if (t < cue.end) active.add(i)
    }
    return active
  }

  /** The next position at which the active set changes, after `position`; `null`: never again. */
  fun nextChange(cues: List<CueTime>, position: Double, delay: Double = 0.0): Double? {
    val t = position - delay
    var next = Double.POSITIVE_INFINITY
    for (cue in cues) {
      if (cue.start > t) {
        next = minOf(next, cue.start)
        break
      }
      if (cue.end > t) next = minOf(next, cue.end)
    }
    return if (next == Double.POSITIVE_INFINITY) null else next + delay
  }
}
