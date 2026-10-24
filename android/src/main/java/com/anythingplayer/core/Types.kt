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
  SYSTEM("system"),
  /** Video: the app went to the background (`whenBackgrounded`, ambient players). */
  BACKGROUND("background"),
  /** Video: an ambient player's view left the screen; it resumes when shown again. */
  OFFSCREEN("offscreen");

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
  ROUTE_PICKER_UNAVAILABLE("ROUTE_PICKER_UNAVAILABLE"),
  CAST_UNAVAILABLE("CAST_UNAVAILABLE"),
  CAST_UNSUPPORTED_SOURCE("CAST_UNSUPPORTED_SOURCE"),
  VIDEO_UNAVAILABLE("VIDEO_UNAVAILABLE"),
  DRM_UNSUPPORTED("DRM_UNSUPPORTED"),
  DRM_LICENSE_FAILED("DRM_LICENSE_FAILED"),
  SUBTITLE_LOAD_FAILED("SUBTITLE_LOAD_FAILED"),
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

/** A key system's license server and the headers sent to it (`licenseUrl` `null`: none given). */
data class LicenseServer(val licenseUrl: String?, val headers: Map<String, String> = emptyMap())

/**
 * A source's `drm`, as JavaScript validated it. [clearKeys] maps key ids to
 * keys (hex), answered on the device; [fairplay] is Apple's (named so Android
 * can say why it cannot play); [hook]: the app's `getLicense` answers the
 * license requests.
 */
data class DrmDescriptor(
  val widevine: LicenseServer? = null,
  val playready: LicenseServer? = null,
  val clearkey: LicenseServer? = null,
  val clearKeys: Map<String, String>? = null,
  val fairplay: Boolean = false,
  val hook: Boolean = false,
)

/** What the app asked to play. */
data class SourceDescriptor(
  val uri: String,
  val headers: Map<String, String> = emptyMap(),
  /** App hint. `null` = detect (indefinite duration ⇒ live). */
  val liveHint: Boolean? = null,
  /**
   * Separate files of one video at different qualities. The engine picks one
   * and switches between them (`uri` is then unused); `null`: one file or an
   * adaptive manifest.
   */
  val renditions: List<Rendition>? = null,
  /** The app can hand over a new source on 401/403 or before `expiresAt`. */
  val refreshable: Boolean = false,
  /** Wall-clock epoch ms when the source's URL stops working. */
  val expiresAt: Long? = null,
  /** The source is encrypted: its key systems and license servers (`null`: clear). */
  val drm: DrmDescriptor? = null,
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
  /** The engine re-opens on its own (`reconnect`): a driver may then continue a dropped live connection itself. */
  val allowReconnect: Boolean = true,
  /**
   * Open behind the current item and swap on its first frame (a quality
   * switch): the current item keeps playing until this one reports
   * `playing`, and is dropped then.
   */
  val swap: Boolean = false,
  /** Index into the source's renditions, when it has them. */
  val rendition: Int? = null,
)

/** One file of a video at one quality (`SourceDescriptor.renditions`). */
data class Rendition(
  val uri: String,
  /** `null`: the source's headers. */
  val headers: Map<String, String>? = null,
  /** Pixels; `null` until the platform reads it from the file. */
  val height: Int? = null,
  /** Bits per second; `null` until known. */
  val bitrate: Long? = null,
  val label: String? = null,
  /** Sound only: the last step of the audio-only fallback. */
  val audioOnly: Boolean = false,
)

/** A quality of an adaptive source as the driver reports it, or a rendition (`status.video.qualities`). */
data class VideoVariant(
  val id: String,
  val height: Int? = null,
  val bitrate: Long? = null,
  /** An audio-only variant (or, for HLS/DASH, the audio rendition alone). */
  val audioOnly: Boolean = false,
  val label: String? = null,
)

/** What the driver learned about the picture. */
data class VideoInfo(
  val width: Int,
  val height: Int,
  val hdr: Boolean = false,
  /** The variant playing (adaptive sources), when the driver knows it. */
  val variantId: String? = null,
)

/** What the engine asks an adaptive source's driver to keep to. */
data class QualityConstraints(
  val maxHeight: Int?,
  val maxBitrate: Long?,
  /** A variant the app picked; `null`: the driver's own ABR. */
  val pinned: String?,
  /** Prefer an audio-only variant (listen-only, background, fallback). */
  val audioOnly: Boolean,
)

/** Why a video player plays its sound alone. */
enum class AudioOnlyReason(val wire: String) {
  LISTEN("listen"),
  BACKGROUND("background"),
  FALLBACK("fallback"),
}

/** Why the engine asks for a new source. */
enum class RefreshReason(val wire: String) {
  /** A 401/403. */
  UNAUTHORIZED("unauthorized"),
  /** `expiresAt` is near. */
  EXPIRING("expiring"),
}

/** The view showing a video player (`viewChanged`). */
data class ViewState(
  val attached: Boolean = false,
  val visible: Boolean = false,
  /** Physical pixels; 0 when unknown. */
  val width: Int = 0,
  val height: Int = 0,
)

/** Quality-of-experience numbers the engine counts (`getStats()`). */
data class EngineStats(
  /** `load()` to the first audio, ms; `null` until then. */
  val startupMs: Long? = null,
  val rebufferCount: Int = 0,
  val rebufferMs: Long = 0L,
  val qualitySwitches: Int = 0,
  val audioOnlySwitches: Int = 0,
)

/** A video player's part of the status (`status.video`). */
data class VideoStatus(
  val width: Int?,
  val height: Int?,
  val hdr: Boolean,
  /** A frame of the current load has been shown. */
  val firstFrame: Boolean,
  val audioOnly: AudioOnlyReason?,
  val pictureInPicture: Boolean,
  val qualities: List<VideoVariant>,
  /** The quality playing (`null` when unknown). */
  val quality: String?,
  /** The app's pick; `null` = automatic. */
  val selectedQuality: String?,
  /** The audio and text tracks: the source's, then the app's subtitle files. */
  val tracks: List<MediaTrack> = emptyList(),
  val audioTrack: String? = null,
  /** `null`: no subtitles. */
  val textTrack: String? = null,
  /** Seconds the subtitles are shown later (negative: earlier). */
  val subtitleDelay: Double = 0.0,
  val fullscreen: Boolean = false,
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

/** The kind of audio output. Mirrors `AudioRouteKind` in `src/types.ts`. */
enum class AudioRouteKind(val wire: String) {
  SPEAKER("speaker"),
  HEADPHONES("headphones"),
  BLUETOOTH("bluetooth"),
  AIRPLAY("airplay"),
  CAST("cast"),
  CAR("car"),
  HDMI("hdmi"),
  USB("usb"),
  OTHER("other"),
  UNKNOWN("unknown");

  companion object {
    fun fromWire(value: String?): AudioRouteKind? = entries.firstOrNull { it.wire == value }
  }
}

/** Where a player's audio goes. Mirrors `AudioRoute` in `src/types.ts`. */
data class AudioRoute(
  val kind: AudioRouteKind,
  /** The device's name when the platform tells it ("Living Room"), else `null`. */
  val name: String?,
) {
  companion object {
    /** The route before the platform reports one: the engine never guesses. */
    val UNKNOWN = AudioRoute(AudioRouteKind.UNKNOWN, null)
  }
}

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
  /** The output the audio goes to (speaker, AirPods, a Cast receiver). */
  val route: AudioRoute = AudioRoute.UNKNOWN,
  /** Wall-clock epoch ms when the sleep timer pauses the player, `null` when off. */
  val sleepAt: Long? = null,
  /** `null` for an audio player. */
  val video: VideoStatus? = null,
)

/** A linear move from `from` to `to` between two monotonic instants (ms). */
data class Ramp(val from: Double, val to: Double, val startAt: Long, val endAt: Long) {
  /** The value at `t`: `from` before it starts, `to` once it ends. */
  fun valueAt(t: Long): Double =
    when {
      t >= endAt -> to
      t <= startAt -> from
      else -> from + (to - from) * ((t - startAt).toDouble() / (endAt - startAt).toDouble())
    }
}

/** One structured diagnostic line (ring-buffered natively, optionally streamed). */
data class DiagnosticEntry(
  val wallTime: Long,
  val generation: Int,
  val state: PlaybackState,
  val event: String,
  val details: Map<String, String>,
)
