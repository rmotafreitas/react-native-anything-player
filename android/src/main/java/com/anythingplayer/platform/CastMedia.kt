package com.anythingplayer.platform

import android.net.Uri
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToLong

/** One of the app's subtitle files, as WebVTT for a Cast receiver. */
internal data class CastSubtitle(
  /** The engine's track id (`sub:<n>`). */
  val id: String,
  val captions: Boolean,
  val language: String?,
  val label: String?,
  val vtt: String,
)

/** What a video player hands a Cast receiver besides the source. */
internal data class CastMedia(
  val video: Boolean = false,
  val subtitles: List<CastSubtitle> = emptyList(),
  /** The text track shown (`status.video.textTrack`). */
  val textTrack: String? = null,
)

/** A WebVTT file a receiver fetches without a server: a `data:` URL. */
internal fun vttDataUri(vtt: String): Uri = Uri.parse("data:text/vtt;charset=utf-8," + Uri.encode(vtt))

private fun clock(seconds: Double): String {
  val ms = max(0L, (seconds * 1000).roundToLong())
  return String.format(
    Locale.US,
    "%02d:%02d:%02d.%03d",
    ms / 3_600_000,
    (ms % 3_600_000) / 60_000,
    (ms % 60_000) / 1000,
    ms % 1000,
  )
}

private fun escapeVtt(text: String) = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

/** Where the cue sits, as WebVTT settings. */
private fun settingsOf(cue: OverlayCue): String {
  val out = mutableListOf("align:" + mapOf("left" to "start", "right" to "end").getOrDefault(cue.align, "center"))
  val y = cue.y
  when {
    y != null -> {
      val anchor = mapOf("top" to "start", "middle" to "center").getOrDefault(cue.vertical, "end")
      out.add(String.format(Locale.US, "line:%.1f%%,%s", y * 100, anchor))
    }
    cue.vertical == "top" -> out.add("line:0")
    cue.vertical == "middle" -> out.add("line:50%,center")
  }
  cue.x?.let { out.add(String.format(Locale.US, "position:%.1f%%", it * 100)) }
  return out.joinToString(" ")
}

/**
 * Cues as a WebVTT file (bold, italic, underline and placement kept), shifted
 * by `delay`. Twin of `cuesToVtt` in src/core/subtitles/vtt.ts: how an app's
 * subtitle file, whatever its format, reaches a Cast receiver.
 */
internal fun cuesToVtt(cues: List<OverlayCue>, delay: Double = 0.0): String {
  val blocks =
    cues.filter { it.end + delay > 0 && it.bitmap == null }.map { cue ->
      val text =
        cue.spans.joinToString("") { span ->
          var t = escapeVtt(span.text)
          if (span.underline) t = "<u>$t</u>"
          if (span.italic) t = "<i>$t</i>"
          if (span.bold) t = "<b>$t</b>"
          t
        }
      "${clock(cue.start + delay)} --> ${clock(cue.end + delay)} ${settingsOf(cue)}\n$text"
    }
  return (listOf("WEBVTT") + blocks).joinToString("\n\n") + "\n"
}
