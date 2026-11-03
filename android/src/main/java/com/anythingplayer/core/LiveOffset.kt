package com.anythingplayer.core

/**
 * How far what is heard trails a live source's live point (`liveOffset`).
 *
 * A progressive stream (ICY/Icecast, plain HTTP, a remuxed MPEG-TS channel)
 * has no clock of its own: what it has received is the live point, as it
 * arrives. Its buffered edge moves in steps, one per chunk, and never past
 * live, so the freshest `edge − time` at an arrival is the live point against
 * the device's clock; the offset is then that point now minus the playhead.
 * The freshest is kept over the last 60 s of audio received, not of time: a
 * full buffer (a long pause) or a stall freezes the edge, and nothing then
 * says the live point moved, so it is kept, however long, and however seldom
 * the player is read. It does not saw-tooth between chunks, it grows while
 * paused or stalled, and it keeps going across a lined-up quality switch
 * (positions are continuous). It starts again on a new connection: a
 * `discontinuity`, or a playhead that went back.
 *
 * A source with a clock (HLS program dates, a DASH or ExoPlayer live window)
 * is the player's own reading, passed through. Settled: the live point has
 * not risen for [SETTLE_MS] (the connect burst has arrived) and has been read
 * that long. For a reading with a clock that point is `playhead + offset −
 * time`, the playhead on the stream's clock (`programDate`) when it has one:
 * it holds still while paused, at any rate, and as a live window slides. Twin of `src/web/engine/LiveOffset.ts` and `ios/Core/LiveOffset.swift`,
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
    /** Epoch ms the stream's own clock gives the playhead (program dates); `null` without one. */
    val programDate: Long? = null,
  )

  data class Value(val offset: Double?, val settled: Boolean)

  /** An arrival: the edge it brought, and its `edge − time`. */
  private class Lead(val edge: Double, val lead: Double)

  /** The window's arrivals, leads decreasing (a monotonic queue: the front is the freshest). */
  private val leads = ArrayDeque<Lead>()
  private var lastEdge: Double? = null
  private var since: Long? = null
  private var risenAt = 0L
  private var anchor: Double? = null
  /** A reading with a clock: the live point it gives (`position + offset − time`). */
  private var native: Double? = null
  private var lastPosition: Double? = null

  /** A new connection (a `discontinuity`, a new load): measure again. */
  fun reset() {
    leads.clear()
    lastEdge = null
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
    // A reading with a clock is the player's own: its position can go back
    // as a live window slides (ExoPlayer), and a new connection is a
    // `discontinuity` there. Its playhead on the stream's clock does not move back.
    r.native?.let { return fromNative(t, it, r.programDate?.let { d -> d / 1000.0 } ?: r.position) }
    lastPosition?.let { if (r.position < it - BACK_S) reset() }
    lastPosition = r.position
    val edge = r.edge ?: return Value(null, false)
    if (since == null) since = t
    if (lastEdge.let { it == null || edge > it }) arrived(t, edge)
    val next = leads.first().lead
    val previous = anchor
    if (previous == null || next > previous + RISE_S) risenAt = t
    anchor = next
    return Value(maxOf(0.0, t / 1000.0 + next - r.position), settled(t))
  }

  /** New audio arrived (the edge moved on): a lead, and the window slides by it. */
  private fun arrived(t: Long, edge: Double) {
    lastEdge = edge
    val lead = edge - t / 1000.0
    while (leads.isNotEmpty() && leads.last().lead <= lead) leads.removeLast()
    leads.addLast(Lead(edge, lead))
    while (leads.first().edge < edge - WINDOW_S) leads.removeFirst()
  }

  /** [at]: the playhead, on the stream's clock when it has one. */
  private fun fromNative(t: Long, value: Double, at: Double): Value {
    if (since == null) since = t
    val point = at + value - t / 1000.0
    val previous = native
    if (previous == null || kotlin.math.abs(point - previous) > NATIVE_STEP_S) risenAt = t
    native = point
    return Value(maxOf(0.0, value), settled(t))
  }

  private fun settled(t: Long): Boolean = t - since!! >= SETTLE_MS && t - risenAt >= SETTLE_MS

  companion object {
    /** The live point is the freshest `edge − time` over this much audio received (seconds). */
    const val WINDOW_S = 60.0

    /** Settled once the reading has not risen for this long (and was read this long). */
    const val SETTLE_MS = 3_000L

    /** A rise smaller than this is a chunk's jitter, not the burst still arriving. */
    const val RISE_S = 0.1

    /** A playhead this far back is a new connection: start again. */
    const val BACK_S = 1.0

    /** A platform reading whose live point moves more than this has not settled. */
    const val NATIVE_STEP_S = 0.25
  }
}
