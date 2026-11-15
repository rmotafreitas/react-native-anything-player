package com.anythingplayer.core

import kotlin.math.abs

/**
 * When each emitted window is heard, as `timestamp + outputLatency`, laid end
 * to end.
 *
 * Windows go out in batches (two per HE-AAC buffer, more after the decoder
 * fills the output). The sink is read once per batch: the first window is
 * timed against it, and every later one exactly its own length after the one
 * before. Read per window, the clock's millisecond and the position's
 * rounding (or a latency estimate that ignores the start) would overlap them,
 * and whoever joins windows in time (boundary detection) drops an overlap. A
 * batch that continues the last one's audio, read within [toleranceMs] of
 * where it ended, starts there too, eased a little toward its own reading:
 * the sink's position runs on the audio hardware's clock, `timestamp` on the
 * system's, and chained on window lengths alone the two would drift apart
 * until a reading snapped back by the whole tolerance. Eased, a seam moves by
 * at most `easing × toleranceMs` (0.25 ms), inside the 0.5 ms a boundary
 * finder (`src/core/boundaries.ts`) joins as one: raise either only with it.
 * A real jump keeps its own reading.
 *
 * The windows of a batch share its `timestamp`; the later ones are heard
 * later by a larger latency. Lengths are media time: at a playback speed
 * other than 1 they are not heard end to end.
 */
class WindowTimeline(private val toleranceMs: Double = 5.0, private val easing: Double = 0.05) {
  /** Where the last window ends: its presentation time (µs) and when it is heard (epoch ms). */
  private var lastEndUs = WindowCutter.NO_TIME
  private var lastEndHeardMs = 0.0

  /** A flush, a new format, sampling turned back on: what comes next continues nothing. */
  fun reset() {
    lastEndUs = WindowCutter.NO_TIME
  }

  /**
   * The output latency (s) of each of a batch's consecutive windows, read at
   * [timestampMs] as [readLatency] for the first, which starts at [startUs]
   * ([WindowCutter.NO_TIME] when unknown) and lasts [durations] (s) each.
   */
  fun latencies(timestampMs: Long, readLatency: Double, startUs: Long, durations: DoubleArray): DoubleArray {
    var latency = readLatency
    if (startUs != WindowCutter.NO_TIME && lastEndUs != WindowCutter.NO_TIME && abs(startUs - lastEndUs) <= 1_000) {
      val heardMs = timestampMs + latency * 1000
      if (abs(heardMs - lastEndHeardMs) <= toleranceMs) {
        val chained = (lastEndHeardMs - timestampMs) / 1000
        latency = (chained + easing * (latency - chained)).coerceAtLeast(0.0)
      }
    }
    val out = DoubleArray(durations.size)
    for (i in durations.indices) {
      out[i] = latency
      latency += durations[i]
    }
    val totalUs = Math.round(durations.sum() * 1_000_000)
    lastEndUs = if (startUs == WindowCutter.NO_TIME) WindowCutter.NO_TIME else startUs + totalUs
    lastEndHeardMs = timestampMs + latency * 1000
    return out
  }
}
