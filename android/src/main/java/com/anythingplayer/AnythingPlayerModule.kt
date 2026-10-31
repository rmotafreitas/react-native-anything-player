package com.anythingplayer

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.LoadOutcome
import com.anythingplayer.core.PlayerError
import com.anythingplayer.core.TrackKind
import com.anythingplayer.platform.ActivitySource
import com.anythingplayer.platform.AnythingPlayerRuntime
import com.anythingplayer.platform.EventSink
import com.anythingplayer.platform.LicenseRequests
import com.anythingplayer.platform.PlayerController
import com.anythingplayer.platform.SearchRequest
import com.anythingplayer.platform.Voice
import com.anythingplayer.platform.errorToMap
import com.anythingplayer.platform.fadeMs
import com.anythingplayer.platform.optBoolean
import com.anythingplayer.platform.optDouble
import com.anythingplayer.platform.optMap
import com.anythingplayer.platform.optArray
import com.anythingplayer.platform.optString
import com.anythingplayer.platform.parseSubtitleTracks
import com.anythingplayer.platform.parseVideoParts
import com.anythingplayer.platform.toJson
import com.anythingplayer.platform.toWritableMap
import com.anythingplayer.platform.parseNowPlaying
import com.anythingplayer.platform.parseOptions
import com.anythingplayer.platform.parseSource
import com.anythingplayer.platform.statusToMap

/**
 * The TurboModule. Thin: every command is posted, in call order, to the main
 * thread where the engines live, and resolves with the status *after* it was
 * applied. Synchronous getters read the snapshots the controllers publish.
 */
class AnythingPlayerModule(reactContext: ReactApplicationContext) : NativeAnythingPlayerSpec(reactContext) {
  private val main = Handler(Looper.getMainLooper())
  /**
   * Players this module instance created or attached to. On reload/teardown
   * the ones without an app id are released; the others keep playing.
   */
  private val owned = mutableSetOf<String>()
  private val sinkLock = Any()
  private var invalidated = false
  /**
   * Dropped once invalidated (the emitter is torn down with the React
   * instance); emitting under the lock means none is in flight afterwards.
   */
  private val sink = EventSink { event -> synchronized(sinkLock) { if (!invalidated) emitOnPlayerEvent(event) } }
  /** React Native's current activity: the one on screen before the runtime saw any resume. */
  private val activities = ActivitySource { reactApplicationContext.currentActivity }

  companion object {
    const val NAME = NativeAnythingPlayerSpec.NAME
    private const val PLAYER_RELEASED_MESSAGE = "The player was released."

    private fun notVideo() = PlayerError(ErrorCode.INVALID_ARGUMENT, "This is not a video player (create it with `video`).", false)
  }

  // ── Video ──

  override fun videoCommand(playerId: String, command: ReadableMap, promise: Promise) {
    val op = command.optString("op")
    if (op == "license") {
      // The app's getLicense answered (any player's request: the ids are unique).
      LicenseRequests.answer(command.optDouble("requestId")?.toInt() ?: -1, command.optString("license"), command.optString("error"))
      promise.resolve(null)
      return
    }
    val refreshed = if (op == "refreshed") command.optMap("source")?.let { parseSource(it).first } else null
    val added = if (op == "addSubtitles") parseSubtitleTracks(command.optArray("tracks")) else emptyList()
    command(playerId, promise) { controller ->
      val engine = controller.engine
      when (op) {
        "loop" -> engine.setLoop(command.optBoolean("value") == true)
        "seek" -> engine.seek(command.optDouble("position") ?: 0.0, command.optBoolean("exact") == true)
        "refreshed" -> if (refreshed != null) engine.sourceRefreshed(command.optDouble("loadId")?.toInt() ?: -1, refreshed)
        "refreshFailed" -> engine.sourceRefreshFailed(command.optDouble("loadId")?.toInt() ?: -1)
        // Any player's: an audio player has qualities too (its renditions).
        "selectQuality" -> engine.selectQuality(command.optString("id"))
        else -> {
          val picture = controller.picture ?: throw notVideo()
          val id = command.optString("id")
          when (op) {
            "selectAudioTrack" -> engine.selectAudioTrack(id)
            "selectTextTrack" -> engine.selectTextTrack(id)
            "subtitleDelay" -> engine.setSubtitleDelay(command.optDouble("seconds") ?: 0.0)
            "listenOnly" -> engine.setListenOnly(command.optBoolean("value") == true)
            "addSubtitles" -> {
              // The app's files so far (the source's own tracks are `track:` ids), then these.
              val known = controller.status.video?.tracks.orEmpty().filter { it.kind != TrackKind.AUDIO && !it.id.startsWith("track:") }
              engine.setAppTracks(known + added)
            }
            else -> picture.command(op ?: "", command)
          }
        }
      }
    }
  }

  override fun getVideoStats(playerId: String): WritableMap =
    AnythingPlayerRuntime.players[playerId]?.statsMap() ?: Arguments.createMap()

  override fun fetchText(uri: String, headers: ReadableMap, encoding: String?, promise: Promise) {
    val builder = okhttp3.Request.Builder().url(uri)
    val it = headers.keySetIterator()
    while (it.hasNextKey()) {
      val key = it.nextKey()
      headers.optString(key)?.let { value -> builder.header(key, value) }
    }
    val request =
      try {
        builder.build()
      } catch (error: IllegalArgumentException) {
        reject(promise, PlayerError(ErrorCode.INVALID_SOURCE, "Not a URL: $uri", false))
        return
      }
    com.anythingplayer.platform.HttpConnections.client.newCall(request).enqueue(
      object : okhttp3.Callback {
        override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
          reject(promise, PlayerError(ErrorCode.NETWORK_ERROR, "$uri could not be fetched (${e.message}).", true))
        }

        override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
          response.use {
            if (!it.isSuccessful) {
              val status = it.code
              reject(
                promise,
                PlayerError(ErrorCode.HTTP_ERROR, "The server returned HTTP $status for $uri.", status >= 500, httpStatus = status),
              )
              return
            }
            val bytes = it.body?.bytes() ?: ByteArray(0)
            val charset = encoding ?: com.anythingplayer.core.SubtitleCharset.detect(bytes)
            val text =
              try {
                String(bytes, java.nio.charset.Charset.forName(charset))
              } catch (error: IllegalArgumentException) {
                String(bytes, Charsets.UTF_8)
              }
            promise.resolve(
              Arguments.createMap().apply {
                putString("text", text)
                putString("charset", charset)
              },
            )
          }
        }
      },
    )
  }

  override fun initialize() {
    super.initialize()
    AnythingPlayerRuntime.attachModule(sink, activities)
    main.post { AnythingPlayerRuntime.initialize(reactApplicationContext) }
  }

  override fun createPlayer(options: ReadableMap): String {
    val obtained = AnythingPlayerRuntime.obtain(reactApplicationContext, options.optString("id"), parseOptions(options))
    synchronized(owned) { owned.add(obtained.controller.id) }
    if (obtained.attached) main.post { obtained.controller.noteAttach() }
    return obtained.controller.id
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
        reject(promise, PlayerError(ErrorCode.PLAYER_RELEASED, PLAYER_RELEASED_MESSAGE, false))
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
    val parts = parseVideoParts(source)
    val autoplay = options.optBoolean("autoplay")
    val start = options.optDouble("startPosition")
    // `quality`: an id, `'auto'` for automatic; absent: keep the pick.
    val qualityGiven = options.hasKey("quality")
    val quality = options.optString("quality")?.takeIf { it != "auto" }
    main.post {
      val controller = AnythingPlayerRuntime.players[playerId]
      if (controller == null) {
        reject(promise, PlayerError(ErrorCode.PLAYER_RELEASED, PLAYER_RELEASED_MESSAGE, false))
        return@post
      }
      try {
        controller.load(descriptor, fields, autoplay, start, parts, qualityGiven, quality) { outcome ->
          when (outcome) {
            is LoadOutcome.Failed -> reject(promise, outcome.error)
            else -> promise.resolve(controller.statusMap())
          }
        }
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

  override fun fadeTo(playerId: String, volume: Double, seconds: Double, promise: Promise) {
    main.post {
      val controller = AnythingPlayerRuntime.players[playerId]
      if (controller == null) {
        reject(promise, PlayerError(ErrorCode.PLAYER_RELEASED, PLAYER_RELEASED_MESSAGE, false))
        return@post
      }
      try {
        // Resolves when the volume got there (after the status it implies).
        controller.engine.fadeTo(volume, seconds * 1000) { main.post { promise.resolve(controller.statusMap()) } }
      } catch (error: PlayerError) {
        reject(promise, error)
      }
    }
  }

  override fun sleep(playerId: String, timer: ReadableMap, promise: Promise) {
    val after = timer.optDouble("after")?.let { it * 1000 }
    val fadeOut = timer.optDouble("fadeOut")?.let { it * 1000 }
    command(playerId, promise) { it.engine.sleep(after, fadeOut) }
  }

  override fun setFade(playerId: String, fade: ReadableMap, promise: Promise) {
    val inMs = fadeMs(fade, "in").toDouble()
    val outMs = fadeMs(fade, "out").toDouble()
    command(playerId, promise) { it.engine.setFades(inMs, outMs) }
  }

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

  // ── Outputs, Cast and the voice catalog ──
  // Compile-only stubs for the new members of the JS ⇄ native contract: the
  // native routing, Cast and catalog glue is its own commit and lands here.

  override fun showRoutePicker(playerId: String?, promise: Promise) {
    main.post {
      try {
        AnythingPlayerRuntime.showRoutePicker()
        promise.resolve(null)
      } catch (error: PlayerError) {
        reject(promise, error)
      }
    }
  }

  /** The Output Switcher, a dialog or the Bluetooth settings: there is always something to try. */
  override fun isRoutePickerAvailable(): Boolean = true

  override fun getCastState(): WritableMap =
    AnythingPlayerRuntime.castStatus.let { status ->
      Arguments.createMap().apply {
        putString("state", status.state.wire)
        if (status.device == null) putNull("device") else putString("device", status.device)
      }
    }

  /** The receiver is set at build time (`com.anythingplayer.CAST_RECEIVER_ID`); nothing to load here. */
  override fun configureCast(options: ReadableMap, promise: Promise) = promise.resolve(null)

  override fun showCastPicker(promise: Promise) {
    main.post {
      try {
        AnythingPlayerRuntime.showCastPicker()
        promise.resolve(null)
      } catch (error: PlayerError) {
        reject(promise, error)
      }
    }
  }

  override fun stopCasting(promise: Promise) {
    main.post {
      AnythingPlayerRuntime.stopCasting()
      promise.resolve(null)
    }
  }

  // ── Catalog & voice ──

  override fun setCatalog(items: ReadableArray, options: ReadableMap, promise: Promise) {
    try {
      Voice.attach(reactApplicationContext)
      val serialized = (0 until items.size()).mapNotNull { items.getMap(it)?.toJson() }
      Voice.set(serialized, options.optString("playerId") ?: "default", options.optMap("playerOptions")?.toJson(), options.optMap("browse")?.toJson())
      promise.resolve(null)
    } catch (error: Throwable) {
      reject(promise, PlayerError(ErrorCode.INTERNAL_ERROR, error.message ?: error.javaClass.simpleName, false, causeDescription = error.toString()))
    }
  }

  override fun setFavorites(ids: ReadableArray, promise: Promise) {
    try {
      Voice.attach(reactApplicationContext)
      Voice.setFavorites((0 until ids.size()).mapNotNull { ids.getString(it) })
      promise.resolve(null)
    } catch (error: Throwable) {
      reject(promise, PlayerError(ErrorCode.INTERNAL_ERROR, error.message ?: error.javaClass.simpleName, false, causeDescription = error.toString()))
    }
  }

  override fun searchCatalog(request: ReadableMap, promise: Promise) {
    Voice.attach(reactApplicationContext)
    val matches = Arguments.createArray()
    Voice.search(searchRequest(request)).forEach { matches.pushMap(it.json.toWritableMap()) }
    promise.resolve(matches)
  }

  override fun playFromSearch(request: ReadableMap, playerId: String?, promise: Promise) {
    Voice.attach(reactApplicationContext)
    val asked = searchRequest(request)
    main.post {
      Voice.playFromSearch(asked, playerId) { result ->
        result.fold(
          onSuccess = { entry ->
            promise.resolve(
              Arguments.createMap().apply {
                if (entry == null) putNull("item") else putMap("item", entry.json.toWritableMap())
              }
            )
          },
          onFailure = { error ->
            reject(promise, error as? PlayerError ?: PlayerError(ErrorCode.INTERNAL_ERROR, error.message ?: "playFromSearch failed", false, causeDescription = error.toString()))
          },
        )
      }
    }
  }

  override fun setSearchHandlerEnabled(enabled: Boolean) {
    Voice.handlerEnabled = enabled
    // A request that waited for the app can be asked now.
    if (enabled) main.post { Voice.answerWaiting() }
  }

  override fun resolveSearchRequest(requestId: String, result: ReadableMap) {
    Voice.answer(requestId, result.optMap("item")?.toJson())
  }

  private fun searchRequest(map: ReadableMap) =
    SearchRequest(
      query = map.optString("query") ?: "",
      title = map.optString("title"),
      artist = map.optString("artist"),
      album = map.optString("album"),
      genre = map.optString("genre"),
      focus = map.optString("focus"),
      origin = "app",
      group = map.optString("group"),
    )

  /** JS reload / React host teardown: no JS can control these players any more. */
  override fun invalidate() {
    synchronized(sinkLock) { invalidated = true }
    AnythingPlayerRuntime.detachModule(sink, activities)
    main.post { Voice.jsDetached() }
    val ids = synchronized(owned) { owned.toList().also { owned.clear() } }
    main.post {
      ids.forEach { id ->
        // A player with an app id keeps playing: the next JS instance attaches to it.
        AnythingPlayerRuntime.players[id]?.takeIf { !it.appId }?.let {
          it.release()
          AnythingPlayerRuntime.unregister(it)
        }
      }
    }
    super.invalidate()
  }
}
