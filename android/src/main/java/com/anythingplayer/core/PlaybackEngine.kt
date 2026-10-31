package com.anythingplayer.core

import kotlin.math.max
import kotlin.math.min

// The playback engine: one per player. A deterministic state machine that owns
// the play intent, the recovery policy and every timing decision. It never
// touches Media3 — it drives an [EngineDriver] (the ExoPlayer adapter in
// production, a recorder in tests) and reads time from an [EngineClock].
//
// Threading: every entry point must be called on the same thread (the main
// looper in production). The engine never blocks and never sleeps; it asks its
// delegate for a single wake-up instant instead of owning timers.
//
// Stale-event protection: every source open gets a new `generation`; native
// observations for any other generation are dropped (`accepts`).
//
// Swift twin: `ios/Core/PlaybackEngine.swift`. Both run `conformance/`.

private const val SLEEP_TIMER = "sleep timer"

/** The longest sleep timer or fade: 24 h (larger values overflow native timers). */
private const val MAX_TIMER_MS = 86_400_000L

/** Playback wanted, nothing heard yet: the foreground recovers these at once. */
private val WAITING_STATES = setOf(PlaybackState.RECONNECTING, PlaybackState.BUFFERING, PlaybackState.LOADING)

/** States in which the screen stays on for a visible video player. */
private val AWAKE_STATES =
  setOf(PlaybackState.LOADING, PlaybackState.BUFFERING, PlaybackState.PLAYING, PlaybackState.RECONNECTING)

/** States a rebuffer goes on through (the user is still waiting). */
private val REBUFFER_STATES = setOf(PlaybackState.BUFFERING, PlaybackState.RECONNECTING, PlaybackState.LOADING)

/** Heights a view's size is rounded up to before it caps an adaptive source. */
private val STANDARD_HEIGHTS = listOf(144, 240, 360, 480, 540, 720, 1080, 1440, 2160, 4320)

private fun minOf(a: Int?, b: Int?): Int? = if (a == null) b else if (b == null) a else min(a, b)

private fun minOf(a: Long?, b: Long?): Long? = if (a == null) b else if (b == null) a else min(a, b)

private fun notVideoPlayer() =
  PlayerError(ErrorCode.INVALID_ARGUMENT, "This is not a video player (create it with `video`).", false)

interface EngineDriver {
  fun open(request: OpenRequest)
  /** Start/resume the current item (latched until the item is ready). */
  fun play()
  fun pause()
  fun seek(seconds: Double)
  /** `exact`: frame-accurate; otherwise the nearest keyframe is fine. */
  fun seek(seconds: Double, exact: Boolean) {
    seek(seconds)
  }
  /** Drop the network connection / decoder but keep nothing playing. */
  fun releaseConnection()
  /** Remove the current item entirely. */
  fun unload()
  /** Effective output volume (volume × mute × duck × fades), 0..1. */
  fun setVolume(effective: Double)
  fun setRate(rate: Double)
  /**
   * Send what follows to another output (`'local'`, `'cast:<device>'`). Only
   * the platform's routing driver implements a real switch; the engine calls
   * it from `handoff`, after unloading the item from the previous output.
   */
  fun switchOutput(outputId: String)
  fun sample(): PlaybackSample
  /** Video players: decode and show the picture, or not (the sound plays on). */
  fun setVideoEnabled(enabled: Boolean) {
    // Audio drivers have no picture.
  }
  /** Video players with an adaptive source: what its own ABR must keep to. */
  fun setQuality(constraints: QualityConstraints) {
    // Audio drivers have no qualities.
  }
  /** Repeat a finite item from the start, seamlessly where the platform can. */
  fun setLoop(loop: Boolean) {
    // The engine restarts an item that ends.
  }
  /** Drop the item an `open(swap = true)` was preparing. */
  fun cancelSwap(generation: Int) {
    // Drivers without quality switches never prepare one.
  }
  /** The output plays one item at a time: a quality switch re-opens in place, as on Cast. */
  val swapsInPlace: Boolean
    get() = false
  /**
   * Play these of the source's own tracks (`null` text: none of them, which
   * is also how an app's subtitle file is shown: by the overlay).
   */
  fun selectTracks(audio: String?, text: String?) {
    // Audio drivers have one track.
  }
}

interface EngineClock {
  /** Monotonic milliseconds (including device sleep). */
  val monotonicMs: Long
  /** Wall-clock epoch milliseconds. */
  val wallMs: Long
}

sealed class LoadOutcome {
  object Ready : LoadOutcome()
  object Superseded : LoadOutcome()
  data class Failed(val error: PlayerError) : LoadOutcome()
}

interface EngineDelegate {
  fun engineRequestsAudioFocus(): FocusResult
  fun engineStatusChanged(status: Status)
  fun engineLoadSettled(loadId: Int, outcome: LoadOutcome)
  fun engineError(error: PlayerError, fatal: Boolean)
  /** Something the app should hear that stops nothing and starts no recovery (a quality switch that failed). */
  fun engineWarning(error: PlayerError)
  fun engineDidEnd()
  /** The sleep timer paused the player (`sleep` event). */
  fun engineSleepFired()
  fun engineDiagnostic(entry: DiagnosticEntry)
  /** The engine wants `onWakeup()` at this monotonic instant (`null` = none). */
  fun engineWakeupAt(at: Long?)
  /**
   * The source needs a new URL. Answer with `sourceRefreshed` or
   * `sourceRefreshFailed` for the same `loadId`.
   */
  fun engineRequestsSourceRefresh(loadId: Int, reason: RefreshReason) {
    // Without an answer the engine backs off as for any failure.
  }
}

class PlaybackEngine(
  private val driver: EngineDriver,
  private val clock: EngineClock,
  var options: EngineOptions = EngineOptions(),
  random: () -> Double = { Math.random() },
) {
  var delegate: EngineDelegate? = null

  // ── Source & intent ──
  var source: SourceDescriptor? = null
    private set
  var generation = 0
    private set
  /**
   * The last generation handed out. Every open takes the next one, so an item
   * a quality switch was preparing (a generation ahead of the current one)
   * can never share a number with a later open.
   */
  private var issuedGeneration = 0
  var loadId = 0
    private set
  private var pendingLoadId: Int? = null
  var state = PlaybackState.IDLE
    private set
  var playWhenReady = false
    private set
  private var released = false

  // ── Source facts ──
  private var isLive = false
  private var duration: Double? = null
  private var seekable = false
  private var readyForGeneration = false

  // ── System ──
  var interruption: Interruption? = null
    private set
  private var lastError: PlayerError? = null
  private var network = NetworkState.UNKNOWN
  private var duckFactor = 1.0
  private var volume = 1.0
  private var muted = false
  private var rate = 1.0
  /** Repeat a finite item from the start instead of ending. */
  private var loop = false

  // ── Output ──
  private var route = AudioRoute.UNKNOWN
  private var outputId = "local"
  /** The audio plays on another device (Cast): the local audio rules are off. */
  private var remote = false

  // ── Timing (monotonic ms) ──
  private var lastOpenAt: Long? = null
  private var flowedSinceOpen = false
  private var stallStartedAt: Long? = null
  /** A native stall waiting out `STALL_DEBOUNCE_MS` before it is published. */
  private var stallPublishAt: Long? = null
  private var lastPosition = 0.0
  private var lastPositionAdvanceAt = 0L
  private var lastBuffered = 0.0
  private var lastBufferedAdvanceAt = 0L
  /**
   * While waiting, where the playhead's current run at the playback rate
   * began, and the last reading (the playhead can prove playback).
   */
  private var waitingFromPosition: Double? = null
  private var waitingLastPosition = 0.0
  private var waitingLastAt = 0L
  private var pausedAt: Long? = null
  private var driftMs = 0L
  private var playingSince: Long? = null
  private var recoveringSince: Long? = null
  /** Audio has flowed for `STABLE_PLAYBACK_MS`: the next loss reconnects at once. */
  private var stable = false
  private var nextAttemptAt: Long? = null
  private var reconnectReason = ""
  private val backoff = Backoff(random)
  private var offlineSkips = 0
  /** Bumped by every network edge; [openNetworkRevision] is its value at the last open. */
  private var networkRevision = 0
  /** The engine detected a stall native never reported (it still says playing). */
  private var silentStall = false
  private var openNetworkRevision = -1
  private var suspectUntil = Long.MIN_VALUE
  private var pauseReleaseAt: Long? = null
  private var connectionReleased = false
  private var resumePosition: Double? = null
  private var lastHeartbeatAt = 0L
  private var lastPublished: Status? = null
  /** Discrete events wait until the status they imply was published. */
  private val pendingEvents = mutableListOf<() -> Unit>()

  // ── Fades & sleep timer (monotonic ms) ──
  // The output volume is volume × duck × gain × sleep attenuation (or 0 when
  // muted): fades never touch the app's `volume` except `fadeTo`, whose
  // target is the new volume.
  /** `volume` still on its way to a `fadeTo` target. */
  private var levelRamp: Ramp? = null
  private var fadeToDone: (() -> Unit)? = null
  /** The play/pause/stop fade, 0…1 (`gainRamp` while it moves). */
  private var gain = 1.0
  private var gainRamp: Ramp? = null
  /** A fade-out under way: the intent is already off; at silence it pauses or stops. */
  private var fadeOutThen: FadeOutEnd? = null
  /** Playback was asked for with a fade-in: it starts when the audio does. */
  private var fadeInPending = false
  private var fadeTickAt: Long? = null
  /** What the driver was last given. */
  private var appliedVolume = 1.0
  private var sleepAt: Long? = null
  /** The sleep timer's fade-out: the last `sleepFadeMs` before `sleepAt`. */
  private var sleepFadeMs = 0L
  private var sleepWallAt: Long? = null

  // ── Video: surroundings ──
  private var backgrounded = false
  private var pictureInPicture = false
  /** The view's cap when Picture in Picture started: it holds while the window is up. */
  private var pipCap: Int? = null
  private var view = ViewState()
  /** No view since this instant: the picture goes off `VIEW_DETACH_GRACE_MS` later. */
  private var detachedSince: Long? = null
  /** In the background without Picture in Picture: pause at this instant. */
  private var pipDecisionAt: Long? = null
  private var metered = false
  private var saveData = false

  // ── Video: the picture ──
  private var listenOnly = false
  private var videoInfo: VideoInfo? = null
  /** What a quality switch's new file said about its picture, for when it takes over. */
  private var swapVideoInfo: VideoInfo? = null
  private var firstFrame = false
  private var variants: List<VideoVariant> = emptyList()
  /** What the driver was last told (`null`: nothing yet; drivers start with the picture on). */
  private var appliedVideoEnabled: Boolean? = null
  /** The constraints the driver was last given (an adaptive source). */
  private var appliedQuality: String? = null
  private var lastAudioOnly: AudioOnlyReason? = null

  // ── Video: renditions ──
  private var renditions: MutableList<Rendition>? = null
  private var selectedQuality: String? = null
  /** The app's pick, kept across loads (`null`: automatic). */
  private var wantedQuality: String? = null
  /** Quiet step ups: counted from the load; the last one; how many stalls undid. */
  private var quietSince = 0L
  private var quietUpAt: Long? = null
  private var quietUndone = 0
  /** The engine's own pick among the renditions (automatic quality). */
  private var abrLevel: Int? = null
  private var currentRendition: Int? = null
  private var pendingSwap: PendingSwap? = null
  private val failedUntil = mutableMapOf<Int, Long>()
  /** The last bandwidth reading, kept across loads for the next start. */
  private var bandwidth: Double? = null
  /** When this load last had a reading. */
  private var bandwidthAt: Long? = null
  private var stallTimes = mutableListOf<Long>()
  private var lastSwitchAt: Long? = null
  /** The bandwidth has been under the current rendition's bitrate since… */
  private var abrLowSince: Long? = null
  /** …above `ABR_UP_RATIO` × the next one's since. */
  private var abrUpSince: Long? = null

  // ── Video: the audio-only fallback ──
  private var fallbackActive = false
  private var fallbackSince: Long? = null
  /** The bandwidth has been under the fallback's drop ratio since… */
  private var dropSince: Long? = null
  /** …above its return ratio since. */
  private var returnSince: Long? = null

  // ── Refresh ──
  private var pendingRefresh: PendingRefresh? = null
  private var refreshAskAt: Long? = null
  /** Bumped by every `sourceRefreshed`; [openedRevision] is its value at the last open. */
  private var sourceRevision = 0
  private var openedRevision = 0

  // ── Stats ──
  private var loadStartedAt: Long? = null
  private var counters = EngineStats()
  private var rebufferSince: Long? = null

  // ── Tracks ──
  /** The source's own audio and text tracks (the driver's). */
  private var sourceTracks: List<MediaTrack> = emptyList()
  /** The app's subtitle files (`load({ subtitles })`, `addSubtitles`). */
  private var appTracks: List<MediaTrack> = emptyList()
  /** The app's audio pick (`null`: automatic). */
  private var chosenAudio: String? = null
  /** The app's text pick: [TextChoice.Auto], off, or a track. */
  private var chosenText: TextChoice = TextChoice.Auto
  private var audioTrack: String? = null
  private var textTrack: String? = null
  /** What the driver was last told (`null`: nothing yet for this item). */
  private var appliedTracks: String? = null
  private var system = SystemPreferences()
  private var subtitleDelay = 0.0
  private var fullscreen = false

  private sealed class TextChoice {
    object Auto : TextChoice()
    object Off : TextChoice()
    data class Track(val id: String) : TextChoice()
  }

  /** `info`: what the new file reported when ready, the item's facts once it takes over. */
  private data class PendingSwap(
    val generation: Int,
    val rendition: Int,
    val startedAt: Long,
    var info: ReadyInfo? = null,
    var readyAt: Long? = null,
  ) {
    /** The new file must play by then: [RecoveryPolicy.SWAP_TIMEOUT_MS] to be ready, [RecoveryPolicy.SWAP_ALIGN_MS] once ready. */
    val deadline: Long
      get() = readyAt?.let { it + RecoveryPolicy.SWAP_ALIGN_MS } ?: (startedAt + RecoveryPolicy.SWAP_TIMEOUT_MS)
  }

  private data class PendingRefresh(
    val reason: RefreshReason,
    val deadline: Long,
    /** The failure that asked for it (`UNAUTHORIZED`). */
    val error: PlayerError?,
  )

  /** What a fade-out leads to when it reaches silence. */
  private enum class FadeOutEnd { PAUSE, STOP }

  private val now: Long
    get() = clock.monotonicMs

  // ── Queries ──

  val status: Status
    get() {
      val reconnect =
        if (state == PlaybackState.RECONNECTING || (state == PlaybackState.LOADING && backoff.attempts > 0)) {
          val wallAt = nextAttemptAt?.let { clock.wallMs + max(0L, it - now) }
          ReconnectInfo(max(1, backoff.attempts), wallAt, reconnectReason)
        } else {
          null
        }
      return Status(
        state = state,
        playWhenReady = playWhenReady,
        loadId = loadId,
        isLive = isLive,
        duration = duration,
        seekable = seekable,
        interruption = interruption,
        error = if (state == PlaybackState.ERROR) lastError else null,
        reconnect = reconnect,
        network = network,
        volume = volume,
        muted = muted,
        rate = rate,
        route = route,
        sleepAt = sleepWallAt,
        // An audio player picks no quality.
        qualities = statusQualities(),
        quality = if (statusQualities().isEmpty()) null else currentQualityId(),
        selectedQuality = if (statusQualities().isEmpty()) null else selectedQuality,
        video = videoStatus(),
      )
    }

  /** Playback wanted but no audio rendered (see the iOS keepalive). */
  val wantsKeepalive: Boolean
    get() =
      playWhenReady &&
        (state == PlaybackState.LOADING || state == PlaybackState.BUFFERING || state == PlaybackState.RECONNECTING)

  /** Whether the player holds (or may soon re-take) audio focus. */
  val needsAudioFocus: Boolean
    get() {
      if (remote || focusExempt) return false
      return playWhenReady || fadeOutThen != null || (interruption?.resumable ?: false)
    }

  /** Native observations for any other generation are stale and must be dropped. */
  fun accepts(generation: Int): Boolean = !released && generation == this.generation

  // ── Commands ──

  /**
   * `quality`: the quality to play, for this load and the next (`null`:
   * automatic); only used when `qualityGiven`, else the current pick stays.
   */
  fun load(
    newSource: SourceDescriptor,
    autoplay: Boolean?,
    startPosition: Double?,
    qualityGiven: Boolean = false,
    quality: String? = null,
  ) {
    ensureAlive()
    if (qualityGiven) chooseQuality(newSource, quality)
    // A fade-out ends with the item it was fading.
    cancelFadeOut()
    val flowing = playWhenReady && state == PlaybackState.PLAYING
    val wanted = autoplay ?: (playWhenReady && continuesIntent(state))
    pendingLoadId?.let {
      pendingLoadId = null
      delegate?.engineLoadSettled(it, LoadOutcome.Superseded)
    }
    source = newSource
    loadId += 1
    pendingLoadId = loadId
    isLive = newSource.liveHint ?: false
    duration = null
    seekable = false
    lastError = null
    interruption = null
    resetRecovery()
    resumePosition = startPosition
    playWhenReady = wanted
    if (wanted) applyFocus(requestFocus())
    videoLoad()
    if (playWhenReady) startFadeIn(flowing)
    log("load", mapOf("uri" to newSource.uri, "autoplay" to "$playWhenReady"))
    open(startPosition, "load")
    commit()
  }

  fun play() {
    ensureAlive()
    if (source == null) throw PlayerError(ErrorCode.NO_SOURCE, "No source loaded.", false)
    if (playWhenReady && continuesIntent(state)) {
      commit()
      return
    }
    when (requestFocus()) {
      FocusResult.DENIED -> {
        interruption = Interruption(InterruptionReason.AUDIO_FOCUS_DENIED, false, clock.wallMs)
        log("play refused", mapOf("focus" to "denied"))
        commit()
        throw PlayerError(
          ErrorCode.AUDIO_FOCUS_DENIED,
          "The system refused audio focus (another app or a call holds it).",
          true,
        )
      }
      FocusResult.DELAYED -> {
        interruption = Interruption(InterruptionReason.AUDIO_FOCUS_DELAYED, true, clock.wallMs)
        log("play deferred", mapOf("focus" to "delayed"))
        commit()
        return
      }
      FocusResult.GRANTED -> Unit
    }
    interruption = null
    startPlayback("play")
    commit()
  }

  fun pause() {
    ensureAlive()
    if (fadeOutThen != null) {
      // A pause during a fade-out: silence now.
      completeFadeOut()
      commit()
      return
    }
    val hadInterruption = interruption != null
    interruption = null
    if (!playWhenReady) {
      if (hadInterruption) log("pause", mapOf("note" to "cancels system resume"))
      commit()
      return
    }
    playWhenReady = false
    if (!beginFadeOut(FadeOutEnd.PAUSE)) pauseIntent("pause")
    commit()
  }

  fun stop() {
    ensureAlive()
    if (source == null) return
    if (fadeOutThen != null) {
      // A stop during a fade-out: stop now.
      completeFadeOut(FadeOutEnd.STOP)
    } else if (playWhenReady && beginFadeOut(FadeOutEnd.STOP)) {
      playWhenReady = false
      interruption = null
    } else {
      stopNow()
    }
    commit()
  }

  private fun stopNow() {
    settlePendingLoad(LoadOutcome.Superseded)
    holdGain()
    playWhenReady = false
    interruption = null
    resetRecovery()
    pauseReleaseAt = null
    stallStartedAt = null
    pausedAt = null
    // Late callbacks of the released item (an end, a failure) must not move
    // the player out of `stopped`: `play()` opens a new generation anyway.
    releaseItemConnection()
    resumePosition = if (isLive) null else 0.0
    setState(PlaybackState.STOPPED, "stop")
  }

  fun reset() {
    ensureAlive()
    cancelFadeOut()
    settlePendingLoad(LoadOutcome.Superseded)
    cancelSwap("reset")
    generation = issueGeneration()
    source = null
    playWhenReady = false
    interruption = null
    lastError = null
    isLive = false
    duration = null
    seekable = false
    resetRecovery()
    pauseReleaseAt = null
    connectionReleased = false
    driver.unload()
    setState(PlaybackState.IDLE, "reset")
    commit()
  }

  fun seek(seconds: Double, exact: Boolean = false) {
    ensureAlive()
    if (source == null) throw PlayerError(ErrorCode.NO_SOURCE, "No source loaded.", false)
    if (!seekable || isLive) throw PlayerError(ErrorCode.NOT_SEEKABLE, "This source is not seekable.", false)
    if (!seconds.isFinite() || seconds < 0) {
      throw PlayerError(ErrorCode.INVALID_ARGUMENT, "Seek position must be a finite number ≥ 0.", false)
    }
    val target = duration?.let { min(seconds, it) } ?: seconds
    // A quality switch in flight was opened at the old position.
    cancelSwap("seek")
    resumePosition = target
    lastPosition = target
    lastPositionAdvanceAt = now
    if (state == PlaybackState.ENDED) setState(PlaybackState.PAUSED, "seek after end")
    if (connectionReleased || state == PlaybackState.STOPPED || state == PlaybackState.ERROR) {
      commit()
      return
    }
    driver.seek(target, exact)
    commit()
  }

  fun setVolume(value: Double) {
    ensureAlive()
    if (!value.isFinite()) throw PlayerError(ErrorCode.INVALID_ARGUMENT, "Volume must be a finite number.", false)
    cancelFadeTo()
    volume = value.coerceIn(0.0, 1.0)
    applyVolume()
    commit()
  }

  /**
   * Moves the volume to `value` over `durationMs`; `done` runs when it gets
   * there, or when `setVolume`, another `fadeTo` or `release` replaces it.
   * `volume` is the target from the start. Instant on a remote output.
   */
  fun fadeTo(value: Double, durationMs: Double, done: () -> Unit) {
    ensureAlive()
    if (!value.isFinite()) throw PlayerError(ErrorCode.INVALID_ARGUMENT, "Volume must be a finite number.", false)
    if (!validDuration(durationMs)) throw invalidDuration("A fade duration")
    val t = now
    val from = levelAt(t)
    cancelFadeTo()
    volume = value.coerceIn(0.0, 1.0)
    fadeToDone = done
    val ms = Math.round(durationMs)
    if (ms > 0 && !remote && from != volume) {
      levelRamp = Ramp(from, volume, t, t + ms)
      log("fade", mapOf("to" to "$volume", "ms" to "$ms"))
    } else {
      applyVolume()
      settleFadeTo()
    }
    commit()
  }

  /**
   * Pauses after `afterMs` of wall time (counting while paused too), fading
   * out over its last `fadeOutMs` (default `options.fadeOutMs`). `null`
   * cancels; a new timer replaces the previous one.
   */
  fun sleep(afterMs: Double?, fadeOutMs: Double?) {
    ensureAlive()
    if (afterMs != null) {
      if (!validDuration(afterMs)) throw invalidDuration("The sleep delay")
      if (fadeOutMs != null && !validDuration(fadeOutMs)) throw invalidDuration("The sleep fade-out")
    }
    endSleep()
    if (afterMs == null) {
      log(SLEEP_TIMER, mapOf("note" to "cancelled"))
    } else {
      val after = Math.round(afterMs)
      sleepAt = now + after
      sleepWallAt = clock.wallMs + after
      sleepFadeMs = min(if (fadeOutMs != null) Math.round(fadeOutMs) else options.fadeOutMs, after)
      log(SLEEP_TIMER, mapOf("afterMs" to "$after", "fadeOutMs" to "$sleepFadeMs"))
    }
    commit()
  }

  /**
   * The fades of play (in) and of pause and stop (out), in ms; `0` = none.
   * A fade under way keeps its course.
   */
  fun setFades(inMs: Double, outMs: Double) {
    ensureAlive()
    if (!validDuration(inMs)) throw invalidDuration("A fade-in")
    if (!validDuration(outMs)) throw invalidDuration("A fade-out")
    options = options.copy(fadeInMs = Math.round(inMs), fadeOutMs = Math.round(outMs))
    commit()
  }

  fun setMuted(value: Boolean) {
    ensureAlive()
    val was = muted
    muted = value
    applyVolume()
    if (was && !value) unmuted()
    commit()
  }

  /** Repeat a finite item from the start (the driver loops it seamlessly where it can). */
  fun setLoop(value: Boolean) {
    ensureAlive()
    loop = value
    driver.setLoop(value)
    commit()
  }

  fun setRate(value: Double) {
    ensureAlive()
    if (!value.isFinite() || value <= 0) {
      throw PlayerError(ErrorCode.INVALID_ARGUMENT, "Rate must be a finite number > 0.", false)
    }
    rate = value
    driver.setRate(value)
    commit()
  }

  /** Ducking requested by the OS (Android < 8; newer versions duck in the mixer). */
  fun setDucked(ducked: Boolean) {
    if (released) return
    duckFactor = if (ducked) 0.2 else 1.0
    if (!remote) applyVolume()
  }

  fun release() {
    if (released) return
    settlePendingLoad(LoadOutcome.Failed(PlayerError(ErrorCode.PLAYER_RELEASED, "The player was released.", false)))
    cancelFadeOut()
    cancelFadeTo()
    cancelSwap("release")
    sleepAt = null
    sleepWallAt = null
    playWhenReady = false
    interruption = null
    resetRecovery()
    pauseReleaseAt = null
    driver.unload()
    setState(PlaybackState.IDLE, "release")
    commit()
    released = true
    delegate?.engineWakeupAt(null)
  }

  // ── Output ──

  /** The local output changed (headphones, AirPlay, Bluetooth). Ignored while casting. */
  fun routeChanged(next: AudioRoute) {
    if (released) return
    if (remote) {
      log("route ignored", mapOf("kind" to next.kind.wire, "note" to "remote output"))
      return
    }
    route = next
    commit()
  }

  /**
   * The audio moves to another output: a Cast receiver, or back to the
   * device. The item is unloaded from the previous output and, if it was
   * active, re-opened on the new one at the same position. `resume` keeps the
   * play intent; without it the item arrives paused. An inactive item
   * (stopped, ended, failed) re-opens on the new output at the next `play()`.
   */
  fun handoff(next: AudioRoute, outputId: String, resume: Boolean) {
    if (released) return
    if (outputId == this.outputId) {
      route = next
      commit()
      return
    }
    // A fade-out lands first: the pause belongs to the old output.
    completeFadeOut()
    val position = handoffPosition()
    // A paused stream whose connection was released stays released.
    val active =
      source != null && continuesIntent(state) && !(state == PlaybackState.PAUSED && connectionReleased)
    if (source != null) driver.unload()
    driver.switchOutput(outputId)
    this.outputId = outputId
    route = next
    remote = next.kind == AudioRouteKind.CAST
    log("handoff", mapOf("to" to outputId, "resume" to "$resume"))
    settleFades()
    applyVolume()
    if (active) {
      playWhenReady = resume && playWhenReady
      resetRecovery()
      resumePosition = position
      if (playWhenReady) applyFocus(requestFocus())
      open(position, "handoff")
    } else {
      // Old-output callbacks are stale; nothing is loaded on the new one.
      cancelSwap("handoff")
      generation = issueGeneration()
      readyForGeneration = false
      if (source != null) connectionReleased = true
    }
    commit()
  }

  // ── Native observations (generation-guarded) ──

  fun onReady(generation: Int, info: ReadyInfo) {
    if (isSwapGeneration(generation)) {
      // A quality switch's file: its facts wait for it to take over.
      pendingSwap?.let { swap ->
        swap.info = info
        // Live, the driver lines it up first (SwapDriver): more time once ready.
        if (swap.readyAt == null && isLive) swap.readyAt = now
      }
      return swapNote("ready")
    }
    if (!accepts(generation)) return logStale("ready", generation)
    applyFacts(info)
    readyForGeneration = true
    if (state == PlaybackState.LOADING) {
      if (playWhenReady) {
        setState(PlaybackState.BUFFERING, "ready")
        beginWaiting()
      } else {
        setState(PlaybackState.PAUSED, "ready")
        pausedAt = now
        armPauseRelease()
      }
    }
    settlePendingLoad(LoadOutcome.Ready)
    commit()
  }

  /** Audio is actually flowing. */
  fun onPlaying(generation: Int) {
    // A quality switch's new item plays: it is the current item from now on.
    if (isSwapGeneration(generation)) completeSwap()
    if (!accepts(generation)) return logStale("playing", generation)
    if (!playWhenReady) {
      // Fading out: the audio keeps going until the fade ends.
      if (fadeOutThen != null) return commit()
      log("native playing without intent", emptyMap())
      driver.pause()
      commit()
      return
    }
    if (!readyForGeneration) {
      readyForGeneration = true
      settlePendingLoad(LoadOutcome.Ready)
    }
    val t = now
    stallPublishAt = null
    stallStartedAt?.let {
      driftMs += t - it
      stallStartedAt = null
    }
    flowedSinceOpen = true
    silentStall = false
    lastOpenAt = null
    nextAttemptAt = null
    lastPosition = driver.sample().position
    lastPositionAdvanceAt = t
    playingSince = t
    videoPlaying(t)
    if (fadeInPending) {
      fadeInPending = false
      rampGain(1.0, options.fadeInMs)
    }
    // Drift is only enforced at moments that are silent anyway (resuming from a
    // pause, or during a published stall), never by cutting audio that resumed.
    setState(PlaybackState.PLAYING, "audio flowing")
    commit()
  }

  /** Playback wanted, waiting for data. */
  fun onBuffering(generation: Int) {
    if (isSwapGeneration(generation)) return swapNote("buffering")
    if (!accepts(generation)) return logStale("buffering", generation)
    // Nothing left to fade.
    completeFadeOut()
    // Native reports the stall itself: its own `playing` will end it.
    silentStall = false
    if (state == PlaybackState.PLAYING && stallPublishAt == null) {
      stallStartedAt = now
      stallPublishAt = now + RecoveryPolicy.STALL_DEBOUNCE_MS
      playingSince = null
    }
    commit()
  }

  fun onFailed(generation: Int, error: PlayerError) {
    if (isSwapGeneration(generation)) {
      swapFailed(error)
      return commit()
    }
    if (!accepts(generation)) return logStale("failed", generation)
    completeFadeOut()
    // A stop's fade-out landed: the item is gone.
    if (!accepts(generation)) {
      commit()
      return
    }
    handleFailure(error)
    commit()
  }

  fun onEnded(generation: Int) {
    if (isSwapGeneration(generation)) return swapNote("ended")
    if (!accepts(generation)) return logStale("ended", generation)
    if (state == PlaybackState.ENDED) return logStale("ended again", generation)
    completeFadeOut()
    // A stop's fade-out landed: the item is gone.
    if (!accepts(generation)) {
      commit()
      return
    }
    // Unknown duration reads as a live stream that dropped, unless the app
    // said the source is a file (`live: false`).
    if (source?.liveHint != false && (isLive || duration == null)) {
      handleFailure(PlayerError(ErrorCode.STREAM_ENDED, "The stream closed the connection.", true))
    } else if (loop && playWhenReady) {
      // The driver could not loop it seamlessly: start over.
      restartFromEnd("loop")
    } else {
      playWhenReady = false
      resumePosition = 0.0
      stallStartedAt = null
      setState(PlaybackState.ENDED, "end of media")
      pendingEvents.add { delegate?.engineDidEnd() }
    }
    commit()
  }

  /** The platform paused the player without being asked to. */
  fun onPausedExternally(generation: Int, reason: InterruptionReason) {
    if (isSwapGeneration(generation)) return swapNote("paused")
    if (!accepts(generation)) return logStale("paused externally", generation)
    if (fadeOutThen != null) {
      completeFadeOut()
      return commit()
    }
    if (!playWhenReady) return
    systemPause(reason, false)
  }

  // ── System events ──

  fun interruptionBegan(reason: InterruptionReason, resumable: Boolean) {
    if (released) return
    if (remote) {
      // A call on the phone does not pause the living-room speaker.
      log("interruption ignored", mapOf("reason" to reason.wire, "note" to "remote output"))
      return
    }
    systemPause(reason, resumable)
  }

  /** Shared by the system inputs and the externally-paused observation. */
  private fun systemPause(reason: InterruptionReason, resumable: Boolean) {
    // A user's fade-out stops at once; the pause stays the user's.
    completeFadeOut()
    if (!playWhenReady) {
      val current = interruption
      if (current != null && current.resumable && !resumable) {
        interruption = Interruption(reason, false, current.since)
      }
      commit()
      return
    }
    playWhenReady = false
    interruption = Interruption(reason, resumable, clock.wallMs)
    pauseIntent("system: ${reason.wire}")
    commit()
  }

  fun interruptionEnded(shouldResume: Boolean) {
    if (released) return
    val current = interruption ?: return
    if (current.resumable && shouldResume && options.autoResumeAfterInterruption && source != null) {
      interruption = null
      log("system resume", mapOf("reason" to current.reason.wire))
      startPlayback("system resume")
    } else {
      interruption = Interruption(current.reason, false, current.since)
    }
    commit()
  }

  fun networkChanged(next: NetworkState, interfaceChanged: Boolean) {
    if (released) return
    val previous = network
    network = next
    if (remote) {
      // The receiver has its own network: the phone's must not reload it.
      commit()
      return
    }
    val t = now
    when {
      previous == NetworkState.ONLINE && next == NetworkState.OFFLINE -> {
        markNetworkEdge(t)
        log("network lost", emptyMap())
      }
      previous == NetworkState.OFFLINE && next == NetworkState.ONLINE -> {
        // (`unknown` → `online` is the first reading: a baseline, not an edge.)
        markNetworkEdge(t)
        backoff.reset()
        offlineSkips = 0
        log("network restored", emptyMap())
        if (autoReconnect && state != PlaybackState.PLAYING) attemptReconnect("network restored")
      }
      previous == NetworkState.ONLINE && next == NetworkState.ONLINE && interfaceChanged -> {
        markNetworkEdge(t)
        log("network handoff", emptyMap())
        if (autoReconnect && (state == PlaybackState.BUFFERING || state == PlaybackState.RECONNECTING)) {
          attemptReconnect("network handoff")
        }
      }
    }
    commit()
  }

  /** The app came to the foreground: recover wanted-but-silent audio now. */
  fun appForegrounded() {
    if (released) return
    // Read before a video player resumes: its resume is not a stall.
    val stalled = autoReconnect && !remote && state in WAITING_STATES
    videoForegrounded()
    if (stalled) attemptReconnect("app foregrounded")
    commit()
  }

  /** The platform media stack was reset; the driver has been rebuilt. */
  fun platformReset() {
    if (released || remote || source == null || state == PlaybackState.IDLE) return
    log("platform reset", emptyMap())
    completeFadeOut()
    if (
      state == PlaybackState.STOPPED ||
        state == PlaybackState.ENDED ||
        state == PlaybackState.ERROR ||
        connectionReleased
    ) {
      // Nothing was open (a paused stream may have released its connection):
      // `play()` opens it, as before the reset.
      connectionReleased = true
      commit()
      return
    }
    if (!options.reconnect) {
      // Re-opening on its own is what `reconnect: false` turns off.
      handleFailure(PlayerError(ErrorCode.NETWORK_ERROR, "The media services were reset.", true))
      commit()
      return
    }
    reopen("media services reset")
    commit()
  }

  // ── Video: queries ──

  /** The player should own a media session (lock screen, notification). */
  val wantsMediaSession: Boolean
    get() {
      val v = options.video ?: return true
      return !(v.ambient || (muted && !v.focusWhenMuted))
    }

  /** Keep the screen on: a video playing in a visible view. */
  val wantsScreenAwake: Boolean
    get() {
      val v = options.video ?: return false
      if (!v.keepAwake || v.ambient) return false
      if (!view.attached || !view.visible || backgrounded) return false
      return playWhenReady && state in AWAKE_STATES
    }

  /** Start-up, rebuffers and switches since the last `load()`. */
  val stats: EngineStats
    get() {
      val ongoing = rebufferSince?.let { now - it } ?: 0L
      return counters.copy(rebufferMs = counters.rebufferMs + ongoing)
    }

  // ── Video: commands ──

  /** Pins a quality (`status.qualities[].id`), or `null` for automatic. */
  fun selectQuality(id: String?) {
    ensureAlive()
    val qualities = statusQualities()
    if (id != null && qualities.none { it.id == id }) {
      throw PlayerError(ErrorCode.INVALID_ARGUMENT, "No quality \"$id\".", false)
    }
    // Kept for the next loads too (`load(…, quality)` overrides it).
    wantedQuality = id
    // Nothing to pick from (one file): automatic already.
    if (qualities.isEmpty()) return
    selectedQuality = id
    log("quality selected", mapOf("id" to (id ?: "auto")))
    applyQuality("selected")
    commit()
  }

  /** Plays the sound alone (an audio-only variant or rendition where there is one). */
  fun setListenOnly(value: Boolean) {
    ensureAlive()
    if (options.video == null) throw notVideoPlayer()
    listenOnly = value
    applyOutput("listen-only")
    commit()
  }

  /** Plays this audio track (`null`: back to the automatic choice). */
  fun selectAudioTrack(id: String?) {
    ensureAlive()
    if (options.video == null) throw notVideoPlayer()
    if (id != null) assertTrack(id, true)
    chosenAudio = id
    log("audio track selected", mapOf("id" to (id ?: "auto")))
    applyTracks("selected")
    commit()
  }

  /** Shows this text track; `null` turns subtitles off. */
  fun selectTextTrack(id: String?) {
    ensureAlive()
    if (options.video == null) throw notVideoPlayer()
    if (id != null) assertTrack(id, false)
    chosenText = if (id == null) TextChoice.Off else TextChoice.Track(id)
    log("text track selected", mapOf("id" to (id ?: "off")))
    applyTracks("selected")
    commit()
  }

  /** Shows subtitles this many seconds later (negative: earlier). */
  fun setSubtitleDelay(seconds: Double) {
    ensureAlive()
    if (!seconds.isFinite()) {
      throw PlayerError(ErrorCode.INVALID_ARGUMENT, "The subtitle delay must be a finite number.", false)
    }
    subtitleDelay = seconds
    commit()
  }

  /** The app's subtitle files for the current load. */
  fun setAppTracks(tracks: List<MediaTrack>) {
    if (released) return
    appTracks = tracks.toList()
    applyTracks("app tracks")
    commit()
  }

  /** The OS's languages and accessibility settings changed. */
  fun systemPreferencesChanged(preferences: SystemPreferences) {
    if (released) return
    system = preferences
    applyTracks("system preferences")
    commit()
  }

  fun fullscreenChanged(active: Boolean) {
    if (released || active == fullscreen) return
    fullscreen = active
    commit()
  }

  /** The source's own audio and text tracks. */
  fun onTracks(generation: Int, tracks: List<MediaTrack>) {
    if (!accepts(generation)) return logStale("tracks", generation)
    sourceTracks = tracks.toList()
    applyTracks("source tracks")
    commit()
  }

  /** The app's new source for `loadId` (after `engineRequestsSourceRefresh`). */
  fun sourceRefreshed(loadId: Int, next: SourceDescriptor) {
    if (released) return
    if (loadId != this.loadId || source == null) {
      log("refresh ignored", mapOf("loadId" to "$loadId"))
      return
    }
    val pending = pendingRefresh
    pendingRefresh = null
    source = next.copy(refreshable = true)
    val nextRenditions = next.renditions
    if (nextRenditions != null && renditions != null) renditions = nextRenditions.toMutableList()
    sourceRevision += 1
    armExpiry()
    log("source refreshed", mapOf("reason" to (pending?.reason?.wire ?: "none")))
    if (pending?.reason == RefreshReason.UNAUTHORIZED) useRefreshedSource()
    commit()
  }

  /** The app could not make a new source for `loadId`. */
  fun sourceRefreshFailed(loadId: Int) {
    if (released || loadId != this.loadId) return
    val pending = pendingRefresh
    pendingRefresh = null
    log("refresh failed", mapOf("reason" to (pending?.reason?.wire ?: "none")))
    val error = if (pending?.reason == RefreshReason.UNAUTHORIZED) pending.error else null
    if (error != null) {
      settlePendingLoad(LoadOutcome.Failed(error))
      fail(error)
    }
    commit()
  }

  /** The platform read a rendition's height or bitrate from its file. */
  fun renditionInfo(index: Int, height: Int?, bitrate: Long?) {
    val table = renditions ?: return
    val r = table.getOrNull(index)
    if (released || r == null) return
    table[index] = r.copy(height = height ?: r.height, bitrate = bitrate ?: r.bitrate)
    commit()
  }

  // ── Video: system inputs ──

  /** The app went to the background (`whenBackgrounded`). */
  fun appBackgrounded() {
    if (released || backgrounded) return
    backgrounded = true
    val v = options.video
    if (v != null && !pictureOnAnotherScreen) {
      backgroundPolicy(v)
      applyOutput("background")
    }
    commit()
  }

  /** The view showing the player changed (mounted, scrolled, resized). */
  fun viewChanged(next: ViewState) {
    if (released) return
    val previous = view
    view = next
    val v = options.video ?: return
    detachedSince =
      when {
        next.attached -> null
        previous.attached -> now
        else -> detachedSince ?: now
      }
    if (v.ambient) ambientCheck()
    applyOutput("view")
    commit()
  }

  fun pictureInPictureChanged(active: Boolean) {
    if (released || active == pictureInPicture) return
    if (active) pipCap = viewCap()
    pictureInPicture = active
    log("picture in picture", mapOf("active" to "$active"))
    if (active) pipDecisionAt = null else pictureInPictureClosed()
    applyOutput("picture in picture")
    commit()
  }

  /** A metered network (cellular caps) and the OS's data saver. */
  fun networkCostChanged(metered: Boolean, saveData: Boolean) {
    if (released) return
    if (metered == this.metered && saveData == this.saveData) return
    this.metered = metered
    this.saveData = saveData
    applyQuality("network cost")
    commit()
  }

  // ── Video: driver observations ──

  /** A bandwidth estimate, bits per second (for the current item or a switch's). */
  fun onBandwidth(generation: Int, bitsPerSecond: Double) {
    if (!accepts(generation) && !isSwapGeneration(generation)) return
    if (!bitsPerSecond.isFinite() || bitsPerSecond <= 0) return
    val t = now
    bandwidth = bitsPerSecond
    bandwidthAt = t
    trackBandwidth(t, bitsPerSecond)
  }

  /** An adaptive source's qualities. */
  fun onVariants(generation: Int, variants: List<VideoVariant>) {
    if (!accepts(generation)) return logStale("variants", generation)
    this.variants = variants.toList()
    // A pick among renditions stands: each file's variants are not the list.
    val selected = selectedQuality
    if (selected != null && renditions == null && this.variants.none { it.id == selected }) selectedQuality = null
    val wanted = wantedQuality
    if (selectedQuality == null && wanted != null && renditions == null && this.variants.any { it.id == wanted }) {
      selectedQuality = wanted
    }
    applyQuality("variants")
    commit()
  }

  fun onVideoInfo(generation: Int, info: VideoInfo) {
    // A switch's new file: its picture is the one once it takes over.
    if (isSwapGeneration(generation)) {
      swapVideoInfo = info
      return
    }
    if (!accepts(generation)) return logStale("video info", generation)
    videoInfo = info
    val index = currentRendition
    val table = renditions
    if (table != null && index != null && table[index].height == null && info.height > 0) {
      table[index] = table[index].copy(height = info.height)
    }
    applyQuality("video info")
    commit()
  }

  fun onFirstFrame(generation: Int) {
    if (!accepts(generation)) return logStale("first frame", generation)
    firstFrame = true
    commit()
  }

  // ── Clock ──

  fun onWakeup() {
    if (released) return
    val t = now
    releasePausedConnectionIfDue(t)
    publishStallIfDue(t)
    videoWakeup(t)
    if (state == PlaybackState.RECONNECTING) {
      val due = nextAttemptAt
      if (due != null && due <= t) {
        nextAttemptAt = null
        attemptReconnect("backoff elapsed")
      }
    }
    fireSleepIfDue(t)
    stepFades(t)
    if (heartbeatDue && t - lastHeartbeatAt >= RecoveryPolicy.HEARTBEAT_MS - 50) {
      lastHeartbeatAt = t
      heartbeat(t)
    }
    commit()
  }

  private fun releasePausedConnectionIfDue(t: Long) {
    pauseReleaseAt?.let { due ->
      if (due <= t) {
        pauseReleaseAt = null
        if (state == PlaybackState.PAUSED && !playWhenReady && !connectionReleased) {
          releaseItemConnection()
          log("paused stream released", emptyMap())
        }
      }
    }
  }

  private fun publishStallIfDue(t: Long) {
    stallPublishAt?.let { due ->
      if (due <= t) {
        stallPublishAt = null
        val started = stallStartedAt
        if (state == PlaybackState.PLAYING && started != null) {
          setState(PlaybackState.BUFFERING, "native stall")
          beginWaiting()
          stallStartedAt = started
          lastBufferedAdvanceAt = started
          stallPublished(t)
        }
      }
    }
  }

  // ── Internals ──

  private fun continuesIntent(state: PlaybackState): Boolean =
    when (state) {
      PlaybackState.LOADING,
      PlaybackState.BUFFERING,
      PlaybackState.PLAYING,
      PlaybackState.RECONNECTING,
      PlaybackState.PAUSED -> true
      else -> false
    }

  private fun ensureAlive() {
    if (released) throw PlayerError(ErrorCode.PLAYER_RELEASED, "The player was released.", false)
  }

  /** Audio focus is the device's: a remote output always has it. */
  private fun requestFocus(): FocusResult =
    if (remote || focusExempt) FocusResult.GRANTED else delegate?.engineRequestsAudioFocus() ?: FocusResult.GRANTED

  private fun applyFocus(focus: FocusResult) {
    when (focus) {
      FocusResult.GRANTED -> Unit
      FocusResult.DELAYED -> {
        playWhenReady = false
        interruption = Interruption(InterruptionReason.AUDIO_FOCUS_DELAYED, true, clock.wallMs)
      }
      FocusResult.DENIED -> {
        playWhenReady = false
        interruption = Interruption(InterruptionReason.AUDIO_FOCUS_DENIED, false, clock.wallMs)
      }
    }
  }

  private fun startPlayback(cause: String) {
    if (fadeOutThen != null) {
      // Playing again during a fade-out: the audio never stopped.
      fadeOutThen = null
      playingSince = now
      log("fade-out cancelled", mapOf("cause" to cause))
    }
    startFadeIn(state == PlaybackState.PLAYING)
    playWhenReady = true
    pauseReleaseAt = null
    if (state == PlaybackState.ERROR) lastError = null
    when (state) {
      PlaybackState.IDLE -> playWhenReady = false
      PlaybackState.LOADING -> driver.play()
      PlaybackState.PAUSED -> {
        val pausedFor = pausedAt?.let { now - it } ?: 0L
        pausedAt = null
        if (connectionReleased || !readyForGeneration) {
          reopen("$cause: connection released", if (isLive) null else resumePosition)
        } else if (isLive && driftMs + pausedFor >= options.liveMaxDriftMs) {
          reopen("$cause: live edge after ${pausedFor}ms paused")
        } else {
          driftMs += pausedFor
          // State first: drivers may report "playing" re-entrantly from play().
          setState(PlaybackState.BUFFERING, cause)
          beginWaiting()
          driver.play()
        }
      }
      PlaybackState.STOPPED, PlaybackState.ERROR -> reopen(cause, if (isLive) null else resumePosition)
      PlaybackState.ENDED -> restartFromEnd(cause)
      PlaybackState.BUFFERING, PlaybackState.PLAYING, PlaybackState.RECONNECTING -> Unit
    }
  }

  private fun restartFromEnd(cause: String) {
    resumePosition = 0.0
    if (connectionReleased) {
      // The item left its output (a handoff): open it again.
      reopen("$cause: restart", 0.0)
      return
    }
    setState(PlaybackState.BUFFERING, "$cause: restart")
    beginWaiting()
    driver.seek(0.0)
    driver.play()
  }

  private fun pauseIntent(cause: String) {
    cancelSwap("pause")
    holdGain()
    resetRecovery()
    stallStartedAt = null
    playingSince = null
    when (state) {
      PlaybackState.PLAYING, PlaybackState.BUFFERING -> {
        rememberPosition()
        pausedAt = now
        setState(PlaybackState.PAUSED, cause)
        armPauseRelease()
      }
      PlaybackState.RECONNECTING -> {
        connectionReleased = true
        pausedAt = now
        setState(PlaybackState.PAUSED, cause)
      }
      PlaybackState.LOADING -> log("paused while loading", emptyMap())
      else -> Unit
    }
    driver.pause()
  }

  private fun open(startPosition: Double?, reason: String) {
    val source = this.source ?: return
    cancelSwap("open")
    generation = issueGeneration()
    readyForGeneration = false
    flowedSinceOpen = false
    silentStall = false
    connectionReleased = false
    stallStartedAt = null
    pausedAt = null
    playingSince = null
    driftMs = 0
    pauseReleaseAt = null
    lastOpenAt = now
    openNetworkRevision = networkRevision
    lastPosition = startPosition ?: 0.0
    lastBuffered = 0.0
    lastBufferedAdvanceAt = now
    lastPositionAdvanceAt = now
    lastHeartbeatAt = now
    setState(PlaybackState.LOADING, reason)
    val index = currentRendition
    val target = if (renditions != null && index != null) renditionSource(index) else source
    driver.open(
      OpenRequest(
        generation,
        target,
        startPosition,
        playWhenReady,
        allowReconnect = options.reconnect,
        rendition = if (renditions != null) index else null,
      ),
    )
    videoOpened()
  }

  private fun reopen(reason: String, startPosition: Double? = null) {
    val position = if (isLive) null else (startPosition ?: resumePosition ?: currentPositionEstimate())
    log("reopen", mapOf("reason" to reason))
    open(position, reason)
  }

  private fun currentPositionEstimate(): Double? =
    if (isLive) null else if (lastPosition > 0) lastPosition else null

  /** Where the item is, read before it leaves its output. */
  private fun handoffPosition(): Double? {
    if (isLive) return null
    val sampled =
      state == PlaybackState.PLAYING || state == PlaybackState.BUFFERING || state == PlaybackState.PAUSED
    if (sampled && readyForGeneration && !connectionReleased) rememberPosition()
    return resumePosition ?: currentPositionEstimate()
  }

  private fun rememberPosition() {
    if (isLive) return
    val p = driver.sample().position
    if (p.isFinite() && p >= 0) {
      lastPosition = p
      resumePosition = p
    }
  }

  private fun beginWaiting() {
    stallStartedAt = now
    playingSince = null
    lastBufferedAdvanceAt = now
    val sample = driver.sample()
    lastBuffered = sample.bufferedPosition
    waitingFromPosition = sample.position
    waitingLastPosition = sample.position
    waitingLastAt = now
  }

  /**
   * Whether the playhead has run on, reading after reading, at about the
   * playback rate for `PLAYHEAD_PROOF_S` (a jump, like a live edge or a
   * seek, or a frozen playhead, starts the run again).
   */
  private fun playheadPlays(t: Long, p: Double): Boolean {
    var from = waitingFromPosition ?: return false
    if (remote) return false
    val dt = (t - waitingLastAt) / 1000.0
    val dp = p - waitingLastPosition
    val r = maxOf(rate, 0.1)
    val runs = dt > 0 && dp >= 0.5 * r * dt && dp <= 1.5 * r * dt + 0.25
    waitingLastPosition = p
    waitingLastAt = t
    if (!runs) {
      from = p
      waitingFromPosition = p
    }
    return runs && p - from >= RecoveryPolicy.PLAYHEAD_PROOF_S
  }

  private fun handleFailure(error: PlayerError) {
    // A 401/403 on a source the app can refresh waits for a new URL first.
    if (refreshOnFailure(error)) return
    lastError = error
    val wasInitialLoad = !readyForGeneration && pendingLoadId != null
    settlePendingLoad(LoadOutcome.Failed(error))
    log(
      "failure",
      mapOf("code" to error.code.wire, "recoverable" to "${error.recoverable}", "message" to error.message),
    )
    if (!error.recoverable) {
      fail(error)
      return
    }
    if (playWhenReady && options.reconnect) {
      pendingEvents.add { delegate?.engineError(error, false) }
      if (!isLive) rememberPosition()
      scheduleReconnect(error.code.wire)
    } else if (playWhenReady || wasInitialLoad) {
      fail(error)
    } else {
      connectionReleased = true
      pauseReleaseAt = null
      if (state == PlaybackState.LOADING || state == PlaybackState.BUFFERING) {
        setState(PlaybackState.PAUSED, "died while paused")
      }
    }
  }

  private fun fail(error: PlayerError) {
    lastError = error
    playWhenReady = false
    resetRecovery()
    pauseReleaseAt = null
    stallStartedAt = null
    releaseItemConnection()
    setState(PlaybackState.ERROR, error.code.wire)
    pendingEvents.add { delegate?.engineError(error, true) }
  }

  /**
   * Releases the item's connection and invalidates its generation: callbacks
   * the driver already queued for it (an end, a failure) must not move the
   * player out of `stopped`, `paused` or `error`. Resuming opens a new one.
   */
  private fun releaseItemConnection() {
    cancelSwap("release")
    generation = issueGeneration()
    readyForGeneration = false
    silentStall = false
    driver.releaseConnection()
    connectionReleased = true
  }

  private fun scheduleReconnect(reason: String) {
    val t = now
    if (recoveringSince == null) recoveringSince = t
    if (state == PlaybackState.RECONNECTING && nextAttemptAt != null) return
    // A healthy stream that suddenly drops reconnects immediately; repeated failures back off.
    val delay =
      if (stable) {
        stable = false
        0L
      } else {
        backoff.next()
      }
    nextAttemptAt = t + delay
    reconnectReason = reason
    stallStartedAt = null
    playingSince = null
    setState(PlaybackState.RECONNECTING, "$reason — attempt ${backoff.attempts} in ${delay}ms")
  }

  private val openInFlight: Boolean
    get() {
      val opened = lastOpenAt
      if (state != PlaybackState.LOADING || opened == null || flowedSinceOpen) return false
      // Issued after the latest network edge (a revision, not a time: an open
      // and the edge that caused it can share a millisecond).
      return openNetworkRevision == networkRevision && now - opened < RecoveryPolicy.OPEN_GRACE_MS
    }

  private fun attemptReconnect(reason: String) {
    if (!playWhenReady || source == null) return
    if (openInFlight) {
      log("reconnect skipped", mapOf("reason" to reason, "note" to "open in flight"))
      return
    }
    if (recoveringSince == null) recoveringSince = now
    if (
      !remote &&
      network == NetworkState.OFFLINE &&
      offlineSkips < RecoveryPolicy.OFFLINE_PROBE_EVERY
    ) {
      offlineSkips += 1
      val delay = backoff.next()
      nextAttemptAt = now + delay
      reconnectReason = "offline"
      setState(PlaybackState.RECONNECTING, "$reason: offline, probe in ${delay}ms")
      return
    }
    offlineSkips = 0
    if (backoff.attempts == 0) backoff.next()
    nextAttemptAt = null
    reconnectReason = reason
    reopen("reconnect: $reason")
  }

  /** Recovery may re-open on its own: playback is wanted and reconnecting is on. */
  private val autoReconnect: Boolean
    get() = playWhenReady && options.reconnect

  /** Playback is wanted, or an open is outstanding (it times out either way). */
  private val heartbeatDue: Boolean
    get() = playWhenReady || state == PlaybackState.LOADING

  private fun heartbeat(t: Long) {
    val since = recoveringSince
    val limit = options.giveUpAfterMs
    if (since != null && limit != null && t - since >= limit && state != PlaybackState.PLAYING) {
      val error = lastError ?: PlayerError(ErrorCode.NETWORK_ERROR, "Recovery gave up after ${limit / 1000}s.", true)
      log("giving up", mapOf("afterMs" to "${t - since}"))
      fail(error)
      return
    }
    val suspect = t < suspectUntil
    when (state) {
      PlaybackState.LOADING -> {
        val opened = lastOpenAt
        if (opened != null && t - opened >= RecoveryPolicy.OPEN_TIMEOUT_MS) {
          handleFailure(PlayerError(ErrorCode.TIMEOUT, "Opening the source timed out.", true))
        }
      }
      PlaybackState.PLAYING -> {
        heartbeatPlaying(t, suspect)
        videoHeartbeat(t)
      }
      PlaybackState.BUFFERING -> if (remote) heartbeatRemoteBuffering(t) else heartbeatBuffering(t, suspect)
      else -> Unit
    }
  }

  private fun heartbeatPlaying(t: Long, suspect: Boolean) {
    val sample = driver.sample()
    if (!isLive) resumePosition = sample.position
    when {
      sample.position > lastPosition + 0.05 || sample.position < lastPosition - 0.5 -> {
        lastPosition = sample.position
        lastPositionAdvanceAt = t
      }
      remote -> {
        // A receiver's position is interpolated between its reports: only the
        // state it reports (buffering, failed) counts.
      }
      else -> {
        val stallLimit = if (suspect) RecoveryPolicy.SUSPECT_SILENT_STALL_MS else RecoveryPolicy.SILENT_STALL_MS
        // A native stall awaiting publication is not silent.
        if (stallPublishAt == null && t - lastPositionAdvanceAt >= stallLimit && rate > 0) {
          log("silent stall", mapOf("frozenMs" to "${t - lastPositionAdvanceAt}"))
          setState(PlaybackState.BUFFERING, "silent stall")
          beginWaiting()
          stallStartedAt = lastPositionAdvanceAt
          silentStall = true
          stallPublished(t)
        }
      }
    }
    val playing = playingSince
    if (playing != null && t - playing >= RecoveryPolicy.STABLE_PLAYBACK_MS) {
      playingSince = null
      stable = true
      backoff.reset()
      offlineSkips = 0
      recoveringSince = null
    }
  }

  private fun heartbeatBuffering(t: Long, suspect: Boolean) {
    val sample = driver.sample()
    val p = sample.position
    trackResumePosition(p)
    if (silentStall && p > lastPosition + 0.05) {
      // The stall was ours (native never left playing): the playhead moving
      // again is the only sign it is over.
      endSilentStall(t, p)
      return
    }
    if (playheadPlays(t, p)) {
      // The platform plays but never said so: the playhead is the proof.
      log("playhead moving", mapOf("at" to "%.1f".format(java.util.Locale.ROOT, p)))
      onPlaying(generation)
      return
    }
    if (sample.bufferedPosition > lastBuffered + 0.01) {
      lastBuffered = sample.bufferedPosition
      lastBufferedAdvanceAt = t
    }
    val stalled = stallStartedAt ?: return
    if (network == NetworkState.OFFLINE) return heartbeatOffline(t, stalled)
    val deadLimit = if (suspect) RecoveryPolicy.SUSPECT_STALL_DEAD_MS else RecoveryPolicy.STALL_DEAD_MS
    when {
      t - lastBufferedAdvanceAt >= deadLimit -> recoverStall("stalled ${t - stalled}ms with no data")
      t - stalled >= RecoveryPolicy.STALL_MAX_MS -> recoverStall("stalled ${t - stalled}ms")
      isLive && driftMs + (t - stalled) >= options.liveMaxDriftMs -> recoverStall("live drift during stall")
    }
  }

  /** Offline, a stall with no data for long enough waits for the network (or fails). */
  private fun heartbeatOffline(t: Long, stalled: Long) {
    if (t - lastBufferedAdvanceAt < RecoveryPolicy.STALL_DEAD_MS) return
    if (!options.reconnect) return failStall("offline")
    if (recoveringSince == null) recoveringSince = stalled
    scheduleReconnect("offline")
  }

  /**
   * A re-open resumes where the playhead got to during a stall; a reading
   * behind the last trusted position (a start seek still pending) is not one.
   */
  private fun trackResumePosition(p: Double) {
    if (!isLive && p.isFinite() && p >= max(lastPosition, resumePosition ?: 0.0)) resumePosition = p
  }

  /** No buffer to watch on a receiver: only a stall that lasts too long. */
  private fun heartbeatRemoteBuffering(t: Long) {
    val stalled = stallStartedAt
    if (stalled != null && t - stalled >= RecoveryPolicy.STALL_MAX_MS) {
      recoverStall("stalled ${t - stalled}ms")
    }
  }

  /** A stall the watchdog gave up waiting on: re-open, or fail with reconnecting off. */
  private fun recoverStall(reason: String) {
    when {
      stalledAtEnd() -> {
        // A re-open would land at the end and stall again, in a loop.
        log("stall at the end", mapOf("reason" to reason))
        onEnded(generation)
      }
      options.reconnect -> attemptReconnect(reason)
      else -> failStall(reason)
    }
  }

  /** The playhead and the buffer are at a file's end: no data is coming because there is none left. */
  private fun stalledAtEnd(): Boolean {
    val d = duration ?: return false
    if (isLive || remote) return false
    val end = d - RecoveryPolicy.END_SLACK_S
    val sample = driver.sample()
    return sample.position >= end && sample.bufferedPosition >= end
  }

  private fun failStall(reason: String) {
    log("stall, reconnect off", mapOf("reason" to reason))
    fail(
      PlayerError(
        ErrorCode.NETWORK_ERROR,
        "Playback stalled ($reason) and reconnecting is off.",
        true,
      ),
    )
  }

  /** Native kept saying playing through a silent stall: the audio flows again. */
  private fun endSilentStall(t: Long, position: Double) {
    silentStall = false
    stallStartedAt?.let { driftMs += t - it }
    stallStartedAt = null
    lastPosition = position
    lastPositionAdvanceAt = t
    playingSince = t
    videoPlaying(t)
    setState(PlaybackState.PLAYING, "silent stall over")
  }

  private fun armPauseRelease() {
    val source = this.source ?: return
    if (!source.isNetwork || !(isLive || duration == null) || connectionReleased) return
    pauseReleaseAt = now + RecoveryPolicy.PAUSED_STREAM_RELEASE_MS
  }

  private fun resetRecovery() {
    stable = false
    backoff.reset()
    nextAttemptAt = null
    recoveringSince = null
    offlineSkips = 0
    reconnectReason = ""
  }

  private fun markNetworkEdge(t: Long) {
    networkRevision += 1
    suspectUntil = t + RecoveryPolicy.NETWORK_SUSPECT_MS
  }

  private fun applyVolume() {
    val value = outputVolume(now)
    appliedVolume = value
    driver.setVolume(value)
  }

  /** Sends the output volume only when it changed (fade steps). */
  private fun refreshVolume() {
    if (outputVolume(now) != appliedVolume) applyVolume()
  }

  private fun outputVolume(t: Long): Double {
    if (muted) return 0.0
    val duck = if (remote) 1.0 else duckFactor
    return levelAt(t) * duck * gainAt(t) * sleepGainAt(t)
  }

  // ── Fades & sleep timer ──

  private fun invalidDuration(what: String) =
    PlayerError(ErrorCode.INVALID_ARGUMENT, "$what must be a finite number from 0 to 24 h.", false)

  private fun validDuration(ms: Double): Boolean = ms.isFinite() && ms >= 0 && ms <= MAX_TIMER_MS.toDouble()

  private fun levelAt(t: Long): Double = levelRamp?.valueAt(t) ?: volume

  private fun gainAt(t: Long): Double = gainRamp?.valueAt(t) ?: gain

  /** In the sleep timer's last `sleepFadeMs`: the fade-out (local output only). */
  private fun sleepFading(t: Long): Boolean {
    val at = sleepAt ?: return false
    return sleepFadeMs > 0 && !remote && t >= at - sleepFadeMs
  }

  private fun sleepGainAt(t: Long): Double {
    val at = sleepAt
    if (at == null || !sleepFading(t)) return 1.0
    return min(1.0, max(0.0, (at - t).toDouble() / sleepFadeMs.toDouble()))
  }

  private fun setGain(value: Double) {
    gainRamp = null
    gain = value
    refreshVolume()
  }

  /** Stops the gain where it is. */
  private fun freezeGain() {
    gain = gainAt(now)
    gainRamp = null
  }

  /** The audio stops: a pending fade-in is dropped, the gain stays where it is. */
  private fun holdGain() {
    fadeInPending = false
    freezeGain()
  }

  /** Moves the gain to `to` at `fullScaleMs` per 0…1 (instant when `0`). */
  private fun rampGain(to: Double, fullScaleMs: Long) {
    val t = now
    val from = gainAt(t)
    val ms = Math.round(fullScaleMs * Math.abs(to - from))
    if (ms <= 0) {
      setGain(to)
      return
    }
    gain = from
    gainRamp = Ramp(from, to, t, t + ms)
  }

  /** The intent turns on: from silence when a fade-in is set, else full. */
  private fun startFadeIn(flowing: Boolean) {
    fadeInPending = false
    val ms = if (remote) 0L else options.fadeInMs
    if (ms > 0 && !flowing) {
      // Silent until the audio flows, then `onPlaying` starts the ramp.
      fadeInPending = true
      setGain(0.0)
    } else {
      rampGain(1.0, ms)
    }
  }

  /** Starts the fade-out of a pause or a stop; `false` when there is nothing to fade. */
  private fun beginFadeOut(then: FadeOutEnd): Boolean {
    val ms = if (remote) 0L else options.fadeOutMs
    if (ms <= 0 || state != PlaybackState.PLAYING || stallPublishAt != null) return false
    fadeInPending = false
    rampGain(0.0, ms)
    val ramp = gainRamp ?: return false
    fadeOutThen = then
    resetRecovery()
    playingSince = null
    log("fade-out", mapOf("end" to then.name.lowercase(), "ms" to "${ramp.endAt - ramp.startAt}"))
    return true
  }

  /** Lands a fade-out now (`override` changes what it ends in): silence, then the pause or the stop. */
  private fun completeFadeOut(override: FadeOutEnd? = null) {
    val pending = fadeOutThen ?: return
    val then = override ?: pending
    fadeOutThen = null
    setGain(0.0)
    if (then == FadeOutEnd.STOP) stopNow() else pauseIntent("pause: faded out")
  }

  private fun cancelFadeOut() {
    fadeOutThen = null
    fadeInPending = false
    freezeGain()
  }

  private fun cancelFadeTo() {
    if (levelRamp == null) return
    levelRamp = null
    settleFadeTo()
  }

  private fun settleFadeTo() {
    val done = fadeToDone
    fadeToDone = null
    if (done != null) pendingEvents.add(done)
  }

  /** Fades belong to the output: a handoff lands them where they were going. */
  private fun settleFades() {
    fadeInPending = false
    gainRamp = null
    gain = 1.0
    cancelFadeTo()
  }

  /**
   * Clears the sleep timer. Its fade-out, if under way, becomes the gain: it
   * climbs back at the speed it went down (or keeps falling into a pause).
   */
  private fun endSleep() {
    if (sleepAt == null) return
    val t = now
    val attenuation = sleepGainAt(t)
    val fadeMs = sleepFadeMs
    sleepAt = null
    sleepWallAt = null
    sleepFadeMs = 0L
    if (attenuation >= 1) return
    val combined = gainAt(t) * attenuation
    val ramp = gainRamp
    if (fadeOutThen != null && ramp != null) {
      gainRamp = Ramp(combined, 0.0, t, ramp.endAt)
      return
    }
    gain = combined
    gainRamp = null
    if (playWhenReady && !fadeInPending) rampGain(1.0, fadeMs)
  }

  private fun fireSleepIfDue(t: Long) {
    val due = sleepAt ?: return
    if (due > t) return
    val attenuation = sleepGainAt(t)
    sleepAt = null
    sleepWallAt = null
    sleepFadeMs = 0L
    log(SLEEP_TIMER, mapOf("note" to "fired"))
    // Like a user pause: a pending system resume is cancelled too.
    interruption = null
    if (fadeOutThen != null) {
      completeFadeOut()
    } else if (playWhenReady) {
      gain = gainAt(t) * attenuation
      gainRamp = null
      refreshVolume()
      playWhenReady = false
      pauseIntent(SLEEP_TIMER)
    }
    pendingEvents.add { delegate?.engineSleepFired() }
  }

  private fun stepFades(t: Long) {
    fadeTickAt?.let { if (it <= t) fadeTickAt = null }
    levelRamp?.let {
      if (t >= it.endAt) {
        levelRamp = null
        settleFadeTo()
      }
    }
    gainRamp?.let {
      if (t >= it.endAt) {
        gain = it.to
        gainRamp = null
      }
    }
    refreshVolume()
    if (fadeOutThen != null && gainRamp == null) completeFadeOut()
  }

  private val fading: Boolean
    get() = levelRamp != null || gainRamp != null || (playWhenReady && sleepFading(now))

  private fun fadeWakeups(candidates: MutableList<Long>) {
    if (fading) {
      val tick = fadeTickAt ?: (now + RecoveryPolicy.FADE_TICK_MS)
      fadeTickAt = tick
      candidates.add(tick)
    } else {
      fadeTickAt = null
    }
    levelRamp?.let { candidates.add(it.endAt) }
    gainRamp?.let { candidates.add(it.endAt) }
    val at = sleepAt ?: return
    candidates.add(at)
    val fadeFrom = at - sleepFadeMs
    if (sleepFadeMs > 0 && fadeFrom > now) candidates.add(fadeFrom)
  }

  // ── Video: hooks in the engine's paths ──

  private val focusExempt: Boolean
    get() {
      val v = options.video ?: return false
      return v.ambient || (muted && !v.focusWhenMuted)
    }

  private fun issueGeneration(): Int {
    issuedGeneration += 1
    return issuedGeneration
  }

  private fun videoStatus(): VideoStatus? {
    if (options.video == null) return null
    val info = videoInfo
    return VideoStatus(
      width = info?.width,
      height = info?.height,
      hdr = info?.hdr ?: false,
      firstFrame = firstFrame,
      audioOnly = audioOnlyReason,
      pictureInPicture = pictureInPicture,
      tracks = allTracks,
      audioTrack = audioTrack,
      textTrack = textTrack,
      subtitleDelay = subtitleDelay,
      fullscreen = fullscreen,
    )
  }

  private fun videoLoad() {
    loadStartedAt = now
    counters = EngineStats()
    rebufferSince = null
    pendingRefresh = null
    sourceRevision = 0
    openedRevision = 0
    armExpiry()
    // The qualities are any player's (an audio player's renditions too).
    resetQuality()
    val v = options.video ?: return
    firstFrame = false
    resetTracks()
    if (!view.attached && detachedSince == null) detachedSince = now
    lastAudioOnly = audioOnlyReason
    if (v.ambient && !shown && playWhenReady) {
      // Not on screen: it starts when its view is (nothing is open to pause).
      playWhenReady = false
      val reason = if (backgrounded) InterruptionReason.BACKGROUND else InterruptionReason.OFFSCREEN
      interruption = Interruption(reason, true, clock.wallMs)
    }
  }

  private fun videoOpened() {
    openedRevision = sourceRevision
    // A new item plays its default tracks until it is told again.
    appliedTracks = null
    if (options.video == null || renditions != null) return
    // A new item starts from the driver's defaults: tell it the caps again.
    appliedQuality = null
    applyQuality("open")
  }

  private fun isSwapGeneration(generation: Int): Boolean = !released && pendingSwap?.generation == generation

  private fun completeSwap() {
    val swap = pendingSwap ?: return
    pendingSwap = null
    generation = swap.generation
    currentRendition = swap.rendition
    swap.info?.let(::applyFacts)
    readyForGeneration = true
    connectionReleased = false
    openedRevision = sourceRevision
    lastSwitchAt = now
    abrLowSince = null
    abrUpSince = null
    counters = counters.copy(qualitySwitches = counters.qualitySwitches + 1)
    swapVideoInfo?.let { videoInfo = it }
    swapVideoInfo = null
    log("quality switched", mapOf("to" to "r${swap.rendition}"))
    appliedTracks = null
    applyTracks("quality switched")
  }

  private fun swapFailed(error: PlayerError) {
    val swap = pendingSwap ?: return
    dropSwap(swap, "failed: ${error.code.wire}", error)
  }

  /** The item's duration, live state and seekability, as the platform reports them. */
  private fun applyFacts(info: ReadyInfo) {
    duration = info.duration
    isLive = source?.liveHint ?: info.isLive
    seekable = info.seekable && !isLive
  }

  private fun swapNote(event: String) {
    log("quality switch", mapOf("event" to event))
  }

  private fun cancelSwap(reason: String) {
    val swap = pendingSwap ?: return
    pendingSwap = null
    driver.cancelSwap(swap.generation)
    log("quality switch cancelled", mapOf("reason" to reason))
  }

  private fun refreshOnFailure(error: PlayerError): Boolean {
    if (source?.refreshable != true) return false
    if (error.httpStatus != 401 && error.httpStatus != 403) return false
    if (sourceRevision > openedRevision) {
      // A new source came in ahead (`expiresAt`): use it now.
      log("refreshed source", mapOf("note" to "already here"))
      useRefreshedSource()
      return true
    }
    if (pendingRefresh?.reason == RefreshReason.UNAUTHORIZED) return true
    lastError = error
    requestRefresh(RefreshReason.UNAUTHORIZED, error)
    if (playWhenReady) {
      if (!isLive) rememberPosition()
      if (recoveringSince == null) recoveringSince = now
      nextAttemptAt = null
      reconnectReason = "refresh"
      setState(PlaybackState.RECONNECTING, "waiting for a new source")
    }
    return true
  }

  private fun videoPlaying(t: Long) {
    val started = loadStartedAt
    if (counters.startupMs == null && started != null) counters = counters.copy(startupMs = t - started)
    endRebuffer(t)
  }

  private fun stallPublished(t: Long) {
    counters = counters.copy(rebufferCount = counters.rebufferCount + 1)
    if (rebufferSince == null) rebufferSince = t
    if (remote) return
    if (audioOnlyReason == null) {
      stallTimes.add(t)
      stallTimes.removeAll { t - it >= RecoveryPolicy.FALLBACK_PROBE_MS }
    }
    evaluateAbr(t, true)
    // The audio-only fallback is the picture's.
    if (options.video != null) evaluateFallback(t, true)
  }

  private fun stateChanged(next: PlaybackState) {
    if (rebufferSince != null && next !in REBUFFER_STATES) endRebuffer(now)
  }

  private fun unmuted() {
    val v = options.video ?: return
    if (v.ambient || v.focusWhenMuted) return
    if (remote || !playWhenReady) return
    // A muted video took no focus: it asks now, and a refusal pauses it.
    when (delegate?.engineRequestsAudioFocus() ?: FocusResult.GRANTED) {
      FocusResult.GRANTED -> Unit
      FocusResult.DELAYED -> systemPause(InterruptionReason.AUDIO_FOCUS_DELAYED, true)
      FocusResult.DENIED -> systemPause(InterruptionReason.AUDIO_FOCUS_DENIED, false)
    }
  }

  private fun videoWakeup(t: Long) {
    pipDecisionAt?.let { if (it <= t) pipDecision() }
    detachedSince?.let { if (t - it >= RecoveryPolicy.VIEW_DETACH_GRACE_MS) noViewDue() }
    pendingRefresh?.let { if (it.deadline <= t) refreshTimedOut(it) }
    refreshAskAt?.let { if (it <= t) expiryDue() }
    pendingSwap?.let { if (t >= it.deadline) dropSwap(it, "timeout") }
  }

  private fun videoWakeups(candidates: MutableList<Long>) {
    pipDecisionAt?.let { candidates.add(it) }
    val detached = detachedSince
    if (detached != null && pictureMayGoOff) candidates.add(detached + RecoveryPolicy.VIEW_DETACH_GRACE_MS)
    pendingRefresh?.let { candidates.add(it.deadline) }
    refreshAskAt?.let { candidates.add(it) }
    pendingSwap?.let { candidates.add(it.deadline) }
  }

  /** The app came back (`appForegrounded`). */
  private fun videoForegrounded() {
    if (!backgrounded) return
    backgrounded = false
    pipDecisionAt = null
    val v = options.video ?: return
    if (v.ambient) {
      ambientCheck()
    } else if (pausedFor(InterruptionReason.BACKGROUND)) {
      interruption = null
      startPlayback("foreground")
    }
    applyOutput("foreground")
  }

  /** The watchdog's tick, while playback is wanted. */
  private fun videoHeartbeat(t: Long) {
    if (remote || state != PlaybackState.PLAYING) return
    if (options.video == null && renditions == null) return
    // A switch a seek or a pause cancelled is tried again.
    if (renditions != null && pendingSwap == null) retarget("resume switch")
    evaluateAbr(t, false)
    if (options.video != null) evaluateFallback(t, false)
  }

  // ── Video: surroundings ──

  /** The picture is on another screen (Cast, AirPlay): the app's state does not matter. */
  private val pictureOnAnotherScreen: Boolean
    get() = remote || route.kind == AudioRouteKind.AIRPLAY

  /** The view is attached, visible, and the app in the foreground. */
  private val shown: Boolean
    get() = view.attached && view.visible && !backgrounded

  private val audioOnlyReason: AudioOnlyReason?
    get() =
      when {
        options.video == null -> null
        listenOnly -> AudioOnlyReason.LISTEN
        backgroundAudio -> AudioOnlyReason.BACKGROUND
        fallbackActive -> AudioOnlyReason.FALLBACK
        else -> null
      }

  /** `whenBackgrounded: 'audio'` applies now. */
  private val backgroundAudio: Boolean
    get() {
      val v = options.video ?: return false
      if (v.ambient || !backgrounded) return false
      if (pictureInPicture || pictureOnAnotherScreen) return false
      return v.whenBackgrounded == BackgroundMode.AUDIO
    }

  /** Decode the picture: something shows it, or a view went away only just now. */
  private val wantsPicture: Boolean
    get() {
      if (audioOnlyReason != null) return false
      if (pictureInPicture || view.attached || remote) return true
      val since = detachedSince ?: return true
      return now - since < RecoveryPolicy.VIEW_DETACH_GRACE_MS
    }

  /** The no-view grace can still turn the picture off. */
  private val pictureMayGoOff: Boolean
    get() = options.video != null && source != null && appliedVideoEnabled != false

  /** The system paused it for `reason` and may resume it. */
  private fun pausedFor(reason: InterruptionReason): Boolean {
    val i = interruption ?: return false
    return i.resumable && i.reason == reason
  }

  private fun backgroundPolicy(v: VideoEngineOptions) {
    if (v.ambient) return ambientCheck()
    if (pictureInPicture) return
    when (v.whenBackgrounded) {
      // Picture in Picture may start a moment after the app leaves.
      BackgroundMode.PIP -> pipDecisionAt = now + RecoveryPolicy.PIP_GRACE_MS
      BackgroundMode.PAUSE -> if (playWhenReady) systemPause(InterruptionReason.BACKGROUND, false)
      BackgroundMode.AUDIO -> Unit
    }
  }

  /**
   * Closing Picture in Picture from the background pauses, unless the app
   * comes back ("back to app" brings the app forward right after).
   */
  private fun pictureInPictureClosed() {
    val v = options.video ?: return
    if (v.ambient || !backgrounded) return
    if (v.whenBackgrounded != BackgroundMode.AUDIO) pipDecisionAt = now + RecoveryPolicy.PIP_GRACE_MS
  }

  /** The Picture in Picture grace ran out in the background. */
  private fun pipDecision() {
    pipDecisionAt = null
    if (!backgrounded || pictureInPicture) return
    if (playWhenReady) systemPause(InterruptionReason.BACKGROUND, false)
  }

  private fun noViewDue() {
    if (appliedVideoEnabled != false) applyOutput("no view")
  }

  private fun expiryDue() {
    refreshAskAt = null
    if (pendingRefresh == null) requestRefresh(RefreshReason.EXPIRING, null)
  }

  /** An ambient player plays only when shown, and resumes when shown again. */
  private fun ambientCheck() {
    if (!shown) {
      if (playWhenReady) {
        systemPause(if (backgrounded) InterruptionReason.BACKGROUND else InterruptionReason.OFFSCREEN, true)
      }
      return
    }
    val waiting = pausedFor(InterruptionReason.BACKGROUND) || pausedFor(InterruptionReason.OFFSCREEN)
    if (waiting && source != null) {
      interruption = null
      startPlayback("on screen")
    }
  }

  /** Sends what changed about the picture: on or off, audio only, the quality. */
  private fun applyOutput(cause: String) {
    if (options.video == null || source == null) return
    val reason = audioOnlyReason
    if (reason != lastAudioOnly) {
      if (lastAudioOnly == null) counters = counters.copy(audioOnlySwitches = counters.audioOnlySwitches + 1)
      log("audio only", mapOf("reason" to (reason?.wire ?: "off"), "cause" to cause))
      lastAudioOnly = reason
    }
    val on = wantsPicture
    if (on != (appliedVideoEnabled ?: true)) {
      appliedVideoEnabled = on
      driver.setVideoEnabled(on)
      log("picture", mapOf("on" to "$on", "cause" to cause))
    }
    applyQuality(cause)
  }

  private val allTracks: List<MediaTrack>
    get() = sourceTracks + appTracks

  private fun resetTracks() {
    sourceTracks = emptyList()
    appTracks = emptyList()
    chosenAudio = null
    chosenText = TextChoice.Auto
    audioTrack = null
    textTrack = null
    appliedTracks = null
    subtitleDelay = 0.0
  }

  private fun assertTrack(id: String, audio: Boolean) {
    if (allTracks.none { it.id == id && (it.kind == TrackKind.AUDIO) == audio }) {
      throw PlayerError(ErrorCode.INVALID_ARGUMENT, "No ${if (audio) "audio" else "text"} track \"$id\".", false)
    }
  }

  /** The tracks to play: the app's pick where it made one, else the automatic choice. */
  private fun applyTracks(cause: String) {
    val v = options.video ?: return
    val all = allTracks
    val auto =
      TrackSelection.select(
        all,
        TrackPreferences(
          languages = v.tracks.languages,
          followSystem = v.tracks.followSystem,
          systemLanguages = system.languages,
          systemCaptions = system.captions,
          systemAudioDescriptions = system.audioDescriptions,
        ),
      )
    val has = { id: String? -> id != null && all.any { it.id == id } }
    val audio = if (has(chosenAudio)) chosenAudio else auto.audio
    val text =
      when (val choice = chosenText) {
        TextChoice.Auto -> auto.text
        TextChoice.Off -> null
        is TextChoice.Track -> if (has(choice.id)) choice.id else auto.text
      }
    audioTrack = audio
    textTrack = text
    sendTracks(audio, text, cause)
  }

  /** The driver plays the source's own tracks; an app's subtitle file is the overlay's. */
  private fun sendTracks(audio: String?, text: String?, cause: String) {
    if (source == null || sourceTracks.isEmpty()) return
    val own = { id: String? -> if (id != null && sourceTracks.any { it.id == id }) id else null }
    val key = "${own(audio)}|${own(text)}"
    if (key == appliedTracks) return
    appliedTracks = key
    driver.selectTracks(own(audio), own(text))
    log("tracks", mapOf("audio" to (audio ?: "-"), "text" to (text ?: "-"), "cause" to cause))
  }

  private fun endRebuffer(t: Long) {
    val since = rebufferSince ?: return
    counters = counters.copy(rebufferMs = counters.rebufferMs + (t - since))
    rebufferSince = null
  }

  // ── Refresh ──

  /** A 401/403 met a source the app already replaced, or the app's answer came. */
  private fun useRefreshedSource() {
    val opening = playWhenReady || pendingLoadId != null
    if (opening || state == PlaybackState.LOADING) {
      if (!isLive && readyForGeneration) rememberPosition()
      reopen("refreshed source")
    } else {
      connectionReleased = true
    }
  }

  private fun armExpiry() {
    val current = source
    val expires = current?.expiresAt
    if (current?.refreshable != true || expires == null) {
      refreshAskAt = null
      return
    }
    val left = expires - clock.wallMs - RecoveryPolicy.REFRESH_AHEAD_MS
    refreshAskAt = now + max(0L, left)
  }

  private fun requestRefresh(reason: RefreshReason, error: PlayerError?) {
    pendingRefresh = PendingRefresh(reason, now + RecoveryPolicy.REFRESH_TIMEOUT_MS, error)
    log("refresh requested", mapOf("reason" to reason.wire))
    delegate?.engineRequestsSourceRefresh(loadId, reason)
  }

  /** The app did not answer in time (JavaScript frozen, a slow token server). */
  private fun refreshTimedOut(refresh: PendingRefresh) {
    pendingRefresh = null
    log("refresh timed out", mapOf("reason" to refresh.reason.wire))
    val error = refresh.error
    if (refresh.reason != RefreshReason.UNAUTHORIZED || error == null) return
    settlePendingLoad(LoadOutcome.Failed(error))
    if (playWhenReady && options.reconnect) {
      // Try the old source again in the backoff; a 401/403 asks again.
      pendingEvents.add { delegate?.engineError(error, false) }
      scheduleReconnect("refresh timed out")
    } else {
      fail(error)
    }
  }

  // ── Video: quality ──

  /** A new source: the renditions and the quality facts start over. */
  private fun resetQuality() {
    videoInfo = null
    variants = emptyList()
    quietSince = now
    quietUpAt = null
    quietUndone = 0
    fallbackActive = false
    fallbackSince = null
    stallTimes = mutableListOf()
    failedUntil.clear()
    bandwidthAt = null
    abrLowSince = null
    abrUpSince = null
    dropSince = null
    returnSince = null
    lastSwitchAt = null
    appliedQuality = null
    // An audio player's renditions are all rungs of one ladder: none is the
    // picture's audio-only fallback.
    val audio = options.video == null
    renditions =
      source?.renditions?.takeIf { it.isNotEmpty() }?.map { it.copy(audioOnly = it.audioOnly && !audio) }?.toMutableList()
    // The app's pick holds from the first byte where this source has it; an
    // adaptive source's variants take it when they are known (onVariants).
    selectedQuality = wantedQuality?.takeIf { renditionIndex(it) != null }
    abrLevel = if (renditions != null) startLevel() else null
    currentRendition = targetRendition()
  }

  /** The quality the status reports as playing. */
  private fun currentQualityId(): String? {
    val table = renditions ?: return videoInfo?.variantId
    return currentRendition?.let { table[it].idAt(it) }
  }

  private fun applyQuality(cause: String) {
    if (source == null) return
    if (renditions != null) {
      retarget(cause)
      return
    }
    if (options.video == null) return
    val c = constraints()
    val key = "${c.maxHeight}|${c.maxBitrate}|${c.pinned}|${c.audioOnly}"
    if (key == appliedQuality) return
    appliedQuality = key
    driver.setQuality(c)
  }

  /** The caps for an adaptive source's ABR (and the allowed renditions). */
  private fun constraints(): QualityConstraints {
    // An audio player has no caps: they are the picture's.
    val q = options.video?.quality ?: return QualityConstraints(null, null, null, false)
    var maxHeight = q.maxHeight
    var maxBitrate = q.maxBitrate
    if (metered) {
      maxHeight = minOf(maxHeight, q.cellularMaxHeight)
      maxBitrate = minOf(maxBitrate, q.cellularMaxBitrate)
    }
    if (saveData && q.followDataSaver) maxHeight = minOf(maxHeight, RecoveryPolicy.DATA_SAVER_MAX_HEIGHT)
    if (q.capToView) maxHeight = minOf(maxHeight, viewCap())
    return QualityConstraints(
      maxHeight = maxHeight,
      maxBitrate = maxBitrate,
      pinned = if (renditions == null) selectedQuality else null,
      audioOnly = audioOnlyReason != null,
    )
  }

  /** The picture height the view can show (contain fit), rounded up; `null`: no cap. */
  private fun viewCap(): Int? {
    // Picture in Picture keeps the quality it started with: no switch (and
    // no rebuffer) on the way in or back for a window that small.
    if (pictureInPicture) return pipCap
    if (!view.attached || view.height <= 0) return null
    val shownHeight = shownHeight(view)
    val table = renditions ?: return STANDARD_HEIGHTS.firstOrNull { it >= shownHeight }
    // The smallest rendition that fills it.
    return table.filter { !it.audioOnly }.mapNotNull { it.height }.filter { it >= shownHeight }.minOrNull()
  }

  /** How many rows of the picture the view shows. */
  private fun shownHeight(view: ViewState): Double {
    val info = videoInfo
    if (info == null || info.width <= 0 || info.height <= 0) return view.height.toDouble()
    if (view.width <= 0) return view.height.toDouble()
    val scale = min(view.width.toDouble() / info.width, view.height.toDouble() / info.height)
    return info.height * scale
  }

  /**
   * The qualities the status lists. An audio player picks among renditions
   * only: an adaptive source's variants are the platform's to switch.
   */
  private fun statusQualities(): List<VideoVariant> =
    if (options.video == null && renditions == null) emptyList() else qualityList()

  /**
   * `load(…, quality)`: the pick for this load and the next (`null`:
   * automatic). Checked before anything changes: an id the source's
   * renditions lack is refused.
   */
  private fun chooseQuality(source: SourceDescriptor, quality: String?) {
    val table = source.renditions
    if (quality != null && !table.isNullOrEmpty() && table.withIndex().none { (i, r) -> r.idAt(i) == quality }) {
      throw PlayerError(ErrorCode.INVALID_ARGUMENT, "No quality \"$quality\".", false)
    }
    wantedQuality = quality
  }

  /** A rendition's index by its id, `null` when there is none. */
  private fun renditionIndex(id: String): Int? =
    renditions?.withIndex()?.firstOrNull { (i, r) -> r.idAt(i) == id }?.index

  private fun qualityList(): List<VideoVariant> {
    val table = renditions ?: return variants
    // Every quality of an audio player is sound alone.
    return table.mapIndexed { i, r -> VideoVariant(r.idAt(i), r.height, r.bitrate, r.audioOnly || options.video == null, r.label) }
  }

  private fun renditionSource(index: Int): SourceDescriptor {
    val current = source!!
    val r = renditions!![index]
    return SourceDescriptor(r.uri, r.headers ?: current.headers, current.liveHint, drm = current.drm)
  }

  /** A rendition's bitrate, or an estimate from its height and a known one. */
  private fun bitrateOf(index: Int): Long? {
    val table = renditions!!
    val r = table[index]
    if (r.bitrate != null) return r.bitrate
    val height = r.height ?: return null
    val known = table.firstOrNull { !it.audioOnly && it.bitrate != null && it.height != null } ?: return null
    val ratio = height.toDouble() / known.height!!
    return Math.round(known.bitrate!! * ratio * ratio)
  }

  /** The video renditions, lowest first. */
  private fun videoOrder(): List<Int> {
    val table = renditions ?: return emptyList()
    return table.indices.filter { !table[it].audioOnly }.sortedWith { a, b -> compareRenditions(a, b) }
  }

  private fun compareRenditions(a: Int, b: Int): Int {
    val ba = bitrateOf(a)
    val bb = bitrateOf(b)
    if (ba != null && bb != null && ba != bb) return ba.compareTo(bb)
    val ha = renditions!![a].height
    val hb = renditions!![b].height
    if (ha != null && hb != null && ha != hb) return ha.compareTo(hb)
    return a.compareTo(b)
  }

  /** The video renditions the caps allow and none failed of, lowest first. */
  private fun allowedOrder(): List<Int> {
    val order = videoOrder()
    if (order.isEmpty()) return order
    val t = now
    val usable = order.filter { (failedUntil[it] ?: 0L) <= t }
    val pool = usable.ifEmpty { order }
    val c = constraints()
    val allowed = pool.filter { withinCaps(it, c) }
    return allowed.ifEmpty { listOf(pool[0]) }
  }

  private fun withinCaps(index: Int, c: QualityConstraints): Boolean {
    val height = renditions!![index].height
    val bitrate = bitrateOf(index)
    if (c.maxHeight != null && height != null && height > c.maxHeight) return false
    return c.maxBitrate == null || bitrate == null || bitrate <= c.maxBitrate
  }

  private fun audioRendition(): Int? {
    val index = renditions?.indexOfFirst { it.audioOnly } ?: -1
    return if (index >= 0) index else null
  }

  /** The highest rendition that fits a bandwidth, among `order` (lowest first). */
  private fun fitting(order: List<Int>, bandwidth: Double): Int? =
    order.lastOrNull { i -> bitrateOf(i)?.let { it <= RecoveryPolicy.ABR_FIT_RATIO * bandwidth } ?: false }

  private fun startLevel(): Int? {
    val order = allowedOrder()
    if (order.isEmpty()) return null
    // An audio player starts at the highest (a sound's bitrates are small)
    // unless a file's bandwidth says otherwise; a live one cannot say.
    val video = options.video ?: return bandwidth?.takeIf { !isLive }?.let { fitting(order, it) ?: order.first() } ?: order.last()
    return when (val start = video.quality.startQuality) {
      StartQuality.Lowest -> order.first()
      StartQuality.Highest -> order.last()
      is StartQuality.Height -> tallestUpTo(order, start.value)
      StartQuality.Auto -> bandwidth?.let { fitting(order, it) ?: order.first() } ?: automaticStart(order)
    }
  }

  /** The tallest rendition no taller than `height`, or the lowest. */
  private fun tallestUpTo(order: List<Int>, height: Int): Int =
    order.lastOrNull { i -> renditions!![i].height?.let { it <= height } ?: false } ?: order.first()

  /** No bandwidth reading yet: the lowest at least 480p (or the tallest under it). */
  private fun automaticStart(order: List<Int>): Int {
    val table: List<Rendition> = renditions!!
    val tall = order.firstOrNull { i -> table[i].height?.let { it >= RecoveryPolicy.START_MIN_HEIGHT } ?: false }
    if (tall != null) return tall
    val allKnown = order.all { table[it].height != null }
    return if (allKnown) order.last() else order.first()
  }

  /** Which rendition should play now. */
  private fun targetRendition(): Int? {
    if (renditions == null) return null
    val audio = audioRendition()
    if (audioOnlyReason != null && audio != null) return audio
    val selected = selectedQuality
    if (selected != null) {
      val index = renditionIndex(selected)!!
      val failed = (failedUntil[index] ?: 0L) > now
      return if (failed) currentRendition else index
    }
    val order = allowedOrder()
    if (order.isEmpty()) return currentRendition
    val level = abrLevel ?: return order.first()
    if (level in order) return level
    // Not allowed any more (caps, a failure): the highest allowed below it.
    val all = videoOrder()
    val position = all.indexOf(level)
    return order.lastOrNull { all.indexOf(it) < position } ?: order.first()
  }

  /** Moves to the target rendition if it changed. */
  private fun retarget(cause: String) {
    val target = targetRendition() ?: return
    val swap = pendingSwap
    if (swap?.rendition == target) return
    if (swap != null) cancelSwap("retarget")
    if (target != currentRendition) moveTo(target, cause)
  }

  private fun moveTo(target: Int, cause: String) {
    val open = readyForGeneration && !connectionReleased
    val flowing = state == PlaybackState.PLAYING || state == PlaybackState.BUFFERING
    // A Cast receiver (or an output like Safari's AirPlay) plays one item: it re-opens in place.
    if (flowing && open && playWhenReady && !remote && !driver.swapsInPlace) return startSwap(target, cause)
    // A switch in place counts as one (the next quiet step up waits again).
    if (target != currentRendition) lastSwitchAt = now
    currentRendition = target
    // Stopped, ended, failed or reconnecting: the next open uses it.
    val reopens = state == PlaybackState.LOADING || (open && (flowing || state == PlaybackState.PAUSED))
    if (!reopens) return
    // A load still opening keeps its start position.
    if (open && !isLive) rememberPosition()
    reopen("quality: $cause")
  }

  private fun startSwap(target: Int, cause: String) {
    val position = if (isLive) null else driver.sample().position
    val generation = issueGeneration()
    pendingSwap = PendingSwap(generation, target, now)
    log("quality switch", mapOf("to" to "r$target", "cause" to cause))
    driver.open(
      OpenRequest(
        generation,
        renditionSource(target),
        position,
        playWhenReady = true,
        allowReconnect = options.reconnect,
        swap = true,
        rendition = target,
      ),
    )
  }

  /**
   * A switch that failed or timed out: its file sits out a while, and the
   * app hears it (non-fatal: the current file plays on). `cause`: the new
   * file's own failure, if it had one.
   */
  private fun dropSwap(swap: PendingSwap, reason: String, cause: PlayerError? = null) {
    failedUntil[swap.rendition] = now + RecoveryPolicy.FAILED_RENDITION_MS
    if (abrLevel == swap.rendition) abrLevel = currentRendition
    cancelSwap(reason)
    val target = renditions!![swap.rendition].idAt(swap.rendition)
    val outcome = if (cause != null) "failed" else "timed out"
    val error =
      PlayerError(
        ErrorCode.QUALITY_SWITCH_FAILED,
        "The switch to quality \"$target\" $outcome; the current one plays on.",
        true,
        // The new file's own failure: its code, then its message.
        causeDescription = if (cause != null) "${cause.code.wire}: ${cause.message}" else reason,
        platformDomain = cause?.platformDomain,
        platformCode = cause?.platformCode,
      )
    pendingEvents.add { delegate?.engineWarning(error) }
  }

  private fun trackBandwidth(t: Long, bps: Double) {
    trackFallbackBandwidth(t, bps)
    if (renditions == null) return
    val level = abrLevel ?: currentRendition
    val bitrate = level?.let { videoBitrateOf(it) }
    abrLowSince = if (bitrate != null && bps < bitrate) abrLowSince ?: t else null
    val next = level?.let { nextAllowed(it) }
    val nextBitrate = next?.let { bitrateOf(it) }
    abrUpSince = if (nextBitrate != null && bps > RecoveryPolicy.ABR_UP_RATIO * nextBitrate) abrUpSince ?: t else null
  }

  /** A video rendition's bitrate (`null` for the audio-only one). */
  private fun videoBitrateOf(index: Int): Long? = if (renditions!![index].audioOnly) null else bitrateOf(index)

  /** The allowed rendition above `index`, if any. */
  private fun nextAllowed(index: Int): Int? {
    val order = allowedOrder()
    val position = order.indexOf(index)
    if (position < 0) return null
    return order.getOrNull(position + 1)
  }

  private fun trackFallbackBandwidth(t: Long, bps: Double) {
    val f = options.video?.fallback ?: return
    val lowest = lowestVideoBitrate() ?: return
    dropSince = if (bps < f.dropBelowRatio * lowest) dropSince ?: t else null
    returnSince = if (bps > f.returnAboveRatio * lowest) returnSince ?: t else null
  }

  private fun lowestVideoBitrate(): Long? {
    if (renditions != null) return videoOrder().firstOrNull()?.let { bitrateOf(it) }
    return variants.filter { !it.audioOnly }.mapNotNull { it.bitrate }.minOrNull()
  }

  private fun hasAudioOption(): Boolean {
    if (renditions != null) return audioRendition() != null
    return variants.any { it.audioOnly }
  }

  private fun stallsWithin(t: Long, windowMs: Long): Int = stallTimes.count { t - it < windowMs }

  /** The bandwidth reading of this load, if it had one. */
  private val currentBandwidth: Double?
    // A live sound arrives at its own bitrate: its reading is no headroom.
    get() = if (options.video == null && isLive) null else if (bandwidthAt != null) bandwidth else null

  /** The engine picks among the renditions itself (none pinned, the picture on). */
  private val automaticRenditions: Boolean
    get() = renditions != null && selectedQuality == null && audioOnlyReason == null

  /** The engine's own ABR over the renditions (automatic quality only). */
  private fun evaluateAbr(t: Long, stalled: Boolean) {
    if (!automaticRenditions) return
    val order = allowedOrder()
    // The engine's pick, whether or not its switch has landed yet.
    val level = abrLevel ?: currentRendition
    if (order.isEmpty() || level == null) return
    val position = max(0, order.indexOf(level))
    val next =
      when {
        stalled -> stallStep(order, position, t)
        options.video == null && currentBandwidth == null -> quietStep(order, position, t)
        else -> bandwidthStep(order, position, t)
      }
    if (next == position && order[position] == abrLevel) return
    // Stalls undid a quiet step up: the next one waits longer.
    val quietUp = quietUpAt
    if (stalled && next < position && quietUp != null) {
      if (t - quietUp < RecoveryPolicy.ABR_QUIET_UP_MS) quietUndone += 1
      quietUpAt = null
    }
    abrLevel = order[next]
    abrLowSince = null
    abrUpSince = null
    retarget(if (stalled) "stall" else "bandwidth")
  }

  /** A stall steps down: to what the bandwidth fits, or one step without a reading. */
  private fun stallStep(order: List<Int>, position: Int, t: Long): Int {
    if (position == 0) return 0
    val bw = currentBandwidth
    val bitrate = bitrateOf(order[position])
    val repeated = stallsWithin(t, RecoveryPolicy.ABR_STALL_WINDOW_MS) >= 2
    val slow = bw != null && bitrate != null && bw < RecoveryPolicy.ABR_STALL_RATIO * bitrate
    if (!repeated && !slow) return position
    if (bw == null) return position - 1
    val fit = fitting(order.subList(0, position), bw)
    return if (fit != null) order.indexOf(fit) else 0
  }

  /**
   * An audio player that measures nothing it can trust steps up one after
   * a quiet while (no stall since the load and the last switch); each step
   * up that stalls undid waits twice as long (at most 8 times).
   */
  private fun quietStep(order: List<Int>, position: Int, t: Long): Int {
    val quiet = RecoveryPolicy.ABR_QUIET_UP_MS shl min(quietUndone, 3)
    if (position >= order.size - 1) return position
    val since = max(lastSwitchAt ?: Long.MIN_VALUE, quietSince)
    if (t - since < quiet || stallsWithin(t, quiet) > 0) return position
    quietUpAt = t
    return position + 1
  }

  /** Sustained low bandwidth steps down; sustained headroom steps up. */
  private fun bandwidthStep(order: List<Int>, position: Int, t: Long): Int {
    val low = abrLowSince
    if (position > 0 && low != null && t - low >= RecoveryPolicy.ABR_LOW_MS) return position - 1
    if (position < order.size - 1 && canStepUp(t)) return position + 1
    return position
  }

  private fun canStepUp(t: Long): Boolean {
    val up = abrUpSince
    if (up == null || t - up < RecoveryPolicy.ABR_UP_MS) return false
    val last = lastSwitchAt
    if (last != null && t - last < RecoveryPolicy.ABR_UP_MS) return false
    return stallsWithin(t, RecoveryPolicy.ABR_UP_MS) == 0
  }

  /** The audio-only fallback (`fallbackToAudio`). */
  private fun evaluateFallback(t: Long, stalled: Boolean) {
    val f = options.video?.fallback ?: return
    if (listenOnly) return
    if (!hasAudioOption()) {
      if (fallbackActive) endFallback("no audio-only option")
      return
    }
    if (fallbackActive) {
      checkFallbackReturn(t, f)
      return
    }
    fallbackCause(t, stalled, f)?.let { startFallback(t, it) }
  }

  /** Why the picture should go now, or `null`. */
  private fun fallbackCause(t: Long, stalled: Boolean, f: FallbackPolicy): String? {
    // The renditions step down first; audio is the step below the lowest.
    if (!atLowestRendition) return null
    val drop = dropSince
    if (drop != null && t - drop >= f.dropAfterMs) return "slow network"
    if (stalled && stallsWithin(t, f.stallWindowMs) >= f.dropAfterStalls) return "stalls"
    return null
  }

  private val atLowestRendition: Boolean
    get() {
      if (renditions == null || selectedQuality != null) return true
      val order = allowedOrder()
      return order.isEmpty() || currentRendition == order[0]
    }

  private fun startFallback(t: Long, cause: String) {
    fallbackActive = true
    fallbackSince = t
    stallTimes = mutableListOf()
    dropSince = null
    returnSince = null
    applyOutput(cause)
  }

  private fun checkFallbackReturn(t: Long, f: FallbackPolicy) {
    val since = fallbackSince ?: t
    val back = returnSince
    if (back != null && t - back >= f.returnAfterMs) {
      endFallback("network recovered")
      return
    }
    // No reading since the drop: try the picture again after a quiet minute.
    val measuredAt = bandwidthAt
    val measured = measuredAt != null && measuredAt >= since
    if (measured || t - since < RecoveryPolicy.FALLBACK_PROBE_MS) return
    if (stallsWithin(t, RecoveryPolicy.FALLBACK_PROBE_MS) == 0) endFallback("probe")
  }

  private fun endFallback(cause: String) {
    fallbackActive = false
    fallbackSince = null
    dropSince = null
    returnSince = null
    stallTimes = mutableListOf()
    applyOutput(cause)
  }

  private fun settlePendingLoad(outcome: LoadOutcome) {
    val id = pendingLoadId ?: return
    pendingLoadId = null
    delegate?.engineLoadSettled(id, outcome)
  }

  private fun setState(next: PlaybackState, cause: String) {
    if (next == state) return
    if (next != PlaybackState.PLAYING) stallPublishAt = null
    val previous = state
    state = next
    stateChanged(next)
    log("transition", mapOf("from" to previous.wire, "to" to next.wire, "cause" to cause))
  }

  private fun log(event: String, details: Map<String, String>) {
    delegate?.engineDiagnostic(DiagnosticEntry(clock.wallMs, generation, state, event, details))
  }

  private fun logStale(event: String, gen: Int) {
    log("stale event dropped", mapOf("event" to event, "eventGeneration" to "$gen"))
  }

  /** Publishes the status (if changed) and the next wake-up instant. */
  private fun commit() {
    val current = status
    if (current != lastPublished) {
      lastPublished = current
      delegate?.engineStatusChanged(current)
    }
    val events = pendingEvents.toList()
    pendingEvents.clear()
    events.forEach { it() }
    delegate?.engineWakeupAt(nextWakeup())
  }

  private fun nextWakeup(): Long? {
    if (released) return null
    val candidates = mutableListOf<Long>()
    pauseReleaseAt?.let { candidates.add(it) }
    stallPublishAt?.let { candidates.add(it) }
    if (state == PlaybackState.RECONNECTING) nextAttemptAt?.let { candidates.add(it) }
    if (heartbeatDue) candidates.add(lastHeartbeatAt + RecoveryPolicy.HEARTBEAT_MS)
    fadeWakeups(candidates)
    videoWakeups(candidates)
    return candidates.minOrNull()
  }
}
