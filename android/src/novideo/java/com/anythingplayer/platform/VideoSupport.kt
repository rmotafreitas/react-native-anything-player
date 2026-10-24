package com.anythingplayer.platform

import android.app.Activity
import android.content.Context
import android.view.View
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.viewmanagers.RNAPVideoViewManagerDelegate
import com.facebook.react.viewmanagers.RNAPVideoViewManagerInterface

// The build without the video module (the default): no video player can be
// created (`status.video` is null, so JS throws VIDEO_UNAVAILABLE saying how
// to turn it on), and `<VideoView>` is an empty box. `src/video` holds the
// implementation, compiled in instead of this file with `rnapVideo=true` (see
// `android/build.gradle`).

/** The video module this build has. Chosen at build time: `src/video` or `src/novideo`. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
internal object VideoSupport {
  const val AVAILABLE = false

  fun create(
    context: Context,
    controller: PlayerController,
    make: (DriverObserver) -> ExoPlayerDriver,
  ): VideoPicture? = null

  fun activityResumed(activity: Activity) = Unit

  fun playerRegistered() = Unit

  fun renderers(
    context: Context,
    codecs: androidx.media3.exoplayer.mediacodec.MediaCodecAdapter.Factory,
    handler: android.os.Handler,
    video: androidx.media3.exoplayer.video.VideoRendererEventListener,
    text: androidx.media3.exoplayer.text.TextOutput,
  ): Array<androidx.media3.exoplayer.Renderer> = emptyArray()

  fun viewManagers(): List<ViewManager<*, *>> = listOf(EmptyVideoViewManager())
}

/** `<VideoView>` without the video module: a box, so a stray one never breaks the screen. */
private class EmptyVideoViewManager :
  SimpleViewManager<View>(),
  RNAPVideoViewManagerInterface<View> {
  private val delegate = RNAPVideoViewManagerDelegate(this)

  override fun getDelegate(): ViewManagerDelegate<View> = delegate

  override fun getName() = "RNAPVideoView"

  override fun createViewInstance(context: ThemedReactContext) = View(context)

  override fun setPlayerId(view: View, value: String?) = Unit

  override fun setContentFit(view: View, value: String?) = Unit

  override fun setNativeControls(view: View, value: Boolean) = Unit
}
