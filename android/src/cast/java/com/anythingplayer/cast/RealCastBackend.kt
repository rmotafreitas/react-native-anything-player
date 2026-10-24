package com.anythingplayer.cast

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.media3.cast.Cast
import androidx.media3.cast.RemoteCastPlayer
import androidx.media3.cast.SessionAvailabilityListener
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.mediarouter.app.MediaRouteChooserDialog
import androidx.mediarouter.app.MediaRouteControllerDialog
import androidx.mediarouter.media.MediaRouteSelector
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.PlayerError
import com.anythingplayer.platform.CastBackend
import com.anythingplayer.platform.CastHost
import com.anythingplayer.platform.CastState
import com.anythingplayer.platform.CastStatus
import com.anythingplayer.platform.CastMedia
import com.anythingplayer.platform.DriverObserver
import com.anythingplayer.platform.NowPlaying
import com.anythingplayer.platform.RemoteOutput
import com.google.android.gms.cast.MediaError
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastSession
import com.google.android.gms.cast.framework.CastState as GmsCastState
import com.google.android.gms.cast.framework.SessionManagerListener
import com.google.android.gms.cast.framework.media.RemoteMediaClient

private const val TAG = "RNAP"

/**
 * Google Cast, on Media3's remote-only player.
 *
 * Media3's `RemoteCastPlayer` is the receiver as a `Player`: it loads, plays,
 * seeks and sets the stream volume on the Cast session's `RemoteMediaClient`.
 * (Media3's `CastPlayer` would also own the local/remote transfer; here the
 * engine does — `handoff` — so only the remote half is used.) What it does
 * not report is *why* a receiver went idle (ended, failed, taken over), so
 * [CastOutput] also reads the client's `MediaStatus`.
 *
 * One Cast session and one remote player exist for the app; the output of
 * the player the session follows (see `CastCoordinator`) owns them. Main thread.
 */
@OptIn(UnstableApi::class)
internal class RealCastBackend(context: Context, private val host: CastHost) : CastBackend {
  private val app = context.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private var castContext: CastContext? = null

  @Volatile
  override var status: CastStatus = CastStatus(CastState.INITIALIZING, null)
    private set

  /** The receiver as a Media3 player: set once the Cast framework is up. */
  internal var player: RemoteCastPlayer? = null
    private set

  /** The session's media channel, while one is connected. */
  internal var client: RemoteMediaClient? = null
    private set

  private var owner: CastOutput? = null
  private var deviceName: String? = null
  private var gmsState = GmsCastState.NO_DEVICES_AVAILABLE
  private var awaiting: Pair<String, String>? = null

  init {
    try {
      Cast.getSingletonInstance(app).initialize()
      CastContext.getSharedInstance(app, ContextCompat.getMainExecutor(app)).addOnCompleteListener { task ->
        if (task.isSuccessful) onReady(task.result) else unavailable(task.exception)
      }
    } catch (e: RuntimeException) {
      unavailable(e)
    }
  }

  private fun unavailable(error: Throwable?) {
    Log.w(TAG, "Google Cast is unavailable: ${error?.message}")
    publish(CastStatus.UNAVAILABLE)
  }

  private fun onReady(context: CastContext) {
    castContext = context
    gmsState = context.castState
    context.addCastStateListener { state ->
      gmsState = state
      publish()
    }
    context.sessionManager.addSessionManagerListener(sessionListener, CastSession::class.java)
    player =
      RemoteCastPlayer.Builder(app).setMediaItemConverter(TextTrackConverter()).build().also {
        it.setSessionAvailabilityListener(availability)
        it.addListener(playerListener)
      }
    publish()
    context.sessionManager.currentCastSession?.takeIf { it.isConnected }?.let { sessionReady(it) }
  }

  // ── State ──

  private fun publish(next: CastStatus? = null) {
    val computed =
      next
        ?: when (gmsState) {
          GmsCastState.CONNECTED -> CastStatus(CastState.CONNECTED, deviceName)
          GmsCastState.CONNECTING -> CastStatus(CastState.CONNECTING, deviceName)
          GmsCastState.NOT_CONNECTED -> CastStatus(CastState.NOT_CONNECTED, null)
          else -> CastStatus(CastState.NO_DEVICES, null)
        }
    if (computed == status) return
    status = computed
    host.onCastStatus(computed)
  }

  private val sessionListener =
    object : SessionManagerListener<CastSession> {
      override fun onSessionStarting(session: CastSession) {
        deviceName = session.castDevice?.friendlyName
        publish()
      }

      override fun onSessionStarted(session: CastSession, sessionId: String) = sessionReady(session)

      override fun onSessionResuming(session: CastSession, sessionId: String) {
        deviceName = session.castDevice?.friendlyName
        publish()
      }

      override fun onSessionResumed(session: CastSession, wasSuspended: Boolean) = sessionReady(session)

      override fun onSessionStartFailed(session: CastSession, error: Int) {
        Log.w(TAG, "Cast session failed to start ($error)")
        deviceName = null
        publish()
      }

      override fun onSessionResumeFailed(session: CastSession, error: Int) {
        Log.w(TAG, "Cast session failed to resume ($error)")
        deviceName = null
        publish()
      }

      override fun onSessionEnding(session: CastSession) = Unit

      // The connection dropped; the SDK tries to bring it back (onSessionResumed) or ends it.
      override fun onSessionSuspended(session: CastSession, reason: Int) = Unit

      override fun onSessionEnded(session: CastSession, error: Int) {
        session.removeCastListener(castListener)
        listenedSession = null
        detachClient()
        awaiting = null
        deviceName = null
        publish()
        host.onCastSessionEnded()
      }
    }

  /**
   * The session is up. The runtime is told once Media3's player has the
   * session's client too (it listens to the same events, in no fixed order).
   */
  private fun sessionReady(session: CastSession) {
    val device = session.castDevice ?: return
    deviceName = device.friendlyName
    attachClient(session.remoteMediaClient)
    if (listenedSession !== session) {
      listenedSession?.removeCastListener(castListener)
      session.addCastListener(castListener)
      listenedSession = session
    }
    awaiting = device.deviceId to (device.friendlyName ?: device.deviceId)
    publish()
    main.post { deliver() }
  }

  private fun deliver() {
    val (id, name) = awaiting ?: return
    if (player?.isCastSessionAvailable != true) return
    awaiting = null
    host.onCastSessionStarted(id, name)
  }

  private val availability =
    object : SessionAvailabilityListener {
      override fun onCastSessionAvailable() = deliver()

      override fun onCastSessionUnavailable() = Unit
    }

  // ── The receiver's media ──

  private val clientCallback =
    object : RemoteMediaClient.Callback() {
      override fun onStatusUpdated() {
        owner?.requestEvaluation()
      }

      override fun onMediaError(error: MediaError) {
        owner?.mediaError(error)
      }
    }

  private val playerListener =
    object : Player.Listener {
      override fun onEvents(player: Player, events: Player.Events) {
        owner?.requestEvaluation()
      }
    }

  private val castListener =
    object : com.google.android.gms.cast.Cast.Listener() {
      override fun onVolumeChanged() = host.onCastVolumeChanged()
    }

  private var listenedSession: CastSession? = null

  private fun attachClient(next: RemoteMediaClient?) {
    if (client === next) return
    detachClient()
    client = next
    next?.registerCallback(clientCallback)
  }

  private fun detachClient() {
    client?.unregisterCallback(clientCallback)
    client = null
  }

  /** [output] now owns the receiver's media: events go to it. */
  internal fun claim(output: CastOutput) {
    owner = output
  }

  internal fun release(output: CastOutput) {
    if (owner === output) owner = null
  }

  // ── CastBackend ──

  override fun newOutput(observer: DriverObserver, nowPlaying: () -> NowPlaying, media: () -> CastMedia): RemoteOutput =
    CastOutput(this, observer, nowPlaying, media)

  override fun showPicker(activity: Activity?) {
    val context = castContext
    if (context == null) {
      val starting = status.state == CastState.INITIALIZING
      throw PlayerError(
        ErrorCode.CAST_UNAVAILABLE,
        if (starting) "Google Cast is still starting; try again in a moment." else "Google Cast is not available on this device.",
        starting,
      )
    }
    if (activity == null) throw PlayerError(ErrorCode.CAST_UNAVAILABLE, "The Cast dialog needs the app in the foreground.", true)
    if (status.state == CastState.CONNECTED || status.state == CastState.CONNECTING) {
      MediaRouteControllerDialog(activity).show()
    } else {
      MediaRouteChooserDialog(activity).apply { routeSelector = context.mergedSelector ?: MediaRouteSelector.EMPTY }.show()
    }
  }

  override fun stopCasting() {
    castContext?.sessionManager?.endCurrentSession(true)
  }

  override fun deviceVolume(): Double? =
    castContext?.sessionManager?.currentCastSession?.takeIf { it.isConnected }?.let { runCatching { it.volume }.getOrNull() }

  override fun setDeviceVolume(volume: Double) {
    castContext?.sessionManager?.currentCastSession?.takeIf { it.isConnected }?.let {
      try {
        it.volume = volume
      } catch (e: java.io.IOException) {
        Log.w(TAG, "receiver volume refused: ${e.message}")
      }
    }
  }
}
