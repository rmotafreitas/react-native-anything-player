package com.anythingplayer.platform

import android.app.Activity
import android.content.Context
import android.os.Handler
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.mediacodec.MediaCodecAdapter
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.text.TextOutput
import androidx.media3.exoplayer.text.TextRenderer
import androidx.media3.exoplayer.video.MediaCodecVideoRenderer
import androidx.media3.exoplayer.video.VideoRendererEventListener
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.text.DefaultSubtitleParserFactory
import com.facebook.react.uimanager.ViewManager

// The build with the video module (`rnapVideo=true`, see `android/build.gradle`):
// video players, `<VideoView>`, fullscreen and Picture in Picture.
// `src/novideo` holds the stubs compiled in instead without the switch.

/** How long a seamless switch may wait for the next keyframe, ms (Media3's default). */
private const val ALLOWED_JOINING_TIME_MS = 5_000L

/** Report dropped frames in batches of this many (Media3's default). */
private const val MAX_DROPPED_FRAMES_TO_NOTIFY = 50

/** The video module this build has. Chosen at build time: `src/video` or `src/novideo`. */
@OptIn(UnstableApi::class)
internal object VideoSupport {
  const val AVAILABLE = true

  /** Any thread: builds no view. */
  fun create(
    context: Context,
    controller: PlayerController,
    make: (DriverObserver) -> ExoPlayerDriver,
  ): VideoPicture? = VideoOutput(context, controller, make)

  fun activityResumed(activity: Activity) = PictureInPicture.activityResumed(activity)

  /** A player was registered: `<VideoView>`s mounted before it attach now. */
  fun playerRegistered() = VideoSurfaceView.playerRegistered()

  fun viewManagers(): List<ViewManager<*, *>> = listOf(VideoViewManager())

  /**
   * A video's own subtitles (Matroska's SubRip, ASS and WebVTT, MP4's
   * tx3g and TTML) are parsed as they are extracted, into the cues the text
   * renderer takes; without it Media3 1.4+ lists them as unsupported.
   */
  fun subtitles(extractors: DefaultExtractorsFactory): DefaultExtractorsFactory =
    extractors.setTextTrackTranscodingEnabled(true).setSubtitleParserFactory(DefaultSubtitleParserFactory())

  /**
   * A video player's picture and text renderers. Decoder fallback is on: a
   * device whose first decoder fails to set up tries the next one.
   */
  fun renderers(
    context: Context,
    codecs: MediaCodecAdapter.Factory,
    handler: Handler,
    video: VideoRendererEventListener,
    text: TextOutput,
  ): Array<Renderer> =
    arrayOf(
      MediaCodecVideoRenderer(
        context,
        codecs,
        MediaCodecSelector.DEFAULT,
        ALLOWED_JOINING_TIME_MS,
        /* enableDecoderFallback= */ true,
        handler,
        video,
        MAX_DROPPED_FRAMES_TO_NOTIFY,
      ),
      TextRenderer(text, handler.looper),
    )
}
