package com.radioanimu.airwave.platform

import android.net.Uri
import android.os.Looper
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
import com.radioanimu.airwave.core.PlaybackState

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
  fun refresh() = invalidateState()

  override fun getState(): State {
    val controller = AirwaveRuntime.active
    val status = controller?.status
    if (controller == null || status == null || status.state == PlaybackState.IDLE) {
      return State.Builder()
        .setAvailableCommands(Player.Commands.EMPTY)
        .setPlaybackState(Player.STATE_IDLE)
        .build()
    }
    val now = controller.nowPlaying()
    val reading = controller.progress()
    val elapsed = (AndroidClock.monotonicMs - reading.takenAtMonotonic).coerceAtLeast(0)
    val positionMs = (reading.reading.position * 1000).toLong() + if (status.state == PlaybackState.PLAYING) (elapsed * status.rate).toLong() else 0L
    val remote = controller.options.remoteCommands

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
    if (status.seekable) commands.add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
    if ("next" in remote) commands.addAll(Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
    if ("previous" in remote) commands.addAll(Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
    if ("skipForward" in remote) commands.add(Player.COMMAND_SEEK_FORWARD)
    if ("skipBackward" in remote) commands.add(Player.COMMAND_SEEK_BACK)

    val metadata =
      MediaMetadata.Builder()
        .setTitle(now.title)
        .setArtist(now.artist)
        .setAlbumTitle(now.album)
        .setArtworkUri(now.artwork?.let(Uri::parse))
        .setIsPlayable(true)
        .setIsBrowsable(false)
        .setMediaType(if (status.isLive) MediaMetadata.MEDIA_TYPE_RADIO_STATION else MediaMetadata.MEDIA_TYPE_MUSIC)
        .build()
    val itemBuilder =
      MediaItemData.Builder("airwave")
        .setMediaItem(MediaItem.Builder().setMediaId("airwave").setMediaMetadata(metadata).build())
        .setMediaMetadata(metadata)
        .setIsSeekable(status.seekable)
        .setIsDynamic(status.isLive)
        .setDurationUs(status.duration?.let { (it * 1_000_000).toLong() } ?: C.TIME_UNSET)
    if (status.isLive) itemBuilder.setLiveConfiguration(MediaItem.LiveConfiguration.Builder().build())

    val interruption = status.interruption
    val builder =
      State.Builder()
        .setAvailableCommands(commands.build())
        .setPlaylist(listOf(itemBuilder.build()))
        .setCurrentMediaItemIndex(0)
        .setPlaybackParameters(PlaybackParameters(status.rate.toFloat()))
        .setContentPositionMs(
          if (status.state == PlaybackState.PLAYING) {
            PositionSupplier.getExtrapolating(positionMs, status.rate.toFloat())
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

  override fun handleSetPlayWhenReady(playWhenReady: Boolean): ListenableFuture<*> {
    AirwaveRuntime.remote(if (playWhenReady) "play" else "pause")
    return Futures.immediateVoidFuture()
  }

  override fun handlePrepare(): ListenableFuture<*> = Futures.immediateVoidFuture()

  override fun handleStop(): ListenableFuture<*> {
    AirwaveRuntime.remote("stop")
    return Futures.immediateVoidFuture()
  }

  override fun handleRelease(): ListenableFuture<*> = Futures.immediateVoidFuture()

  override fun handleSeek(mediaItemIndex: Int, positionMs: Long, seekCommand: Int): ListenableFuture<*> {
    when (seekCommand) {
      Player.COMMAND_SEEK_TO_NEXT, Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM -> AirwaveRuntime.remote("next")
      Player.COMMAND_SEEK_TO_PREVIOUS, Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM -> AirwaveRuntime.remote("previous")
      Player.COMMAND_SEEK_FORWARD -> AirwaveRuntime.remote("skipForward")
      Player.COMMAND_SEEK_BACK -> AirwaveRuntime.remote("skipBackward")
      else -> AirwaveRuntime.remote("seek", positionMs / 1000.0)
    }
    return Futures.immediateVoidFuture()
  }
}
