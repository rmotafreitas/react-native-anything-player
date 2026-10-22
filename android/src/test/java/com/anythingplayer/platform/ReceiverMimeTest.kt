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
}
