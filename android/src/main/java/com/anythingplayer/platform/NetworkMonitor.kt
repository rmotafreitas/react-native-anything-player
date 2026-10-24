package com.anythingplayer.platform

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.anythingplayer.core.NetworkState

/**
 * Watches the default network and reports `(state, interfaceChanged)` on the
 * main thread.
 *
 * - "Online" means the default network has internet AND was validated: a
 *   Wi-Fi without internet / captive portal is offline (otherwise a stream
 *   stuck on a dead link never sees a restore edge).
 * - A switch of the default network while online (Wi-Fi ↔ cellular) is a
 *   handoff: the link never reports offline but the stream's socket died with
 *   the old route. It is reported once the new network validates; a new
 *   network that never validates is reported offline after [VALIDATION_GRACE_MS].
 */
internal class NetworkMonitor(
  private val context: Context,
  private val onChange: (NetworkState, Boolean) -> Unit,
  /** `(metered, saveData)`: a metered network (cellular caps) and the OS's Data Saver. */
  private val onCost: (Boolean, Boolean) -> Unit = { _, _ -> },
) {
  companion object {
    const val VALIDATION_GRACE_MS = 5_000L
  }

  private val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
  private val handler = Handler(Looper.getMainLooper())
  private var current: Network? = null
  private var reportedNetwork: Network? = null
  private var started = false

  var state: NetworkState = NetworkState.UNKNOWN
    private set

  /** The default network costs money per byte (cellular, a metered hotspot). */
  var metered = false
    private set

  /** The user turned on Data Saver (background data restricted for this app). */
  var saveData = false
    private set

  private val dataSaverChanged =
    object : android.content.BroadcastReceiver() {
      override fun onReceive(context: Context, intent: android.content.Intent) = onMain { evaluateCost() }
    }

  private val validationTimeout = Runnable { evaluate(forceOfflineIfUnvalidated = true) }

  private val callback =
    object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) = onMain { current = network; evaluate(false) }
      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = onMain {
        current = network
        evaluate(false)
      }
      override fun onLost(network: Network) = onMain {
        if (network == current) current = null
        evaluate(false)
      }
    }

  private fun onMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) block() else handler.post(block)
  }

  fun start() {
    if (started) return
    started = true
    current = connectivity.activeNetwork
    if (current == null) {
      publish(NetworkState.OFFLINE, false)
    } else {
      evaluate(false)
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        connectivity.registerDefaultNetworkCallback(callback, handler)
      } else {
        connectivity.registerDefaultNetworkCallback(callback)
      }
    } catch (_: SecurityException) {
      // ACCESS_NETWORK_STATE missing (merged manifest altered): stay `unknown`.
      state = NetworkState.UNKNOWN
    }
    androidx.core.content.ContextCompat.registerReceiver(
      context,
      dataSaverChanged,
      android.content.IntentFilter(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED),
      androidx.core.content.ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    evaluateCost()
  }

  private fun evaluateCost() {
    val network = current
    val caps = network?.let { connectivity.getNetworkCapabilities(it) }
    val nextMetered =
      when {
        caps == null -> connectivity.isActiveNetworkMetered
        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) -> false
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
          caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_TEMPORARILY_NOT_METERED) -> false
        else -> true
      }
    val nextSave = connectivity.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
    if (nextMetered == metered && nextSave == saveData) return
    metered = nextMetered
    saveData = nextSave
    onCost(metered, saveData)
  }

  fun stop() {
    if (!started) return
    started = false
    handler.removeCallbacks(validationTimeout)
    runCatching { context.unregisterReceiver(dataSaverChanged) }
    try {
      connectivity.unregisterNetworkCallback(callback)
    } catch (_: IllegalArgumentException) {
      // Registration may have failed (e.g. the host removed ACCESS_NETWORK_STATE).
      // Android has no registered callback to remove in that case.
    }
  }

  private fun evaluate(forceOfflineIfUnvalidated: Boolean) {
    evaluateCost()
    val network = current
    if (network == null) {
      handler.removeCallbacks(validationTimeout)
      publish(NetworkState.OFFLINE, false)
      return
    }
    val caps = connectivity.getNetworkCapabilities(network)
    val hasInternet = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    val validated = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
    val captive = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL) == true
    when {
      hasInternet && validated && !captive -> {
        handler.removeCallbacks(validationTimeout)
        val changed = reportedNetwork != null && reportedNetwork != network
        publish(NetworkState.ONLINE, changed)
        reportedNetwork = network
      }
      captive || !hasInternet || forceOfflineIfUnvalidated -> {
        handler.removeCallbacks(validationTimeout)
        publish(NetworkState.OFFLINE, false)
      }
      else -> {
        // A new network that has not validated yet: keep the previous reading
        // for a moment instead of flapping offline.
        handler.removeCallbacks(validationTimeout)
        handler.postDelayed(validationTimeout, VALIDATION_GRACE_MS)
      }
    }
  }

  private fun publish(next: NetworkState, interfaceChanged: Boolean) {
    if (next == state && !interfaceChanged) return
    state = next
    onChange(next, interfaceChanged)
  }
}
