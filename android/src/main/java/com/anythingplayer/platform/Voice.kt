package com.anythingplayer.platform

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.anythingplayer.core.CatalogSearch
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.LoadOutcome
import com.anythingplayer.core.PlaybackState
import com.anythingplayer.core.PlayerError
import java.io.File
import java.util.concurrent.Executors
import org.json.JSONObject

private const val TAG = "RNAP"
/** How long the app's search handler may take (JS gives itself 5 s; this covers the bridge). */
private const val HANDLER_TIMEOUT_MS = 5_500L
/** JS-provided items kept so a media item resolved from one can be loaded a moment later. */
private const val ADHOC_CAPACITY = 8

/**
 * The voice side of the library: the persisted catalog, the search every entry
 * point shares (`playFromSearch()`, the assistants' media session, the
 * `MEDIA_PLAY_FROM_SEARCH` intent), and which player plays. Twin of
 * `WebCatalog` / `WebModule.playFromSearch` — the web is the reference for
 * what a request does. Everything that touches players runs on the main thread.
 */
internal object Voice {
  private val main = Handler(Looper.getMainLooper())
  /** The catalog file is written off the main thread (the last-played mark is written on every request). */
  private val writes = Executors.newSingleThreadExecutor { Thread(it, "rnap-catalog") }
  private var store: CatalogStore? = null
  private var context: Context? = null

  /** Whether the app answers what the catalog does not have (`setSearchHandler`). */
  @Volatile var handlerEnabled = false

  private val pending = HashMap<String, (CatalogEntry?) -> Unit>()
  private var asked = 0
  private val adhoc = object : LinkedHashMap<String, CatalogEntry>() {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CatalogEntry>?) = size > ADHOC_CAPACITY
  }

  /** Idempotent; any thread. */
  @Synchronized
  fun attach(appContext: Context) {
    if (store != null) return
    context = appContext.applicationContext
    store = CatalogStore(File(appContext.applicationContext.filesDir, "rnap/catalog.json"))
  }

  private fun store(): CatalogStore = store ?: error("Voice used before attach(context)")

  // ── The catalog ──

  fun items(): List<CatalogEntry> = store().snapshot().items

  fun hasItems(): Boolean = items().isNotEmpty()

  /** A catalog item, or an item JS answered a search with a moment ago. */
  fun entry(id: String): CatalogEntry? = items().firstOrNull { it.id == id } ?: synchronized(adhoc) { adhoc[id] }

  /** Replaces the catalog (persisted before this returns) and tells the media library. Any thread. */
  fun set(items: List<JSONObject>, playerId: String, playerOptions: JSONObject?, browse: JSONObject? = null) {
    store().replace(items, playerId, playerOptions, browse)
    AnythingPlayerRuntime.post { AnythingPlayerRuntime.catalogChanged() }
  }

  /** Replaces the ids of the Favorites folder (persisted before this returns) and tells the media library. Any thread. */
  fun setFavorites(ids: List<String>) {
    store().setFavorites(ids)
    AnythingPlayerRuntime.post { AnythingPlayerRuntime.catalogChanged() }
  }

  /** The catalog with its browse settings, as one reading. */
  fun snapshot(): CatalogSnapshot = store().snapshot()

  /** Ranked matches, best first. */
  fun search(request: SearchRequest): List<CatalogEntry> {
    val entries = items()
    return CatalogSearch.search(entries.map { it.searchable }, request.toQuery()).matches.map { entries[it] }
  }

  /** The best match; for a request that says nothing, the last item played (else the first). */
  fun resolve(request: SearchRequest): CatalogEntry? {
    val snapshot = store().snapshot()
    val outcome = CatalogSearch.search(snapshot.items.map { it.searchable }, request.toQuery())
    outcome.matches.firstOrNull()?.let { return snapshot.items[it] }
    if (!outcome.emptyQuery) return null
    return snapshot.items.firstOrNull { it.id == snapshot.lastPlayedId } ?: snapshot.items.firstOrNull()
  }

  /** What "play" with nothing said plays. */
  fun defaultEntry(): CatalogEntry? = resolve(SearchRequest("", origin = "assistant"))

  // ── Asking the app ──

  /** Main thread. The catalog's answer, else the app's search handler's (if JS is running), else `null`. */
  fun resolveOrAsk(request: SearchRequest, done: (CatalogEntry?) -> Unit) {
    resolve(request)?.let { return done(it) }
    if (!handlerEnabled || !AnythingPlayerRuntime.hasJs) return done(null)
    asked += 1
    val requestId = "search-$asked"
    val timeout = Runnable { pending.remove(requestId)?.invoke(null) }
    pending[requestId] = { entry ->
      main.removeCallbacks(timeout)
      done(entry)
    }
    main.postDelayed(timeout, HANDLER_TIMEOUT_MS)
    AnythingPlayerRuntime.emit(
      Arguments.createMap().apply {
        putString("type", "searchRequest")
        putString("requestId", requestId)
        putMap("request", request.toMap())
      }
    )
  }

  /** The app answered a `searchRequest` event. Any thread. */
  fun answer(requestId: String, item: JSONObject?) {
    main.post {
      val entry = item?.let { runCatching { CatalogEntry(it) }.getOrNull() }
      if (entry != null) synchronized(adhoc) { adhoc[entry.id] = entry }
      pending.remove(requestId)?.invoke(entry)
    }
  }

  /** The JS instance is gone: nobody will answer. Main thread. */
  fun jsDetached() {
    handlerEnabled = false
    pending.keys.toList().forEach { pending.remove(it)?.invoke(null) }
  }

  // ── Playing ──

  /**
   * The player a voice request uses: the given one, else the one on the lock
   * screen, else the catalog's own (created here if the app has not — that is
   * how a request works with no JS running). Main thread.
   */
  fun voicePlayer(given: String?): PlayerController {
    val runtime = AnythingPlayerRuntime
    if (given != null) {
      return runtime.players[given]?.takeIf { !it.isReleased } ?: throw PlayerError(ErrorCode.PLAYER_RELEASED, "The player was released.", false)
    }
    runtime.active?.takeIf { !it.isReleased }?.let { return it }
    val snapshot = store().snapshot()
    runtime.players[snapshot.playerId]?.takeIf { !it.isReleased }?.let { return it }
    val options = snapshot.playerOptions?.let { parseOptions(it.toReadableMap()) } ?: PlayerOptions()
    // Native-made players are on the lock screen: that is where a voice request is controlled from.
    return runtime.obtain(context!!, snapshot.playerId, options.copy(mediaSession = true)).controller
  }

  /**
   * Loads [entry] on [controller] and tells the app (`searchPlay`). [autoplay]
   * is false when an assistant stages an item and starts it with the next
   * command. Main thread.
   */
  fun load(controller: PlayerController, entry: CatalogEntry, request: SearchRequest, autoplay: Boolean, startSeconds: Double?, completion: LoadCompletion?) {
    val (descriptor, fields) = parseSource(entry.source.toReadableMap())
    controller.load(descriptor, fields, autoplay, startSeconds, completion)
    store().let { s -> writes.execute { s.played(entry.id) } }
    AnythingPlayerRuntime.activate(controller)
    controller.emitEvent(
      "searchPlay",
      Arguments.createMap().apply {
        putMap("request", request.toMap())
        putMap("item", entry.json.toWritableMap())
      },
    )
  }

  /** `playFromSearch()` and the assistants' intent: resolve, play, report. Main thread. */
  fun playFromSearch(request: SearchRequest, playerId: String?, done: (Result<CatalogEntry?>) -> Unit) {
    resolveOrAsk(request) { entry ->
      if (entry == null) return@resolveOrAsk done(Result.success(null))
      val controller =
        try {
          voicePlayer(playerId)
        } catch (error: PlayerError) {
          return@resolveOrAsk done(Result.failure(error))
        }
      load(controller, entry, request, autoplay = true, startSeconds = null) { outcome ->
        done(if (outcome is LoadOutcome.Failed) Result.failure(outcome.error) else Result.success(entry))
      }
    }
  }

  /** Nothing is loaded anywhere and there is a catalog: an assistant's bare "play" has something to start. */
  fun nothingLoaded(): Boolean {
    val active = AnythingPlayerRuntime.active
    return (active == null || active.status.state == PlaybackState.IDLE) && hasItems()
  }

  /** Loads what an empty request plays (the last item, else the first); [autoplay] starts it. Main thread. */
  fun playDefault(autoplay: Boolean): Boolean {
    val entry = defaultEntry() ?: return false
    val controller =
      try {
        voicePlayer(null)
      } catch (error: PlayerError) {
        Log.w(TAG, "no player for a bare play: ${error.message}")
        return false
      }
    load(controller, entry, SearchRequest("", origin = "assistant"), autoplay, null, null)
    return true
  }

  /** An assistant started the app with a request: no JS is needed, no answer is expected. */
  fun playFromAssistant(request: SearchRequest) {
    playFromSearch(request, null) { result ->
      result.onFailure { Log.w(TAG, "assistant request \"${request.query}\" failed: ${it.message}") }
      result.onSuccess { if (it == null) Log.d(TAG, "assistant request \"${request.query}\" matched nothing") }
    }
  }

}

/** A request as the `searchRequest` and `searchPlay` events carry it. */
internal fun SearchRequest.toMap(): WritableMap =
  Arguments.createMap().apply {
    putString("query", query)
    title?.let { putString("title", it) }
    artist?.let { putString("artist", it) }
    album?.let { putString("album", it) }
    genre?.let { putString("genre", it) }
    focus?.let { putString("focus", it) }
    group?.let { putString("group", it) }
    putString("origin", origin)
  }
