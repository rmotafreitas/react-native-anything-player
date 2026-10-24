package com.anythingplayer.platform

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.graphics.Typeface
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.text.style.UnderlineSpan
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.accessibility.CaptioningManager
import android.widget.FrameLayout
import android.widget.ImageView
import java.util.Collections
import java.util.WeakHashMap
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** How the picture fills its box. */
internal enum class ContentFit(val wire: String) {
  CONTAIN("contain"),
  COVER("cover"),
  FILL("fill");

  companion object {
    fun fromWire(value: String?): ContentFit = entries.firstOrNull { it.wire == value } ?: CONTAIN
  }
}

/**
 * One ExoPlayer's picture: a TextureView whose SurfaceTexture outlives the
 * view's window, so the picture moves between the inline view, fullscreen
 * and Picture in Picture without the decoder seeing a new surface (no black
 * frame, the paused frame stays).
 */
internal class PictureSurface(context: Context, private val onSurface: (Surface?) -> Unit) : TextureView.SurfaceTextureListener {
  val view = TextureView(context)
  private var texture: SurfaceTexture? = null
  private var surface: Surface? = null

  init {
    view.surfaceTextureListener = this
  }

  /** Puts the picture in [host] (keeping its frame). */
  fun moveTo(host: PictureHost) {
    if (view.parent === host) return
    (view.parent as? ViewGroup)?.removeView(view)
    // A detached TextureView forgot its texture: hand it the one the decoder draws into.
    texture?.let { if (view.surfaceTexture !== it) view.setSurfaceTexture(it) }
    host.addPicture(view)
  }

  override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
    if (texture != null) return
    texture = st
    surface = Surface(st).also(onSurface)
  }

  /** Kept for the next window the picture goes to; released with [release]. */
  override fun onSurfaceTextureDestroyed(st: SurfaceTexture) = false

  override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) = Unit

  override fun onSurfaceTextureUpdated(st: SurfaceTexture) = Unit

  fun release() {
    (view.parent as? ViewGroup)?.removeView(view)
    onSurface(null)
    surface?.release()
    texture?.release()
    surface = null
    texture = null
  }
}

/**
 * A box that shows a video player's pictures (laid out to the picture's
 * aspect), its poster until the first frame, the subtitle overlay and,
 * optionally, controls. The inline view ([VideoSurfaceView]), the fullscreen
 * window and the Picture in Picture window each have one.
 */
internal open class PictureHost(context: Context) : FrameLayout(context) {
  val overlay = SubtitleOverlayView(context)
  private val poster = ImageView(context)
  var controls: VideoControls? = null
    set(value) {
      if (value === field) return
      field?.let {
        it.onBarChanged = null
        removeView(it)
      }
      barHeight = 0
      overlay.bottomInset = 0
      field = value
      value?.let {
        it.onBarChanged = { height ->
          barHeight = height
          updateInset()
        }
        addView(it, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
      }
      relayout()
    }
  var fit = ContentFit.CONTAIN
    set(value) {
      field = value
      poster.scaleType =
        when (value) {
          ContentFit.CONTAIN -> ImageView.ScaleType.FIT_CENTER
          ContentFit.COVER -> ImageView.ScaleType.CENTER_CROP
          ContentFit.FILL -> ImageView.ScaleType.FIT_XY
        }
      relayout()
    }
  /** Size changes (the engine caps the quality to the view). */
  var onResized: (() -> Unit)? = null
  /** The picture's size in pixels (0: unknown, the box is filled). */
  private var pictureWidth = 0
  private var pictureHeight = 0
  private var layoutPending = false
  private val pictureBox = Rect()
  private val visibleBox = Rect()
  private var barHeight = 0

  /** The part of the controls' bar over the picture (subtitles stay above it). */
  private fun updateInset() {
    overlay.bottomInset = max(0, barHeight - (height - visibleBox.bottom))
  }

  init {
    setBackgroundColor(Color.BLACK)
    clipChildren = true
    poster.visibility = View.GONE
    poster.scaleType = ImageView.ScaleType.FIT_CENTER
    addView(poster, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    addView(overlay, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  fun setPictureSize(width: Int, height: Int) {
    if (width == pictureWidth && height == pictureHeight) return
    pictureWidth = width
    pictureHeight = height
    relayout()
  }

  /** The poster, until the first frame (`null`: none). */
  fun setPoster(bitmap: Bitmap?) {
    poster.setImageBitmap(bitmap)
    poster.visibility = if (bitmap == null) View.GONE else View.VISIBLE
  }

  /** Adds a picture under everything else. */
  fun addPicture(view: View) {
    addView(view, 0, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    relayout()
  }

  /** [picture] on top of the other pictures; the poster, subtitles and controls above it. */
  fun restack(picture: View) {
    if (picture.parent !== this) return
    bringChildToFront(picture)
    bringChildToFront(poster)
    bringChildToFront(overlay)
    controls?.let { bringChildToFront(it) }
    relayout()
  }

  /** Where the picture is drawn in a [w]×[h] box (this one's by default). */
  fun pictureRect(out: Rect = Rect(), w: Int = width, h: Int = height): Rect {
    if (pictureWidth <= 0 || pictureHeight <= 0 || fit == ContentFit.FILL || w == 0 || h == 0) {
      out.set(0, 0, w, h)
      return out
    }
    val scale =
      if (fit == ContentFit.CONTAIN) min(w.toFloat() / pictureWidth, h.toFloat() / pictureHeight)
      else max(w.toFloat() / pictureWidth, h.toFloat() / pictureHeight)
    val pw = (pictureWidth * scale).roundToInt()
    val ph = (pictureHeight * scale).roundToInt()
    val left = (w - pw) / 2
    val top = (h - ph) / 2
    out.set(left, top, left + pw, top + ph)
    return out
  }

  /** The picture's box, and its part inside this box (subtitles sit there). */
  private fun computeBoxes(w: Int, h: Int) {
    pictureRect(pictureBox, w, h)
    visibleBox.set(pictureBox)
    if (!visibleBox.intersect(0, 0, w, h)) visibleBox.setEmpty()
  }

  /** The picture's aspect (width / height), `null` before it is known. */
  val pictureAspect: Double?
    get() = if (pictureWidth > 0 && pictureHeight > 0) pictureWidth.toDouble() / pictureHeight else null

  private fun isPicture(child: View) = child is TextureView

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(
      MeasureSpec.getSize(widthMeasureSpec),
      MeasureSpec.getSize(heightMeasureSpec),
    )
    computeBoxes(measuredWidth, measuredHeight)
    for (i in 0 until childCount) {
      val child = getChildAt(i)
      val box =
        when {
          isPicture(child) -> pictureBox
          child === overlay -> visibleBox
          else -> null
        }
      val w = box?.width() ?: measuredWidth
      val h = box?.height() ?: measuredHeight
      child.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY))
    }
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    computeBoxes(width, height)
    for (i in 0 until childCount) {
      val child = getChildAt(i)
      when {
        isPicture(child) -> child.layout(pictureBox.left, pictureBox.top, pictureBox.right, pictureBox.bottom)
        child === overlay -> child.layout(visibleBox.left, visibleBox.top, visibleBox.right, visibleBox.bottom)
        else -> child.layout(0, 0, width, height)
      }
    }
    updateInset()
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    onResized?.invoke()
  }

  /**
   * React Native lays out its own views only: children it does not know about
   * (the pictures, the overlay, the controls) are laid out here, on the next
   * frame.
   */
  override fun requestLayout() {
    super.requestLayout()
    if (layoutPending) return
    layoutPending = true
    post {
      layoutPending = false
      measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
      layout(left, top, right, bottom)
    }
  }

  private fun relayout() {
    requestLayout()
    invalidate()
  }
}

/**
 * The inline view behind `<VideoView>` (`RNAPVideoView`): finds its player by
 * id and tells it where it is, whether it is on screen and how big.
 */
internal class VideoSurfaceView(context: Context) : PictureHost(context) {
  var playerId: String? = null
    set(value) {
      if (value == field) return
      detachFromPlayer()
      field = value
      attachToPlayer()
    }
  var nativeControls = false
    set(value) {
      if (value == field) return
      field = value
      output?.viewChanged(this)
    }
  private var output: VideoOutput? = null
  private var lastVisible: Boolean? = null
  private val visibleRect = Rect()
  private val scrolled = ViewTreeObserver.OnScrollChangedListener { reportVisibility() }
  private val laidOut = ViewTreeObserver.OnGlobalLayoutListener { reportVisibility() }

  init {
    onResized = { output?.viewChanged(this) }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    viewTreeObserver.addOnScrollChangedListener(scrolled)
    viewTreeObserver.addOnGlobalLayoutListener(laidOut)
    attachToPlayer()
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnScrollChangedListener(scrolled)
    viewTreeObserver.removeOnGlobalLayoutListener(laidOut)
    detachFromPlayer()
    super.onDetachedFromWindow()
  }

  override fun onWindowVisibilityChanged(visibility: Int) {
    super.onWindowVisibilityChanged(visibility)
    reportVisibility()
  }

  /** On screen: attached, shown, and some of it inside the window. */
  val onScreen: Boolean
    get() = isAttachedToWindow && isShown && getGlobalVisibleRect(visibleRect) && visibleRect.width() > 0 && visibleRect.height() > 0

  /** The view's place on the screen (the Picture in Picture animation starts from it). */
  fun screenRect(): Rect? = if (getGlobalVisibleRect(visibleRect)) Rect(visibleRect) else null

  private fun reportVisibility() {
    val visible = onScreen
    if (visible == lastVisible) return
    lastVisible = visible
    output?.viewChanged(this)
  }

  /** Main thread. Looks for the player again (it was created or released). */
  fun attachToPlayer() {
    if (!isAttachedToWindow || output != null) return
    val id = playerId ?: return
    val found = AnythingPlayerRuntime.players[id]?.picture as? VideoOutput
    if (found == null) {
      waiting.add(this)
      return
    }
    waiting.remove(this)
    output = found
    found.attach(this)
  }

  private fun detachFromPlayer() {
    waiting.remove(this)
    output?.detach(this)
    output = null
    lastVisible = null
  }

  /** The player went away: wait for the next one with this id. */
  fun outputReleased() {
    output = null
    lastVisible = null
    attachToPlayer()
  }

  companion object {
    /** Views whose player does not exist yet (mounted before `new Player`, or after a release). */
    private val waiting: MutableSet<VideoSurfaceView> = Collections.newSetFromMap(WeakHashMap())

    /** A player was registered: views waiting for it attach. */
    fun playerRegistered() {
      waiting.toList().forEach { it.attachToPlayer() }
    }
  }
}

/**
 * Draws cues over the picture in the OS's caption style (Settings ›
 * Accessibility › Caption preferences: text and background colours, the
 * window, the edge, the typeface and the text size).
 */
internal class SubtitleOverlayView(context: Context) : View(context) {
  private val captioning = context.getSystemService(Context.CAPTIONING_SERVICE) as? CaptioningManager
  private var cues: List<OverlayCue> = emptyList()
  private val paint = TextPaint(Paint.ANTI_ALIAS_FLAG)
  private val windowPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val bitmapPaint = Paint(Paint.FILTER_BITMAP_FLAG)
  private val dest = RectF()
  private val density = context.resources.displayMetrics.density
  /** Pixels at the bottom covered by the controls: cues placed at the bottom stay above. */
  var bottomInset = 0
    set(value) {
      if (value == field) return
      field = value
      invalidate()
    }

  init {
    setWillNotDraw(false)
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  fun show(next: List<OverlayCue>) {
    if (next == cues) return
    cues = next
    invalidate()
  }

  /** The user's caption style, read when drawing (it can change while playing). */
  private class Style(
    val foreground: Int,
    val background: Int,
    val window: Int,
    val edgeType: Int,
    val edgeColor: Int,
    val typeface: Typeface,
  )

  private fun style(): Style {
    val s = captioning?.userStyle
    return Style(
      foreground = s?.takeIf { it.hasForegroundColor() }?.foregroundColor ?: Color.WHITE,
      background = s?.takeIf { it.hasBackgroundColor() }?.backgroundColor ?: Color.argb(153, 0, 0, 0),
      window = s?.takeIf { it.hasWindowColor() }?.windowColor ?: Color.TRANSPARENT,
      edgeType = s?.takeIf { it.hasEdgeType() }?.edgeType ?: CaptioningManager.CaptionStyle.EDGE_TYPE_NONE,
      edgeColor = s?.takeIf { it.hasEdgeColor() }?.edgeColor ?: Color.BLACK,
      typeface = s?.typeface ?: Typeface.DEFAULT,
    )
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (cues.isEmpty() || width == 0 || height == 0) return
    val style = style()
    // ExoPlayer's default size: 5.33% of the picture's height, times the user's scale.
    paint.textSize = max(12f * density, height * 0.0533f * (captioning?.fontScale ?: 1f))
    paint.typeface = style.typeface
    for (cue in cues) {
      val bitmap = cue.bitmap
      if (bitmap != null) drawBitmap(canvas, cue, bitmap) else drawText(canvas, cue, style)
    }
  }

  private fun drawBitmap(canvas: Canvas, cue: OverlayCue, bitmap: Bitmap) {
    val w = (cue.bitmapWidth ?: (bitmap.width.toDouble() / width)) * width
    val h = cue.bitmapHeight?.let { it * height } ?: (w * bitmap.height / bitmap.width)
    val left = (cue.x ?: 0.0) * width
    val top = (cue.y ?: 0.0) * height
    dest.set(left.toFloat(), top.toFloat(), (left + w).toFloat(), (top + h).toFloat())
    canvas.drawBitmap(bitmap, null, dest, bitmapPaint)
  }

  /** The cue's runs as styled text; [colors] off for the outline pass. */
  private fun spanned(cue: OverlayCue, style: Style, colors: Boolean): CharSequence {
    val text = SpannableStringBuilder()
    for (span in cue.spans) {
      val start = text.length
      text.append(span.text)
      val end = text.length
      if (start == end) continue
      val flags = Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
      val face =
        when {
          span.bold && span.italic -> Typeface.BOLD_ITALIC
          span.bold -> Typeface.BOLD
          span.italic -> Typeface.ITALIC
          else -> null
        }
      face?.let { text.setSpan(StyleSpan(it), start, end, flags) }
      if (span.underline) text.setSpan(UnderlineSpan(), start, end, flags)
      if (colors) {
        span.color?.let { text.setSpan(ForegroundColorSpan(it), start, end, flags) }
        if (Color.alpha(style.background) > 0) text.setSpan(BackgroundColorSpan(style.background), start, end, flags)
      }
    }
    return text
  }

  private fun drawText(canvas: Canvas, cue: OverlayCue, style: Style) {
    val maxWidth = (width * 0.9f).toInt()
    val alignment =
      when (cue.align) {
        "left" -> Layout.Alignment.ALIGN_NORMAL
        "right" -> Layout.Alignment.ALIGN_OPPOSITE
        else -> Layout.Alignment.ALIGN_CENTER
      }
    val text = spanned(cue, style, colors = true)
    paint.style = Paint.Style.FILL
    paint.color = style.foreground
    applyShadow(style)
    val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, maxWidth).setAlignment(alignment).build()
    val left = boxLeft(cue, maxWidth)
    val top = boxTop(cue, layout.height)
    canvas.save()
    canvas.translate(left, top)
    if (Color.alpha(style.window) > 0 && layout.lineCount > 0) {
      // The window wraps the lines, not the whole box they may use.
      var l = Float.MAX_VALUE
      var r = 0f
      for (i in 0 until layout.lineCount) {
        l = min(l, layout.getLineLeft(i))
        r = max(r, layout.getLineRight(i))
      }
      windowPaint.color = style.window
      val pad = 4 * density
      canvas.drawRect(l - pad, -pad, r + pad, layout.height + pad, windowPaint)
    }
    if (style.edgeType == CaptioningManager.CaptionStyle.EDGE_TYPE_OUTLINE) {
      // The outline first, under the text: the same runs, stroked.
      val outline = TextPaint(paint).apply {
        this.style = Paint.Style.STROKE
        strokeJoin = Paint.Join.ROUND
        strokeWidth = max(2f, textSize * 0.08f)
        color = style.edgeColor
        clearShadowLayer()
      }
      val plain = spanned(cue, style, colors = false)
      StaticLayout.Builder.obtain(plain, 0, plain.length, outline, maxWidth).setAlignment(alignment).build().draw(canvas)
    }
    layout.draw(canvas)
    canvas.restore()
  }

  private fun applyShadow(style: Style) {
    val d = density
    when (style.edgeType) {
      CaptioningManager.CaptionStyle.EDGE_TYPE_DROP_SHADOW -> paint.setShadowLayer(2 * d, 2 * d, 2 * d, style.edgeColor)
      CaptioningManager.CaptionStyle.EDGE_TYPE_RAISED -> paint.setShadowLayer(d, -d, -d, style.edgeColor)
      CaptioningManager.CaptionStyle.EDGE_TYPE_DEPRESSED -> paint.setShadowLayer(d, d, d, style.edgeColor)
      else -> paint.clearShadowLayer()
    }
  }

  /** The text box's left edge: at the cue's `x` (anchored by its alignment), else centred. */
  private fun boxLeft(cue: OverlayCue, boxWidth: Int): Float {
    val x = cue.x ?: return (width - boxWidth) / 2f
    val anchor =
      when (cue.align) {
        "left" -> 0f
        "right" -> boxWidth.toFloat()
        else -> boxWidth / 2f
      }
    return ((x * width).toFloat() - anchor).coerceIn(0f, max(0f, (width - boxWidth).toFloat()))
  }

  /** The text box's top edge: at the cue's `y` (anchored by its vertical side), else near an edge. */
  private fun boxTop(cue: OverlayCue, boxHeight: Int): Float {
    val margin = height * 0.06f
    val y = cue.y
    if (y == null) {
      return when (cue.vertical) {
        "top" -> margin
        "middle" -> (height - boxHeight) / 2f
        else -> height - max(margin, bottomInset.toFloat()) - boxHeight
      }
    }
    val anchor =
      when (cue.vertical) {
        "top" -> 0f
        "middle" -> boxHeight / 2f
        else -> boxHeight.toFloat()
      }
    return ((y * height).toFloat() - anchor).coerceIn(0f, max(0f, (height - boxHeight).toFloat()))
  }
}
