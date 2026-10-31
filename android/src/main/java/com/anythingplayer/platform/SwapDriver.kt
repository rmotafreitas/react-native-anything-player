package com.anythingplayer.platform

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import com.anythingplayer.core.InterruptionReason
import com.anythingplayer.core.LiveSwapAligner
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

/**
 * A player's local output: the ExoPlayer heard (and on screen), and a second
 * one that prepares a quality switch behind it (`open(swap = true)`, separate
 * files of one video or one sound). The second one opens a little ahead,
 * muted, waits until the first reaches that point, plays, and takes over: no
 * spinner, no gap, no jump. Live, where there is no position to wait for, the
 * new connection is lined up with what is heard first ([LiveSwapAligner]: it
 * catches up muted, or holds, so the switch neither repeats nor skips). The
 * second ExoPlayer is only made at the first switch. Twin of
 * `src/web/platform/SwapDriver.ts`.
 */
internal class SwapDriver(
  private val observer: DriverObserver,
  private val make: (DriverObserver) -> ExoPlayerDriver,
  private val stage: SwapStage,
) : Output {
  private class Pending(val generation: Int, var target: Double?, var ready: Boolean = false) {
    /** Live: lines the new connection up before it takes over. */
    var aligner: LiveSwapAligner? = null
    /** The new file plays muted to catch up: its `playing` is not the takeover yet. */
    var aligning = false
    /** Taken over without lining up: the audio jumps, which the engine is told. */
    var unaligned = false
  }

  private val main = Handler(Looper.getMainLooper())
  private val proxy = Proxy()
  /** The driver on screen. */
  var current: ExoPlayerDriver = make(proxy)
    private set
  private var spare: ExoPlayerDriver? = null
  private var pending: Pending? = null
  private var volume = 1.0
  private var rate = 1.0
  private var loop = false
  private var quality: QualityConstraints? = null
  private var videoEnabled = true
  /** The engine's track picks (audio, text): a switch's file plays the same ones. */
  private var tracks: Pair<String?, String?>? = null
  private val tick = Runnable { rendezvous() }

  /** Both drivers, the one on screen first. */
  val drivers: List<ExoPlayerDriver>
    get() = listOfNotNull(current, spare)

  // ── EngineDriver ──

  override fun open(request: OpenRequest) {
    if (request.swap) return prepare(request)
    drop()
    current.open(request)
  }

  override fun play() = current.play()

  override fun pause() = current.pause()

  override fun seek(seconds: Double) = current.seek(seconds)

  override fun seek(seconds: Double, exact: Boolean) = current.seek(seconds, exact)

  override fun releaseConnection() {
    drop()
    current.releaseConnection()
  }

  override fun unload() {
    drop()
    current.unload()
  }

  override fun setVolume(effective: Double) {
    volume = effective
    current.setVolume(effective)
  }

  override fun setRate(rate: Double) {
    this.rate = rate
    current.setRate(rate)
    spare?.setRate(rate)
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

  override fun switchOutput(outputId: String) {
    // The routing driver switches outputs.
  }

  override fun sample(): PlaybackSample = current.sample()

  override fun progress(): ProgressReading = current.progress()

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
    pending = Pending(request.generation, target)
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
    val target = waiting.target ?: return align(waiting, next)
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
    main.removeCallbacks(tick)
    main.postDelayed(tick, RENDEZVOUS_TICK_MS)
  }

  /** Live: plays the new connection once it is lined up with what is heard. */
  private fun align(waiting: Pending, next: ExoPlayerDriver) {
    val now = SystemClock.elapsedRealtime()
    val aligner = waiting.aligner ?: LiveSwapAligner(now).also { waiting.aligner = it }
    val old = current.progress()
    val new = next.progress()
    val step =
      aligner.step(
        now,
        LiveSwapAligner.Reading(old.position, old.buffered, old.isPlaying, old.connection, old.rate, old.continuing),
        LiveSwapAligner.Reading(new.position, new.buffered, new.isPlaying, new.connection, new.rate, new.continuing),
      )
    when (step) {
      LiveSwapAligner.Step.Measure, LiveSwapAligner.Step.Hold -> {
        waiting.aligning = true
        if (new.isPlaying) next.pause()
      }
      is LiveSwapAligner.Step.Steer -> {
        waiting.aligning = true
        next.setRate(step.rate)
        if (!new.isPlaying) next.play()
      }
      LiveSwapAligner.Step.Play, is LiveSwapAligner.Step.Fallback -> {
        waiting.aligning = false
        waiting.unaligned = step is LiveSwapAligner.Step.Fallback
        next.setRate(rate)
        // Playing (Play always is): it takes over now; else (a fallback) its `playing` will.
        if (new.isPlaying) playing(waiting.generation) else next.play()
        return
      }
    }
    main.removeCallbacks(tick)
    main.postDelayed(tick, RENDEZVOUS_TICK_MS)
  }

  /** The switch's new file plays (and is lined up): it takes over, and the engine hears it. */
  private fun playing(generation: Int) {
    val unaligned = pending?.unaligned == true
    takeOver()
    observer.onPlaying(generation)
    // The engine took the switch's generation: the new file's tracks are the ones now.
    current.mappedTracks?.let { observer.onTracks(generation, it.tracks, it.variants) }
    // A live switch that could not be lined up repeats or skips: say where the new audio starts.
    if (unaligned) observer.onDiscontinuity(generation, current.sample().position)
  }

  /** The new file plays: it is the picture and the sound now. */
  private fun takeOver() {
    val next = spare ?: return
    val old = current
    main.removeCallbacks(tick)
    pending = null
    next.setVolume(volume)
    current = next
    spare = old
    stage.show(next, old)
    old.releaseConnection()
  }

  private fun drop() {
    if (pending == null) return
    main.removeCallbacks(tick)
    pending = null
    spare?.releaseConnection()
  }

  private fun switching(generation: Int) = pending?.generation == generation

  /** Forwards both drivers' events; the switch's ready starts the rendezvous, its playing takes over first. */
  private inner class Proxy : DriverObserver {
    override fun onReady(generation: Int, info: ReadyInfo) {
      observer.onReady(generation, info)
      if (switching(generation)) {
        pending?.ready = true
        rendezvous()
      }
    }

    override fun onPlaying(generation: Int) {
      if (!switching(generation)) return observer.onPlaying(generation)
      // Catching up muted: not lined up yet (align() hands it over).
      if (pending?.aligning == true) return
      playing(generation)
    }

    override fun onBuffering(generation: Int) = observer.onBuffering(generation)

    override fun onEnded(generation: Int) = observer.onEnded(generation)

    override fun onFailed(generation: Int, error: PlayerError) = observer.onFailed(generation, error)

    override fun onPausedExternally(generation: Int, reason: InterruptionReason) =
      observer.onPausedExternally(generation, reason)

    override fun onStreamMetadata(generation: Int, metadata: StreamMetadata) =
      observer.onStreamMetadata(generation, metadata)

    override fun onDiscontinuity(generation: Int, position: Double) = observer.onDiscontinuity(generation, position)

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
