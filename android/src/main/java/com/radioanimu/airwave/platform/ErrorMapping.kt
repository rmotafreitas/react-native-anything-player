package com.radioanimu.airwave.platform

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import com.radioanimu.airwave.core.ErrorCode
import com.radioanimu.airwave.core.PlayerError

/** HTTP statuses that a retry can fix. */
internal fun isRetryableHttpStatus(status: Int): Boolean = status == 408 || status == 429 || status >= 500

/**
 * Media3's default policy retries every HTTP status (a 404 takes ~6 s of
 * retries to surface). Client errors cannot be fixed by retrying — fail fast
 * and let the engine classify them.
 */
@OptIn(UnstableApi::class)
internal class AirwaveLoadErrorPolicy : DefaultLoadErrorHandlingPolicy() {
  override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
    val http = findCause<HttpDataSource.InvalidResponseCodeException>(loadErrorInfo.exception)
    if (http != null && !isRetryableHttpStatus(http.responseCode)) return C.TIME_UNSET
    return super.getRetryDelayMsFor(loadErrorInfo)
  }
}

internal inline fun <reified T : Throwable> findCause(error: Throwable?): T? {
  var current = error
  var depth = 0
  while (current != null && depth < 12) {
    if (current is T) return current
    current = current.cause
    depth += 1
  }
  return null
}

private fun causeChain(error: Throwable?): String {
  val parts = mutableListOf<String>()
  var current = error
  var depth = 0
  while (current != null && depth < 6) {
    parts.add("${current.javaClass.simpleName}: ${current.message ?: ""}".trim())
    current = current.cause
    depth += 1
  }
  return parts.joinToString(" ← ")
}

/**
 * Maps a Media3 [PlaybackException] onto a normalized [PlayerError]. The
 * native code, its name and the whole cause chain are always kept.
 *
 * @param offline the device reported no connectivity when the error landed.
 * @param hadPlayed audio had flowed for this source (a malformed chunk in a
 *   live stream that was playing is a transient server glitch, not a bad file).
 */
@OptIn(UnstableApi::class)
internal fun mapPlaybackException(error: PlaybackException, offline: Boolean, hadPlayed: Boolean): PlayerError {
  val http = findCause<HttpDataSource.InvalidResponseCodeException>(error)
  fun make(code: ErrorCode, message: String, recoverable: Boolean, httpStatus: Int? = null) =
    PlayerError(
      code = code,
      message = message,
      recoverable = recoverable,
      httpStatus = httpStatus,
      platformDomain = "androidx.media3:${error.errorCodeName}",
      platformCode = error.errorCode,
      causeDescription = causeChain(error),
    )
  // OkHttp refuses cleartext with an UnknownServiceException that Media3's
  // OkHttp source wraps, so it surfaces as a generic connection failure.
  val cleartextRefused =
    findCause<java.net.UnknownServiceException>(error)?.message?.contains("cleartext", ignoreCase = true) == true
  val code =
    if (cleartextRefused) PlaybackException.ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED else error.errorCode
  return when (code) {
    PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED ->
      if (offline) make(ErrorCode.NETWORK_UNAVAILABLE, "The device is offline.", true)
      else make(ErrorCode.NETWORK_ERROR, "Could not connect to the server.", true)
    PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
    PlaybackException.ERROR_CODE_TIMEOUT -> make(ErrorCode.TIMEOUT, "The connection timed out.", true)
    PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> {
      val status = http?.responseCode ?: 0
      when {
        status == 404 || status == 410 ->
          make(ErrorCode.SOURCE_NOT_FOUND, "The server returned HTTP $status.", false, status)
        isRetryableHttpStatus(status) -> make(ErrorCode.HTTP_ERROR, "The server returned HTTP $status.", true, status)
        else -> make(ErrorCode.HTTP_ERROR, "The server returned HTTP $status.", false, status)
      }
    }
    PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND -> make(ErrorCode.SOURCE_NOT_FOUND, "The file does not exist.", false)
    PlaybackException.ERROR_CODE_IO_NO_PERMISSION ->
      make(ErrorCode.INVALID_SOURCE, "The app has no permission to read this source.", false)
    PlaybackException.ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED ->
      make(
        ErrorCode.INVALID_SOURCE,
        "Cleartext HTTP is blocked by the app's network security config; use https or allow the domain.",
        false,
      )
    PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE ->
      make(ErrorCode.UNSUPPORTED_FORMAT, "The server returned a content type that is not audio.", false)
    PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE,
    PlaybackException.ERROR_CODE_IO_UNSPECIFIED ->
      if (offline) make(ErrorCode.NETWORK_UNAVAILABLE, "The device is offline.", true)
      else make(ErrorCode.NETWORK_ERROR, "The connection failed while reading.", true)
    PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
    PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED ->
      make(ErrorCode.DECODER_ERROR, "The stream data is malformed.", hadPlayed)
    PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
    PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED,
    PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
    PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES,
    PlaybackException.ERROR_CODE_AUDIO_TRACK_OFFLOAD_INIT_FAILED ->
      make(ErrorCode.UNSUPPORTED_FORMAT, "This audio format is not supported on this device.", false)
    PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
    PlaybackException.ERROR_CODE_DECODER_QUERY_FAILED,
    PlaybackException.ERROR_CODE_DECODING_FAILED ->
      make(ErrorCode.DECODER_ERROR, "The audio could not be decoded.", hadPlayed)
    PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW ->
      make(ErrorCode.NATIVE_PLAYER_ERROR, "Playback fell behind the live window.", true)
    else -> make(ErrorCode.NATIVE_PLAYER_ERROR, error.message ?: "Native player error.", true)
  }
}
