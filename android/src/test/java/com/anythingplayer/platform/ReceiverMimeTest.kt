package com.anythingplayer.platform

import org.junit.Assert.assertEquals
import org.junit.Test

class ReceiverMimeTest {
  @Test
  fun `the extension picks the type, the query and fragment do not`() {
    assertEquals("application/x-mpegURL", receiverMimeType("https://x/live/index.m3u8?token=a.mp3"))
    assertEquals("audio/mp4", receiverMimeType("https://x/a.M4A#t=10"))
    assertEquals("audio/ogg", receiverMimeType("https://x/a.opus"))
    assertEquals("audio/aac", receiverMimeType("https://x/stream.aac"))
    assertEquals("audio/flac", receiverMimeType("https://x/a.flac"))
  }

  @Test
  fun `a radio url without an extension is mp3`() {
    assertEquals("audio/mpeg", receiverMimeType("https://stream.example/jazz"))
    assertEquals("audio/mpeg", receiverMimeType("https://x/a.mp3"))
  }

  @Test
  fun `a video player's files are video containers, else mp4`() {
    assertEquals("video/mp4", receiverMimeType("https://x/ep1.mp4", video = true))
    assertEquals("video/webm", receiverMimeType("https://x/a.webm?t=1", video = true))
    assertEquals("application/x-mpegURL", receiverMimeType("https://x/master.m3u8", video = true))
    assertEquals("application/dash+xml", receiverMimeType("https://x/a.mpd", video = true))
    assertEquals("video/mp4", receiverMimeType("https://x/watch", video = true))
  }

  @Test
  fun `cues become WebVTT for a receiver, styles, place and the delay kept`() {
    val cues =
      listOf(
        OverlayCue(1.0, 3.5, listOf(OverlaySpan("Hello", italic = true), OverlaySpan(" & "), OverlaySpan("you", bold = true))),
        OverlayCue(60.25, 62.0, listOf(OverlaySpan("At the top")), vertical = "top"),
        OverlayCue(0.0, 0.5, listOf(OverlaySpan("Gone"))),
      )
    assertEquals(
      "WEBVTT\n\n" +
        "00:00:00.000 --> 00:00:02.500 align:center\n<i>Hello</i> &amp; <b>you</b>\n\n" +
        "00:00:59.250 --> 00:01:01.000 align:center line:0\nAt the top\n",
      cuesToVtt(cues, delay = -1.0),
    )
  }
}
