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
import com.anythingplayer.core.InterruptionReason
import com.anythingplayer.core.OpenRequest
import com.anythingplayer.core.PlaybackSample
import com.anythingplayer.core.PlayerError
import com.anythingplayer.core.ReadyInfo
import com.anythingplayer.platform.DriverObserver
import com.anythingplayer.platform.NowPlaying
import com.anythingplayer.platform.ProgressReading
import com.anythingplayer.platform.RemoteOutput
import com.anythingplayer.platform.receiverMimeType
import com.google.android.gms.cast.MediaError
import com.google.android.gms.cast.MediaInfo
import com.google.android.gms.cast.MediaStatus

private const val TAG = "RNAP"
private const val CONTENT_PREFIX = "anythingplayer:"
/** The receiver loads before it plays: a pause seen this soon after a play request is ours, not someone else's. */
private const val PLAY_GRACE_MS = 3_000L
/** How many times a play that the receiver dropped (a play sent before its load finished) is repeated. */
private const val MAX_PLAY_RETRIES = 3

/** What the output last told the engine about its generation (each is reported once). */
private enum class Report { NONE, READY, BUFFERING, PLAYING, PAUSED, TERMINAL }

/**
 * One player's [RemoteOutput] over the app's Cast session. The engine decides
 * everything (intent, recovery, handoff); this maps what the receiver reports
 * to the engine's callbacks for the generation it was opened with:
 *
 * - loading / buffering → buffering (once ready),
 * - playing → ready + playing,
 * - paused → ready; a pause the engine did not ask for (the TV remote, Google
 *   Home) → paused externally,
 * - idle: finished → ended, error → failed (recoverable: the engine reconnects
 *   with its backoff, against the receiver), cancelled / interrupted (another
 *   sender took over) → paused externally.
 *
 * Commands go to Media3's remote player; the receiver's `MediaStatus` is the
 * truth for state. The output only reads while it owns the receiver's media,
 * and only for the content it loaded (`anythingplayer:<generation>`).
 */
internal class CastOutput(
  private val hub: RealCastBackend,
  private val observer: DriverObserver,
  private val nowPlaying: () -> NowPlaying,
) : RemoteOutput {
  private val main = Handler(Looper.getMainLooper())
  private var owns = false
  private var generation = 0
  private var contentId = ""
  private var request: OpenRequest? = null
  private var wantsPlay = false
  private var volume = 1.0
  private var rate = 1.0
  private var last = Report.NONE
  private var playedThisGeneration = false
  private var graceUntil = 0L
  private var playRetries = 0
  private var evaluating = false
  private var lastPositionMs = 0L
  private var lastError: MediaError? = null
  private var ready: ReadyInfo? = null

  // ── EngineDriver ──

  override fun open(request: OpenRequest) {
    hub.claim(this)
    owns = true
    this.request = request
    generation = request.generation
    contentId = "$CONTENT_PREFIX$generation"
    last = Report.NONE
    ready = null
    playedThisGeneration = false
    lastError = null
    lastPositionMs = (request.startPosition ?: 0.0).times(1000).toLong()
    wantsPlay = request.playWhenReady
    expectPlay()
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
    wantsPlay = true
    expectPlay()
    if (owns) hub.player?.playWhenReady = true
  }

  override fun pause() {
    wantsPlay = false
    if (owns) hub.player?.playWhenReady = false
  }

  override fun seek(seconds: Double) {
    if (owns) hub.player?.seekTo((seconds * 1000).toLong())
  }

  /** Drops the receiver's media: a later `play()` makes the engine open it again. */
  override fun releaseConnection() {
    wantsPlay = false
    last = Report.TERMINAL
    if (owns) hub.player?.stop()
  }

  override fun unload() {
    wantsPlay = false
    last = Report.TERMINAL
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
    val info = ready
    return ProgressReading(lastPositionMs / 1000.0, lastPositionMs / 1000.0, info?.duration, null, last == Report.PLAYING, rate)
  }

  override fun destroy() {
    owns = false
    hub.release(this)
  }

  // ── The receiver's side ──

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
    lastError = error
  }

  private fun expectPlay() {
    graceUntil = SystemClock.elapsedRealtime() + PLAY_GRACE_MS
    playRetries = 0
  }

  private fun readPosition() {
    val position = hub.client?.approximateStreamPosition ?: return
    if (position >= 0) lastPositionMs = position
  }

  private fun evaluate() {
    if (!owns) return
    val client = hub.client ?: return
    val status = client.mediaStatus ?: return
    // Only the content this output loaded: the receiver may still report the previous item.
    if (status.mediaInfo?.contentId != contentId) return
    readPosition()
    when (status.playerState) {
      MediaStatus.PLAYER_STATE_LOADING, MediaStatus.PLAYER_STATE_BUFFERING ->
        if (last != Report.NONE) report(Report.BUFFERING) { observer.onBuffering(generation) }
      MediaStatus.PLAYER_STATE_PLAYING -> {
        becomeReady(status)
        playedThisGeneration = true
        report(Report.PLAYING) { observer.onPlaying(generation) }
      }
      MediaStatus.PLAYER_STATE_PAUSED -> {
        becomeReady(status)
        onReceiverPaused()
      }
      MediaStatus.PLAYER_STATE_IDLE -> onReceiverIdle(status.idleReason)
    }
  }

  private fun becomeReady(status: MediaStatus) {
    if (ready != null) return
    val info = status.mediaInfo
    val request = request ?: return
    val duration = info?.streamDuration?.takeIf { it > 0 && it != MediaInfo.UNKNOWN_DURATION }?.let { it / 1000.0 }
    val live = request.source.liveHint ?: (info?.streamType == MediaInfo.STREAM_TYPE_LIVE || duration == null)
    val seekable = !live && status.isMediaCommandSupported(MediaStatus.COMMAND_SEEK)
    val readyInfo = ReadyInfo(if (live) null else duration, live, seekable)
    ready = readyInfo
    hub.player?.volume = volume.toFloat()
    if (last == Report.NONE) last = Report.READY
    observer.onReady(generation, readyInfo)
  }

  private fun onReceiverPaused() {
    if (!wantsPlay) {
      last = Report.PAUSED
      return
    }
    // A play sent before the receiver finished loading is lost; the load ran
    // paused. Ask again a few times before calling the pause someone else's.
    val inGrace = SystemClock.elapsedRealtime() < graceUntil || !playedThisGeneration
    if (inGrace && playRetries < MAX_PLAY_RETRIES) {
      playRetries += 1
      hub.client?.play()
      return
    }
    report(Report.PAUSED) { observer.onPausedExternally(generation, InterruptionReason.INTERRUPTION) }
  }

  private fun onReceiverIdle(reason: Int) {
    when (reason) {
      MediaStatus.IDLE_REASON_FINISHED -> report(Report.TERMINAL) { observer.onEnded(generation) }
      MediaStatus.IDLE_REASON_ERROR -> report(Report.TERMINAL) { observer.onFailed(generation, receiverError()) }
      MediaStatus.IDLE_REASON_CANCELED, MediaStatus.IDLE_REASON_INTERRUPTED ->
        report(Report.TERMINAL) { if (wantsPlay) observer.onPausedExternally(generation, InterruptionReason.INTERRUPTION) }
      // IDLE_REASON_NONE: the receiver has not started the load yet.
      else -> Unit
    }
  }

  private fun receiverError(): PlayerError {
    val error = lastError
    val detail = error?.reason ?: error?.detailedErrorCode?.let { "code $it" }
    return PlayerError(
      ErrorCode.NETWORK_ERROR,
      "The Cast receiver could not play the stream" + (detail?.let { " ($it)" } ?: "."),
      true,
      platformDomain = "cast",
      platformCode = error?.detailedErrorCode,
    )
  }

  /** Tells the engine once per kind of change. Always called from the main loop, never from inside an engine command. */
  private fun report(kind: Report, block: () -> Unit) {
    if (last == kind) return
    last = kind
    block()
  }

  private fun fail(error: PlayerError) {
    val gen = generation
    main.post { if (owns && generation == gen) observer.onFailed(gen, error) }
  }

  // ── Media3 items ──

  private fun mediaItem(request: OpenRequest): MediaItem {
    val shown = nowPlaying()
    val metadata =
      MediaMetadata.Builder().setTitle(shown.title).setArtist(shown.artist).setAlbumTitle(shown.album)
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
