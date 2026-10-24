package com.anythingplayer.platform

import android.graphics.Bitmap
import android.text.Layout
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.text.style.UnderlineSpan
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import com.anythingplayer.core.MediaTrack
import com.anythingplayer.core.TrackKind
import com.anythingplayer.core.VideoVariant

// What ExoPlayer says about a video, in the engine's words: its tracks (the
// source's own audio and text tracks, and an adaptive source's variants) and
// the cues of the text track it renders. Twin of the iOS driver's media
// selection groups and the web's hls.js groups.

/** A run of a cue's text with one style (the overlay draws it). */
internal data class OverlaySpan(
  val text: String,
  val bold: Boolean = false,
  val italic: Boolean = false,
  val underline: Boolean = false,
  /** ARGB, `null`: the caption style's. */
  val color: Int? = null,
)

/** A cue the overlay draws: the app's subtitle files (from JS) or the source's (ExoPlayer). */
internal data class OverlayCue(
  val start: Double,
  val end: Double,
  val spans: List<OverlaySpan>,
  /** `left`, `center`, `right`. */
  val align: String = "center",
  /** `top`, `middle`, `bottom`. */
  val vertical: String = "bottom",
  /** Fractions of the picture; `null`: the default place. */
  val x: Double? = null,
  val y: Double? = null,
  /** A bitmap subtitle (PGS, VobSub, DVB), with its size as fractions of the picture. */
  val bitmap: Bitmap? = null,
  val bitmapWidth: Double? = null,
  val bitmapHeight: Double? = null,
) {
  val text: String
    get() = spans.joinToString("") { it.text }
}

/** A video's tracks as the engine lists them, and how to find each again. */
@OptIn(UnstableApi::class)
internal class MappedTracks(
  val tracks: List<MediaTrack>,
  val variants: List<VideoVariant>,
  /** Track id (`track:<group>:<index>`, `v<group>:<index>`) → its group and index. */
  val locations: Map<String, Pair<TrackGroup, Int>>,
  /** Format id → variant id: which variant plays. */
  val variantOfFormat: Map<String, String>,
  /** Variant id → its format (HLS variants often have no id: matched by size, then bitrate). */
  val variantFormats: Map<String, Format> = emptyMap(),
) {
  /** The variant [format] (the one decoding) belongs to, if one does. */
  fun variantOf(format: Format?): String? {
    if (format == null || variantFormats.isEmpty()) return null
    format.id?.let { id -> variantOfFormat[id]?.let { return it } }
    val sameSize = variantFormats.filter { (_, f) -> f.height == format.height && (f.width <= 0 || f.width == format.width) }
    if (sameSize.size == 1) return sameSize.keys.first()
    val candidates = sameSize.ifEmpty { variantFormats }
    val bitrate = format.bitrate.takeIf { it > 0 } ?: format.peakBitrate.takeIf { it > 0 } ?: return sameSize.keys.firstOrNull()
    return candidates.minByOrNull { (_, f) -> kotlin.math.abs((f.bitrate.takeIf { it > 0 } ?: f.peakBitrate) - bitrate) }?.key
  }
}

@OptIn(UnstableApi::class)
internal object ExoVideo {
  /** An adaptive source's pseudo-variant: the sound alone (the video track type turned off). */
  const val AUDIO_ONLY_VARIANT = "audio"

  fun map(tracks: Tracks): MappedTracks {
    val list = mutableListOf<MediaTrack>()
    val variants = mutableListOf<VideoVariant>()
    val locations = mutableMapOf<String, Pair<TrackGroup, Int>>()
    val variantOfFormat = mutableMapOf<String, String>()
    val variantFormats = mutableMapOf<String, Format>()
    tracks.groups.forEachIndexed { g, group ->
      val trackGroup = group.mediaTrackGroup
      for (i in 0 until group.length) {
        if (!group.isTrackSupported(i)) continue
        val format = group.getTrackFormat(i)
        when (group.type) {
          C.TRACK_TYPE_VIDEO -> {
            val id = "v$g:$i"
            variants.add(VideoVariant(id, format.height.takeIf { it > 0 }, format.bitrate.takeIf { it > 0 }?.toLong(), false, format.label))
            locations[id] = trackGroup to i
            variantFormats[id] = format
            format.id?.let { variantOfFormat[it] = id }
          }
          C.TRACK_TYPE_AUDIO, C.TRACK_TYPE_TEXT -> {
            val id = "track:$g:$i"
            list.add(trackOf(id, format, group.type == C.TRACK_TYPE_AUDIO))
            locations[id] = trackGroup to i
          }
          else -> Unit
        }
      }
    }
    // Several pictures to choose from: an adaptive source, whose sound can
    // play alone. One picture is no choice: no qualities (like the web's file).
    if (variants.size > 1) {
      variants.add(VideoVariant(AUDIO_ONLY_VARIANT, null, null, true, null))
    } else {
      variants.clear()
      variantOfFormat.clear()
      variantFormats.clear()
    }
    return MappedTracks(list, variants, locations, variantOfFormat, variantFormats)
  }

  private fun trackOf(id: String, format: Format, audio: Boolean): MediaTrack {
    val roles = format.roleFlags
    val sdh = roles and (C.ROLE_FLAG_CAPTION or C.ROLE_FLAG_DESCRIBES_MUSIC_AND_SOUND) != 0
    return MediaTrack(
      id = id,
      kind = if (audio) TrackKind.AUDIO else if (sdh) TrackKind.CAPTIONS else TrackKind.SUBTITLES,
      language = format.language,
      label = format.label,
      forced = format.selectionFlags and C.SELECTION_FLAG_FORCED != 0,
      isDefault = format.selectionFlags and C.SELECTION_FLAG_DEFAULT != 0,
      sdh = sdh,
      describesVideo = roles and C.ROLE_FLAG_DESCRIBES_VIDEO != 0,
    )
  }

  /** A cue ExoPlayer renders now, for the overlay (`position` is now: ExoPlayer gives no end). */
  fun overlayCue(cue: Cue, position: Double): OverlayCue {
    val vertical =
      when {
        cue.lineType == Cue.LINE_TYPE_FRACTION && cue.lineAnchor == Cue.ANCHOR_TYPE_END -> "bottom"
        cue.lineType == Cue.LINE_TYPE_FRACTION && cue.lineAnchor == Cue.ANCHOR_TYPE_MIDDLE -> "middle"
        cue.lineType == Cue.LINE_TYPE_FRACTION -> "top"
        cue.lineType == Cue.LINE_TYPE_NUMBER && cue.line >= 0 -> "top"
        else -> "bottom"
      }
    val align =
      when (cue.textAlignment) {
        Layout.Alignment.ALIGN_NORMAL -> "left"
        Layout.Alignment.ALIGN_OPPOSITE -> "right"
        else -> "center"
      }
    val x = cue.position.takeIf { it != Cue.DIMEN_UNSET }?.toDouble()
    val y = if (cue.lineType == Cue.LINE_TYPE_FRACTION && cue.line != Cue.DIMEN_UNSET) cue.line.toDouble() else null
    val bitmap = cue.bitmap
    if (bitmap != null) {
      return OverlayCue(
        position, position, emptyList(), "left", "top", x ?: 0.0, y ?: 0.0, bitmap,
        cue.size.takeIf { it != Cue.DIMEN_UNSET }?.toDouble(),
        cue.bitmapHeight.takeIf { it != Cue.DIMEN_UNSET }?.toDouble(),
      )
    }
    return OverlayCue(position, position, spansOf(cue.text), align, vertical, x, y)
  }

  /** A styled `CharSequence` as runs (bold, italic, underline, colour). */
  private fun spansOf(text: CharSequence?): List<OverlaySpan> {
    if (text == null) return emptyList()
    if (text !is Spanned) return listOf(OverlaySpan(text.toString()))
    val cuts = sortedSetOf(0, text.length)
    for (span in text.getSpans(0, text.length, Any::class.java)) {
      cuts.add(text.getSpanStart(span))
      cuts.add(text.getSpanEnd(span))
    }
    val bounds = cuts.toList()
    return (0 until bounds.size - 1).mapNotNull { k ->
      val from = bounds[k]
      val to = bounds[k + 1]
      if (from >= to) return@mapNotNull null
      val styles = text.getSpans(from, to, StyleSpan::class.java)
      OverlaySpan(
        text.subSequence(from, to).toString(),
        bold = styles.any { it.style == android.graphics.Typeface.BOLD || it.style == android.graphics.Typeface.BOLD_ITALIC },
        italic = styles.any { it.style == android.graphics.Typeface.ITALIC || it.style == android.graphics.Typeface.BOLD_ITALIC },
        underline = text.getSpans(from, to, UnderlineSpan::class.java).isNotEmpty(),
        color = text.getSpans(from, to, ForegroundColorSpan::class.java).lastOrNull()?.foregroundColor,
      )
    }
  }
}
