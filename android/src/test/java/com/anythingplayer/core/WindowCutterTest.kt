package com.anythingplayer.core

import kotlin.math.abs
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WindowCutterTest {
  /** Decoder buffers of [size] frames, numbered samples, timed at [rate] from 0. */
  private fun play(cutter: WindowCutter, size: Int, buffers: Int, rate: Int): List<WindowCutter.Window> {
    val out = ArrayList<WindowCutter.Window>()
    for (b in 0 until buffers) {
      val block = FloatArray(size) { (b * size + it).toFloat() }
      cutter.append(block, size, (b.toLong() * size * 1_000_000L) / rate)
      out += cutter.cut()
    }
    return out
  }

  @Test
  fun `HE-AAC buffers of 2048 frames come out as two windows each`() {
    val windows = play(WindowCutter(44_100), 2048, 10, 44_100)
    assertEquals(20, windows.size)
    for (window in windows) assertEquals(1024, window.samples.size)
    assertEquals(0L, windows[0].startUs)
    assertEquals(1024L * 1_000_000L / 44_100, windows[1].startUs)
  }

  @Test
  fun `MP3 buffers are cut across, every sample once and in order`() {
    val cutter = WindowCutter(44_100)
    val windows = play(cutter, 1152, 32, 44_100)
    val total = 1152 * 32
    assertEquals(total / 1024, windows.size)
    assertEquals(total % 1024, cutter.pending)
    val joined = windows.flatMap { it.samples.toList() }.toFloatArray()
    assertArrayEquals(FloatArray(joined.size) { it.toFloat() }, joined, 0f)
  }

  @Test
  fun `a window is the same stretch of time at any sample rate`() {
    assertEquals(1024, WindowCutter(44_100).length)
    assertEquals(1115, WindowCutter(48_000).length)
    assertEquals(512, WindowCutter(22_050).length)
  }

  @Test
  fun `window times follow the decoder's and never drift`() {
    // An hour of MP3 frames: each window starts where its first sample was decoded.
    val rate = 44_100
    val cutter = WindowCutter(rate)
    val block = FloatArray(1152)
    var index = 0L
    var worst = 0.0
    for (b in 0 until 140_000) {
      cutter.append(block, 1152, (b.toLong() * 1152 * 1_000_000L) / rate)
      for (window in cutter.cut()) {
        val expectedUs = index++ * 1024.0 * 1_000_000.0 / rate
        worst = maxOf(worst, abs(window.startUs - expectedUs))
      }
    }
    // Whole-µs rounding only (cut times re-rounded from their own 23 ms would be ~157 ms off by now).
    assertTrue("off by up to $worst µs", worst <= 2.0)
  }

  @Test
  fun `waiting audio a block does not continue is dropped, not joined to it`() {
    val cutter = WindowCutter(44_100)
    cutter.append(FloatArray(700) { 1f }, 700, 0)
    // The next block starts 5 s later (a jump without a flush).
    cutter.append(FloatArray(1024) { 2f }, 1024, 5_000_000)
    val windows = cutter.cut()
    assertEquals(1, windows.size)
    assertTrue(windows[0].samples.all { it == 2f })
    assertEquals(5_000_000L, windows[0].startUs)
    assertEquals(0, cutter.pending)
  }

  @Test
  fun `a block that continues within rounding keeps what was waiting`() {
    val cutter = WindowCutter(44_100)
    cutter.append(FloatArray(700) { 1f }, 700, 0)
    cutter.append(FloatArray(700) { 2f }, 700, 700L * 1_000_000L / 44_100 + 3)
    val windows = cutter.cut()
    assertEquals(1, windows.size)
    assertEquals(0L, windows[0].startUs / 1000)
    assertEquals(1f, windows[0].samples[0])
    assertEquals(2f, windows[0].samples[1023])
  }

  @Test
  fun `a reset drops what was waiting and a buffer without a time has none`() {
    val cutter = WindowCutter(44_100)
    cutter.append(FloatArray(700), 700, 5_000)
    cutter.reset(48_000)
    assertEquals(0, cutter.pending)
    cutter.append(FloatArray(1200), 1200, WindowCutter.NO_TIME)
    val windows = cutter.cut()
    assertEquals(1, windows.size)
    assertEquals(WindowCutter.NO_TIME, windows[0].startUs)
    assertEquals(1200 - 1115, cutter.pending)
  }
}
