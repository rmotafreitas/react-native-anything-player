package com.radioanimu.airwave.platform

import android.app.Activity
import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import com.google.common.util.concurrent.ListenableFuture
import com.radioanimu.airwave.core.FocusResult
import com.radioanimu.airwave.core.InterruptionReason
import com.radioanimu.airwave.core.NetworkState
import com.radioanimu.airwave.core.PlaybackState
import com.radioanimu.airwave.core.PlayerError
import java.util.concurrent.ConcurrentHashMap

private const val TAG = "Airwave"
private const val RECOVERY_WAKE_LOCK_MS = 10 * 60 * 1000L
private const val FOCUS_RETRY_MS = 500L
private const val FOCUS_RETRY_ATTEMPTS = 8

/**
 * Process-wide coordination shared by every player: audio focus (one per app),
 * connectivity, app foreground state, the recovery wake lock, and the Media3
 * session service. Everything mutating runs on the main thread; [players] is
 * also read from the JS thread by the synchronous getters.
 */
@OptIn(UnstableApi::class)
internal object AirwaveRuntime : FocusListener {
  private val main = Handler(Looper.getMainLooper())
  private lateinit var appContext: Context
  private var initialized = false

  val players = ConcurrentHashMap<String, PlayerController>()

  private lateinit var focus: AudioFocusCoordinator
  private lateinit var network: NetworkMonitor
  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null
  private var startedActivities = 0

  /** The player the system media controls show and control. */
  @Volatile var active: PlayerController? = null
    private set

  private var controllerFuture: ListenableFuture<MediaController>? = null
  private var sessionPlayer: SessionPlayer? = null
  private var service: AirwavePlaybackService? = null

  val networkState: NetworkState
    get() = if (initialized) network.state else NetworkState.UNKNOWN

  /** Main thread. Idempotent. */
  fun initialize(context: Context) {
    if (initialized) return
    initialized = true
    appContext = context.applicationContext
    focus = AudioFocusCoordinator(appContext, this)
    network = NetworkMonitor(appContext) { state, changed -> players.values.forEach { it.engine.networkChanged(state, changed) } }
    network.start()
    (appContext as? Application)?.registerActivityLifecycleCallbacks(foregroundTracker)
  }

  fun register(controller: PlayerController) {
    players[controller.id] = controller
    controller.engine.networkChanged(network.state, false)
    controller.prewarm()
  }

  /** Main thread. */
  fun unregister(controller: PlayerController) {
    players.remove(controller.id)
    if (active === controller) active = players.values.lastOrNull { it.options.mediaSession && it.status.state != PlaybackState.IDLE }
    refresh()
  }

  // ── Focus ──

  fun requestFocus(controller: PlayerController): FocusResult {
    if (controller.options.mixWithOthers) return FocusResult.GRANTED
    val result = focus.request(controller.options.speech, false)
    if (result == FocusResult.DENIED && startedActivities == 0) {
      // Android 15+: only the top app or an app with a foreground service may
      // take audio focus. A start requested from the background (headset,
      // notification, a load right after a cold start) is therefore refused
      // until Media3 has promoted our service. Keep the intent ("delayed"),
      // let the session facade report it as wanted (that promotes the
      // service), and retry briefly.
      scheduleFocusRetry(controller, attempt = 1)
      return FocusResult.DELAYED
    }
    return result
  }

  private fun scheduleFocusRetry(controller: PlayerController, attempt: Int) {
    main.postDelayed(
      {
        if (players[controller.id] !== controller) return@postDelayed
        val pending = controller.status.interruption
        if (pending?.reason != InterruptionReason.AUDIO_FOCUS_DELAYED) return@postDelayed
        when (focus.request(controller.options.speech, false)) {
          FocusResult.GRANTED -> controller.engine.interruptionEnded(shouldResume = true)
          FocusResult.DELAYED -> Unit // the system will call back with GAIN
          FocusResult.DENIED ->
            if (attempt < FOCUS_RETRY_ATTEMPTS) scheduleFocusRetry(controller, attempt + 1)
            else controller.engine.interruptionEnded(shouldResume = false)
        }
      },
      FOCUS_RETRY_MS,
    )
  }

  override fun onFocusLost(transient: Boolean) {
    val reason = if (transient) InterruptionReason.AUDIO_FOCUS_LOSS_TRANSIENT else InterruptionReason.AUDIO_FOCUS_LOSS
    players.values.filter { !it.options.mixWithOthers }.forEach { it.engine.interruptionBegan(reason, transient) }
  }

  override fun onFocusGained() {
    players.values.forEach {
      it.engine.setDucked(false)
      it.engine.interruptionEnded(shouldResume = true)
    }
  }

  override fun onDuck(ducked: Boolean) {
    players.values.filter { !it.options.mixWithOthers }.forEach { it.engine.setDucked(ducked) }
  }

  // ── State fan-in ──

  fun onStatusChanged(controller: PlayerController) {
    val status = controller.status
    if (controller.options.mediaSession && status.playWhenReady) active = controller
    if (active == null && controller.options.mediaSession && status.state != PlaybackState.IDLE) active = controller
    refresh()
  }

  fun onNowPlayingChanged(controller: PlayerController) {
    if (controller === active) sessionPlayer?.refresh()
  }

  private fun refresh() {
    if (!initialized) return
    // Focus: give it back as soon as nobody needs it.
    if (focus.isRegistered && players.values.none { !it.options.mixWithOthers && it.engine.needsAudioFocus }) {
      focus.abandon()
    }
    updateRecoveryLocks()
    updateService()
    sessionPlayer?.refresh()
  }

  /**
   * ExoPlayer holds its wake/Wi-Fi locks only while it is buffering or playing
   * with play intent. Between reconnect attempts it is idle, so with the
   * screen off the CPU could sleep through the backoff. Hold our own (bounded)
   * locks while any player wants audio that is not flowing.
   */
  private fun updateRecoveryLocks() {
    val wanted = players.values.any { it.engine.wantsKeepalive }
    try {
      if (wanted) {
        val wl =
          wakeLock
            ?: (appContext.getSystemService(Context.POWER_SERVICE) as PowerManager)
              .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "airwave:recovery")
              .also {
                it.setReferenceCounted(false)
                wakeLock = it
              }
        wl.acquire(RECOVERY_WAKE_LOCK_MS)
        val wifi =
          wifiLock
            ?: (appContext.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager)
              ?.let {
                @Suppress("DEPRECATION")
                it.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "airwave:recovery")
              }
              ?.also {
                it.setReferenceCounted(false)
                wifiLock = it
              }
        if (wifi?.isHeld == false) wifi.acquire()
      } else {
        if (wakeLock?.isHeld == true) wakeLock?.release()
        if (wifiLock?.isHeld == true) wifiLock?.release()
      }
    } catch (e: SecurityException) {
      Log.w(TAG, "recovery wake lock unavailable: ${e.message}")
    }
  }

  // ── Media session service ──

  private fun wantsService(): Boolean =
    players.values.any {
      it.options.mediaSession &&
        (it.engine.needsAudioFocus ||
          it.status.state == PlaybackState.PAUSED ||
          it.status.state == PlaybackState.BUFFERING ||
          it.status.state == PlaybackState.PLAYING)
    }

  private fun updateService() {
    if (wantsService()) {
      if (controllerFuture == null) {
        // Connecting a controller binds (and creates) the service; Media3 then
        // promotes it to a foreground service whenever playback is engaged.
        val token = SessionToken(appContext, ComponentName(appContext, AirwavePlaybackService::class.java))
        controllerFuture = MediaController.Builder(appContext, token).buildAsync()
      }
    } else if (controllerFuture != null && players.values.none { it.options.mediaSession && it.status.state != PlaybackState.IDLE && it.status.state != PlaybackState.STOPPED && it.status.state != PlaybackState.ERROR && it.status.state != PlaybackState.ENDED }) {
      releaseService()
    }
  }

  private fun releaseService() {
    controllerFuture?.let { MediaController.releaseFuture(it) }
    controllerFuture = null
    service?.stopForegroundAndSelf()
  }

  fun attachService(service: AirwavePlaybackService, player: SessionPlayer) {
    this.service = service
    sessionPlayer = player
  }

  fun detachService(service: AirwavePlaybackService) {
    if (this.service === service) {
      this.service = null
      sessionPlayer = null
    }
  }

  /** The user swiped the app away from recents. */
  fun onTaskRemoved(): Boolean {
    val stop = players.values.any { it.options.stopOnTaskRemoved } || players.values.none { it.engine.playWhenReady }
    if (stop) {
      players.values.forEach { runCatching { it.engine.pause() } }
      controllerFuture?.let { MediaController.releaseFuture(it) }
      controllerFuture = null
    }
    return stop
  }

  /** A command from the system media controls (lock screen, headset, car, Bluetooth). */
  fun remote(command: String, position: Double? = null) {
    val target = active ?: return
    try {
      when (command) {
        "play" -> target.engine.play()
        "pause" -> target.engine.pause()
        "stop" -> target.engine.stop()
        "seek" -> position?.let { target.engine.seek(it) }
        else -> Unit
      }
    } catch (e: PlayerError) {
      Log.w(TAG, "remote $command refused: ${e.code.wire} ${e.message}")
    }
    // Commands the app opted into are also forwarded to JS (next/previous have
    // no native meaning: a radio app maps them to station switching).
    if (command in target.options.remoteCommands) target.emitRemoteCommand(command, position)
  }

  // ── App foreground ──

  private val foregroundTracker =
    object : Application.ActivityLifecycleCallbacks {
      override fun onActivityStarted(activity: Activity) {
        startedActivities += 1
        if (startedActivities == 1) players.values.forEach { it.engine.appForegrounded() }
      }
      override fun onActivityStopped(activity: Activity) {
        startedActivities = (startedActivities - 1).coerceAtLeast(0)
      }
      override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
      override fun onActivityResumed(activity: Activity) = Unit
      override fun onActivityPaused(activity: Activity) = Unit
      override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
      override fun onActivityDestroyed(activity: Activity) = Unit
    }

  fun post(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
  }
}
