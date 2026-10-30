package com.anythingplayer.platform

import androidx.media3.common.C
import androidx.media3.common.MimeTypes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TrackSupportTest {
  private fun track(mime: String, support: Int) = TrackEntry(mime, null, support)

  @Test
  fun `a kind of track with one playable track is fine`() {
    assertNull(unplayable(listOf(track(MimeTypes.AUDIO_AC3, C.FORMAT_UNSUPPORTED_SUBTYPE), track(MimeTypes.AUDIO_AAC, C.FORMAT_HANDLED))))
    // Too much for the hardware is still tried.
    assertNull(unplayable(listOf(track(MimeTypes.VIDEO_H265, C.FORMAT_EXCEEDS_CAPABILITIES))))
    // None of that kind at all.
    assertNull(unplayable(emptyList()))
  }

  @Test
  fun `a sound no decoder here plays is named, with the decoder that would`() {
    val sound = unplayable(listOf(track(MimeTypes.AUDIO_MPEG_L2, C.FORMAT_UNSUPPORTED_SUBTYPE)))!!
    assertEquals(Unplayable("MPEG audio layer II", drm = false, decoder = "ffmpeg"), sound)
    assertEquals(
      "This device cannot decode the sound (MPEG audio layer II). The picture plays without it. " +
        "RNAP's software decoders play it: `npx rnap add video-decoders` (or `rnapVideoDecoders=true`).",
      unplayableMessage("the sound", sound, installed = emptyList(), then = "The picture plays without it."),
    )
    // With the decoder built in, no advice.
    assertEquals("This device cannot decode the sound (MPEG audio layer II).", unplayableMessage("the sound", sound, listOf("ffmpeg")))
    assertEquals("av1", unplayable(listOf(track(MimeTypes.VIDEO_AV1, C.FORMAT_UNSUPPORTED_SUBTYPE)))!!.decoder)
  }

  @Test
  fun `a codec no decoder covers, an unknown one, and encrypted tracks`() {
    val mpeg2 = unplayable(listOf(track(MimeTypes.VIDEO_MPEG2, C.FORMAT_UNSUPPORTED_SUBTYPE)))!!
    assertEquals(Unplayable("MPEG-2", drm = false, decoder = null), mpeg2)
    assertEquals("This device cannot decode the picture (MPEG-2).", unplayableMessage("the picture", mpeg2, emptyList()))
    assertEquals("dvh1.05.06", unplayable(listOf(TrackEntry("video/x-odd", "dvh1.05.06", C.FORMAT_UNSUPPORTED_TYPE)))!!.codec)
    assertEquals(true, unplayable(listOf(track(MimeTypes.VIDEO_H264, C.FORMAT_UNSUPPORTED_DRM)))!!.drm)
  }
}
