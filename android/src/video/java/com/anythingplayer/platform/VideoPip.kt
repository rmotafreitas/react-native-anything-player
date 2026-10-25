package com.anythingplayer.platform

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.util.Rational
import androidx.activity.ComponentActivity
import androidx.annotation.RequiresApi
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.PlayerError
import java.lang.ref.WeakReference
import java.util.Collections
import java.util.WeakHashMap

private const val TAG = "RNAP"

/** Android's limits on a Picture in Picture window's aspect. */
private val MAX_ASPECT = Rational(239, 100)
private val MIN_ASPECT = Rational(100, 239)

private const val MANIFEST_HINT =
  "Picture in Picture is off for this activity: add android:supportsPictureInPicture=\"true\" to it in " +
    "AndroidManifest.xml (the Expo plugin's `video` option does it; `npx rnap add video` prints the lines)."

/**
 * Picture in Picture on Android: the activity's PiP mode, one per app. The
 * player that asked (`startPictureInPicture()`), or the one
 * `whenBackgrounded: 'pip'` takes there when the user leaves the app
 * (Android 12+: the system's auto-enter, from the view's place on screen;
 * Android 8–11: on the user-leave hint), moves its picture into a host over
 * the whole activity while the window is small. Main thread.
 */
internal object PictureInPicture {
  /** The player in Picture in Picture, or entering it. */
  private var owner: VideoOutput? = null
  private var active = false
  private var pipActivity: WeakReference<Activity>? = null
  private val listened: MutableSet<Activity> = Collections.newSetFromMap(WeakHashMap())
  /** The auto-enter parameters last given to the activity. */
  private var lastParams: String? = null
  private var armed = false
  /** The activity refused PiP parameters (no `supportsPictureInPicture`): stop asking. */
  private var refused = false

  fun supported(context: Context): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  /** An activity came to the front: listen to it, and give it the current auto-enter parameters. */
  fun activityResumed(activity: Activity) {
    listen(activity)
    lastParams = null
    update()
  }

  /** `startPictureInPicture()`. */
  fun start(output: VideoOutput) {
    val activity =
      AnythingPlayerRuntime.foregroundActivity
        ?: throw PlayerError(ErrorCode.INVALID_ARGUMENT, "Picture in Picture needs the app on screen.", false)
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !supported(activity)) {
      throw PlayerError(ErrorCode.INVALID_ARGUMENT, "This device has no Picture in Picture.", false)
    }
    if (active && owner === output) return
    enter(output, activity)
  }

  /** `stopPictureInPicture()`: back to the app, full size. */
  fun stop(output: VideoOutput) {
    if (!active || owner !== output) return
    val activity = pipActivity?.get() ?: return
    activity.startActivity(Intent(activity, activity.javaClass).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
  }

  /** A released player gives up the window. */
  fun forget(output: VideoOutput) {
    if (owner === output) owner = null
    update()
  }

  @RequiresApi(Build.VERSION_CODES.O)
  private fun enter(output: VideoOutput, activity: Activity) {
    listen(activity)
    owner = output
    val entered =
      try {
        activity.enterPictureInPictureMode(params(output.pipShape(), autoEnter = false))
      } catch (error: IllegalStateException) {
        owner = null
        throw PlayerError(ErrorCode.INVALID_ARGUMENT, MANIFEST_HINT, false)
      }
    if (!entered) {
      owner = null
      throw PlayerError(
        ErrorCode.INVALID_ARGUMENT,
        "The system refused Picture in Picture (it may be turned off for this app in Settings).",
        false,
      )
    }
  }

  /** The player `whenBackgrounded: 'pip'` would take into Picture in Picture now. */
  private fun candidate(): VideoOutput? =
    AnythingPlayerRuntime.players.values.mapNotNull { it.picture as? VideoOutput }.lastOrNull { it.wantsAutoPip }

  /**
   * Android 12+: arms (or disarms) auto-enter with the candidate's shape.
   * Cheap when nothing changed: the activity is only told about changes.
   */
  fun update() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || refused || active) return
    val activity = AnythingPlayerRuntime.foregroundActivity ?: return
    val candidate = candidate()
    if (candidate == null && !armed) return
    // The activity may have resumed before the runtime watched resumes.
    listen(activity)
    val shape = candidate?.pipShape()
    val key = if (shape == null) "off" else "on ${shape.width}x${shape.height} ${shape.sourceRect}"
    if (key == lastParams) return
    lastParams = key
    try {
      activity.setPictureInPictureParams(
        if (shape == null) PictureInPictureParams.Builder().setAutoEnterEnabled(false).build() else params(shape, autoEnter = true)
      )
      armed = shape != null
    } catch (error: IllegalStateException) {
      refused = true
      Log.w(TAG, "whenBackgrounded 'pip': $MANIFEST_HINT")
    } catch (error: IllegalArgumentException) {
      Log.w(TAG, "Picture in Picture parameters refused: ${error.message}")
    }
  }

  @RequiresApi(Build.VERSION_CODES.O)
  private fun params(shape: PipShape, autoEnter: Boolean): PictureInPictureParams {
    var aspect = Rational(shape.width.coerceAtLeast(1), shape.height.coerceAtLeast(1))
    if (aspect > MAX_ASPECT) aspect = MAX_ASPECT
    if (aspect < MIN_ASPECT) aspect = MIN_ASPECT
    val builder = PictureInPictureParams.Builder().setAspectRatio(aspect)
    shape.sourceRect?.let { builder.setSourceRectHint(it) }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setAutoEnterEnabled(autoEnter)
      // A video resizes by its aspect, not by the activity's layout.
      builder.setSeamlessResizeEnabled(false)
    }
    return builder.build()
  }

  private fun listen(activity: Activity) {
    if (!listened.add(activity)) return
    val component = activity as? ComponentActivity ?: return
    component.addOnPictureInPictureModeChangedListener { info -> modeChanged(activity, info.isInPictureInPictureMode) }
    // Android 8–11 have no auto-enter: the user leaving the app is the moment.
    // The listener is androidx.activity 1.9+; React Native pins an older one,
    // so it is looked up (apps on a newer one get it).
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      runCatching {
        ComponentActivity::class.java
          .getMethod("addOnUserLeaveHintListener", Runnable::class.java)
          .invoke(component, Runnable { userLeaving(activity) })
      }.onFailure { Log.i(TAG, "whenBackgrounded 'pip' on Android 8–11 needs androidx.activity 1.9+.") }
    }
  }

  private fun userLeaving(activity: Activity) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S || active || refused) return
    val candidate = candidate() ?: return
    if (!supported(activity)) return
    try {
      enter(candidate, activity)
    } catch (error: PlayerError) {
      refused = true
      Log.w(TAG, "whenBackgrounded 'pip': ${error.message}")
    }
  }

  private fun modeChanged(activity: Activity, inPip: Boolean) {
    if (inPip == active) return
    active = inPip
    if (inPip) {
      pipActivity = WeakReference(activity)
      val target = owner ?: candidate() ?: return
      owner = target
      target.pictureInPictureStarted(activity)
    } else {
      pipActivity = null
      val target = owner
      owner = null
      lastParams = null
      target?.pictureInPictureEnded()
      update()
    }
  }
}
