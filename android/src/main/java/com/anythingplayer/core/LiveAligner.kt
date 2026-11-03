package com.anythingplayer.core

import kotlin.math.abs
import kotlin.math.floor

/**
 * A live quality switch's audio, lined up with what is heard.
 *
 * Separate Icecast mounts of one station, loaded as renditions, are separate
 * connections, and each starts with the server's burst of recent audio. The
 * burst is a byte count, so how far behind live a connection starts depends
 * on its bitrate (64 KiB is 1.6 s at 320 kbps, 8 s at 64 kbps): taking over on
 * the new connection's first audio repeats or skips the difference.
 *
 * Once a connection's burst has arrived, its buffered edge is the live edge,
 * so the two timelines map onto each other by `k = edge(new) − edge(old)`. An
 * edge moves in steps, as chunks arrive (each connection on its own beat,
 * ExoPlayer's a second apart at 64 kbps), and never past live: a connection's
 * freshest reading over a window, the most of `edge − time`, is its live edge.
 * While a burst arrives that rises fast; once two windows in a row agree on
 * both connections, the burst is in and the newer gives `k`. The
 * aligner then drives the new, muted player until it plays what the old one
 * plays: held paused while it is ahead, run faster while it is behind (or
 * moved forward, where the platform can), and gently slower or faster for
 * the last tenths. It says when to take over and when to give up and switch
 * as before (a `discontinuity` for the app).
 *
 * Pure: the platform's `SwapDriver` feeds it readings every [TICK_MS] and
 * applies what it answers. Twin of `src/web/engine/LiveAligner.ts` and
 * `ios/Core/LiveAligner.swift`, against `conformance/align/live.json`.
 */
class LiveAligner(private val caps: Caps) {
  /** One player's reading, on its own timeline (seconds). */
  data class Reading(
    val position: Double,
    /** Where the audio received so far ends; `null` when unknown. */
    val edge: Double?,
    /** The playhead moves. */
    val playing: Boolean,
    /** A dropped connection is being replaced: the edge says nothing about live. */
    val reconnecting: Boolean = false,
    /** It can start: one not ready yet is held, whatever the gap. */
    val ready: Boolean = true,
    /** When the edge's audio arrived (ms, `t`'s clock), where the player knows: the reading's time otherwise. */
    val edgeAt: Long? = null,
  )

  /** Whether (and when) the new player can be moved forward within what it received. */
  enum class Jump {
    /** A seek, any time it is held. */
    ALWAYS,

    /** Only at the first decision, before it plays anything. */
    FIRST,
    NEVER,
  }

  /** What the new player can do while it is muted. */
  data class Caps(
    /** The fastest it may run (1: it cannot catch up by speed). */
    val maxRate: Double,
    /** The slowest it may run (1: it cannot). */
    val minRate: Double,
    val jump: Jump,
    /** How far ahead a held player starts, seconds: its start-up delay, learned again after every start. */
    val startLead: Double,
    /** A moved player lands this much further ahead than its start lead, then is held (its time to be ready). */
    val jumpLead: Double,
  )

  sealed class Action {
    object Wait : Action()

    /** Run the new player at this rate (× the app's); 0 holds it paused. [afterMs]: start it this much later (a hold that ends between ticks). */
    data class Rate(val rate: Double, val afterMs: Long = 0) : Action()

    /** Move the new player to this position (held). */
    data class JumpTo(val to: Double) : Action()

    /** Aligned: make the new player the one heard. `residual`: new − old, seconds. */
    data class TakeOver(val residual: Double) : Action()

    /** Switch as before (on the new player's first audio) and report a discontinuity. */
    data class Fallback(val reason: String) : Action()
  }

  /** Both edges at `t`, and when each one's audio arrived. */
  private class EdgeSample(val t: Long, val next: Double, val old: Double, val nextAt: Long, val oldAt: Long)

  private var startedAt: Long? = null
  private var samples = mutableListOf<EdgeSample>()
  private var k: Double? = null
  private var decided = false
  private var done = false
  private var commanded = 0.0
  private var runningSince: Long? = null
  private var steadySince: Long? = null
  private var fineSince: Long? = null
  private var startGap: Double? = null
  private var lead = caps.startLead

  /** Where it was when it was told to start: it has started once it moved. */
  private var startPosition = 0.0

  /** `k`, once measured: new position = old position + k. */
  val offset: Double?
    get() = k

  /** The last gap read (new − old, seconds): what a switch now would skip (+) or repeat (−). */
  var gap: Double? = null
    private set

  /** Whether it answered take over or fall back. */
  val finished: Boolean
    get() = done

  /** A connection jumped (either player): the mapping no longer holds. */
  fun interrupt(): Action = fallback("discontinuity")

  /** One tick: both readings at monotonic time [t] (ms). */
  fun step(t: Long, old: Reading, next: Reading): Action {
    if (done) return Action.Wait
    val started = startedAt ?: t.also { startedAt = it }
    val elapsed = t - started
    if (old.reconnecting || next.reconnecting) return fallback("reconnecting")
    if (!old.playing) return fallback("stalled")
    if (k == null) {
      if (elapsed >= SETTLE_BUDGET_MS) return fallback("unsettled")
      measure(t, old, next)
      if (k == null) return Action.Wait
    }
    if (elapsed >= BUDGET_MS) return fallback("timeout")
    return align(t, elapsed, old, next)
  }

  // ── The mapping ──

  private fun measure(t: Long, old: Reading, next: Reading) {
    val oldEdge = old.edge ?: return
    val nextEdge = next.edge ?: return
    samples.add(EdgeSample(t, nextEdge, oldEdge, next.edgeAt ?: t, old.edgeAt ?: t))
    // Keep two windows, and one sample at or before their start.
    val span = 2 * SETTLE_WINDOW_MS
    while (samples.size > 1 && samples[1].t <= t - span) samples.removeAt(0)
    if (t - samples[0].t < span) return
    val middle = t - SETTLE_WINDOW_MS
    val earlier = samples.filter { it.t < middle }
    val later = samples.filter { it.t >= middle }
    fun drift(nextEdge: Boolean) = abs(freshest(later, nextEdge) - freshest(earlier, nextEdge))
    fun grew(edge: (EdgeSample) -> Double) = edge(later.last()) - edge(later.first()) >= GROWTH * SETTLE_WINDOW_MS / 1000
    // Still arriving, or not growing: the windows slide on.
    if (drift(nextEdge = true) > DRIFT_S || drift(nextEdge = false) > DRIFT_S) return
    if (!grew { it.next } || !grew { it.old }) return
    k = freshest(later, nextEdge = true) - freshest(later, nextEdge = false)
    samples = mutableListOf()
  }

  // ── Driving the new player ──

  private fun align(t: Long, elapsed: Long, old: Reading, next: Reading): Action {
    val target = old.position + k!!
    val gap = next.position - target
    this.gap = gap
    val first = !decided
    decided = true
    if (commanded == 0.0) return fromHold(t, elapsed, target, gap, first, next)
    return running(t, gap, next)
  }

  /** Running: started, faster or slower, until close enough. */
  private fun running(t: Long, gap: Double, next: Reading): Action {
    if (!next.playing) {
      // Starting, or out of audio.
      steadySince = null
      if (t - runningSince!! >= START_BUDGET_MS) return fallback("starting")
      return Action.Wait
    }
    val started = startGap
    if (started != null && next.position != startPosition) {
      // It started from a hold at `startGap` and moves at `gap`: its start-up delay.
      lead = (started - gap).coerceIn(0.0, 1.0)
      startGap = null
    }
    // Close for a while without settling (readings too coarse for the tolerance): close enough.
    val close = abs(gap) <= ACCEPT_S
    if (close && fineSince == null) fineSince = t
    val late = fineSince?.let { t - it >= FINE_BUDGET_MS } ?: false
    if (close && late) return takeOver(gap)
    val desired = desiredRate(gap)
    if (desired != commanded) return setRate(t, desired, gap, next)
    if (commanded != 1.0) return Action.Wait
    return steady(t, gap, close)
  }

  /** At rate 1: trusted once steady, then aligned, or as close as it gets. */
  private fun steady(t: Long, gap: Double, close: Boolean): Action {
    val since = steadySince ?: t.also { steadySince = it }
    if (t - since < STEADY_MS) return Action.Wait
    if (abs(gap) <= TOLERANCE_S) return takeOver(gap)
    val canFix = if (gap < 0) caps.maxRate > 1 else caps.minRate < 1
    if (close && !canFix) return takeOver(gap)
    if (gap < -ACCEPT_S && !canFix) return fallback("behind")
    return Action.Wait
  }

  /** Held: moved, held on, started, or run faster. */
  private fun fromHold(t: Long, elapsed: Long, target: Double, gap: Double, first: Boolean, next: Reading): Action {
    val canJump = caps.jump == Jump.ALWAYS || (caps.jump == Jump.FIRST && first)
    // At first anything short of the lead is moved (the start is then always
    // from a hold); later only a player that fell behind.
    val short = if (first) gap < lead else gap < -TOLERANCE_S
    if (short && canJump) {
      // Moved just ahead, then held: it never starts behind.
      val to = target + lead + caps.jumpLead
      return Action.JumpTo(next.edge?.let { minOf(to, it) } ?: to)
    }
    if (gap > lead || !next.ready) return holding(t, elapsed, gap, first, next)
    if (gap < -TOLERANCE_S && caps.maxRate > 1) return setRate(t, speedUp(gap), gap, next)
    if (gap < -ACCEPT_S) return fallback("behind")
    return setRate(t, 1.0, gap, next)
  }

  /** Ahead (or not ready): held until the old one gets there, if it gets there in time. */
  private fun holding(t: Long, elapsed: Long, gap: Double, first: Boolean, next: Reading): Action {
    val due = (gap - lead) * 1000
    if (first && due > BUDGET_MS - elapsed) return fallback("ahead")
    // Due before the next tick: started then, on a timer of its own.
    if (next.ready && due < TICK_MS) return setRate(t, 1.0, lead, next, floor(due).toLong())
    return Action.Wait
  }

  /** While it runs: faster when behind, held again when well ahead, slower when a little. */
  private fun desiredRate(gap: Double): Double =
    when {
      gap < -TOLERANCE_S -> if (caps.maxRate > 1) speedUp(gap) else 1.0
      gap > ACCEPT_S -> 0.0
      gap > TOLERANCE_S -> if (caps.minRate < 1) slowDown(gap) else 1.0
      else -> 1.0
    }

  private fun speedUp(gap: Double): Double = minOf(caps.maxRate, maxOf(1 + RATE_STEP, quantize(1 - gap / HORIZON_S)))

  private fun slowDown(gap: Double): Double = maxOf(caps.minRate, minOf(1 - RATE_STEP, quantize(1 - gap / HORIZON_S)))

  private fun setRate(t: Long, rate: Double, gap: Double, next: Reading, afterMs: Long = 0): Action {
    val from = commanded
    commanded = rate
    steadySince = null
    startGap = if (from == 0.0 && rate == 1.0) gap else null
    startPosition = next.position
    if (rate == 0.0) runningSince = null else if (from == 0.0) runningSince = t + afterMs
    return Action.Rate(rate, afterMs)
  }

  private fun takeOver(residual: Double): Action {
    done = true
    return Action.TakeOver(residual)
  }

  private fun fallback(reason: String): Action {
    done = true
    return Action.Fallback(reason)
  }

  companion object {
    /** How often the drivers read both players. */
    const val TICK_MS = 40L

    /** Each connection's freshest edge, against the clock, over two windows this long… */
    const val SETTLE_WINDOW_MS = 1_500L

    /** …moved less than this, and both edges grew by [GROWTH] × the window in the newer one: the burst is in. */
    const val DRIFT_S = 0.1
    const val GROWTH = 0.5

    /** No settled burst by then: switch as before. */
    const val SETTLE_BUDGET_MS = 8_000L

    /** Not aligned by then (from the first reading): switch as before. */
    const val BUDGET_MS = 30_000L

    /** Aligned: take over. */
    const val TOLERANCE_S = 0.05

    /** Close enough when the player cannot do better, or did not within [FINE_BUDGET_MS] of first getting this close. */
    const val ACCEPT_S = 0.3
    const val FINE_BUDGET_MS = 3_000L

    /** The rate closes the gap over about this long (1 + gap / horizon). */
    const val HORIZON_S = 1.0
    const val RATE_STEP = 0.05

    /** At rate 1 this long before its readings are trusted for a takeover. */
    const val STEADY_MS = 300L

    /** Told to run but not moving for this long: it stalled. */
    const val START_BUDGET_MS = 3_000L

    /** Rates move in [RATE_STEP]s: no stream of tiny changes. */
    private fun quantize(rate: Double): Double = floor(rate / RATE_STEP + 0.5) * RATE_STEP

    /** A connection's live edge, against the clock: its freshest reading of `edge − time`. */
    private fun freshest(samples: List<EdgeSample>, nextEdge: Boolean): Double {
      var best = Double.NEGATIVE_INFINITY
      for (s in samples) {
        val at = if (nextEdge) s.nextAt else s.oldAt
        best = maxOf(best, (if (nextEdge) s.next else s.old) - at / 1000.0)
      }
      return best
    }
  }
}
