package com.anythingplayer.platform

import androidx.media3.common.C
import com.anythingplayer.core.DrmDescriptor
import com.anythingplayer.core.LicenseServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DrmTest {
  private val kid = "a7e61c373e219033c21091fa607bf3b8"
  private val key = "76a6c65c5ea762046bd749a2e632ccbb"
  private val server = LicenseServer("https://l/x")

  @Test
  fun `the first key system the source gives and the device has`() {
    val all = DrmDescriptor(widevine = server, playready = server, clearkey = server)
    assertEquals(KeySystem.WIDEVINE, chooseKeySystem(all) { true })
    assertEquals(KeySystem.PLAYREADY, chooseKeySystem(all) { it != C.WIDEVINE_UUID })
    assertEquals(KeySystem.CLEARKEY, chooseKeySystem(DrmDescriptor(clearkey = LicenseServer(null), clearKeys = mapOf(kid to key))) { true })
    assertNull(chooseKeySystem(DrmDescriptor(playready = server)) { it == C.WIDEVINE_UUID })
  }

  @Test
  fun `a source with FairPlay alone says why Android cannot play it`() {
    assertTrue(noKeySystemMessage(DrmDescriptor(fairplay = true)).contains("only FairPlay"))
    assertTrue(noKeySystemMessage(DrmDescriptor(playready = server)).contains("(playready)"))
  }

  @Test
  fun `a Clear Key license holds the source's keys in base64url`() {
    val license = String(clearKeyLicense(mapOf(kid to key)), Charsets.UTF_8)
    assertEquals(
      """{"keys":[{"kty":"oct","kid":"p-YcNz4hkDPCEJH6YHvzuA","k":"dqbGXF6nYgRr10mi5jLMuw"}],"type":"temporary"}""",
      license,
    )
  }

  @Test
  fun `base64url without padding`() {
    assertEquals("", base64Url(ByteArray(0)))
    assertEquals("-w", base64Url(byteArrayOf(0xfb.toByte())))
    assertEquals("-_8", base64Url(byteArrayOf(0xfb.toByte(), 0xff.toByte())))
    assertEquals("AAEC", base64Url(byteArrayOf(0, 1, 2)))
  }
}
