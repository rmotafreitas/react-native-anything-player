package com.anythingplayer.platform

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.view.WindowManager
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSourceBitmapLoader
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableArray
import com.anythingplayer.core.BackgroundMode
import com.anythingplayer.core.CueSchedule
import com.anythingplayer.core.CueTime
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.PlaybackState
import com.anythingplayer.core.PlayerError
import com.anythingplayer.core.Status
import com.anythingplayer.core.TrackKind
import com.anythingplayer.core.VideoStatus
import com.anythingplayer.core.ViewState
import com.google.common.util.concurrent.ListenableFuture
import kotlin.math.max

/** While cues are on, the overlay checks the clock at least this often (rate changes, drift). */
private const val CUE_RECHECK_MS = 1_000L

/**
 * A video player's picture side on Android: its two ExoPlayers ([SwapDriver]),
 * a [PictureSurface] each, and where they show: the newest attached
 * `<VideoView>`, the fullscreen window over it, or the Picture in Picture
 * window over both. Tells the engine about the view (attached, on screen,
 * its size), keeps the screen on, draws the subtitles (the app's files on
 * the cue schedule, the source's as ExoPlayer renders them) and emits `cues`.
 * Main thread, except construction (any thread, touches no view).
 */
@OptIn(UnstableApi::class)
internal class VideoOutput(
  private val context: Context,
  private val controller: PlayerController,
  make: (DriverObserver) -> ExoPlayerDriver,
) : VideoPicture, SwapStage, VideoControls.Actions {
  private val main = Handler(Looper.getMainLooper())
  private val swap = SwapDriver(controller, make, this)
  private val surfaces = HashMap<ExoPlayerDriver, PictureSurface>()
  /** Attached inline views, the newest last (it shows the picture). */
  private val inline = mutableListOf<VideoSurfaceView>()
  private var fullscreen: FullscreenWindow? = null
  private var pipHost: PictureHost? = null
  private var host: PictureHost? = null
  private var status = Status()
  private var reportedView = ViewState()
  private var released = false

  // ── Subtitles ──
  private class AppTrack(val times: List<CueTime>, val cues: List<OverlayCue>)

  private var session: String? = null
  private val appCues = HashMap<String, AppTrack>()
  private var sourceCueList: List<OverlayCue> = emptyList()
  private var shownCues: List<OverlayCue> = emptyList()
  private var shownTrack: String? = null
  private val cueTick = Runnable { applyCues() }

  // ── Poster ──
  private var posterBitmap: Bitmap? = null
  private var posterLoad: ListenableFuture<Bitmap>? = null

  override val output: Output
    get() = swap

  override val primary: ExoPlayerDriver
    get() = swap.current

  override val drivers: List<ExoPlayerDriver>
    get() = swap.drivers

  private val engine
    get() = controller.engine

  // ── VideoPicture ──

  override fun load(parts: VideoLoadParts) {
    session = parts.session
    appCues.clear()
    sourceCueList = emptyList()
    loadPoster(parts.poster)
    applyCues()
  }

  override fun statusChanged(status: Status) {
    this.status = status
    if (status.video?.firstFrame == true) host?.setPoster(null)
    // Nothing plays: ExoPlayer's last cue would stay up.
    if (status.state in NOTHING_PLAYS) sourceCueList = emptyList()
    applyCues()
    updateKeepAwake()
    host?.controls?.refresh()
    PictureInPicture.update()
  }

  override fun pictureChanged() {
    primary.pictureSize?.let { (w, h) -> host?.setPictureSize(w, h) }
    PictureInPicture.update()
  }

  override fun sourceCues(cues: List<OverlayCue>) {
    sourceCueList = cues
    applyCues()
  }

  override fun positionJumped() = applyCues()

  override fun castSubtitles(status: VideoStatus): List<CastSubtitle> =
    status.tracks.mapNotNull { track ->
      if (track.kind == TrackKind.AUDIO || track.id.startsWith("track:")) return@mapNotNull null
      val cues = appCues[track.id]?.cues ?: return@mapNotNull null
      CastSubtitle(track.id, track.kind == TrackKind.CAPTIONS, track.language, track.label, cuesToVtt(cues, status.subtitleDelay))
    }

  override fun command(op: String, command: ReadableMap) {
    when (op) {
      "cues" -> setCues(command.optString("session"), command.optString("trackId"), command.optArray("cues"))
      "fullscreen" ->
        if (command.optBoolean("active") == true) enterFullscreen(command.optString("lockOrientation")) else exitFullscreen()
      "pictureInPicture" ->
        if (command.optBoolean("active") == true) PictureInPicture.start(this) else PictureInPicture.stop(this)
      else -> throw PlayerError(ErrorCode.INVALID_ARGUMENT, "Unknown video command \"$op\".", false)
    }
  }

  override fun destroy() {
    if (released) return
    released = true
    main.removeCallbacks(cueTick)
    posterLoad?.cancel(true)
    PictureInPicture.forget(this)
    fullscreen?.dismiss()
    fullscreen = null
    pipHost?.let { (it.parent as? ViewGroup)?.removeView(it) }
    pipHost = null
    host?.keepScreenOn = false
    host?.controls = null
    host = null
    inline.toList().forEach {
      it.controls = null
      it.overlay.show(emptyList())
      it.setPoster(null)
      it.outputReleased()
    }
    inline.clear()
    swap.destroy()
    surfaces.values.forEach { it.release() }
    surfaces.clear()
  }

  // ── SwapStage ──

  override fun show(current: ExoPlayerDriver, hidden: ExoPlayerDriver?) {
    surfaceOf(current)
    hidden?.let(::surfaceOf)
    host?.let(::placePictures)
  }

  // ── Views ──

  /** A `<VideoView>` for this player appeared: it shows the picture now. */
  fun attach(view: VideoSurfaceView) {
    if (released) return
    inline.remove(view)
    inline.add(view)
    applyControls(view)
    hostChanged()
  }

  fun detach(view: VideoSurfaceView) {
    if (!inline.remove(view)) return
    view.controls = null
    view.keepScreenOn = false
    view.overlay.show(emptyList())
    view.setPoster(null)
    hostChanged()
  }

  /** A view moved, resized, scrolled on or off screen, or changed its controls. */
  fun viewChanged(view: VideoSurfaceView) {
    if (released || view !in inline) return
    applyControls(view)
    reportView()
    updateKeepAwake()
    PictureInPicture.update()
  }

  private fun applyControls(view: VideoSurfaceView) {
    if (!view.nativeControls) {
      view.controls = null
    } else if (view.controls == null) {
      view.controls = VideoControls(view.context, this)
    }
  }

  private fun surfaceOf(driver: ExoPlayerDriver): PictureSurface =
    surfaces.getOrPut(driver) { PictureSurface(context) { surface -> driver.attachSurface(surface) } }

  private fun chooseHost(): PictureHost? = pipHost ?: fullscreen?.host ?: inline.lastOrNull()

  private fun hostChanged() {
    if (released) return
    val next = chooseHost()
    if (next !== host) {
      host?.let {
        it.overlay.show(emptyList())
        it.keepScreenOn = false
        it.setPoster(null)
      }
      host = next
      if (next != null) {
        placePictures(next)
        next.overlay.show(shownCues)
        next.setPoster(if (status.video?.firstFrame == true) null else posterBitmap)
        next.controls?.refresh()
      }
    }
    reportView()
    updateKeepAwake()
    PictureInPicture.update()
  }

  /** Both ExoPlayers' pictures in [target], the one on screen on top. */
  private fun placePictures(target: PictureHost) {
    swap.drivers.forEach { surfaceOf(it).moveTo(target) }
    target.restack(surfaceOf(swap.current).view)
    primary.pictureSize?.let { (w, h) -> target.setPictureSize(w, h) }
  }

  private fun reportView() {
    val h = host
    // A host not laid out yet (a window just opened) keeps the last size: a
    // 0×0 view would lift the quality cap for a frame.
    val laidOut = h != null && h.width > 0 && h.height > 0
    val width = if (laidOut) h!!.width else reportedView.width
    val height = if (laidOut) h!!.height else reportedView.height
    val next =
      when {
        h == null -> ViewState()
        h is VideoSurfaceView -> ViewState(true, h.onScreen, width, height)
        else -> ViewState(true, true, width, height)
      }
    if (next == reportedView) return
    reportedView = next
    engine.viewChanged(next)
  }

  private fun updateKeepAwake() {
    host?.keepScreenOn = !released && engine.wantsScreenAwake
  }

  /** The activity for windows: the one the newest view is in, else the one on screen. */
  private fun activity(): Activity? {
    for (view in inline.asReversed()) {
      var c: Context? = view.context
      while (c is ContextWrapper) {
        if (c is Activity) return c
        c = (c as? com.facebook.react.bridge.ReactContext)?.currentActivity ?: c.baseContext
      }
    }
    return AnythingPlayerRuntime.foregroundActivity
  }

  // ── Fullscreen ──

  private fun enterFullscreen(lock: String?) {
    if (fullscreen != null) return
    val activity =
      activity()?.takeIf { !it.isFinishing }
        ?: throw PlayerError(ErrorCode.INVALID_ARGUMENT, "Fullscreen needs the app on screen.", false)
    val target = PictureHost(activity)
    target.controls = VideoControls(activity, this)
    val window = FullscreenWindow(activity, target, lock) { fullscreenDismissed() }
    fullscreen = window
    window.show()
    hostChanged()
    engine.fullscreenChanged(true)
  }

  private fun exitFullscreen() {
    fullscreen?.dismiss()
  }

  private fun fullscreenDismissed() {
    val window = fullscreen ?: return
    fullscreen = null
    window.restore()
    hostChanged()
    if (!released) engine.fullscreenChanged(false)
  }

  // ── Picture in Picture ──

  /** `whenBackgrounded: 'pip'` would take this player into Picture in Picture now. */
  val wantsAutoPip: Boolean
    get() {
      val v = controller.options.engine.video ?: return false
      if (released || v.ambient || v.whenBackgrounded != BackgroundMode.PIP) return false
      if (!status.playWhenReady || status.state !in AUTO_PIP_STATES) return false
      val h = host ?: return false
      return h === fullscreen?.host || (h as? VideoSurfaceView)?.onScreen == true
    }

  /** The picture's aspect and where it is on screen (the animation starts there). */
  fun pipShape(): PipShape {
    val size = primary.pictureSize
    val h = host
    val rect =
      (h as? VideoSurfaceView)?.screenRect()?.let { screen ->
        val picture = h.pictureRect()
        android.graphics.Rect(screen.left + picture.left, screen.top + picture.top, screen.left + picture.right, screen.top + picture.bottom)
      }
    return PipShape(size?.first ?: 16, size?.second ?: 9, rect)
  }

  fun pictureInPictureStarted(activity: Activity) {
    if (released) return
    val decor = activity.window?.decorView as? ViewGroup ?: return
    val target = PictureHost(activity)
    decor.addView(target, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    // The engine first: the quality cap freezes at the view's before the
    // picture moves to the window.
    engine.pictureInPictureChanged(true)
    pipHost = target
    fullscreen?.hideForPip()
    hostChanged()
  }

  fun pictureInPictureEnded() {
    val target = pipHost ?: return
    pipHost = null
    fullscreen?.showAfterPip()
    hostChanged()
    (target.parent as? ViewGroup)?.removeView(target)
    if (!released) engine.pictureInPictureChanged(false)
  }

  // ── Controls ──

  override fun reading(): VideoControls.Reading {
    val r = controller.currentProgress()
    return VideoControls.Reading(status.playWhenReady, r.position, status.duration, status.seekable, fullscreen != null)
  }

  override fun togglePlay() {
    try {
      if (status.playWhenReady) engine.pause() else engine.play()
    } catch (_: PlayerError) {
      // Nothing loaded: the button does nothing.
    }
  }

  override fun seekTo(seconds: Double) {
    try {
      engine.seek(seconds, false)
    } catch (_: PlayerError) {
      // Not seekable after all (a live stream).
    }
  }

  override fun toggleFullscreen() {
    try {
      if (fullscreen != null) exitFullscreen() else enterFullscreen(null)
    } catch (_: PlayerError) {
      // No activity on screen.
    }
  }

  // ── Subtitles ──

  private fun setCues(session: String?, trackId: String?, cues: ReadableArray?) {
    if (session == null || session != this.session || trackId == null) return
    val parsed = cues?.let(::parseCues) ?: emptyList()
    appCues[trackId] = AppTrack(parsed.map { CueTime(it.start, it.end) }, parsed)
    applyCues()
  }

  /** Draws the cues on screen now, emits `cues` when they change, and plans the next change. */
  private fun applyCues() {
    main.removeCallbacks(cueTick)
    if (released) return
    val video = status.video
    val track = video?.textTrack
    val app = track?.let { appCues[it] }
    val next =
      when {
        app != null -> {
          val reading = controller.currentProgress()
          val delay = video.subtitleDelay
          val active = CueSchedule.active(app.times, reading.position, delay)
          if (reading.isPlaying) {
            val rate = if (reading.rate > 0) reading.rate else 1.0
            val change = CueSchedule.nextChange(app.times, reading.position, delay)
            val wait = change?.let { ((it - reading.position) / rate * 1000).toLong() } ?: CUE_RECHECK_MS
            main.postDelayed(cueTick, wait.coerceIn(10L, CUE_RECHECK_MS))
          }
          active.map { app.cues[it] }
        }
        track != null && track.startsWith("track:") -> sourceCueList
        else -> emptyList()
      }
    if (next == shownCues && track == shownTrack) return
    shownCues = next
    shownTrack = track
    host?.overlay?.show(next)
    controller.emitEvent("cues", Arguments.createMap().apply { putArray("cues", cuesToArray(next)) })
  }

  // ── Poster ──

  private fun loadPoster(uri: String?) {
    posterLoad?.cancel(true)
    posterLoad = null
    posterBitmap = null
    host?.setPoster(null)
    if (uri.isNullOrEmpty()) return
    val load = DataSourceBitmapLoader(context).loadBitmap(posterUri(uri))
    posterLoad = load
    load.addListener(
      {
        if (posterLoad !== load || released) return@addListener
        val bitmap = runCatching { load.get() }.getOrNull() ?: return@addListener
        posterBitmap = bitmap
        if (status.video?.firstFrame != true) host?.setPoster(bitmap)
      },
      ContextCompat.getMainExecutor(context),
    )
  }

  /** A URL, a file, or a bundled image's resource name (release builds). */
  private fun posterUri(uri: String): Uri {
    if (uri.contains(":")) return Uri.parse(uri)
    val id = context.resources.getIdentifier(uri, "drawable", context.packageName)
    return if (id != 0) Uri.parse("android.resource://${context.packageName}/$id") else Uri.parse(uri)
  }

  companion object {
    private val AUTO_PIP_STATES = setOf(PlaybackState.LOADING, PlaybackState.BUFFERING, PlaybackState.PLAYING)
    private val NOTHING_PLAYS = setOf(PlaybackState.IDLE, PlaybackState.ENDED, PlaybackState.STOPPED, PlaybackState.ERROR)
  }
}

/** A picture's shape for Picture in Picture: its size and its place on screen. */
internal data class PipShape(val width: Int, val height: Int, val sourceRect: android.graphics.Rect?)

/**
 * `presentFullscreen()`: a full-screen dialog over the app, immersive (the
 * system bars hidden until a swipe), around the display cutout, optionally
 * holding the screen in landscape or portrait. Back dismisses it.
 */
private class FullscreenWindow(
  private val activity: Activity,
  val host: PictureHost,
  lock: String?,
  onDismiss: () -> Unit,
) {
  private val dialog = Dialog(activity, android.R.style.Theme_Black_NoTitleBar_Fullscreen)
  private val previousOrientation = activity.requestedOrientation
  private var hiddenForPip = false

  init {
    dialog.setContentView(host, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    dialog.setOnDismissListener { onDismiss() }
    dialog.window?.let { w ->
      w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      w.setBackgroundDrawable(android.graphics.drawable.ColorDrawable(Color.BLACK))
      WindowCompat.setDecorFitsSystemWindows(w, false)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        w.attributes = w.attributes.apply { layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES }
      }
    }
    when (lock) {
      "landscape" -> activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
      "portrait" -> activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
    }
  }

  fun show() {
    dialog.show()
    dialog.window?.let { w ->
      WindowCompat.getInsetsController(w, w.decorView).apply {
        hide(WindowInsetsCompat.Type.systemBars())
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
      }
    }
  }

  /** Also while hidden for Picture in Picture (`hide()` keeps the window). */
  fun dismiss() {
    hiddenForPip = false
    dialog.dismiss()
  }

  /** Picture in Picture shows the activity, not this dialog: step aside meanwhile. */
  fun hideForPip() {
    hiddenForPip = true
    dialog.hide()
  }

  fun showAfterPip() {
    if (!hiddenForPip) return
    hiddenForPip = false
    if (!activity.isFinishing) show()
  }

  fun restore() {
    if (!activity.isFinishing) activity.requestedOrientation = previousOrientation
  }
}

// ── Cues across the bridge ──

private fun ReadableMap.number(key: String): Double? = optDouble(key)?.takeIf { it.isFinite() }

private fun parseCues(array: ReadableArray): List<OverlayCue> =
  (0 until array.size()).mapNotNull { i ->
    if (array.getType(i) != ReadableType.Map) return@mapNotNull null
    val map = array.getMap(i) ?: return@mapNotNull null
    val spans =
      map.optArray("spans")?.let { list ->
        (0 until list.size()).mapNotNull { j ->
          if (list.getType(j) != ReadableType.Map) return@mapNotNull null
          val span = list.getMap(j) ?: return@mapNotNull null
          OverlaySpan(
            span.optString("text") ?: "",
            bold = span.optBoolean("bold") == true,
            italic = span.optBoolean("italic") == true,
            underline = span.optBoolean("underline") == true,
            color = span.optString("color")?.let { runCatching { Color.parseColor(it) }.getOrNull() },
          )
        }
      } ?: listOf(OverlaySpan(map.optString("text") ?: ""))
    OverlayCue(
      start = map.number("start") ?: 0.0,
      end = map.number("end") ?: 0.0,
      spans = spans,
      align = map.optString("align") ?: "center",
      vertical = map.optString("vertical") ?: "bottom",
      x = map.number("x"),
      y = map.number("y"),
    )
  }

private fun colorString(color: Int): String = String.format("#%06x", color and 0xffffff)

/** Cues as `SubtitleCue` (src/core/subtitles/types.ts) for the `cues` event. */
private fun cuesToArray(cues: List<OverlayCue>): WritableArray =
  Arguments.createArray().apply {
    cues.forEach { cue ->
      pushMap(
        Arguments.createMap().apply {
          putDouble("start", cue.start)
          putDouble("end", max(cue.end, cue.start))
          putString("text", cue.text)
          putArray(
            "spans",
            Arguments.createArray().apply {
              cue.spans.forEach { span ->
                pushMap(
                  Arguments.createMap().apply {
                    putString("text", span.text)
                    if (span.bold) putBoolean("bold", true)
                    if (span.italic) putBoolean("italic", true)
                    if (span.underline) putBoolean("underline", true)
                    span.color?.let { putString("color", colorString(it)) }
                  }
                )
              }
            },
          )
          putString("align", cue.align)
          putString("vertical", cue.vertical)
          cue.x?.let { putDouble("x", it) } ?: putNull("x")
          cue.y?.let { putDouble("y", it) } ?: putNull("y")
        }
      )
    }
  }
