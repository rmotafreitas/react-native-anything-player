package com.anythingplayer.cast

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.media3.cast.RemoteCastPlayer
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.OpenRequest
import com.anythingplayer.core.PlaybackSample
import com.anythingplayer.core.PlayerError
import com.anythingplayer.platform.DriverObserver
import com.anythingplayer.platform.NowPlaying
import com.anythingplayer.platform.ProgressReading
import com.anythingplayer.platform.IdleReason
import com.anythingplayer.platform.ReceiverActions
import com.anythingplayer.platform.ReceiverMapper
import com.anythingplayer.platform.ReceiverState
import com.anythingplayer.platform.ReceiverStatus
import com.anythingplayer.platform.RemoteOutput
import com.anythingplayer.platform.receiverMimeType
import com.google.android.gms.cast.MediaError
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaStatus

private const val TAG = "RNAP"
private const val CONTENT_PREFIX = "anythingplayer:"

/**
 * One player's [RemoteOutput] over the app's Cast session. The engine decides
 * everything (intent, recovery, handoff); [ReceiverMapper] maps what the
 * receiver reports to the engine's callbacks for the generation this output
 * was opened with.
 *
 * Commands go to Media3's remote player; the receiver's `MediaStatus` is the
 * truth for state. The output only reads while it owns the receiver's media.
 */
internal class CastOutput(
  private val hub: RealCastBackend,
  private val observer: DriverObserver,
  private val nowPlaying: () -> NowPlaying,
) : RemoteOutput, ReceiverActions {
  private val main = Handler(Looper.getMainLooper())
  private val mapper = ReceiverMapper(observer, this, SystemClock::elapsedRealtime)
  private var owns = false
  private var generation = 0
  private var contentId = ""
  private var volume = 1.0
  private var rate = 1.0
  private var evaluating = false
  private var lastPositionMs = 0L

  // ── EngineDriver ──

  override fun open(request: OpenRequest) {
    hub.claim(this)
    owns = true
    generation = request.generation
    contentId = "$CONTENT_PREFIX$generation"
    lastPositionMs = (request.startPosition ?: 0.0).times(1000).toLong()
    mapper.open(generation, contentId, request.source.liveHint, request.playWhenReady)
    val player = hub.player
    when {
      !request.source.isNetwork ->
        fail(PlayerError(ErrorCode.CAST_UNSUPPORTED_SOURCE, "A Cast receiver can only play http(s) sources.", false, platformDomain = "cast"))
      player == null || !player.isCastSessionAvailable ->
        fail(PlayerError(ErrorCode.NETWORK_ERROR, "There is no Cast session to play on.", true, platformDomain = "cast"))
      else -> {
        // The load's autoplay is the player's play-when-ready: set it first.
        player.playWhenReady = request.playWhenReady
        val start = request.startPosition?.takeIf { it > 0 }?.let { (it * 1000).toLong() } ?: C.TIME_UNSET
        player.setMediaItem(mediaItem(request), start)
        player.volume = volume.toFloat()
      }
    }
  }

  override fun play() {
    mapper.playRequested()
    if (owns) hub.player?.playWhenReady = true
  }

  override fun pause() {
    mapper.pauseRequested()
    if (owns) hub.player?.playWhenReady = false
  }

  override fun seek(seconds: Double) {
    if (owns) hub.player?.seekTo((seconds * 1000).toLong())
  }

  /** Drops the receiver's media: a later `play()` makes the engine open it again. */
  override fun releaseConnection() {
    mapper.stopped()
    if (owns) hub.player?.stop()
  }

  override fun unload() {
    mapper.stopped()
    if (owns) hub.player?.stop()
    owns = false
    hub.release(this)
  }

  override fun setVolume(effective: Double) {
    volume = effective
    if (owns) hub.player?.volume = effective.toFloat()
  }

  override fun setRate(rate: Double) {
    this.rate = rate
    if (!owns) return
    val supported = RemoteCastPlayer.MIN_SPEED_SUPPORTED.toDouble()..RemoteCastPlayer.MAX_SPEED_SUPPORTED.toDouble()
    if (rate in supported) hub.player?.setPlaybackSpeed(rate.toFloat()) else Log.d(TAG, "Cast receivers play at 0.5x–2x; rate $rate ignored")
  }

  /** The output id (`cast:<device>`) is the routing driver's concern; the session is the app's. */
  override fun switchOutput(outputId: String) = Unit

  override fun sample(): PlaybackSample {
    if (owns) readPosition()
    val seconds = lastPositionMs / 1000.0
    return PlaybackSample(seconds, seconds)
  }

  override fun progress(): ProgressReading {
    if (owns) readPosition()
    return ProgressReading(lastPositionMs / 1000.0, lastPositionMs / 1000.0, mapper.ready?.duration, null, mapper.playing, rate)
  }

  override fun destroy() {
    owns = false
    hub.release(this)
  }

  // ── The receiver's side ──

  override fun playAgain() {
    hub.client?.play()
  }

  override fun receiverReady() {
    hub.player?.volume = volume.toFloat()
  }

  /** From the SDK's callbacks: evaluated once, after every listener of this update ran. */
  fun requestEvaluation() {
    if (!owns || evaluating) return
    evaluating = true
    main.post {
      evaluating = false
      evaluate()
    }
  }

  fun mediaError(error: MediaError) {
    mapper.mediaError(error.reason ?: error.detailedErrorCode?.let { "code $it" }, error.detailedErrorCode)
  }

  private fun readPosition() {
    val position = hub.client?.approximateStreamPosition ?: return
    if (position >= 0) lastPositionMs = position
  }

  private fun evaluate() {
    if (!owns) return
    val status = hub.client?.mediaStatus ?: return
    readPosition()
    val info = status.mediaInfo
    val duration = info?.streamDuration?.takeIf { it > 0 && it != MediaInfo.UNKNOWN_DURATION }?.let { it / 1000.0 }
    mapper.evaluate(
      ReceiverStatus(
        contentId = info?.contentId,
        state =
          when (status.playerState) {
            MediaStatus.PLAYER_STATE_IDLE -> ReceiverState.IDLE
            MediaStatus.PLAYER_STATE_LOADING -> ReceiverState.LOADING
            MediaStatus.PLAYER_STATE_BUFFERING -> ReceiverState.BUFFERING
            MediaStatus.PLAYER_STATE_PLAYING -> ReceiverState.PLAYING
            MediaStatus.PLAYER_STATE_PAUSED -> ReceiverState.PAUSED
            else -> ReceiverState.UNKNOWN
          },
        idle =
          when (status.idleReason) {
            MediaStatus.IDLE_REASON_FINISHED -> IdleReason.FINISHED
            MediaStatus.IDLE_REASON_CANCELED -> IdleReason.CANCELED
            MediaStatus.IDLE_REASON_INTERRUPTED -> IdleReason.INTERRUPTED
            MediaStatus.IDLE_REASON_ERROR -> IdleReason.ERROR
            else -> IdleReason.NONE
          },
        duration = duration,
        live = info?.streamType == MediaInfo.STREAM_TYPE_LIVE,
        seekable = status.isMediaCommandSupported(MediaStatus.COMMAND_SEEK),
      )
    )
  }

  private fun fail(error: PlayerError) {
    val gen = generation
    main.post { if (owns && generation == gen) observer.onFailed(gen, error) }
  }

  // ── Media3 items ──

  private fun mediaItem(request: OpenRequest): MediaItem {
    val shown = nowPlaying()
    val metadata = MediaMetadata.Builder().setTitle(shown.title).setArtist(shown.artist).setAlbumTitle(shown.album)
    shown.artwork?.takeIf { it.startsWith("http://") || it.startsWith("https://") }?.let { metadata.setArtworkUri(Uri.parse(it)) }
    val builder =
      MediaItem.Builder()
        .setMediaId(contentId)
        .setUri(request.source.uri)
        .setMimeType(receiverMimeType(request.source.uri))
        .setMediaMetadata(metadata.build())
    // An explicit live configuration is how Media3 marks a stream as live for the receiver.
    if (request.source.liveHint == true) builder.setLiveConfiguration(MediaItem.LiveConfiguration.Builder().build())
    return builder.build()
  }
}
