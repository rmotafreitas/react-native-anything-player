package com.radioanimu.airwave.platform

import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.OkHttpClient
import okhttp3.Request

private const val HTTP_TIMEOUT_MS = 10_000L
/** Calls kept per item for cancellation; older ones finished long ago. */
private const val MAX_TRACKED_CALLS = 32

/**
 * The HTTP client for every player. No idle connections are pooled: a socket
 * belongs to one request and is gone when that request ends, so "stopped"
 * means no connection to the station.
 */
internal object HttpConnections {
  val client: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(HTTP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      .readTimeout(HTTP_TIMEOUT_MS, TimeUnit.MILLISECONDS)
      .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
      .followRedirects(true)
      .followSslRedirects(true)
      // Retries belong to the engine (backoff, offline probing, give-up).
      .retryOnConnectionFailure(false)
      .build()
  }
}

/**
 * The HTTP calls made for one media item.
 *
 * Reproduced on device: when a silent socket was replaced, ExoPlayer's load
 * cancellation could not interrupt the blocked read and the dead connection
 * stayed open until the read timeout (10 s). `Call.cancel()` closes the socket
 * from any thread, so the read fails at once. Every teardown (re-open, connection
 * release, unload, playlist removal, destroy) cancels the affected registries.
 *
 * Thread-safe: calls are created on ExoPlayer's loading threads, cancelled
 * from the main thread.
 */
internal class CallRegistry : Call.Factory {
  private val calls = ArrayDeque<Call>()
  private var cancelled = false

  override fun newCall(request: Request): Call {
    val call = HttpConnections.client.newCall(request)
    synchronized(calls) {
      if (cancelled) {
        // A late load of an item that is already gone.
        call.cancel()
      } else {
        calls.addLast(call)
        if (calls.size > MAX_TRACKED_CALLS) calls.removeFirst()
      }
    }
    return call
  }

  /**
   * Closes every socket of the item. With [retire] the item is gone and any
   * late call is cancelled on creation; without it the item stays usable
   * (a later `prepare()` re-opens through this registry).
   */
  fun cancelAll(retire: Boolean) {
    val pending = synchronized(calls) {
      if (retire) cancelled = true
      calls.toList().also { calls.clear() }
    }
    pending.forEach { it.cancel() }
  }
}
