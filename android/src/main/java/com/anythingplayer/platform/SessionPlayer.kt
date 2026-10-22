package com.anythingplayer.platform

import android.net.Uri
import java.io.File
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.SimpleBasePlayer
import androidx.media3.common.util.UnstableApi
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.anythingplayer.core.PlaybackState
import com.anythingplayer.core.PlayerError

/**
 * The player the Media3 session (notification, lock screen, headset, Bluetooth,
 * car, Wear) sees. It is a *facade* over the active player's engine — not the
 * ExoPlayer — for two reasons learned in production:
 *
 * - Media3 keeps the service in the foreground only while the session player
 *   reports `playWhenReady` and BUFFERING/READY. ExoPlayer is idle between
 *   reconnect attempts; exposed directly, a long outage would drop the
 *   foreground service and let the OS freeze the process mid-recovery. The
 *   facade reports a reconnecting stream as BUFFERING with play intent, and a
 *   transient interruption (a call) as suppressed-but-wanted.
 * - Every command must go through the engine (live-edge policy, user-pause
 *   latch), never straight to ExoPlayer.
 */
@OptIn(UnstableApi::class)
internal class SessionPlayer : SimpleBasePlayer(Looper.getMainLooper()) {
  /** The last local artwork read (uri → bytes): states are rebuilt often. */
  private var localArtwork: Pair<String, ByteArray?>? = null

  /**
   * Remote artwork is loaded by Media3 in this process. Local artwork
   * (`file://`, an absolute path) is read here and attached as bytes: the
   * system UI (notification, media controls) loads an artwork *URI* itself,
   * cross-process, and cannot open the app's private files — reproduced:
   * SystemUI's ImageLoader failed with ENOENT on the app's cache file.
   */
  private fun setArtwork(builder: MediaMetadata.Builder, artwork: String?) {
    if (artwork == null) return
    val uri = Uri.parse(artwork)
    val path = if (uri.scheme == null) artwork else if (uri.scheme == "file") uri.path else null
    if (path == null) {
      builder.setArtworkUri(uri)
      return
    }
    val bytes =
      localArtwork?.takeIf { it.first == artwork }?.second
        ?: runCatching { File(path).readBytes().takeIf { it.isNotEmpty() } }.getOrNull()
          .also { localArtwork = artwork to it }
    bytes?.let { builder.setArtworkData(it, MediaMetadata.PICTURE_TYPE_FRONT_COVER) }
  }

  fun refresh() = invalidateState()

  /** What a controller may do while nothing plays, when a catalog exists. */
  private val idleCommands =
    Player.Commands.Builder()
      .addAll(Player.COMMAND_SET_MEDIA_ITEM, Player.COMMAND_CHANGE_MEDIA_ITEMS, Player.COMMAND_PREPARE, Player.COMMAND_PLAY_PAUSE)
      .build()

  override fun getState(): State {
    val controller = AnythingPlayerRuntime.active
    val status = controller?.status
    if (controller == null || status == null || status.state == PlaybackState.IDLE) {
      // Nothing is loaded. With a catalog an assistant may still ask for
      // something to play ("play Jazz FM"): it sets an item, prepares and plays.
      return State.Builder()
        .setAvailableCommands(if (Voice.hasItems()) idleCommands else Player.Commands.EMPTY)
        .setPlaybackState(Player.STATE_IDLE)
        .build()
    }
    val now = controller.nowPlaying()
    val reading = controller.progress()
    val elapsed = (AndroidClock.monotonicMs - reading.takenAtMonotonic).coerceAtLeast(0)
    val track = now.track
    val playing = status.state == PlaybackState.PLAYING
    val positionMs = contentPosition(track, reading, elapsed, playing, status.rate)
    val positionRate = if (track != null) 1f else status.rate.toFloat()
    // The "live" badge: a live item with no song timeline, unless the app
    // turned it off (a radio between songs).
    val live = track == null && (now.live ?: status.isLive)
    val remote = controller.options.remoteCommands

    val commands = availableCommands(status.seekable, remote)

    val metadata =
      MediaMetadata.Builder()
        .setTitle(now.title)
        .setArtist(now.artist)
        .setAlbumTitle(now.album)
        .also { setArtwork(it, now.artwork) }
        .setIsPlayable(true)
        .setIsBrowsable(false)
        .setMediaType(if (status.isLive) MediaMetadata.MEDIA_TYPE_RADIO_STATION else MediaMetadata.MEDIA_TYPE_MUSIC)
        .build()
    val itemBuilder =
      MediaItemData.Builder("anythingplayer")
        .setMediaItem(MediaItem.Builder().setMediaId("anythingplayer").setMediaMetadata(metadata).build())
        .setMediaMetadata(metadata)
        .setIsSeekable(status.seekable)
        .setIsDynamic(live)
        .setDurationUs(
          (track?.duration ?: status.duration)?.let { (it * 1_000_000).toLong() } ?: C.TIME_UNSET
        )
    if (live) itemBuilder.setLiveConfiguration(MediaItem.LiveConfiguration.Builder().build())

    val interruption = status.interruption
    val builder =
      State.Builder()
        .setAvailableCommands(commands)
        .setPlaylist(listOf(itemBuilder.build()))
        .setCurrentMediaItemIndex(0)
        .setPlaybackParameters(PlaybackParameters(status.rate.toFloat()))
        .setContentPositionMs(
          if (playing) {
            PositionSupplier.getExtrapolating(positionMs, positionRate)
          } else {
            PositionSupplier.getConstant(positionMs)
          }
        )
    when (status.state) {
      PlaybackState.LOADING, PlaybackState.BUFFERING, PlaybackState.RECONNECTING ->
        builder.setPlaybackState(Player.STATE_BUFFERING).setPlayWhenReady(status.playWhenReady, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      PlaybackState.PLAYING ->
        builder.setPlaybackState(Player.STATE_READY).setPlayWhenReady(true, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      PlaybackState.PAUSED ->
        if (interruption != null && interruption.resumable) {
          // A call / transient focus loss: still "wanted", so Media3 keeps the
          // foreground service and the resume can start from the background.
          builder
            .setPlaybackState(Player.STATE_READY)
            .setPlayWhenReady(true, Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_FOCUS_LOSS)
            .setPlaybackSuppressionReason(Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS)
        } else {
          builder.setPlaybackState(Player.STATE_READY).setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
        }
      PlaybackState.ENDED -> builder.setPlaybackState(Player.STATE_ENDED).setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_END_OF_MEDIA_ITEM)
      PlaybackState.STOPPED, PlaybackState.IDLE -> builder.setPlaybackState(Player.STATE_IDLE).setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
      PlaybackState.ERROR -> {
        builder.setPlaybackState(Player.STATE_IDLE).setPlayWhenReady(false, Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST)
        status.error?.let { builder.setPlayerError(PlaybackException(it.message, null, PlaybackException.ERROR_CODE_UNSPECIFIED)) }
      }
    }
    return builder.build()
  }

  private fun availableCommands(seekable: Boolean, remote: Set<String>): Player.Commands {
    val commands =
      Player.Commands.Builder()
        .addAll(
          Player.COMMAND_PLAY_PAUSE,
          Player.COMMAND_STOP,
          Player.COMMAND_PREPARE,
          Player.COMMAND_GET_CURRENT_MEDIA_ITEM,
          Player.COMMAND_GET_METADATA,
          Player.COMMAND_GET_TIMELINE,
          Player.COMMAND_RELEASE,
        )
    // Voice: an assistant can replace what plays with something from the catalog.
    if (Voice.hasItems()) commands.addAll(Player.COMMAND_SET_MEDIA_ITEM, Player.COMMAND_CHANGE_MEDIA_ITEMS)
    if (seekable) commands.add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
    if ("next" in remote) commands.addAll(Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
    if ("previous" in remote) commands.addAll(Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
    if ("skipForward" in remote) commands.add(Player.COMMAND_SEEK_FORWARD)
    if ("skipBackward" in remote) commands.add(Player.COMMAND_SEEK_BACK)

    return commands.build()
  }

  private fun contentPosition(track: TrackProgress?, reading: ProgressSnapshot, elapsed: Long, playing: Boolean, rate: Double): Long =
      if (track != null) {
        val sinceMs = if (playing) (AndroidClock.monotonicMs - track.atMonotonic).coerceAtLeast(0) else 0L
        ((track.elapsed * 1000).toLong() + sinceMs).coerceAtMost((track.duration * 1000).toLong())
      } else {
        (reading.reading.position * 1000).toLong() + if (playing) (elapsed * rate).toLong() else 0L
      }

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
    AnythingPlayerRuntime.remote(if (playWhenReady) "play" else "pause")
    return Futures.immediateVoidFuture()
  }

  /** With nothing loaded, an assistant's `prepare()` stages what "play" would play. */
  override fun handlePrepare(): ListenableFuture<*> {
    if (Voice.nothingLoaded()) Voice.playDefault(autoplay = false)
    return Futures.immediateVoidFuture()
  }

  /**
   * An assistant set an item (already resolved to the catalog by the library
   * callback): load it, paused. The `play()` that follows starts it.
   */
  override fun handleSetMediaItems(mediaItems: MutableList<MediaItem>, startIndex: Int, startPositionMs: Long): ListenableFuture<*> {
    val chosen = mediaItems.getOrNull(startIndex.coerceAtLeast(0)) ?: mediaItems.firstOrNull()
    val entry = chosen?.let { Voice.entry(it.mediaId) }
    if (entry == null) {
      Log.w("RNAP", "assistant set an item that is not in the catalog: ${chosen?.mediaId}")
      return Futures.immediateVoidFuture()
    }
    val request = Voice.takeResolvedRequest() ?: SearchRequest(entry.title, origin = "assistant")
    try {
      val start = if (startPositionMs != C.TIME_UNSET && startPositionMs > 0) startPositionMs / 1000.0 else null
      Voice.load(Voice.voicePlayer(null), entry, request, autoplay = false, startSeconds = start, completion = null)
    } catch (error: PlayerError) {
      Log.w("RNAP", "assistant request failed: ${error.message}")
    }
    return Futures.immediateVoidFuture()
  }

  override fun handleStop(): ListenableFuture<*> {
    AnythingPlayerRuntime.remote("stop")
    return Futures.immediateVoidFuture()
  }

  override fun handleRelease(): ListenableFuture<*> = Futures.immediateVoidFuture()

  override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
    when (seekCommand) {
      Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> AnythingPlayerRuntime.remote("next")
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> AnythingPlayerRuntime.remote("previous")
      Player.COMMAND_SEEK_FORWARD -> AnythingPlayerRuntime.remote("skipForward")
      Player.COMMAND_SEEK_BACK -> AnythingPlayerRuntime.remote("skipBackward")
      else -> AnythingPlayerRuntime.remote("seek", positionMs / 1000.0)
    }
    return Futures.immediateVoidFuture()
  }
}
