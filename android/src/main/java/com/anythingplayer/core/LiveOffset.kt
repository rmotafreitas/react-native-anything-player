package com.anythingplayer.core

/**
 * How far what is heard trails a live source's live point (`liveOffset`).
 *
 * A progressive stream (ICY/Icecast, plain HTTP, a remuxed MPEG-TS channel)
 * has no clock of its own: what it has received is the live point, as it
 * arrives. Its buffered edge moves in steps, one per chunk, and never past
 * live, so the freshest reading of `edge − time` over a window (60 s) is the
 * live point against the device's clock; the offset is then that point now
 * minus the playhead. It does not saw-tooth between chunks, it grows while
 * paused or stalled, and it keeps going across a lined-up quality switch
 * (positions are continuous). It starts again on a new connection: a
 * `discontinuity`, or a playhead that went back.
 *
 * A source with a clock (HLS program dates, a DASH or ExoPlayer live window)
 * is the player's own reading, passed through. Settled: the reading has not
 * risen for [SETTLE_MS] (the connect burst has arrived) and has been read that
 * long. Twin of `src/web/engine/LiveOffset.ts` and `ios/Core/LiveOffset.swift`,
 * against `conformance/align/offset.json`.
 */
class LiveOffset {
  /** One reading of the player, on its reported timeline (seconds). */
  data class Reading(
    val position: Double,
    /** Where the audio received so far ends (a progressive live stream); `null` otherwise. */
    val edge: Double?,
    /** The platform's own offset behind live (program dates, a live window); `null` when it has none. */
    val native: Double?,
    val live: Boolean,
  )

  data class Value(val offset: Double?, val settled: Boolean)

  private class Lead(val t: Long, val lead: Double)

  private val leads = ArrayDeque<Lead>()
  private var since: Long? = null
  private var risenAt = 0L
  private var anchor: Double? = null
  private var native: Double? = null
  private var lastPosition: Double? = null

  /** A new connection (a `discontinuity`, a new load): measure again. */
  fun reset() {
    leads.clear()
    since = null
    anchor = null
    native = null
    lastPosition = null
  }

  /** The offset at monotonic time [t] (ms). */
  fun read(t: Long, r: Reading): Value {
    if (!r.live) {
      reset()
      return Value(null, false)
    }
    lastPosition?.let { if (r.position < it - BACK_S) reset() }
    lastPosition = r.position
    r.native?.let { return fromNative(t, it) }
    val edge = r.edge ?: return Value(null, false)
    if (since == null) since = t
    val lead = edge - t / 1000.0
    while (leads.isNotEmpty() && leads.last().lead <= lead) leads.removeLast()
    leads.addLast(Lead(t, lead))
    while (leads.first().t < t - WINDOW_MS) leads.removeFirst()
    val next = leads.first().lead
    val previous = anchor
    if (previous == null || next > previous + RISE_S) risenAt = t
    anchor = next
    return Value(maxOf(0.0, t / 1000.0 + next - r.position), settled(t))
  }

  private fun fromNative(t: Long, value: Double): Value {
    if (since == null) since = t
    val previous = native
    if (previous == null || kotlin.math.abs(value - previous) > NATIVE_STEP_S) risenAt = t
    native = value
    return Value(maxOf(0.0, value), settled(t))
  }

  private fun settled(t: Long): Boolean = t - since!! >= SETTLE_MS && t - risenAt >= SETTLE_MS

  companion object {
    /** The live point is the freshest `edge − time` this long back. */
    const val WINDOW_MS = 60_000L

    /** Settled once the reading has not risen for this long (and was read this long). */
    const val SETTLE_MS = 3_000L

    /** A rise smaller than this is a chunk's jitter, not the burst still arriving. */
    const val RISE_S = 0.1

    /** A playhead this far back is a new connection: start again. */
    const val BACK_S = 1.0

    /** A platform reading that moves more than this has not settled. */
    const val NATIVE_STEP_S = 0.25
  }
}
