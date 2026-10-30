package com.anythingplayer.core

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

  /**
   * A stall this close to a file's end (seconds), with the rest buffered, is
   * its end: nothing more will come.
   */
  const val END_SLACK_S = 0.1

  /**
   * A playhead that advances this far (seconds), at about the playback rate,
   * while the platform still says buffering: it is playing.
   */
  const val PLAYHEAD_PROOF_S = 1.5

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

  /** How often a fade (play, pause, stop, `fadeTo`, the sleep timer) updates the volume. */
  const val FADE_TICK_MS = 50L

  // ── Video ──

  /** A player without a view this long stops decoding the picture (a move between views keeps it). */
  const val VIEW_DETACH_GRACE_MS = 1_000L

  /** In the background, Picture in Picture may start (or the app return) this long after the event. */
  const val PIP_GRACE_MS = 1_000L

  /** A quality switch's new file must play within this, or the switch is dropped. */
  const val SWAP_TIMEOUT_MS = 12_000L

  /** A rendition that failed is not picked again for this long. */
  const val FAILED_RENDITION_MS = 60_000L

  /** How long a 401/403 waits for the app's new source before the backoff takes over. */
  const val REFRESH_TIMEOUT_MS = 10_000L

  /** A source with `expiresAt` asks for a new one this long ahead. */
  const val REFRESH_AHEAD_MS = 60_000L

  /** Automatic quality: a rendition fits a bandwidth this many times its bitrate. */
  const val ABR_FIT_RATIO = 0.7

  /** A stall steps down when the bandwidth is under this × the current bitrate. */
  const val ABR_STALL_RATIO = 1.2

  /** The bandwidth under the current bitrate for this long steps down. */
  const val ABR_LOW_MS = 10_000L

  /** The bandwidth above this × the next bitrate… */
  const val ABR_UP_RATIO = 1.5

  /** …for this long steps up (and as long after any switch or stall). */
  const val ABR_UP_MS = 30_000L

  /** Two stalls in this window step down whatever the bandwidth. */
  const val ABR_STALL_WINDOW_MS = 30_000L

  /**
   * An audio player that measures nothing it can trust (no bandwidth
   * reading, or a live stream, which arrives at its own rate) steps up one
   * rendition after this long without a stall.
   */
  const val ABR_QUIET_UP_MS = 120_000L

  /** Data Saver, Low Data Mode, `saveData`: the highest picture. */
  const val DATA_SAVER_MAX_HEIGHT = 480

  /** Automatic start with no bandwidth reading: the lowest rendition at least this high. */
  const val START_MIN_HEIGHT = 480

  /** Audio-only fallback without bandwidth readings: try the picture again after this long without a stall. */
  const val FALLBACK_PROBE_MS = 60_000L
}

/** App-configurable engine knobs (`PlayerOptions` in TS): recovery and fades. */
data class EngineOptions(
  /** Reconnect automatically after recoverable failures while playback is wanted. */
  val reconnect: Boolean = true,
  /** Give up recovering after this long without stable playback (`null` = never). */
  val giveUpAfterMs: Long? = 600_000L,
  /** Resume automatically when the OS ends a transient interruption. */
  val autoResumeAfterInterruption: Boolean = true,
  /** Live drift (pauses + stalls since the open) that forces a live-edge re-open. */
  val liveMaxDriftMs: Long = 5_000L,
  /** Fade-in when playback starts (`0` = none). Starts when the audio does. */
  val fadeInMs: Long = 0L,
  /** Fade-out before a pause or a stop, and the sleep timer's default (`0` = none). */
  val fadeOutMs: Long = 0L,
  /** A video player's rules; `null` for an audio player. */
  val video: VideoEngineOptions? = null,
)

/** What a video player does when the app goes to the background. */
enum class BackgroundMode(val wire: String) {
  PAUSE("pause"),
  AUDIO("audio"),
  PIP("pip");

  companion object {
    fun fromWire(value: String?): BackgroundMode = entries.firstOrNull { it.wire == value } ?: PAUSE
  }
}

/** Where automatic quality starts (`PlayerOptions.video.quality.startQuality`). */
sealed class StartQuality {
  object Auto : StartQuality()
  object Lowest : StartQuality()
  object Highest : StartQuality()
  /** The tallest at or below this height. */
  data class Height(val value: Int) : StartQuality()
}

/** Quality caps (`PlayerOptions.video.quality`). */
data class QualityPolicy(
  val maxHeight: Int? = null,
  val maxBitrate: Long? = null,
  val cellularMaxHeight: Int? = null,
  val cellularMaxBitrate: Long? = null,
  val startQuality: StartQuality = StartQuality.Auto,
  /** Data Saver, Low Data Mode, `saveData`: at most 480p. */
  val followDataSaver: Boolean = true,
  /** Never more pixels than the view shows. */
  val capToView: Boolean = true,
)

/** The audio-only fallback's thresholds (`fallbackToAudio`). */
data class FallbackPolicy(
  /** Drop when the bandwidth stays under this × the lowest video quality… */
  val dropBelowRatio: Double = 1.2,
  /** …for this long. */
  val dropAfterMs: Long = 10_000L,
  /** Or after this many stalls… */
  val dropAfterStalls: Int = 2,
  /** …within this window. */
  val stallWindowMs: Long = 30_000L,
  /** Return when the bandwidth stays above this × the lowest video quality… */
  val returnAboveRatio: Double = 1.5,
  /** …for this long. */
  val returnAfterMs: Long = 30_000L,
)

/** A video player's engine rules (`EngineOptions.video`). */
data class VideoEngineOptions(
  val whenBackgrounded: BackgroundMode = BackgroundMode.PAUSE,
  /** Decorative: no focus, no media session, paused off screen and in the background. */
  val ambient: Boolean = false,
  val keepAwake: Boolean = true,
  val focusWhenMuted: Boolean = false,
  /** `null`: no audio-only fallback. */
  val fallback: FallbackPolicy? = null,
  val quality: QualityPolicy = QualityPolicy(),
  val tracks: TrackPolicy = TrackPolicy(),
)

/** How the starting audio and text tracks are chosen (`PlayerOptions.video.tracks`). */
data class TrackPolicy(
  /** The user's languages, in order. */
  val languages: List<String> = emptyList(),
  /** Follow the OS's captions and audio-description settings. */
  val followSystem: Boolean = true,
)

/** What the OS says about the user (`systemPreferencesChanged`). */
data class SystemPreferences(
  /** The device's languages, in order. */
  val languages: List<String> = emptyList(),
  val captions: Boolean = false,
  val audioDescriptions: Boolean = false,
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
