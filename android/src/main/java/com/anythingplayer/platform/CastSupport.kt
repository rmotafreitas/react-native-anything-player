package com.anythingplayer.platform

import android.app.Activity
import android.content.Context
import com.anythingplayer.core.AudioRoute
import com.anythingplayer.core.AudioRouteKind

/** `CastState` of the public API (`src/types.ts`). */
internal enum class CastState(val wire: String) {
  UNAVAILABLE("unavailable"),
  INITIALIZING("initializing"),
  NO_DEVICES("noDevices"),
  NOT_CONNECTED("notConnected"),
  CONNECTING("connecting"),
  CONNECTED("connected"),
}

internal data class CastStatus(val state: CastState, val device: String?) {
  companion object {
    val UNAVAILABLE = CastStatus(CastState.UNAVAILABLE, null)
  }
}

/** What the Cast integration tells the runtime. Main thread. */
internal interface CastHost {
  fun onCastStatus(status: CastStatus)

  /** A session is connected and the remote client usable. Also fires when a session resumes. */
  fun onCastSessionStarted(deviceId: String, deviceName: String)

  fun onCastSessionEnded()
}

/**
 * The Cast integration, behind one interface: the real one lives in
 * `src/cast` (built with `rnapCast=true`), a stub that reports `unavailable`
 * in `src/nocast`. The Cast SDK is never referenced from the main source set.
 */
internal interface CastBackend {
  val status: CastStatus

  /** An output for one player's routing driver. */
  fun newOutput(observer: DriverObserver, nowPlaying: () -> NowPlaying): RemoteOutput?

  /** The device chooser, or the dialog to stop while connected. Throws `CAST_UNAVAILABLE`. Main thread. */
  fun showPicker(activity: Activity?)

  fun stopCasting()

  /** The receiver's volume (0..1) while connected: what the hardware keys control. */
  fun deviceVolume(): Double?

  fun setDeviceVolume(volume: Double)
}

/** A player the Cast session can move to the receiver and back. */
internal interface CastTarget {
  /** Whether the loaded source can be reached by a receiver (`http(s)`); `null` when nothing is loaded. */
  val castableSource: Boolean?

  fun handoff(route: AudioRoute, outputId: String, resume: Boolean)

  /** The source cannot go to the receiver: say so (a non-fatal `CAST_UNSUPPORTED_SOURCE`). */
  fun castRefused()
}

/**
 * Which player the Cast session carries. The session follows the player on the
 * lock screen; everything else stays on the device. Pure policy over
 * [CastTarget]s — the engines do the moving (`handoff`). Main thread.
 *
 * - session starts: the active player moves to the receiver, keeping its intent;
 * - session ends: the carried player returns to the device, paused (never a
 *   surprise start from the phone's speaker);
 * - the same device resuming a session changes nothing;
 * - another player becomes active: the previous one returns (paused), the new
 *   one moves over;
 * - a source a receiver cannot reach (file, `content://`, bundled asset) stays
 *   on the device and reports `CAST_UNSUPPORTED_SOURCE`.
 */
internal class CastCoordinator(private val localRoute: () -> AudioRoute) {
  private var device: Pair<String, String>? = null
  private var carrier: CastTarget? = null

  val casting: Boolean
    get() = device != null

  fun sessionStarted(deviceId: String, name: String, active: CastTarget?) {
    val previous = device
    if (previous != null) {
      if (previous.first == deviceId) {
        device = deviceId to name
        return
      }
      sessionEnded()
    }
    device = deviceId to name
    active?.let(::moveToCast)
  }

  fun sessionEnded() {
    carrier?.handoff(localRoute(), LOCAL, resume = false)
    carrier = null
    device = null
  }

  fun activeChanged(active: CastTarget?) {
    if (device == null || active === carrier) return
    carrier?.handoff(localRoute(), LOCAL, resume = false)
    carrier = null
    active?.let(::moveToCast)
  }

  /**
   * A carried player is about to load a source: one a receiver cannot reach
   * returns the player to the device first, and plays there as asked.
   */
  fun beforeLoad(target: CastTarget, reachable: Boolean) {
    if (target !== carrier || reachable) return
    target.castRefused()
    target.handoff(localRoute(), LOCAL, resume = true)
    carrier = null
  }

  fun released(target: CastTarget) {
    if (carrier === target) carrier = null
  }

  private fun moveToCast(target: CastTarget) {
    val (id, name) = device ?: return
    if (target.castableSource == false) {
      target.castRefused()
      return
    }
    target.handoff(AudioRoute(AudioRouteKind.CAST, name), "$CAST_PREFIX$id", resume = true)
    carrier = target
  }

  companion object {
    const val LOCAL = RoutingDriver.LOCAL
    const val CAST_PREFIX = RoutingDriver.CAST_PREFIX
  }
}
