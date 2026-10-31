package com.anythingplayer.core

import kotlin.math.abs
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Steering against simulated devices: a rate reaches the output only after
 * the audio already buffered (the delay), and a paused player sounds only
 * after its start latency. Whatever the device, a switch must take over lined
 * up, or fall back (reported as a jump), never take over off the point.
 */
class LiveSwapSteeringTest {
  private class Outcome(val step: String, val error: Double, val at: Double)

  /** Ticks every 40 ms: the old player plays at [oldRate]; the new one obeys the aligner through a delay. */
  private fun run(oldRate: Double, behindAtSettle: Double, delayS: Double, latencyS: Double): Outcome {
    val shift = behindAtSettle - 25.0 - 2.5 * oldRate
    val aligner = LiveSwapAligner(startedAt = 0)
    var newPos = 0.0
    var playing = false
    var startsAt = Double.MAX_VALUE
    var appliedRate = oldRate
    val pending = ArrayDeque<Pair<Double, Double>>() // (applies at, rate)
    var t = 0.0
    while (t < 40.0) {
      val oldPos = 25.0 + oldRate * t
      val step =
        aligner.step(
          (t * 1000).toLong(),
          LiveSwapAligner.Reading(oldPos, 30.0 + t, true, 0, oldRate),
          LiveSwapAligner.Reading(newPos, 30.0 + shift + t, playing && t >= startsAt),
        )
      when (step) {
        LiveSwapAligner.Step.Measure, LiveSwapAligner.Step.Hold -> {
          playing = false
          startsAt = Double.MAX_VALUE
        }
        is LiveSwapAligner.Step.Steer -> {
          if (pending.lastOrNull()?.second != step.rate) pending.addLast(t + delayS to step.rate)
          if (!playing) {
            playing = true
            startsAt = t + latencyS
          }
        }
        LiveSwapAligner.Step.Play -> {
          // After takeover the new player plays at the old rate, once its buffered audio (at the last applied rate) has played.
          val drift = (appliedRate - oldRate) * delayS
          return Outcome("play", oldPos + shift - newPos - drift, t)
        }
        is LiveSwapAligner.Step.Fallback -> return Outcome("fallback", Double.NaN, t)
      }
      t += 0.04
      while (pending.isNotEmpty() && pending.first().first <= t) appliedRate = pending.removeFirst().second
      if (playing && t >= startsAt) newPos += appliedRate * 0.04
    }
    return Outcome("timeout", Double.NaN, t)
  }

  @Test
  fun realisticDevicesLineUp() {
    for (oldRate in listOf(1.0, 0.75))
      for (behind in listOf(14.0, 2.7, -1.5, -12.0))
        for (delay in listOf(0.0, 0.25, 0.75, 1.0))
          for (latency in listOf(0.0, 0.3)) {
            val o = run(oldRate, behind, delay, latency)
            val label = "rate=$oldRate behind=$behind delay=$delay latency=$latency"
            assertTrue("$label: ${o.step} at ${o.at}", o.step == "play")
            assertTrue("$label: off by ${o.error}", abs(o.error) <= 0.08)
          }
  }

  @Test
  fun anExtremeDelayLinesUpOrFallsBackNeverOffThePoint() {
    for (behind in listOf(14.0, -12.0)) {
      val o = run(1.0, behind, delayS = 3.0, latencyS = 0.5)
      assertTrue("behind=$behind: ${o.step}", o.step == "fallback" || (o.step == "play" && abs(o.error) <= 0.08))
    }
  }
}
