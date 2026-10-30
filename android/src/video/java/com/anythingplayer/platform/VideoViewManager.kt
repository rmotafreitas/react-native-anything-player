package com.anythingplayer.platform

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.viewmanagers.RNAPVideoViewManagerDelegate
import com.facebook.react.viewmanagers.RNAPVideoViewManagerInterface

/** The Fabric view behind `<VideoView>` (src/native/VideoViewNativeComponent.ts). */
@ReactModule(name = VideoViewManager.NAME)
internal class VideoViewManager :
  SimpleViewManager<VideoSurfaceView>(),
  RNAPVideoViewManagerInterface<VideoSurfaceView> {
  companion object {
    const val NAME = "RNAPVideoView"
  }

  private val delegate = RNAPVideoViewManagerDelegate(this)

  override fun getDelegate(): ViewManagerDelegate<VideoSurfaceView> = delegate

  override fun getName() = NAME

  override fun createViewInstance(context: ThemedReactContext) = VideoSurfaceView(context)

  override fun setPlayerId(view: VideoSurfaceView, value: String?) {
    view.playerId = value
  }

  override fun setContentFit(view: VideoSurfaceView, value: String?) {
    view.fit = ContentFit.fromWire(value)
  }

  /** RNAP's light controls (Android has no system player UI). */
  override fun setNativeControls(view: VideoSurfaceView, value: Boolean) {
    view.nativeControls = value
  }
}
