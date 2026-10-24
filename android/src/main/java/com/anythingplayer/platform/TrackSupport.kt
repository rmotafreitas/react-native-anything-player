@file:OptIn(UnstableApi::class)

package com.anythingplayer.platform

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi

/**
 * A kind of track (the picture, the sound) the source has and this device
 * cannot play: ExoPlayer leaves such tracks out and plays the rest (or
 * nothing) as if all were well. [drm]: they are encrypted for a key system
 * the player has no session for.
 */
internal data class Unplayable(val codec: String, val drm: Boolean, val decoder: String?)

/** A track's codec and whether a renderer here plays it (a `C.FORMAT_*` support). */
internal data class TrackEntry(val mime: String?, val codecs: String?, val support: Int)

/** The source's [type] tracks, when there are some and none can play here. */
internal fun unplayable(tracks: Tracks, type: Int): Unplayable? =
  unplayable(
    tracks.groups
      .filter { it.type == type }
      .flatMap { g ->
        (0 until g.length).map {
          val format: Format = g.getTrackFormat(it)
          TrackEntry(format.sampleMimeType, format.codecs, g.getTrackSupport(it))
        }
      }
  )

/** Tracks of one kind, when there are some and none can play (too much for the hardware is still tried). */
internal fun unplayable(tracks: List<TrackEntry>): Unplayable? {
  if (tracks.isEmpty()) return null
  if (tracks.any { it.support == C.FORMAT_HANDLED || it.support == C.FORMAT_EXCEEDS_CAPABILITIES }) return null
  val first = tracks.first()
  return Unplayable(
    codec = NAMES[first.mime] ?: first.codecs ?: first.mime ?: "an unknown codec",
    drm = tracks.all { it.support == C.FORMAT_UNSUPPORTED_DRM },
    decoder = SOFTWARE_DECODERS[first.mime],
  )
}

/** Which of RNAP's software decoders (`rnapVideoDecoders`) plays a codec. */
private val SOFTWARE_DECODERS =
  listOf(
    MimeTypes.AUDIO_AC3,
    MimeTypes.AUDIO_E_AC3,
    MimeTypes.AUDIO_E_AC3_JOC,
    MimeTypes.AUDIO_DTS,
    MimeTypes.AUDIO_DTS_HD,
    MimeTypes.AUDIO_TRUEHD,
    MimeTypes.AUDIO_MPEG,
    MimeTypes.AUDIO_MPEG_L1,
    MimeTypes.AUDIO_MPEG_L2,
  ).associateWith { "ffmpeg" } + mapOf(MimeTypes.VIDEO_VP9 to "vp9", MimeTypes.VIDEO_AV1 to "av1")

private val NAMES =
  mapOf(
    MimeTypes.AUDIO_AC3 to "AC-3",
    MimeTypes.AUDIO_E_AC3 to "E-AC-3",
    MimeTypes.AUDIO_E_AC3_JOC to "E-AC-3 with Atmos",
    MimeTypes.AUDIO_AC4 to "AC-4",
    MimeTypes.AUDIO_DTS to "DTS",
    MimeTypes.AUDIO_DTS_HD to "DTS-HD",
    MimeTypes.AUDIO_DTS_EXPRESS to "DTS Express",
    MimeTypes.AUDIO_TRUEHD to "TrueHD",
    MimeTypes.AUDIO_MPEG to "MP3",
    MimeTypes.AUDIO_MPEG_L1 to "MPEG audio layer I",
    MimeTypes.AUDIO_MPEG_L2 to "MPEG audio layer II",
    MimeTypes.AUDIO_VORBIS to "Vorbis",
    MimeTypes.AUDIO_OPUS to "Opus",
    MimeTypes.AUDIO_FLAC to "FLAC",
    MimeTypes.AUDIO_ALAC to "ALAC",
    MimeTypes.VIDEO_VP8 to "VP8",
    MimeTypes.VIDEO_VP9 to "VP9",
    MimeTypes.VIDEO_AV1 to "AV1",
    MimeTypes.VIDEO_H265 to "HEVC",
    MimeTypes.VIDEO_DOLBY_VISION to "Dolby Vision",
    MimeTypes.VIDEO_MPEG2 to "MPEG-2",
    MimeTypes.VIDEO_VC1 to "VC-1",
    MimeTypes.VIDEO_H263 to "H.263",
    MimeTypes.VIDEO_MP4V to "MPEG-4 Part 2",
  )

/** Why the source's picture or sound cannot play, for its error. */
internal fun unplayableMessage(what: String, track: Unplayable, installed: List<String>, then: String = ""): String {
  val hint =
    if (track.decoder != null && track.decoder !in installed) {
      " RNAP's software decoders play it: `npx rnap add video-decoders` (or `rnapVideoDecoders=true`)."
    } else {
      ""
    }
  val after = if (then.isEmpty()) "" else " $then"
  return "This device cannot decode $what (${track.codec}).$after$hint"
}
