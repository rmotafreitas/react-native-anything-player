package com.anythingplayer.platform

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What a stored catalog item and the persisted player options become when native loads them with no JS. */
class JsonBridgeTest {
  @Test
  fun `a stored source loads like one JS passed`() {
    val source =
      JSONObject(
        """{"uri":"https://stream.example/jazz","live":true,"headers":{"Authorization":"Bearer t"},
            "metadata":{"title":"Jazz FM","artist":"Various","artwork":"https://x/a.png"}}"""
      )
    val (descriptor, fields) = parseSource(source.toReadableMap())
    assertEquals("https://stream.example/jazz", descriptor.uri)
    assertEquals(true, descriptor.liveHint)
    assertEquals(mapOf("Authorization" to "Bearer t"), descriptor.headers)
    assertEquals("Jazz FM", fields.title)
    assertEquals("Various", fields.artist)
    assertEquals("https://x/a.png", fields.artwork)
  }

  @Test
  fun `persisted player options parse like the app's`() {
    val options =
      parseOptions(
        JSONObject(
          """{"mediaSession":{"enabled":false,"commands":["next","previous"]},
              "audio":{"contentType":"speech","mixWithOthers":false},
              "progressInterval":1000,"recovery":{"giveUpAfterMs":null}}"""
        ).toReadableMap()
      )
    assertEquals(false, options.mediaSession)
    assertEquals(setOf("next", "previous"), options.remoteCommands)
    assertTrue(options.speech)
    assertEquals(1000L, options.progressIntervalMs)
    assertNull(options.engine.giveUpAfterMs)
  }
}
