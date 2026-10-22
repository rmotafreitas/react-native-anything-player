package com.anythingplayer.platform

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors

/**
 * Hosts the Media3 session that powers the media notification, lock screen,
 * headset/Bluetooth buttons and car/Wear controllers, and keeps the process in
 * the foreground (type `mediaPlayback`) while playback is engaged. Media3
 * decides when to start/stop the foreground state from [SessionPlayer]'s state.
 *
 * It is a media *library* service so Google Assistant and Gemini can browse
 * and search the catalog and start it — even when the app is not running: the
 * system binds the service, which brings the runtime up without JS.
 */
@OptIn(UnstableApi::class)
class AnythingPlayerPlaybackService : MediaLibraryService() {
  private var session: MediaLibrarySession? = null

  override fun onCreate() {
    super.onCreate()
    // The assistants start us in a process where nothing else has run yet.
    AnythingPlayerRuntime.initialize(applicationContext)
    val player = SessionPlayer()
    val builder = MediaLibrarySession.Builder(this, player, LibraryCallback(applicationContext)).setId("anythingplayer")
    // Tapping the notification opens the app (the session activity is the
    // notification's content intent; without it the tap does nothing).
    packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      builder.setSessionActivity(
        PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      )
    }
    session = builder.build()
    // Optional: how long a paused session stays in the foreground (Media3
    // default and maximum: 10 min). `<meta-data
    // android:name="com.anythingplayer.FOREGROUND_TIMEOUT_MS" android:value="…"/>`
    foregroundTimeoutFromManifest()?.let { setForegroundServiceTimeoutMs(it) }
    setListener(
      object : Listener {
        override fun onForegroundServiceStartNotAllowedException() {
          Log.w("RNAP", "Android refused to start the media foreground service from the background")
        }
      }
    )
    AnythingPlayerRuntime.attachService(this, player)
  }

  private fun foregroundTimeoutFromManifest(): Long? =
    try {
      val info = packageManager.getApplicationInfo(packageName, android.content.pm.PackageManager.GET_META_DATA)
      info.metaData?.getInt("com.anythingplayer.FOREGROUND_TIMEOUT_MS", -1)?.takeIf { it > 0 }?.toLong()
    } catch (_: Exception) {
      null
    }

  override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

  /** `setCatalog` ran: browsers listing the library reload it. */
  internal fun notifyCatalogChanged() {
    session?.notifyChildrenChanged(MediaLibrary.ROOT_ID, Voice.items().size, null)
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Only the app's own task matters (an auxiliary task — e.g. an auth
    // browser — being removed must not stop playback).
    val removed = rootIntent?.component
    val appTask = packageManager.getLaunchIntentForPackage(packageName)?.component
    if (removed != null && appTask != null && removed != appTask) return
    if (AnythingPlayerRuntime.onTaskRemoved()) pauseAllPlayersAndStopSelf()
  }

  internal fun stopForegroundAndSelf() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onDestroy() {
    AnythingPlayerRuntime.detachService(this)
    session?.run {
      player.release()
      release()
    }
    session = null
    super.onDestroy()
  }
}

/**
 * What the assistants can do with the library: browse the catalog (flat,
 * paginated), search it, and set items on the player — every path to
 * "play this" goes through [MediaLibrary.resolve].
 */
@OptIn(UnstableApi::class)
private class LibraryCallback(private val context: Context) : MediaLibraryService.MediaLibrarySession.Callback {
  override fun onGetLibraryRoot(
    session: MediaLibraryService.MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    params: MediaLibraryService.LibraryParams?,
  ): ListenableFuture<LibraryResult<MediaItem>> =
    Futures.immediateFuture(LibraryResult.ofItem(MediaLibrary.root(context), params))

  override fun onGetChildren(
    session: MediaLibraryService.MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    parentId: String,
    page: Int,
    pageSize: Int,
    params: MediaLibraryService.LibraryParams?,
  ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    if (parentId != MediaLibrary.ROOT_ID) return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
    return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(MediaLibrary.page(Voice.items(), page, pageSize)), params))
  }

  override fun onGetItem(
    session: MediaLibraryService.MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    mediaId: String,
  ): ListenableFuture<LibraryResult<MediaItem>> {
    if (mediaId == MediaLibrary.ROOT_ID) return Futures.immediateFuture(LibraryResult.ofItem(MediaLibrary.root(context), null))
    val entry = Voice.entry(mediaId) ?: return Futures.immediateFuture(LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE))
    return Futures.immediateFuture(LibraryResult.ofItem(MediaLibrary.item(entry), null))
  }

  override fun onSearch(
    session: MediaLibraryService.MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    query: String,
    params: MediaLibraryService.LibraryParams?,
  ): ListenableFuture<LibraryResult<Void>> {
    session.notifySearchResultChanged(browser, query, Voice.search(SearchRequest(query, origin = "assistant")).size, params)
    return Futures.immediateFuture(LibraryResult.ofVoid())
  }

  override fun onGetSearchResult(
    session: MediaLibraryService.MediaLibrarySession,
    browser: MediaSession.ControllerInfo,
    query: String,
    page: Int,
    pageSize: Int,
    params: MediaLibraryService.LibraryParams?,
  ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
    val matches = Voice.search(SearchRequest(query, origin = "assistant"))
    return Futures.immediateFuture(LibraryResult.ofItemList(ImmutableList.copyOf(MediaLibrary.page(matches, page, pageSize)), params))
  }

  override fun onAddMediaItems(
    mediaSession: MediaSession,
    controller: MediaSession.ControllerInfo,
    mediaItems: MutableList<MediaItem>,
  ): ListenableFuture<MutableList<MediaItem>> = resolved(mediaItems) { it.toMutableList() }

  override fun onSetMediaItems(
    mediaSession: MediaSession,
    controller: MediaSession.ControllerInfo,
    mediaItems: MutableList<MediaItem>,
    startIndex: Int,
    startPositionMs: Long,
  ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> =
    resolved(mediaItems) { items ->
      // Resolution drops what is not in the catalog: the start index follows the
      // items only while they all survived, else the first one starts.
      val index = if (items.size == mediaItems.size) startIndex else if (startIndex == C.INDEX_UNSET) C.INDEX_UNSET else 0
      MediaSession.MediaItemsWithStartPosition(items, index, startPositionMs)
    }

  /** Never an empty answer: a request that matched nothing is an error, not "clear the playlist". */
  private fun <T> resolved(requested: List<MediaItem>, build: (List<MediaItem>) -> T): ListenableFuture<T> =
    Futures.transform(
      MediaLibrary.resolve(requested),
      { items ->
        if (items.isNullOrEmpty()) throw UnsupportedOperationException("nothing in the catalog matches")
        build(items)
      },
      MoreExecutors.directExecutor(),
    )
}
