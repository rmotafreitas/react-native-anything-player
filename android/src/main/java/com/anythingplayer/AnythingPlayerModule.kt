package com.anythingplayer

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.PlayerError
import com.anythingplayer.platform.AnythingPlayerRuntime
import com.anythingplayer.platform.EventSink
import com.anythingplayer.platform.PlayerController
import com.anythingplayer.platform.errorToMap
import com.anythingplayer.platform.optBoolean
import com.anythingplayer.platform.optDouble
import com.anythingplayer.platform.parseNowPlaying
import com.anythingplayer.platform.parseOptions
import com.anythingplayer.platform.parseSource
import com.anythingplayer.platform.statusToMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * The TurboModule. Thin: every command is posted, in call order, to the main
 * thread where the engines live, and resolves with the status *after* it was
 * applied. Synchronous getters read the snapshots the controllers publish.
 */
class AnythingPlayerModule(reactContext: ReactApplicationContext) : NativeAnythingPlayerSpec(reactContext) {
  private val main = Handler(Looper.getMainLooper())
  /** Players created by this module instance (released on reload/teardown). */
  private val owned = mutableSetOf<String>()
  private val sinkLock = Any()
  private var invalidated = false
  /**
   * Dropped once invalidated (the emitter is torn down with the React
   * instance); emitting under the lock means none is in flight afterwards.
   */
  private val sink = EventSink { event -> synchronized(sinkLock) { if (!invalidated) emitOnPlayerEvent(event) } }

  companion object {
    const val NAME = NativeAnythingPlayerSpec.NAME
    private val counter = AtomicInteger(0)
  }

  override fun createPlayer(options: ReadableMap): String {
    val id = "android-${counter.incrementAndGet()}-${System.nanoTime().toString(36)}"
    val parsed = parseOptions(options)
    val controller = PlayerController(id, reactApplicationContext, parsed, AnythingPlayerRuntime, sink)
    synchronized(owned) { owned.add(id) }
    AnythingPlayerRuntime.players[id] = controller
    main.post {
      AnythingPlayerRuntime.initialize(reactApplicationContext)
      AnythingPlayerRuntime.register(controller)
    }
    return id
  }

  override fun releasePlayer(playerId: String, promise: Promise) {
    synchronized(owned) { owned.remove(playerId) }
    main.post {
      val controller = AnythingPlayerRuntime.players[playerId]
      if (controller != null) {
        controller.release()
        AnythingPlayerRuntime.unregister(controller)
      }
      promise.resolve(null)
    }
  }

  private fun command(playerId: String, promise: Promise, block: (PlayerController) -> Unit) {
    main.post {
      val controller = AnythingPlayerRuntime.players[playerId]
      if (controller == null) {
        reject(promise, PlayerError(ErrorCode.PLAYER_RELEASED, "The player was released.", false))
        return@post
      }
      try {
        block(controller)
        promise.resolve(controller.statusMap())
      } catch (error: PlayerError) {
        reject(promise, error)
      } catch (error: Throwable) {
        reject(promise, PlayerError(ErrorCode.INTERNAL_ERROR, error.message ?: error.javaClass.simpleName, false, causeDescription = error.toString()))
      }
    }
  }

  private fun reject(promise: Promise, error: PlayerError) {
    promise.reject(error.code.wire, error.message, errorToMap(error))
  }

  override fun load(playerId: String, source: ReadableMap, options: ReadableMap, promise: Promise) {
    val (descriptor, fields) = parseSource(source)
    val autoplay = options.optBoolean("autoplay")
    val start = options.optDouble("startPosition")
    main.post {
      val controller = AnythingPlayerRuntime.players[playerId]
      if (controller == null) {
        reject(promise, PlayerError(ErrorCode.PLAYER_RELEASED, "The player was released.", false))
        return@post
      }
      try {
        controller.load(descriptor, fields, autoplay, start, promise)
      } catch (error: PlayerError) {
        reject(promise, error)
      }
    }
  }

  override fun play(playerId: String, promise: Promise) = command(playerId, promise) { it.engine.play() }
  override fun pause(playerId: String, promise: Promise) = command(playerId, promise) { it.engine.pause() }
  override fun stop(playerId: String, promise: Promise) = command(playerId, promise) { it.engine.stop() }
  override fun reset(playerId: String, promise: Promise) = command(playerId, promise) { it.engine.reset() }
  override fun seekTo(playerId: String, position: Double, promise: Promise) = command(playerId, promise) { it.engine.seek(position) }
  override fun setVolume(playerId: String, volume: Double, promise: Promise) = command(playerId, promise) { it.engine.setVolume(volume) }
  override fun setMuted(playerId: String, muted: Boolean, promise: Promise) = command(playerId, promise) { it.engine.setMuted(muted) }
  override fun setRate(playerId: String, rate: Double, promise: Promise) = command(playerId, promise) { it.engine.setRate(rate) }

  override fun updateNowPlaying(playerId: String, metadata: ReadableMap, promise: Promise) {
    val fields = parseNowPlaying(metadata)
    command(playerId, promise) { it.updateNowPlaying(fields) }
  }

  private fun idleStatus(): WritableMap = statusToMap(com.anythingplayer.core.Status(), 0)

  override fun getStatus(playerId: String): WritableMap = AnythingPlayerRuntime.players[playerId]?.statusMap() ?: idleStatus()

  override fun getProgress(playerId: String): WritableMap =
    AnythingPlayerRuntime.players[playerId]?.progressMap()
      ?: Arguments.createMap().apply {
        putDouble("position", 0.0)
        putNull("duration")
        putDouble("buffered", 0.0)
        putDouble("bufferedAhead", 0.0)
        putNull("liveOffset")
        putDouble("timestamp", System.currentTimeMillis().toDouble())
      }

  override fun getMetadata(playerId: String): WritableMap =
    AnythingPlayerRuntime.players[playerId]?.metadataMap() ?: Arguments.createMap().apply { putNull("metadata") }

  override fun getDiagnostics(playerId: String): WritableArray =
    AnythingPlayerRuntime.players[playerId]?.diagnosticsArray() ?: Arguments.createArray()

  override fun setDiagnosticsEnabled(playerId: String, enabled: Boolean) {
    AnythingPlayerRuntime.players[playerId]?.diagnosticsEnabled = enabled
  }

  override fun setAudioSampling(playerId: String, enabled: Boolean, points: Double): Boolean {
    val clamped = points.toInt().coerceIn(16, 4096)
    main.post { AnythingPlayerRuntime.players[playerId]?.setAudioSampling(enabled, clamped) }
    return true
  }

  /** JS reload / React host teardown: no JS can control these players any more. */
  override fun invalidate() {
    synchronized(sinkLock) { invalidated = true }
    val ids = synchronized(owned) { owned.toList().also { owned.clear() } }
    main.post {
      ids.forEach { id ->
        AnythingPlayerRuntime.players[id]?.let {
          it.release()
          AnythingPlayerRuntime.unregister(it)
        }
      }
    }
    super.invalidate()
  }
}
