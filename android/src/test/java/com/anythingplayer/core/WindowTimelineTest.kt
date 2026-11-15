package com.anythingplayer.core

import androidx.media3.common.C
import kotlin.math.abs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WindowTimelineTest {
  private val window = 1024.0 / 44_100
  private val windowUs = Math.round(window * 1_000_000)

  /** When each window of a batch is heard (epoch ms), as boundary detection reads it. */
  private fun heard(timestampMs: Long, latencies: DoubleArray) = latencies.map { timestampMs + it * 1000 }

  @Test
  fun `a batch's windows follow one another exactly, whatever the latency read`() {
    // No sink position yet: a latency estimate that ignores where a window starts.
    val heard = heard(1_000, WindowTimeline().latencies(1_000, 0.2, 0, doubleArrayOf(window, window, window)))
    for (i in 1 until heard.size) assertEquals(heard[i - 1] + window * 1000, heard[i], 1e-9)
  }

  @Test
  fun `a batch that continues the last one starts where it ended, through rounding`() {
    val timeline = WindowTimeline()
    val first = heard(1_000, timeline.latencies(1_000, 0.2, 0, doubleArrayOf(window, window)))
    val end = first.last() + window * 1000
    // Read 46 ms later, a millisecond early: the clock's rounding and the position's jitter.
    val second = heard(1_046, timeline.latencies(1_046, (end - 1 - 1_046) / 1000, 2 * windowUs, doubleArrayOf(window)))
    // Eased 5% toward the reading: 0.05 ms early, well inside what joins as one.
    assertEquals(end - 0.05, second[0], 1e-9)
  }

  /** 20 minutes of two-window batches, the sink's clock [ppm] off the system's, read with ±1 ms jitter: worst seam and error (ms). */
  private fun skewed(ppm: Double): Pair<Double, Double> {
    val timeline = WindowTimeline()
    var trueHeardMs = 1_000.0 + 200
    var lastEnd = Double.NaN
    var startUs = 0L
    var worstSeam = 0.0
    var worstError = 0.0
    var seed = 7L
    for (b in 0 until 26_000) {
      val timestampMs = 1_000L + b * 46
      seed = (seed * 16807) % 2147483647
      val jitterMs = (seed / 2147483647.0) * 2 - 1
      val read = (trueHeardMs + jitterMs - timestampMs) / 1000
      val heard = heard(timestampMs, timeline.latencies(timestampMs, read, startUs, doubleArrayOf(window, window)))
      if (!lastEnd.isNaN()) worstSeam = maxOf(worstSeam, abs(heard[0] - lastEnd))
      worstError = maxOf(worstError, abs(heard[0] - trueHeardMs))
      lastEnd = heard[1] + window * 1000
      startUs += 2 * windowUs
      trueHeardMs += 2 * window * 1000 * (1 + ppm * 1e-6)
    }
    return worstSeam to worstError
  }

  @Test
  fun `a sink clock running fast or slow never makes a seam jump`() {
    for (ppm in listOf(50.0, -50.0)) {
      val (seam, error) = skewed(ppm)
      // Under the 0.5 ms a boundary finder joins as one (src/core/boundaries.ts).
      assertTrue("$ppm ppm: a seam moved $seam ms", seam < 0.5)
      assertTrue("$ppm ppm: drifted $error ms from the reading", error < 3)
    }
  }

  @Test
  fun `a real jump keeps its own reading`() {
    val timeline = WindowTimeline()
    val first = heard(1_000, timeline.latencies(1_000, 0.2, 0, doubleArrayOf(window)))
    val end = first.last() + window * 1000
    // The audio continues, but is heard 40 ms later (the output stalled).
    val late = heard(1_046, timeline.latencies(1_046, (end + 40 - 1_046) / 1000, windowUs, doubleArrayOf(window)))
    assertEquals(end + 40, late[0], 1e-9)
    // Audio that does not continue (a seek), read within the tolerance, is not chained either.
    val seek = heard(1_070, timeline.latencies(1_070, (late[0] + window * 1000 - 1 - 1_070) / 1000, 90_000_000, doubleArrayOf(window)))
    assertEquals(late[0] + window * 1000 - 1, seek[0], 1e-9)
  }

  @Test
  fun `after a reset nothing is chained`() {
    val timeline = WindowTimeline()
    val first = heard(1_000, timeline.latencies(1_000, 0.2, 0, doubleArrayOf(window)))
    timeline.reset()
    val next = heard(1_023, timeline.latencies(1_023, (first[0] + window * 1000 - 2 - 1_023) / 1000, windowUs, doubleArrayOf(window)))
    assertEquals(first[0] + window * 1000 - 2, next[0], 1e-9)
  }

  @Test
  fun `no time is media3's`() {
    assertEquals(C.TIME_UNSET, WindowCutter.NO_TIME)
  }
}
