package com.anythingplayer.platform

import com.facebook.react.bridge.ReadableMap
import com.anythingplayer.core.MediaTrack
import com.anythingplayer.core.Status

/** What a video load brings besides the source: its poster, its subtitle files and their session. */
internal data class VideoLoadParts(
  val poster: String? = null,
  /** The JS loader's session: cues sent for another one are stale. */
  val session: String? = null,
  val subtitles: List<MediaTrack> = emptyList(),
)

/**
 * A video player's picture side: its ExoPlayers (the one on screen and the one
 * a quality switch prepares), the views that show them, fullscreen, Picture in
 * Picture and the subtitle overlay. Built by [VideoSupport] (`src/video`, the
 * `rnapVideo` build switch); without the switch there is none and video
 * players are refused.
 */
internal interface VideoPicture {
  /** What the engine plays through (wrapped by the routing driver). */
  val output: Output

  /** The ExoPlayer on screen. */
  val primary: ExoPlayerDriver

  /** Every ExoPlayer, the one on screen first. */
  val drivers: List<ExoPlayerDriver>

  /** A new load: its poster and subtitle session. */
  fun load(parts: VideoLoadParts)

  /** The engine published a status. */
  fun statusChanged(status: Status)

  /** The picture's size changed. */
  fun pictureChanged()

  /** Cues of the source's own text track, now. */
  fun sourceCues(cues: List<OverlayCue>)

  /** Playback jumped: subtitles place themselves again. */
  fun positionJumped()

  /** `cues`, `fullscreen`, `pictureInPicture` (main thread; throws a `PlayerError`). */
  fun command(op: String, command: ReadableMap)

  fun destroy()
}
