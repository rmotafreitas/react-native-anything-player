package com.radioanimu.airwave.core

import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToLong

/**
 * Every recovery constant, in one place. Swift twin: `ios/Core/RecoveryPolicy.swift`;
 * `docs/recovery.md` documents the production failure each one exists for.
 * Only the fields in [EngineOptions] are app-configurable.
 */
object RecoveryPolicy {
  /** Engine heartbeat while playback is wanted (drives the watchdogs). */
  const val HEARTBEAT_MS = 1_000L

  /** A native stall shorter than this is not published (no spinner flicker, no event spam). */
  const val STALL_DEBOUNCE_MS = 500L

  /** One open attempt (open → ready) may take this long before it times out. */
  const val OPEN_TIMEOUT_MS = 12_000L

  /** An open younger than this is not re-issued by another trigger. */
  const val OPEN_GRACE_MS = 4_000L

  /** "Playing" with a playhead that has not advanced for this long is a stall. */
  const val SILENT_STALL_MS = 4_000L
  const val SUSPECT_SILENT_STALL_MS = 2_000L

  /** A stall with no buffered progress for this long while online: dead socket. */
  const val STALL_DEAD_MS = 3_000L
  const val SUSPECT_STALL_DEAD_MS = 1_500L
  /** A stall that trickles data but never recovers is re-opened after this. */
  const val STALL_MAX_MS = 20_000L

  /** How long after a connectivity edge the link is treated as suspect. */
  const val NETWORK_SUSPECT_MS = 20_000L

  /** Reconnect backoff: base delay, doubled per attempt, capped, ±jitter. */
  const val RECONNECT_BASE_MS = 1_000L
  const val RECONNECT_MAX_MS = 30_000L
  const val RECONNECT_JITTER = 0.2

  /** Every Nth skipped (offline) attempt runs anyway as a probe. */
  const val OFFLINE_PROBE_EVERY = 3

  /** Audio must flow this long before the backoff resets. */
  const val STABLE_PLAYBACK_MS = 10_000L

  /** A paused network live stream's connection is released after this. */
  const val PAUSED_STREAM_RELEASE_MS = 30_000L
}

/** App-configurable recovery knobs (`PlayerOptions` in TS). */
data class EngineOptions(
  /** Reconnect automatically after recoverable failures while playback is wanted. */
  val reconnect: Boolean = true,
  /** Give up recovering after this long without stable playback (`null` = never). */
  val giveUpAfterMs: Long? = 600_000L,
  /** Resume automatically when the OS ends a transient interruption. */
  val autoResumeAfterInterruption: Boolean = true,
  /** Live drift (pauses + stalls since the open) that forces a live-edge re-open. */
  val liveMaxDriftMs: Long = 5_000L,
)

/** Deterministic exponential backoff with injectable jitter. */
class Backoff(private val random: () -> Double = { Math.random() }) {
  var attempts = 0
    private set

  /** Delay for the next attempt; increments the attempt counter. */
  fun next(): Long {
    val exponent = min(attempts, 30)
    val raw =
      min(
        RecoveryPolicy.RECONNECT_BASE_MS * 2.0.pow(exponent),
        RecoveryPolicy.RECONNECT_MAX_MS.toDouble(),
      )
    attempts += 1
    val jitter = (random() * 2 - 1) * RecoveryPolicy.RECONNECT_JITTER
    return max(0L, (raw * (1 + jitter)).roundToLong())
  }

  fun reset() {
    attempts = 0
  }
}
