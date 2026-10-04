package com.radioanimu.airwave.platform

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService

/**
 * Hosts the Media3 session that powers the media notification, lock screen,
 * headset/Bluetooth buttons and car/Wear controllers, and keeps the process in
 * the foreground (type `mediaPlayback`) while playback is engaged. Media3
 * decides when to start/stop the foreground state from [SessionPlayer]'s state.
 */
@OptIn(UnstableApi::class)
class AirwavePlaybackService : MediaSessionService() {
  private var session: MediaSession? = null

  override fun onCreate() {
    super.onCreate()
    val player = SessionPlayer()
    val builder = MediaSession.Builder(this, player).setId("airwave")
    // Tapping the notification opens the app (the session activity is the
    // notification's content intent; without it the tap does nothing).
    packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      builder.setSessionActivity(
        PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      )
    }
    session = builder.build()
    // Optional: how long a paused session stays in the foreground (Media3
    // default and maximum: 10 min). `<meta-data
    // android:name="com.radioanimu.airwave.FOREGROUND_TIMEOUT_MS" android:value="…"/>`
    foregroundTimeoutFromManifest()?.let { setForegroundServiceTimeoutMs(it) }
    setListener(
      object : Listener {
        override fun onForegroundServiceStartNotAllowedException() {
          Log.w("Airwave", "Android refused to start the media foreground service from the background")
        }
      }
    )
    AirwaveRuntime.attachService(this, player)
  }

  private fun foregroundTimeoutFromManifest(): Long? =
    try {
      val info = packageManager.getApplicationInfo(packageName, android.content.pm.PackageManager.GET_META_DATA)
      info.metaData?.getInt("com.radioanimu.airwave.FOREGROUND_TIMEOUT_MS", -1)?.takeIf { it > 0 }?.toLong()
    } catch (_: Exception) {
      null
    }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Only the app's own task matters (an auxiliary task — e.g. an auth
    // browser — being removed must not stop playback).
    val removed = rootIntent?.component
    val appTask = packageManager.getLaunchIntentForPackage(packageName)?.component
    if (removed != null && appTask != null && removed != appTask) return
    if (AirwaveRuntime.onTaskRemoved()) pauseAllPlayersAndStopSelf()
  }

  internal fun stopForegroundAndSelf() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    AirwaveRuntime.detachService(this)
    session?.run {
      player.release()
      release()
    }
    session = null
    super.onDestroy()
  }
}
