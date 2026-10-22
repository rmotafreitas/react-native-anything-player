package com.anythingplayer.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class IcyFramingTest {
  /** An ICY body: `metaint` audio bytes, then a metadata block (or a zero length), repeated. */
  private class Body(val input: ByteArray, val audio: ByteArray, val blocks: List<Pair<Long, String>>)

  private fun body(metaint: Int, chunks: Int, titles: List<String?>): Body {
    val input = java.io.ByteArrayOutputStream()
    val audio = java.io.ByteArrayOutputStream()
    val blocks = ArrayList<Pair<Long, String>>()
    for (c in 0 until chunks) {
      val slice = ByteArray(metaint) { (it + c * 7).toByte() }
      input.write(slice)
      audio.write(slice)
      val title = titles[c % titles.size]
      if (title != null) {
        var payload = "StreamTitle='$title';".toByteArray(Charsets.UTF_8)
        val length = (payload.size + 15) / 16
        payload = payload.copyOf(length * 16)
        input.write(length)
        input.write(payload)
        blocks.add(audio.size().toLong() to title)
      } else {
        input.write(0)
      }
    }
    return Body(input.toByteArray(), audio.toByteArray(), blocks)
  }

  @Test
  fun `a whole body splits into audio and timed blocks`() {
    val b = body(100, 6, listOf("A - B", null, "Ç - 日本"))
    val d = IcyDeinterleaver(100)
    val out = d.consume(b.input)
    assertArrayEquals(b.audio, out.audio)
    assertEquals(b.blocks.map { it.first }, out.blocks.map { it.audioOffset })
    assertEquals(
      b.blocks.map { it.second },
      out.blocks.map { IcyParser.metadataFromBlock(it.bytes, StreamTitleFormat.TITLE).title },
    )
    assertEquals(b.audio.size.toLong(), d.audioBytes)
  }

  @Test
  fun `any chunking gives the same result`() {
    val b = body(37, 40, listOf("x", null, "longer title - with words", null, null))
    for (seed in 1..300) {
      var s = seed.toLong()
      val d = IcyDeinterleaver(37)
      val audio = java.io.ByteArrayOutputStream()
      val offsets = ArrayList<Long>()
      var i = 0
      while (i < b.input.size) {
        s = s * 48271 % 2147483647
        val n = minOf(b.input.size - i, (s % 64).toInt() + 1)
        val out = d.consume(b.input.copyOfRange(i, i + n))
        audio.write(out.audio)
        out.blocks.forEach { offsets.add(it.audioOffset) }
        i += n
      }
      assertArrayEquals("seed $seed", b.audio, audio.toByteArray())
      assertEquals("seed $seed", b.blocks.map { it.first }, offsets)
    }
  }

  @Test
  fun `a chunk may be a prefix of a longer buffer`() {
    val b = body(10, 3, listOf("t"))
    val padded = b.input + ByteArray(5)
    val out = IcyDeinterleaver(10).consume(padded, b.input.size)
    assertArrayEquals(b.audio, out.audio)
  }

  @Test
  fun `without a metaint everything is audio`() {
    val d = IcyDeinterleaver(0)
    val data = byteArrayOf(1, 2, 3)
    val out = d.consume(data)
    assertSame(data, out.audio)
    assertEquals(0, out.blocks.size)
    assertEquals(3L, d.audioBytes)
  }
}
