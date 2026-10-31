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
 * Then the new player is steered, muted, by its measured position: faster when
 * behind, slower when ahead (it waits paused while far ahead), easing off as
 * the gap closes, and takes over already playing once lined up, so how long a
 * device takes to start a player never matters. If either player moves to
 * another connection meanwhile (a dropped one replaced), its timeline no
 * longer maps and the switch takes over unaligned. Pure: the driver reads
 * both players and acts on each [Step]. Specified by
 * `conformance/quality/live-align.json`.
 */
class LiveSwapAligner(private val startedAt: Long) {
  /**
   * A player's reading: playhead and buffered edge, seconds in its own
   * timeline, whether it plays, and which connection the edge belongs to.
   */
  data class Reading(val position: Double, val edge: Double, val playing: Boolean = true, val connection: Int = 0)

  sealed class Step {
    /** The new connection's burst is still arriving: keep it paused. */
    object Measure : Step()

    /** Far ahead: keep it paused until the old one comes close. */
    object Hold : Step()

    /** Play it muted at [rate]: above 1 when behind, below when ahead. */
    data class Steer(val rate: Double) : Step()

    /** Playing and lined up: back to the normal rate, and it takes over. */
    object Play : Step()

    /** No alignment: take over now, as an unaligned switch does. */
    data class Fallback(val reason: String) : Step()
  }

  /** The connections the readings started on. */
  private var oldConnection: Int? = null
  private var newConnection: Int? = null
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
    if (oldConnection.let { it != null && it != old.connection } || newConnection.let { it != null && it != new.connection })
      return Step.Fallback("connection replaced")
    oldConnection = old.connection
    newConnection = new.connection
    val k = shift ?: return measure(now, old, new)
    val behind = old.position + k - new.position
    return when {
      new.playing && abs(behind) <= TOLERANCE_S -> Step.Play
      !new.playing && behind < -STEER_WINDOW_S -> Step.Hold
      else -> Step.Steer((1 + behind / HORIZON_S).coerceIn(MIN_RATE, MAX_RATE))
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
    /** The new connection plays (muted) at 1 + behind / this: it would close the gap in this long, seconds. */
    const val HORIZON_S = 1.0
    /** The rates it is steered within (Media3's Sonic handles these cleanly). */
    const val MIN_RATE = 0.5
    const val MAX_RATE = 4.0
    /** Ahead by more than this it waits paused: at [MIN_RATE] the old one gains on it slowly. */
    const val STEER_WINDOW_S = 2.0
    /** Lined up within this, seconds. */
    const val TOLERANCE_S = 0.05
    /** Past this, the switch takes over unaligned (below RecoveryPolicy.SWAP_ALIGN_MS). */
    const val BUDGET_MS = 25_000L
    /** The burst is in once the new edge has not risen by more than [RAISE_S] over the time for [QUIET_MS], a later step confirmed it... */
    const val RAISE_S = 0.5
    const val QUIET_MS = 2_500L
    /** ...and at least this long after the new file is ready. */
    const val MIN_MEASURE_MS = 1_000L
  }
}
