package com.anythingplayer.platform

import android.app.Activity
import android.app.UiModeManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.MediaRouter2
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import androidx.mediarouter.app.SystemOutputSwitcherDialogController
import com.anythingplayer.core.AudioRoute
import com.anythingplayer.core.AudioRouteKind
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.PlayerError

private const val TAG = "RNAP"
/** How often the selected output is re-read while audio plays (API 33+ has no change callback for it). */
private const val ROUTE_POLL_MS = 3_000L

/** One audio output as the platform lists it: the platform class, decoupled so the choice is testable. */
internal data class OutputDevice(val type: Int, val name: String?)

/**
 * Turns the platform's output devices into the [AudioRoute] of the public API.
 * Pure: `AudioDeviceInfo.TYPE_*` are compile-time constants.
 */
internal object RouteClassifier {
  fun kind(type: Int): AudioRouteKind =
    when (type) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_BUILTIN_SPEAKER_SAFE, AudioDeviceInfo.TYPE_BUILTIN_EARPIECE ->
        AudioRouteKind.SPEAKER
      AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET ->
        AudioRouteKind.HEADPHONES
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_BLE_BROADCAST,
      AudioDeviceInfo.TYPE_HEARING_AID -> AudioRouteKind.BLUETOOTH
      AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_HDMI_ARC, AudioDeviceInfo.TYPE_HDMI_EARC -> AudioRouteKind.HDMI
      AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_ACCESSORY -> AudioRouteKind.USB
      AudioDeviceInfo.TYPE_BUS -> AudioRouteKind.CAR
      else -> AudioRouteKind.OTHER
    }

  /** Outputs that are not somewhere the user listens (calls, loopbacks, tuners). */
  private fun isListenable(type: Int): Boolean =
    type != AudioDeviceInfo.TYPE_TELEPHONY &&
      type != AudioDeviceInfo.TYPE_FM &&
      type != AudioDeviceInfo.TYPE_IP &&
      type != AudioDeviceInfo.TYPE_REMOTE_SUBMIX

  /** What the system prefers when it does not say: Bluetooth > wired / USB > HDMI > the speaker. */
  private fun rank(kind: AudioRouteKind): Int =
    when (kind) {
      AudioRouteKind.CAR, AudioRouteKind.BLUETOOTH -> 5
      AudioRouteKind.HEADPHONES, AudioRouteKind.USB -> 4
      AudioRouteKind.HDMI -> 3
      AudioRouteKind.OTHER -> 2
      else -> 1
    }

  /**
   * The route for [devices]. With [selected] (API 33+: the system's own
   * answer for media) the first device is the output; without it the best
   * connected one is guessed. [carMode]: the phone projects to a car, so a
   * Bluetooth output is the car's.
   */
  fun route(devices: List<OutputDevice>, selected: Boolean, carMode: Boolean = false): AudioRoute {
    val candidates = devices.filter { isListenable(it.type) }
    val device = (if (selected) candidates.firstOrNull() else candidates.maxByOrNull { rank(kind(it.type)) })
      ?: return AudioRoute(AudioRouteKind.SPEAKER, null)
    var kind = kind(device.type)
    if (carMode && kind == AudioRouteKind.BLUETOOTH) kind = AudioRouteKind.CAR
    // A built-in speaker's product name is the phone's model: not a device name.
    val name = if (kind == AudioRouteKind.SPEAKER) null else device.name?.trim()?.ifEmpty { null }
    return AudioRoute(kind, name)
  }
}

/**
 * Watches where media audio goes. API 33+ asks the system for the output media
 * would use; earlier versions guess from the connected devices. A device
 * callback reports plugging and Bluetooth; [refresh] re-reads the choice (the
 * runtime calls it when playback starts and polls while audio plays).
 * Main thread.
 */
internal class RouteMonitor(private val context: Context, private val onChange: (AudioRoute) -> Unit) {
  private val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val main = Handler(Looper.getMainLooper())
  private var last: AudioRoute? = null
  private var polling = false

  private val callback =
    object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = refresh()
      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = refresh()
    }

  private val poll: Runnable =
    Runnable {
      if (polling) {
        refresh()
        main.postDelayed(poll, ROUTE_POLL_MS)
      }
    }

  fun start() {
    audio.registerAudioDeviceCallback(callback, main)
    refresh()
  }

  /** Polls the selected output while [wanted] (audio is playing); a no-op before API 33. */
  fun setPolling(wanted: Boolean) {
    if (wanted == polling || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    polling = wanted
    main.removeCallbacks(poll)
    if (wanted) main.postDelayed(poll, ROUTE_POLL_MS)
  }

  fun current(): AudioRoute {
    val carMode = (context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager)?.currentModeType == Configuration.UI_MODE_TYPE_CAR
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()
      val selected = audio.getAudioDevicesForAttributes(attributes).map(::toDevice)
      if (selected.isNotEmpty()) return RouteClassifier.route(selected, selected = true, carMode = carMode)
    }
    return RouteClassifier.route(audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map(::toDevice), selected = false, carMode = carMode)
  }

  /** Re-reads the route; reports it when it changed. */
  fun refresh() {
    val route = current()
    if (route == last) return
    last = route
    onChange(route)
  }

  fun stop() {
    polling = false
    main.removeCallbacks(poll)
    audio.unregisterAudioDeviceCallback(callback)
  }

  private fun toDevice(info: AudioDeviceInfo) = OutputDevice(info.type, info.productName?.toString())
}

/** Opens the system's output picker. */
internal object OutputPicker {
  /** Where the picker comes from, for the diagnostics. */
  enum class Via { OUTPUT_SWITCHER, MEDIA_ROUTER_DIALOG, BLUETOOTH_SETTINGS }

  /**
   * Main thread. API 34+: the system Output Switcher (foreground apps only).
   * Before it: AndroidX's switcher dialog (API 31+ devices that have one),
   * else the Bluetooth settings. Throws `ROUTE_PICKER_UNAVAILABLE` when none
   * could open.
   */
  fun show(context: Context, activity: Activity?): Via {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
      runCatching { MediaRouter2.getInstance(context).showSystemOutputSwitcher() }.getOrDefault(false)
    ) {
      return Via.OUTPUT_SWITCHER
    }
    if (runCatching { SystemOutputSwitcherDialogController.showDialog(activity ?: context) }.getOrDefault(false)) return Via.MEDIA_ROUTER_DIALOG
    val settings = Intent(Settings.ACTION_BLUETOOTH_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      (activity ?: context).startActivity(settings)
      return Via.BLUETOOTH_SETTINGS
    } catch (e: ActivityNotFoundException) {
      Log.w(TAG, "no output picker: ${e.message}")
    } catch (e: SecurityException) {
      Log.w(TAG, "no output picker: ${e.message}")
    }
    throw PlayerError(ErrorCode.ROUTE_PICKER_UNAVAILABLE, "This device has no output picker.", false)
  }
}
