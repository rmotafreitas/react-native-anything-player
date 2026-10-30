package com.anythingplayer.platform

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import java.util.Locale
import kotlin.math.max
import kotlin.math.min

/** How long the controls stay up after a touch while playing. */
private const val HIDE_AFTER_MS = 3_000L

/** How often the time and the seek bar move. */
private const val TICK_MS = 500L

/**
 * RNAP's own playback controls on Android (Android has no system player
 * UI): play/pause, the time, a seek bar and fullscreen. Shown by
 * `<VideoView nativeControls />` and in fullscreen; a tap shows or hides
 * them. Plain platform widgets, no extra library; D-pad friendly for TVs.
 */
internal class VideoControls(context: Context, private val actions: Actions) : FrameLayout(context) {
  /** What the controls read and do. */
  interface Actions {
    fun reading(): Reading
    fun togglePlay()
    fun seekTo(seconds: Double)
    fun toggleFullscreen()
  }

  data class Reading(
    val playing: Boolean,
    val position: Double,
    val duration: Double?,
    val seekable: Boolean,
    val fullscreen: Boolean,
  )

  private val density = context.resources.displayMetrics.density
  private val bar = LinearLayout(context)
  private val playGlyph = Glyph(Glyph.Kind.PLAY)
  private val fullGlyph = Glyph(Glyph.Kind.ENTER_FULLSCREEN)
  private val play = button(playGlyph)
  private val elapsed = label()
  private val seek = SeekBar(context)
  private val total = label()
  private val full = button(fullGlyph)
  private var dragging = false
  private var shown = true
  /** The bar's height while shown, 0 while hidden (subtitles move up meanwhile). */
  var onBarChanged: ((Int) -> Unit)? = null
  private val hide = Runnable { setShown(false) }
  private val tick =
    object : Runnable {
      override fun run() {
        refresh()
        if (shown && isAttachedToWindow) postDelayed(this, TICK_MS)
      }
    }

  init {
    isClickable = true
    setOnClickListener { setShown(!shown) }
    bar.orientation = LinearLayout.HORIZONTAL
    bar.gravity = Gravity.CENTER_VERTICAL
    val pad = dp(8)
    bar.setPadding(pad, dp(24), pad, pad)
    bar.background =
      GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(Color.argb(170, 0, 0, 0), Color.TRANSPARENT))
    bar.addView(play, LinearLayout.LayoutParams(dp(44), dp(44)))
    bar.addView(elapsed, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    bar.addView(seek, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
    bar.addView(total, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT))
    bar.addView(full, LinearLayout.LayoutParams(dp(44), dp(44)))
    addView(bar, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM))
    play.setOnClickListener {
      actions.togglePlay()
      poke()
      refresh()
    }
    full.setOnClickListener {
      actions.toggleFullscreen()
      poke()
    }
    seek.setOnSeekBarChangeListener(
      object : SeekBar.OnSeekBarChangeListener {
        override fun onProgressChanged(bar: SeekBar, value: Int, fromUser: Boolean) {
          if (fromUser) elapsed.text = clock(value / 1000.0)
        }

        override fun onStartTrackingTouch(bar: SeekBar) {
          dragging = true
          removeCallbacks(hide)
        }

        override fun onStopTrackingTouch(bar: SeekBar) {
          dragging = false
          actions.seekTo(bar.progress / 1000.0)
          poke()
        }
      },
    )
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    setShown(true)
  }

  override fun onDetachedFromWindow() {
    removeCallbacks(hide)
    removeCallbacks(tick)
    onBarChanged?.invoke(0)
    super.onDetachedFromWindow()
  }

  /** Shows the controls; they hide again after a while if playing. */
  fun poke() {
    removeCallbacks(hide)
    if (!shown) setShown(true)
    if (actions.reading().playing) postDelayed(hide, HIDE_AFTER_MS)
  }

  private fun setShown(value: Boolean) {
    shown = value
    bar.visibility = if (value) View.VISIBLE else View.INVISIBLE
    onBarChanged?.invoke(if (value) bar.height.takeIf { it > 0 } ?: dp(80) else 0)
    removeCallbacks(tick)
    removeCallbacks(hide)
    if (value) {
      refresh()
      postDelayed(tick, TICK_MS)
      if (actions.reading().playing) postDelayed(hide, HIDE_AFTER_MS)
    }
  }

  /** Reads the player again (a status change, a tick). */
  fun refresh() {
    val r = actions.reading()
    playGlyph.kind = if (r.playing) Glyph.Kind.PAUSE else Glyph.Kind.PLAY
    play.contentDescription = if (r.playing) "Pause" else "Play"
    fullGlyph.kind = if (r.fullscreen) Glyph.Kind.EXIT_FULLSCREEN else Glyph.Kind.ENTER_FULLSCREEN
    full.contentDescription = if (r.fullscreen) "Exit full screen" else "Full screen"
    play.invalidate()
    full.invalidate()
    val duration = r.duration
    val scrubbable = r.seekable && duration != null && duration > 0
    seek.visibility = if (scrubbable) View.VISIBLE else View.INVISIBLE
    total.visibility = if (scrubbable) View.VISIBLE else View.GONE
    if (scrubbable && !dragging) {
      seek.max = (duration!! * 1000).toInt()
      seek.progress = (min(r.position, duration) * 1000).toInt()
      total.text = clock(duration)
    }
    if (!dragging) elapsed.text = if (duration == null && !r.seekable) "LIVE" else clock(r.position)
    // Paused: the controls stay.
    if (!r.playing) removeCallbacks(hide)
  }

  private fun button(glyph: Glyph) =
    ImageButton(context).apply {
      setImageDrawable(glyph)
      background = null
      val p = dp(10)
      setPadding(p, p, p, p)
      isFocusable = true
    }

  private fun label() =
    TextView(context).apply {
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setPadding(dp(6), 0, dp(6), 0)
      fontFeatureSettings = "tnum"
    }

  private fun dp(value: Int) = (value * density).toInt()

  private fun clock(seconds: Double): String {
    val s = max(0, seconds.toLong())
    val h = s / 3600
    val m = (s % 3600) / 60
    val sec = s % 60
    return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, sec) else String.format(Locale.US, "%d:%02d", m, sec)
  }
}

/** The controls' icons, drawn: no image resources to ship. */
internal class Glyph(var kind: Kind) : Drawable() {
  enum class Kind { PLAY, PAUSE, ENTER_FULLSCREEN, EXIT_FULLSCREEN }

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
  private val stroke =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      style = Paint.Style.STROKE
      strokeCap = Paint.Cap.SQUARE
    }
  private val path = Path()

  override fun draw(canvas: Canvas) {
    val b = bounds
    val size = min(b.width(), b.height()).toFloat()
    val l = b.exactCenterX() - size / 2
    val t = b.exactCenterY() - size / 2
    path.reset()
    when (kind) {
      Kind.PLAY -> {
        path.moveTo(l + size * 0.22f, t + size * 0.12f)
        path.lineTo(l + size * 0.88f, t + size * 0.5f)
        path.lineTo(l + size * 0.22f, t + size * 0.88f)
        path.close()
        canvas.drawPath(path, fill)
      }
      Kind.PAUSE -> {
        canvas.drawRect(l + size * 0.2f, t + size * 0.12f, l + size * 0.4f, t + size * 0.88f, fill)
        canvas.drawRect(l + size * 0.6f, t + size * 0.12f, l + size * 0.8f, t + size * 0.88f, fill)
      }
      Kind.ENTER_FULLSCREEN, Kind.EXIT_FULLSCREEN -> {
        stroke.strokeWidth = size * 0.1f
        val outward = kind == Kind.ENTER_FULLSCREEN
        val a = size * 0.12f
        val c = size * 0.36f
        // Four corners, pointing out (enter) or in (exit).
        for ((x, y) in listOf(0f to 0f, 1f to 0f, 0f to 1f, 1f to 1f)) {
          val cx = l + (if (x == 0f) a else size - a)
          val cy = t + (if (y == 0f) a else size - a)
          val dx = if (x == 0f) 1f else -1f
          val dy = if (y == 0f) 1f else -1f
          val (px, py) = if (outward) cx to cy else (cx + dx * (c - a)) to (cy + dy * (c - a))
          val sx = if (outward) dx else -dx
          val sy = if (outward) dy else -dy
          path.moveTo(px + sx * (c - a), py)
          path.lineTo(px, py)
          path.lineTo(px, py + sy * (c - a))
        }
        canvas.drawPath(path, stroke)
      }
    }
  }

  override fun setAlpha(alpha: Int) {
    fill.alpha = alpha
    stroke.alpha = alpha
  }

  override fun setColorFilter(colorFilter: ColorFilter?) {
    fill.colorFilter = colorFilter
    stroke.colorFilter = colorFilter
  }

  @Deprecated("Deprecated in Java")
  override fun getOpacity() = PixelFormat.TRANSLUCENT

  override fun getIntrinsicWidth() = 48

  override fun getIntrinsicHeight() = 48
}
