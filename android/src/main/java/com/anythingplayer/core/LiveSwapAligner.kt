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
 * the gap closes, and takes over already playing once lined up. A new rate
 * reaches what is heard only after the audio a device has already buffered
 * (and a paused player only once it starts): each rate is kept until the
 * player is seen moving at it. The first change made while it plays measures
 * how long this device takes to apply a rate; from then on each rate is
 * planned from the gap as it will be when that rate is heard (the rates
 * already asked play out first), and it takes over once only the old
 * player's rate is heard or on its way, so the steering does not overshoot,
 * whatever the device. If either player moves to
 * another connection meanwhile (a dropped one replaced), its timeline no
 * longer maps (or one is queued: its connection has ended) and the switch
 * takes over unaligned. Pure: the driver reads
 * both players and acts on each [Step]. Specified by
 * `conformance/quality/live-align.json`.
 */
class LiveSwapAligner(private val startedAt: Long) {
  /**
   * A player's reading: playhead and buffered edge, seconds in its own
   * timeline; whether it plays, and at what rate; which connection the
   * timeline belongs to, and whether a replacement is already queued behind it.
   */
  data class Reading(
    val position: Double,
    val edge: Double,
    val playing: Boolean = true,
    val connection: Int = 0,
    val rate: Double = 1.0,
    val continuing: Boolean = false,
  )

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
  /** Rates asked for while it plays (time, rate), oldest first: what is still on its way to the output. */
  private val asked = ArrayList<Pair<Long, Double>>()
  /** A change asked while playing, not yet heard: it measures the device's delay (time, from, to). */
  private var probe: Triple<Long, Double, Double>? = null
  /** How long a rate takes to be heard on this device, ms, once measured. */
  private var delayMs: Long? = null
  /** The new player's recent positions while it plays, for its observed speed. */
  private val trail = ArrayDeque<Pair<Long, Double>>()

  fun step(now: Long, old: Reading, new: Reading): Step {
    if (!old.playing) return Step.Fallback("old player not playing")
    if (now - startedAt >= BUDGET_MS) return Step.Fallback("budget")
    // Before the shift is known, a queued replacement leaves no timeline to measure.
    if (shift == null && (old.continuing || new.continuing)) return Step.Fallback("connection ending")
    if (oldConnection.let { it != null && it != old.connection } || newConnection.let { it != null && it != new.connection })
      return Step.Fallback("connection replaced")
    oldConnection = old.connection
    newConnection = new.connection
    val k = shift ?: return measure(now, old, new)
    val behind = old.position + k - new.position
    if (!new.playing && behind < -STEER_WINDOW_S * old.rate) {
      asked.clear()
      return Step.Hold
    }
    return steer(now, old, new, behind)
  }

  /** Steers by the new player's observed response (see the class comment). */
  private fun steer(now: Long, old: Reading, new: Reading, behind: Double): Step {
    val clamp = { r: Double -> r.coerceIn(old.rate * MIN_RATE, old.rate * MAX_RATE) }
    if (!new.playing) {
      // Starting it: its first rate is kept until it is seen moving at it.
      trail.clear()
      probe = null
      val rate = asked.lastOrNull()?.second ?: clamp(old.rate + behind / HORIZON_S)
      asked.clear()
      asked.add(now to rate)
      return Step.Steer(rate)
    }
    if (asked.isEmpty()) asked.add(now to old.rate)
    trail.addLast(now to new.position)
    while (trail.size > 2 && now - trail.elementAt(1).first >= SPEED_WINDOW_MS) trail.removeFirst()
    val speed = trail.firstOrNull()?.takeIf { now - it.first >= SPEED_WINDOW_MS }?.let {
      (new.position - it.second) / ((now - it.first) / 1000.0)
    }
    val last = asked.last().second
    probe?.let { (at, from, to) ->
      // Heard once the windowed speed covered most of the step; the window lags it by that much of itself.
      if (speed != null && abs(speed - to) <= SEEN_FRACTION * abs(to - from)) {
        delayMs = maxOf(0L, now - at - ((1 - SEEN_FRACTION) * SPEED_WINDOW_MS).toLong())
        probe = null
      }
    }
    val d =
      delayMs
        ?: run {
          // The delay is unknown until a change is heard: once the start rate
          // is, measure it with one clear change, toward where the gap needs it.
          val step = PROBE_STEP * old.rate
          // Settled at the start rate (within a quarter of the probe's step), so the probe is the only change in sight.
          if (probe != null || speed == null || abs(speed - last) > SEEN_FRACTION * step) return Step.Steer(last)
          // A full step from the start rate (toward the old one, else toward the
          // gap; the other way if the limits leave no room), so it stands out.
          val direction =
            when {
              last - old.rate >= step -> -1
              old.rate - last >= step -> 1
              behind >= 0 -> 1
              else -> -1
            }
          val to = clamp(last + direction * step).takeIf { abs(it - last) >= step - EPSILON } ?: clamp(last - direction * step)
          asked.add(now to to)
          probe = Triple(now, last, to)
          return Step.Steer(to)
        }
    // Lined up, with only the old rate on its way and seen heard (closer to it
    // than to a step off, so a device's noisy position reads do not matter): it takes over.
    val heard = asked.lastOrNull { it.first <= now - d }?.second
    if (
      abs(behind) <= TOLERANCE_S &&
      heard == old.rate &&
      asked.all { it.first <= now - d || it.second == old.rate } &&
      speed != null &&
      abs(speed - old.rate) <= RATE_STEP * old.rate / 2
    )
      return Step.Play
    val gap = behind - onTheWay(now, d, old.rate)
    val target =
      if (abs(gap) <= TOLERANCE_S) {
        old.rate
      } else {
        // At least RATE_STEP faster or slower, so each change is observable.
        val push = maxOf(abs(gap) / HORIZON_S, RATE_STEP * old.rate)
        clamp(old.rate + if (gap > 0) push else -push)
      }
    if (abs(target - last) >= RATE_STEP * old.rate - EPSILON || (target == old.rate && last != old.rate)) {
      asked.add(now to target)
      return Step.Steer(target)
    }
    return Step.Steer(last)
  }

  /**
   * How much more the new player gains on the old one before a rate asked now
   * is heard: the rates already asked play out over the next [delayMs].
   */
  private fun onTheWay(now: Long, delayMs: Long, oldRate: Double): Double {
    if (delayMs <= 0) return 0.0
    var gained = 0.0
    var t = now
    val end = now + delayMs
    while (t < end) {
      // Heard at t: the last rate asked by t - delay.
      val heard = asked.lastOrNull { it.first <= t - delayMs }?.second ?: asked.first().second
      val next = asked.firstOrNull { it.first + delayMs > t }?.first?.plus(delayMs) ?: end
      val until = minOf(end, maxOf(next, t + 1))
      gained += (heard - oldRate) * (until - t) / 1000.0
      t = until
    }
    return gained
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
    /** The new connection closes the gap (as it will be when a rate is heard) over this long, seconds. */
    const val HORIZON_S = 1.0
    /** Its speed is read over this window... */
    const val SPEED_WINDOW_MS = 300L
    /** ...and a rate counts as heard once the speed covered all but this fraction of the step. */
    const val SEEN_FRACTION = 0.25
    /** Rates differ by at least this (as factors of 1x), so a change stands out of the speed's noise. */
    const val RATE_STEP = 0.1
    /** The change that measures a device's delay (as a factor of 1x): plain to see. */
    const val PROBE_STEP = 0.5
    private const val EPSILON = 1e-9
    /** The rates it is steered within, as factors of the old one's (Media3's Sonic handles these cleanly). */
    const val MIN_RATE = 0.5
    const val MAX_RATE = 4.0
    /**
     * Ahead by more than this much of the old player's playing (seconds at its
     * rate) it waits paused: paused, the old one gains on it fastest.
     */
    const val STEER_WINDOW_S = 1.0
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
