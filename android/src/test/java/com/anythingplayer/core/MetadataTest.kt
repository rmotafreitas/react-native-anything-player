package com.anythingplayer.core

import java.io.File
import kotlin.random.Random
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs `conformance/metadata/icy.json` (shared with the Swift parser). */
class MetadataTest {
  @Test
  fun icyCases() {
    val cases = JSONArray(File(ConformanceTest.conformanceDir, "metadata/icy.json").readText())
    assertTrue(cases.length() > 10)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val name = c.getString("name")
      val format = StreamTitleFormat.fromWire(c.optString("format", ""))
      val meta =
        when {
          c.has("text") -> IcyParser.metadataFromBlock(c.getString("text").toByteArray(Charsets.UTF_8), format)
          c.has("bytes") -> IcyParser.metadataFromBlock(hex(c.getString("bytes")), format)
          else -> {
            val f = c.getJSONObject("fields")
            IcyParser.metadataFromFields(f.keys().asSequence().associateWith { f.getString(it) }, format)
          }
        }
      val expect = c.getJSONObject("expect")
      for (key in expect.keys()) {
        val v = if (expect.isNull(key)) null else expect.get(key)
        when (key) {
          "title" -> assertEquals("$name: title", v, meta.title)
          "artist" -> assertEquals("$name: artist", v, meta.artist)
          "artworkUri" -> assertEquals("$name: artworkUri", v, meta.artworkUri)
          "raw" -> {
            val o = expect.getJSONObject("raw")
            assertEquals("$name: raw", o.keys().asSequence().associateWith { o.getString(it) }, meta.raw)
          }
          else -> throw AssertionError("$name: unknown key $key")
        }
      }
    }
  }

  @Test
  fun decodeNeverFails() {
    for (b in 0..255) IcyParser.decode(byteArrayOf(b.toByte(), 0x41, (255 - b).toByte()))
    assertEquals("", IcyParser.decode(ByteArray(0)))
    assertEquals("", IcyParser.decode(ByteArray(3)))
  }

  @Test
  fun randomInputNeverCrashes() {
    val alphabet = "StreamTitle='; -".toByteArray() + byteArrayOf(0, 0x92.toByte(), 0xC3.toByte(), 0xE9.toByte())
    val random = Random(42)
    repeat(2_000) {
      val bytes = ByteArray(random.nextInt(64)) { alphabet[random.nextInt(alphabet.size)] }
      IcyParser.metadataFromBlock(bytes, StreamTitleFormat.ARTIST_TITLE)
    }
  }

  @Test
  fun backoffSequence() {
    val backoff = Backoff { 0.5 }
    assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 30000L, 30000L), (0 until 7).map { backoff.next() })
    backoff.reset()
    assertEquals(1000L, backoff.next())
    assertEquals(800L, Backoff { 0.0 }.next())
    assertEquals(1200L, Backoff { 0.999999 }.next())
  }

  private fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}
