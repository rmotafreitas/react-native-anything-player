package com.anythingplayer.sound

import org.junit.Assert.assertEquals
import org.junit.Test

class SoundUriTest {
  @Test
  fun `web addresses are downloaded`() {
    assertEquals(SoundUri.Remote("https://x.test/a.wav"), SoundUri.parse(" https://x.test/a.wav "))
    assertEquals(SoundUri.Remote("HTTP://x.test/a.wav"), SoundUri.parse("HTTP://x.test/a.wav"))
  }

  @Test
  fun `file uris and absolute paths are files`() {
    assertEquals(SoundUri.LocalFile("/data/a b.wav"), SoundUri.parse("file:///data/a%20b.wav"))
    assertEquals(SoundUri.LocalFile("/data/a+b.wav"), SoundUri.parse("file:///data/a+b.wav"))
    assertEquals(SoundUri.LocalFile("/sdcard/a.wav"), SoundUri.parse("/sdcard/a.wav"))
  }

  @Test
  fun `content and resource uris go through the content resolver`() {
    assertEquals(SoundUri.Content("content://media/1"), SoundUri.parse("content://media/1"))
    assertEquals(SoundUri.Content("android.resource://p/raw/a"), SoundUri.parse("android.resource://p/raw/a"))
  }

  @Test
  fun `a bare name is a bundled raw resource, without its extension`() {
    assertEquals(SoundUri.RawResource("laser"), SoundUri.parse("laser"))
    assertEquals(SoundUri.RawResource("laser"), SoundUri.parse("laser.wav"))
  }
}
