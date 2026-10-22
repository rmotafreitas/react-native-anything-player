package com.anythingplayer.cast

import android.content.Context
import android.content.pm.PackageManager
import com.google.android.gms.cast.CastMediaControlIntent
import com.google.android.gms.cast.framework.CastOptions
import com.google.android.gms.cast.framework.OptionsProvider
import com.google.android.gms.cast.framework.SessionProvider
import com.google.android.gms.cast.framework.media.CastMediaOptions

/**
 * Cast options for RNAP. The receiver is the app's `CAST_RECEIVER_ID`
 * (`<meta-data android:name="com.anythingplayer.CAST_RECEIVER_ID" …/>`), else
 * Google's Default Media Receiver.
 *
 * The Cast SDK's own media notification and media session are off: RNAP's
 * session (Media3) is the only one the user sees. The engine owns what plays
 * where, so a saved session is not resumed on its own.
 */
class RnapCastOptionsProvider : OptionsProvider {
  override fun getCastOptions(context: Context): CastOptions =
    CastOptions.Builder()
      .setReceiverApplicationId(receiverId(context))
      .setCastMediaOptions(CastMediaOptions.Builder().setNotificationOptions(null).setMediaSessionEnabled(false).build())
      .setResumeSavedSession(false)
      .setEnableReconnectionService(false)
      .setStopReceiverApplicationWhenEndingSession(true)
      // The system Output Switcher can hand the audio back to the phone.
      .setRemoteToLocalEnabled(true)
      .build()

  override fun getAdditionalSessionProviders(context: Context): List<SessionProvider>? = null

  companion object {
    const val RECEIVER_ID_KEY = "com.anythingplayer.CAST_RECEIVER_ID"

    internal fun receiverId(context: Context): String =
      try {
        val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
        info.metaData?.getString(RECEIVER_ID_KEY)?.trim()?.takeIf { it.isNotEmpty() }
      } catch (_: PackageManager.NameNotFoundException) {
        null
      } ?: CastMediaControlIntent.DEFAULT_MEDIA_RECEIVER_APPLICATION_ID
  }
}
