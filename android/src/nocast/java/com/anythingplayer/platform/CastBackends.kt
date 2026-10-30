package com.anythingplayer.platform

import android.app.Activity
import android.content.Context
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.PlayerError

// The build without Google Cast (the default): no Cast SDK is linked and Cast
// reports `unavailable`. `src/cast` holds the real integration, compiled in
// instead of this file with `rnapCast=true` (see `android/build.gradle`).

/** The Cast integration this build has. Chosen at build time: `src/cast` or `src/nocast`. */
internal object CastBackends {
  fun create(context: Context, host: CastHost): CastBackend = UnavailableCastBackend
}

private object UnavailableCastBackend : CastBackend {
  override val status = CastStatus.UNAVAILABLE

  override fun newOutput(observer: DriverObserver, nowPlaying: () -> NowPlaying, media: () -> CastMedia): RemoteOutput? = null

  override fun showPicker(activity: Activity?) {
    throw PlayerError(
      ErrorCode.CAST_UNAVAILABLE,
      "Google Cast is not built in. Set `rnapCast=true` in gradle.properties (or the Expo plugin's `cast` option) and rebuild.",
      false,
    )
  }

  override fun stopCasting() = Unit

  override fun deviceVolume(): Double? = null

  override fun setDeviceVolume(volume: Double) = Unit
}
