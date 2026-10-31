package com.anythingplayer.core

import kotlin.math.abs

/**
 * Lines a live quality switch's new connection up with what is heard, so the
 * switch neither repeats nor skips audio. Separate live files of one sound
 * (Icecast mounts at different bitrates) start at the oldest audio of their
 * connect burst: a new connection is behind or ahead of the old one by the
 * difference of their bursts (seconds at a low bitrate).
 *
 * Both connections' buffered edges are "now" at the server, so once the new
 * one's burst has arrived, the old position `x` is the new position `x + k`,
 * with `k` the edges' difference. A player reports its edge in steps (a low
 * bitrate's every few seconds), always behind the true one: each edge less
 * the time elapsed peaks right after a step lands, so `k` is the difference of
 * those peaks. The burst is in once the new one's edge has not risen notably
 * for a while and a later step confirmed its peak (and the old one stepped too).
 * Behind, the new player catches up (muted, faster the further behind, up to
 * [MAX_CATCH_UP_RATE]: it slows as it closes in, so it never overshoots); ahead, it
 * holds (paused) until the old one gets there; then it takes over. Pure: the
 * driver reads both players and acts on each [Step]. Specified by
 * `conformance/quality/live-align.json`.
 */
class LiveSwapAligner(private val startedAt: Long) {
  /** A player's reading: playhead and buffered edge, seconds in its own timeline. */
  data class Reading(val position: Double, val edge: Double, val playing: Boolean = true)

  sealed class Step {
    /** The new connection's burst is still arriving: keep it paused. */
    object Measure : Step()

    /** Behind: play it muted at [rate]. */
    data class CatchUp(val rate: Double) : Step()

    /** Ahead: keep it paused until the old one gets there. */
    object Hold : Step()

    /** Lined up: play it at the normal rate and let it take over. */
    object Play : Step()

    /** No alignment: take over now, as an unaligned switch does. */
    data class Fallback(val reason: String) : Step()
  }

  /** Each player's highest edge less the time elapsed (see the class comment). */
  private var newTop: Double? = null
  private var oldTop: Double? = null
  /** The new edge's last notable rise (more than [RAISE_S] above the one before), and when. */
  private var riseBase: Double? = null
  private var raisedAt = startedAt
  /** Steps the new edge took since its last notable rise, and the old edge's steps. */
  private var newStepsSinceRise = 0
  private var oldSteps = 0
  private var lastNewEdge: Double? = null
  private var lastOldEdge: Double? = null
  /** New position = old position + [shift], once measured. */
  var shift: Double? = null
    private set

  fun step(now: Long, old: Reading, new: Reading): Step {
    if (!old.playing) return Step.Fallback("old player not playing")
    if (now - startedAt >= BUDGET_MS) return Step.Fallback("budget")
    val k = shift ?: return measure(now, old, new)
    val behind = old.position + k - new.position
    return when {
      abs(behind) <= TOLERANCE_S -> Step.Play
      behind > 0 -> Step.CatchUp((1 + behind / CATCH_UP_HORIZON_S).coerceIn(MIN_CATCH_UP_RATE, MAX_CATCH_UP_RATE))
      else -> Step.Hold
    }
  }

  private fun measure(now: Long, old: Reading, new: Reading): Step {
    val elapsed = (now - startedAt) / 1000.0
    val n = new.edge - elapsed
    val o = old.edge - elapsed
    val base = riseBase
    if (base == null || n > base + RAISE_S) {
      riseBase = n
      raisedAt = now
      newStepsSinceRise = 0
    } else if (lastNewEdge.let { it != null && new.edge > it }) {
      newStepsSinceRise++
    }
    if (lastOldEdge.let { it != null && old.edge > it }) oldSteps++
    lastNewEdge = new.edge
    lastOldEdge = old.edge
    newTop = maxOf(newTop ?: n, n)
    oldTop = maxOf(oldTop ?: o, o)
    val settled =
      now - startedAt >= MIN_MEASURE_MS && now - raisedAt >= QUIET_MS && newStepsSinceRise >= 1 && oldSteps >= 1
    if (!settled) return Step.Measure
    shift = newTop!! - oldTop!!
    return step(now, old, new)
  }

  companion object {
    /** A behind connection plays (muted) at 1 + behind / this: it would close the gap in this long, seconds. */
    const val CATCH_UP_HORIZON_S = 1.0
    const val MIN_CATCH_UP_RATE = 1.05
    const val MAX_CATCH_UP_RATE = 4.0
    /** Lined up within this, seconds. */
    const val TOLERANCE_S = 0.05
    /** Past this, the switch takes over unaligned (below RecoveryPolicy.SWAP_ALIGN_MS). */
    const val BUDGET_MS = 20_000L
    /** The burst is in once the new edge has not risen by more than [RAISE_S] over the time for [QUIET_MS], a later step confirmed it... */
    const val RAISE_S = 0.5
    const val QUIET_MS = 2_500L
    /** ...and at least this long after the new file is ready. */
    const val MIN_MEASURE_MS = 1_000L
  }
}
