package com.anythingplayer.core

// Value types shared by the engine and the platform layer. Everything in
// `core/` is pure Kotlin (no android.* imports) so it runs in plain JVM unit
// tests. Swift twin: `ios/Core/Types.swift` — keep names and semantics identical.

/** Public playback state. See `docs/events.md` for the full contract. */
enum class PlaybackState(val wire: String) {
  IDLE("idle"),
  LOADING("loading"),
  BUFFERING("buffering"),
  PLAYING("playing"),
  PAUSED("paused"),
  STOPPED("stopped"),
  RECONNECTING("reconnecting"),
  ENDED("ended"),
  ERROR("error"),
}

/** Why the system — not the app — paused (or refused to start) playback. */
enum class InterruptionReason(val wire: String) {
  INTERRUPTION("interruption"),
  AUDIO_FOCUS_LOSS("audio-focus-loss"),
  AUDIO_FOCUS_LOSS_TRANSIENT("audio-focus-loss-transient"),
  AUDIO_FOCUS_DELAYED("audio-focus-delayed"),
  AUDIO_FOCUS_DENIED("audio-focus-denied"),
  OUTPUT_DISCONNECTED("output-disconnected"),
  SYSTEM("system");

  companion object {
    fun fromWire(value: String?): InterruptionReason? = entries.firstOrNull { it.wire == value }
  }
}

data class Interruption(
  val reason: InterruptionReason,
  /** Whether the OS may end it by resuming playback on its own. */
  val resumable: Boolean,
  /** Wall-clock epoch ms when it began. */
  val since: Long,
)

/** Normalized error codes. Mirrors `src/errors.ts`. */
enum class ErrorCode(val wire: String) {
  INVALID_SOURCE("INVALID_SOURCE"),
  SOURCE_NOT_FOUND("SOURCE_NOT_FOUND"),
  UNSUPPORTED_FORMAT("UNSUPPORTED_FORMAT"),
  DECODER_ERROR("DECODER_ERROR"),
  NETWORK_UNAVAILABLE("NETWORK_UNAVAILABLE"),
  NETWORK_ERROR("NETWORK_ERROR"),
  TIMEOUT("TIMEOUT"),
  HTTP_ERROR("HTTP_ERROR"),
  STREAM_ENDED("STREAM_ENDED"),
  AUDIO_FOCUS_DENIED("AUDIO_FOCUS_DENIED"),
  AUDIO_SESSION_ERROR("AUDIO_SESSION_ERROR"),
  NOT_SEEKABLE("NOT_SEEKABLE"),
  NO_SOURCE("NO_SOURCE"),
  PLAYER_RELEASED("PLAYER_RELEASED"),
  INVALID_ARGUMENT("INVALID_ARGUMENT"),
  NATIVE_PLAYER_ERROR("NATIVE_PLAYER_ERROR"),
  INTERNAL_ERROR("INTERNAL_ERROR");

  companion object {
    fun fromWire(value: String?): ErrorCode? = entries.firstOrNull { it.wire == value }
  }
}

data class PlayerError(
  val code: ErrorCode,
  override val message: String,
  /** Whether retrying (reconnecting / calling `play()` again) can succeed. */
  val recoverable: Boolean,
  val httpStatus: Int? = null,
  /** Native diagnostic details — never dropped (see docs/errors.md). */
  val platformDomain: String? = null,
  val platformCode: Int? = null,
  val causeDescription: String? = null,
) : Exception(message)

enum class NetworkState(val wire: String) {
  ONLINE("online"),
  OFFLINE("offline"),
  UNKNOWN("unknown"),
}

enum class FocusResult { GRANTED, DELAYED, DENIED }

/** What the app asked to play. */
data class SourceDescriptor(
  val uri: String,
  val headers: Map<String, String> = emptyMap(),
  /** App hint. `null` = detect (indefinite duration ⇒ live). */
  val liveHint: Boolean? = null,
) {
  val isNetwork: Boolean
    get() {
      val lower = uri.lowercase()
      return lower.startsWith("http://") || lower.startsWith("https://")
    }
}

/** What the engine asks the driver to open. */
data class OpenRequest(
  val generation: Int,
  val source: SourceDescriptor,
  /** Seconds to start at; `null` = default (live edge / beginning). */
  val startPosition: Double?,
  val playWhenReady: Boolean,
)

/** A point-in-time reading of the native player, taken on demand. */
data class PlaybackSample(
  val position: Double = 0.0,
  /** End of the buffered range, in the same timeline as `position`. */
  val bufferedPosition: Double = 0.0,
)

/** What the driver learned when the item became ready. */
data class ReadyInfo(
  /** Seconds; `null` when indefinite (live) or unknown. */
  val duration: Double?,
  val isLive: Boolean,
  val seekable: Boolean,
)

data class ReconnectInfo(
  /** 1-based attempt number of the next/current attempt. */
  val attempt: Int,
  /** Wall-clock epoch ms of the next attempt, `null` while an attempt runs. */
  val nextAttemptAt: Long?,
  val reason: String,
)

/** The authoritative snapshot published to JS. Mirrors `PlayerStatus` in TS. */
data class Status(
  val state: PlaybackState = PlaybackState.IDLE,
  val playWhenReady: Boolean = false,
  /** Increments on every `load()`; identifies the source this status describes. */
  val loadId: Int = 0,
  val isLive: Boolean = false,
  val duration: Double? = null,
  val seekable: Boolean = false,
  val interruption: Interruption? = null,
  val error: PlayerError? = null,
  val reconnect: ReconnectInfo? = null,
  val network: NetworkState = NetworkState.UNKNOWN,
  val volume: Double = 1.0,
  val muted: Boolean = false,
  val rate: Double = 1.0,
)

/** One structured diagnostic line (ring-buffered natively, optionally streamed). */
data class DiagnosticEntry(
  val wallTime: Long,
  val generation: Int,
  val state: PlaybackState,
  val event: String,
  val details: Map<String, String>,
)
