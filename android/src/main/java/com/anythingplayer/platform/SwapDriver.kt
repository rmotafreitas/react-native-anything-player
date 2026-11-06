package com.anythingplayer.platform

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.InterruptionReason
import com.anythingplayer.core.LiveAligner
import com.anythingplayer.core.MediaTrack
import com.anythingplayer.core.OpenRequest
import com.anythingplayer.core.PlaybackSample
import com.anythingplayer.core.PlayerError
import com.anythingplayer.core.QualityConstraints
import com.anythingplayer.core.ReadyInfo
import com.anythingplayer.core.StreamMetadata
import com.anythingplayer.core.VideoInfo
import com.anythingplayer.core.VideoVariant

/** Where the players show: a video's picture, nothing for a sound. */
internal interface SwapStage {
  fun show(current: ExoPlayerDriver, hidden: ExoPlayerDriver?)
}

/** A sound's stage: nothing to show. */
internal object NoStage : SwapStage {
  override fun show(current: ExoPlayerDriver, hidden: ExoPlayerDriver?) = Unit
}

/** How far ahead of the picture the new file opens, seconds. */
private const val LOOKAHEAD_S = 1.5

/** How often the rendezvous checks the picture's position. */
private const val RENDEZVOUS_TICK_MS = 40L

/** What a muted ExoPlayer can do while a live switch lines up (Sonic runs it up to 4× here). */
private val ALIGN_CAPS = LiveAligner.Caps(maxRate = 4.0, minRate = 0.5, jump = LiveAligner.Jump.NEVER, startLead = 0.1, jumpLead = 0.3)

/** HLS or DASH by program dates: a seek within the live window is cheap (no new connection). */
private val CLOCK_CAPS = ALIGN_CAPS.copy(jump = LiveAligner.Jump.ALWAYS, jumpLead = 0.5)

/** Fallbacks after which the aligner's last gap belongs to a mapping that no longer holds. */
private val STALE_GAP = setOf("reconnecting", "discontinuity")

/**
 * A player's local output: the ExoPlayer heard (and on screen), and a second
 * one that prepares a quality switch behind it (`open(swap = true)`, separate
 * files of one video or one sound). The second one opens a little ahead,
 * muted, waits until the first reaches that point, plays, and takes over: no
 * spinner, no gap, no jump. The second ExoPlayer is only made at the first
 * switch. Twin of `src/web/platform/SwapDriver.ts`.
 *
 * A live stream has no shared timeline: each connection starts with its
 * server's burst of recent audio. There the new player is lined up with what
 * is heard first ([LiveAligner]), by its buffered edge (a progressive stream)
 * or its program dates (HLS, DASH: moved by a seek too): held, or run faster
 * or slower, muted, until it plays what the old one plays; then it takes over
 * by volume alone. One that cannot be lined up goes ahead with a
 * `discontinuity` when the player needs it, else is refused. Positions stay
 * continuous across a live switch.
 */
internal class SwapDriver(
  private val observer: DriverObserver,
  private val make: (DriverObserver) -> ExoPlayerDriver,
  private val stage: SwapStage,
) : Output {
  private class Pending(val generation: Int, var target: Double?, var ready: Boolean = false) {
    /** Live: lines the new audio up with what is heard (`null`: not, or not yet). */
    var aligner: LiveAligner? = null

    /** Gave up lining up: takes over on its first audio, reported as a discontinuity. */
    var fallback = false

    /** The player needs it (the current item stalls): one that cannot be lined up switches anyway. */
    var required = false

    /** What a fallback skips (+) or repeats (−), seconds, when the aligner knew. */
    var jump: Double? = null

    /** The rate the aligner asked of the new player (× the app's). */
    var alignRate = 1.0

    /** The latest metadata the new player's audio reached: told again once it is heard. */
    var metadata: StreamMetadata? = null

    /** When it came ([told]): told again only if after the old player's latest. */
    var metadataAt = 0
  }

  private val main = Handler(Looper.getMainLooper())
  private val proxy = Proxy()
  /** The driver on screen. */
  var current: ExoPlayerDriver = make(proxy)
    private set
  private var spare: ExoPlayerDriver? = null
  private var pending: Pending? = null
  /** The queue's next item (`prepareNext`). */
  private var queuedNext: OpenRequest? = null
  private var volume = 1.0
  private var rate = 1.0
  private var loop = false
  private var quality: QualityConstraints? = null
  private var videoEnabled = true
  /** The engine's track picks (audio, text): a switch's file plays the same ones. */
  private var tracks: Pair<String?, String?>? = null
  private val tick = Runnable { rendezvous() }
  private val alignTick = Runnable { alignStep() }

  /** A start the aligner timed between two ticks. */
  private val alignStart = Runnable { if (aligning) spare?.play() }

  /** The current player's generation (its events' positions are shifted). */
  private var generation = -1

  /** Live: the current player's time − the position reported (continuous across switches). */
  private var shift = 0.0

  /** Positions follow [shift] (a live switch happened): a reconnection re-bases them, even at a shift of 0. */
  private var shifted = false

  /** The last position reported (a reconnection's item starts again from 0: it goes on from here). */
  private var lastReported = 0.0

  /** Metadata told so far (either player), and the count at the current player's latest. */
  private var told = 0
  private var toldCurrent = 0

  /** The current player's item when [shift] was last set, its last time, and whether we moved it since. */
  private var shiftItem: String? = null
  private var lastRaw = 0.0
  private var seeked = false

  /** Both drivers, the one on screen first. */
  val drivers: List<ExoPlayerDriver>
    get() = listOfNotNull(current, spare)

  // ── EngineDriver ──

  override fun open(request: OpenRequest) {
    if (request.swap) return prepare(request)
    drop()
    queuedNext = null
    generation = request.generation
    shift = 0.0
    shifted = false
    current.open(request)
    shiftItem = current.currentItemId
    lastRaw = 0.0
    seeked = false
  }

  override fun play() = current.play()

  override fun pause() = current.pause()

  override fun seek(seconds: Double) = seek(seconds, false)

  override fun seek(seconds: Double, exact: Boolean) {
    seeked = true
    current.seek(seconds + shift, exact)
  }

  override fun releaseConnection() {
    drop()
    queuedNext = null
    current.releaseConnection()
  }

  override fun unload() {
    drop()
    queuedNext = null
    current.unload()
  }

  override fun setVolume(effective: Double) {
    volume = effective
    current.setVolume(effective)
  }

  override fun setRate(rate: Double) {
    this.rate = rate
    current.setRate(rate)
    // A live switch lining up keeps running at its multiple of the app's rate.
    spare?.setRate(rate * (pending?.alignRate ?: 1.0))
  }

  override fun setLoop(loop: Boolean) {
    this.loop = loop
    current.setLoop(loop)
    spare?.setLoop(loop)
  }

  override fun setQuality(constraints: QualityConstraints) {
    quality = constraints
    current.setQuality(constraints)
  }

  override fun setVideoEnabled(enabled: Boolean) {
    videoEnabled = enabled
    current.setVideoEnabled(enabled)
    spare?.setVideoEnabled(enabled)
  }

  override fun selectTracks(audio: String?, text: String?) {
    tracks = audio to text
    current.selectTracks(audio, text)
  }

  override fun cancelSwap(generation: Int) {
    if (pending?.generation == generation) drop()
  }

  // ── The queue's next item: in the current player's playlist (gapless) ──

  override val preparesNext: Boolean
    get() = true

  override fun prepareNext(request: OpenRequest) {
    queuedNext = request
    current.prepareNext(request)
  }

  override fun cancelNext(generation: Int) {
    if (queuedNext?.generation == generation) queuedNext = null
    current.cancelNext(generation)
  }

  override fun advance(generation: Int) {
    val request = queuedNext?.takeIf { it.generation == generation }
    queuedNext = null
    // The player that has it in its playlist starts it (or opens it now).
    if (request != null) adopt(generation)
    current.advance(generation)
  }

  /** The current player moved onto the queue's next item: positions start over with it. */
  private fun adopt(generation: Int) {
    this.generation = generation
    shift = 0.0
    shifted = false
    shiftItem = current.currentItemId
    lastRaw = 0.0
    seeked = false
  }

  override fun switchOutput(outputId: String) {
    // The routing driver switches outputs.
  }

  /**
   * A reconnection is a new item whose position starts again from 0: before
   * anything of it is reported, the position goes on from the last one.
   */
  private fun rebase() {
    val item = current.currentItemId
    val raw = current.sample().position
    // A new item, or (after a load error) ExoPlayer restarting the same one from 0 when we did not seek.
    val restarted = item == shiftItem && !seeked && current.isProgressive && raw < lastRaw - RESTART_S
    lastRaw = raw
    seeked = false
    if (item == shiftItem && !restarted) return
    shiftItem = item
    if (shifted) shift = raw - lastReported
  }

  override fun sample(): PlaybackSample {
    rebase()
    val sample = current.sample()
    if (!shifted) return sample
    // A reconnection's item starts again from 0 (ExoPlayer): never before 0.
    lastReported = maxOf(0.0, sample.position - shift)
    return PlaybackSample(lastReported, maxOf(0.0, sample.bufferedPosition - shift))
  }

  override fun progress(): ProgressReading {
    rebase()
    val reading = current.progress()
    if (!shifted) return reading
    lastReported = maxOf(0.0, reading.position - shift)
    return reading.copy(
      position = lastReported,
      buffered = maxOf(0.0, reading.buffered - shift),
      edge = reading.edge?.let { it - shift },
    )
  }

  fun destroy() {
    drop()
    current.destroy()
    spare?.destroy()
    spare = null
  }

  // ── The switch ──

  private fun prepare(request: OpenRequest) {
    drop()
    val next = spare ?: make(proxy).also { spare = it }
    val position = current.sample().position
    val target = if (request.startPosition != null) position + LOOKAHEAD_S else null
    pending = Pending(request.generation, target).also { it.required = request.required }
    next.setVolume(0.0)
    next.setRate(rate)
    next.setLoop(loop)
    next.setVideoEnabled(videoEnabled)
    quality?.let { next.setQuality(it) }
    tracks?.let { (audio, text) -> next.selectTracks(audio, text) }
    stage.show(current, next)
    next.open(request.copy(swap = false, startPosition = target, playWhenReady = false))
  }

  /** Plays the new file once the picture reaches where it waits. */
  private fun rendezvous() {
    val waiting = pending ?: return
    val next = spare ?: return
    if (!waiting.ready) return
    val target = waiting.target ?: return startAligning(waiting, next)
    val reading = current.progress()
    // A stalled picture, or one already at the point: no reason to wait.
    if (!reading.isPlaying || reading.position >= target - 0.04) {
      if (reading.isPlaying && reading.position > target + 0.3) {
        // Too slow to open: try again a little further ahead.
        waiting.target = reading.position + LOOKAHEAD_S
        next.seek(waiting.target!!, true)
      } else {
        next.play()
        return
      }
    }
    main.postDelayed(tick, RENDEZVOUS_TICK_MS)
  }

  // ── A live switch, lined up ──

  private val aligning: Boolean
    get() = pending?.let { it.aligner != null && !it.fallback } ?: false

  /** Live: a progressive stream, or HLS / DASH with program dates, on both sides is lined up; anything else starts at once. */
  private fun startAligning(waiting: Pending, next: ExoPlayerDriver) {
    current.resetAlignEdge()
    next.resetAlignEdge()
    val old = current.alignReading()
    val new = next.alignReading()
    if (old == null || new == null || (old.clock == null) != (new.clock == null)) {
      // HLS or DASH without program dates, or renditions of different kinds: at once, as before.
      Log.d(TAG, "quality switch not aligned: adaptive")
      return next.play()
    }
    waiting.aligner = LiveAligner(if (new.clock != null) CLOCK_CAPS else ALIGN_CAPS)
    alignStep()
  }

  private fun alignStep() {
    val waiting = pending ?: return
    val aligner = waiting.aligner ?: return
    if (waiting.fallback) return
    val old = current.alignReading()
    val next = spare?.alignReading()
    // An item that changed kind: as before.
    val action =
      if (old == null || next == null) aligner.interrupt() else aligner.step(SystemClock.elapsedRealtime(), old, next)
    apply(action)
    if (pending === waiting && aligning) main.postDelayed(alignTick, LiveAligner.TICK_MS)
  }

  private fun apply(action: LiveAligner.Action) {
    val waiting = pending ?: return
    val next = spare ?: return
    when (action) {
      LiveAligner.Action.Wait -> Unit
      is LiveAligner.Action.Rate -> {
        waiting.alignRate = if (action.rate == 0.0) 1.0 else action.rate
        when {
          action.rate == 0.0 -> next.pause()
          action.afterMs > 0 -> {
            // Due between two ticks: started on time.
            next.setRate(action.rate * rate)
            main.postDelayed(alignStart, action.afterMs)
          }
          else -> {
            next.setRate(action.rate * rate)
            next.play()
          }
        }
      }
      is LiveAligner.Action.JumpTo -> next.seek(action.to, true)
      is LiveAligner.Action.TakeOver -> {
        Log.d(TAG, "quality switch aligned: residual ${action.residual} s, offset ${waiting.aligner?.offset} s")
        switched()
      }
      is LiveAligner.Action.Fallback -> {
        // The old one stalls: the player needs the switch now.
        if (action.reason == "stalled") waiting.required = true
        // A connection replaced or jumped: the last gap read is the old mapping's.
        waiting.jump = if (action.reason in STALE_GAP) null else waiting.aligner?.gap
        unaligned(waiting, next, action.reason)
      }
    }
  }

  /**
   * A live switch that cannot be lined up: switched anyway, as a
   * `discontinuity`, when the player needs it; else dropped, the current one
   * playing on (`QUALITY_SWITCH_FAILED`).
   */
  private fun unaligned(waiting: Pending, next: ExoPlayerDriver, reason: String) {
    Log.d(TAG, "quality switch not aligned: $reason, gap ${waiting.aligner?.gap} s")
    main.removeCallbacks(alignTick)
    main.removeCallbacks(alignStart)
    if (!waiting.required) {
      // The engine drops it (cancelSwap) and the app hears why.
      observer.onFailed(
        waiting.generation,
        PlayerError(
          ErrorCode.QUALITY_SWITCH_FAILED,
          "The live switch could not be lined up with what is heard ($reason).",
          recoverable = true,
        ),
      )
      return
    }
    waiting.fallback = true
    waiting.alignRate = 1.0
    next.setRate(rate)
    // Already playing (it was running to catch up): at once.
    if (next.progress().isPlaying) switched() else next.play()
  }

  /** The new player takes over (its first audio, or lined up): the engine hears it play, its tracks, and a fallback's jump. */
  private fun switched() {
    val waiting = pending ?: return
    takeOver(waiting.generation, live = waiting.target == null)
    observer.onPlaying(waiting.generation)
    // The engine took the switch's generation: the new file's tracks are the ones now.
    current.mappedTracks?.let { observer.onTracks(waiting.generation, it.tracks, it.variants) }
    // A fallback's jump first: the title told next is heard after it.
    if (waiting.fallback) observer.onDiscontinuity(waiting.generation, sample().position, "switch", waiting.jump)
    // What it reached while it lined up was the pending generation's: told now.
    waiting.metadata?.let { if (waiting.metadataAt > toldCurrent) observer.onStreamMetadata(waiting.generation, it) }
  }

  /** The new file plays: it is the picture and the sound now. */
  private fun takeOver(generation: Int, live: Boolean) {
    val next = spare ?: return
    // The old player may have moved onto a reconnection's item since it was last read.
    rebase()
    val old = current
    main.removeCallbacks(tick)
    main.removeCallbacks(alignTick)
    main.removeCallbacks(alignStart)
    pending = null
    // Live: the position goes on from where the old one was.
    shift = if (live) next.sample().position - (old.sample().position - shift) else 0.0
    shifted = live
    shiftItem = next.currentItemId
    seeked = false
    lastRaw = next.sample().position
    this.generation = generation
    next.setRate(rate)
    next.setVolume(volume)
    current = next
    spare = old
    stage.show(next, old)
    old.releaseConnection()
    // The queue's next item was in the old player's playlist: the new one prepares it.
    queuedNext?.let { next.prepareNext(it) }
  }

  private fun drop() {
    if (pending == null) return
    main.removeCallbacks(tick)
    main.removeCallbacks(alignTick)
    main.removeCallbacks(alignStart)
    pending = null
    spare?.releaseConnection()
  }

  private fun switching(generation: Int) = pending?.generation == generation

  /** Forwards both drivers' events; the switch's ready starts the rendezvous, its playing takes over first. */
  private inner class Proxy : DriverObserver {
    override fun onReady(generation: Int, info: ReadyInfo) {
      observer.onReady(generation, info)
      val waiting = pending
      if (switching(generation) && waiting != null && !waiting.ready) {
        waiting.ready = true
        rendezvous()
      }
    }

    override fun onPlaying(generation: Int) {
      when {
        !switching(generation) -> observer.onPlaying(generation)
        // Lining up: the new player plays muted, and takes over later.
        aligning -> Unit
        else -> switched()
      }
    }

    override fun onBuffering(generation: Int) = observer.onBuffering(generation)

    override fun onEnded(generation: Int) = observer.onEnded(generation)

    override fun onAdvanced(generation: Int, playing: Boolean) {
      if (queuedNext?.generation == generation) {
        queuedNext = null
        adopt(generation)
      }
      observer.onAdvanced(generation, playing)
    }

    override fun onFailed(generation: Int, error: PlayerError) = observer.onFailed(generation, error)

    override fun onPausedExternally(generation: Int, reason: InterruptionReason) =
      observer.onPausedExternally(generation, reason)

    override fun onStreamMetadata(generation: Int, metadata: StreamMetadata) {
      // The new player's, while it lines up: told again once it is heard
      // (unless the old one told a later title since).
      told += 1
      val waiting = pending
      if (waiting != null && switching(generation)) {
        waiting.metadata = metadata
        waiting.metadataAt = told
      } else if (generation == this@SwapDriver.generation) {
        toldCurrent = told
      }
      observer.onStreamMetadata(generation, metadata)
    }

    override fun onDiscontinuity(generation: Int, position: Double, reason: String, jump: Double?) {
      val current = generation == this@SwapDriver.generation
      if (current) rebase()
      observer.onDiscontinuity(generation, if (current) maxOf(0.0, position - shift) else position, reason, jump)
      // Either connection jumped: the two no longer line up.
      if (aligning) {
        pending?.aligner?.let { apply(it.interrupt()) }
      } else if (pending?.fallback == true) {
        // Given up already, not taken over yet: its jump was read before this one.
        pending?.jump = null
      }
    }

    override fun isOffline(): Boolean = observer.isOffline()

    override fun onVideoInfo(generation: Int, info: VideoInfo) = observer.onVideoInfo(generation, info)

    override fun onFirstFrame(generation: Int) = observer.onFirstFrame(generation)

    override fun onTracks(generation: Int, tracks: List<MediaTrack>, variants: List<VideoVariant>) =
      observer.onTracks(generation, tracks, variants)

    override fun onSourceCues(generation: Int, cues: List<OverlayCue>) = observer.onSourceCues(generation, cues)

    override fun onBandwidth(generation: Int, bitsPerSecond: Double) = observer.onBandwidth(generation, bitsPerSecond)

    override fun onPositionJump(generation: Int) = observer.onPositionJump(generation)

    override fun onLicenseRequest(generation: Int, ask: LicenseAsk) = observer.onLicenseRequest(generation, ask)

    override fun onWarning(generation: Int, error: PlayerError) = observer.onWarning(generation, error)
  }
}

private const val TAG = "RNAP"

/** A backward jump this large on the same item, unasked, is ExoPlayer restarting it. */
private const val RESTART_S = 1.0
