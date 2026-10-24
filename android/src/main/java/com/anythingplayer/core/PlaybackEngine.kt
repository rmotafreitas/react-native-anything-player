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

interface EngineDriver {
  fun open(request: OpenRequest)
  /** Start/resume the current item (latched until the item is ready). */
  fun play()
  fun pause()
  fun seek(seconds: Double)
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
  fun engineDidEnd()
  /** The sleep timer paused the player (`sleep` event). */
  fun engineSleepFired()
  fun engineDiagnostic(entry: DiagnosticEntry)
  /** The engine wants `onWakeup()` at this monotonic instant (`null` = none). */
  fun engineWakeupAt(at: Long?)
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
      if (remote) return false
      return playWhenReady || fadeOutThen != null || (interruption?.resumable ?: false)
    }

  /** Native observations for any other generation are stale and must be dropped. */
  fun accepts(generation: Int): Boolean = !released && generation == this.generation

  // ── Commands ──

  fun load(newSource: SourceDescriptor, autoplay: Boolean?, startPosition: Double?) {
    ensureAlive()
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
    generation += 1
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

  fun seek(seconds: Double) {
    ensureAlive()
    if (source == null) throw PlayerError(ErrorCode.NO_SOURCE, "No source loaded.", false)
    if (!seekable || isLive) throw PlayerError(ErrorCode.NOT_SEEKABLE, "This source is not seekable.", false)
    if (!seconds.isFinite() || seconds < 0) {
      throw PlayerError(ErrorCode.INVALID_ARGUMENT, "Seek position must be a finite number ≥ 0.", false)
    }
    val target = duration?.let { min(seconds, it) } ?: seconds
    resumePosition = target
    lastPosition = target
    lastPositionAdvanceAt = now
    if (state == PlaybackState.ENDED) setState(PlaybackState.PAUSED, "seek after end")
    if (connectionReleased || state == PlaybackState.STOPPED || state == PlaybackState.ERROR) {
      commit()
      return
    }
    driver.seek(target)
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
    muted = value
    applyVolume()
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
      generation += 1
      readyForGeneration = false
      if (source != null) connectionReleased = true
    }
    commit()
  }

  // ── Native observations (generation-guarded) ──

  fun onReady(generation: Int, info: ReadyInfo) {
    if (!accepts(generation)) return logStale("ready", generation)
    duration = info.duration
    isLive = source?.liveHint ?: info.isLive
    seekable = info.seekable && !isLive
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
    if (released || !autoReconnect || remote) return
    if (state == PlaybackState.RECONNECTING || state == PlaybackState.BUFFERING || state == PlaybackState.LOADING) {
      attemptReconnect("app foregrounded")
    }
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

  // ── Clock ──

  fun onWakeup() {
    if (released) return
    val t = now
    releasePausedConnectionIfDue(t)
    publishStallIfDue(t)
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
    if (remote) FocusResult.GRANTED else delegate?.engineRequestsAudioFocus() ?: FocusResult.GRANTED

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
    generation += 1
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
    driver.open(OpenRequest(generation, source, startPosition, playWhenReady, allowReconnect = options.reconnect))
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
    lastBuffered = driver.sample().bufferedPosition
  }

  private fun handleFailure(error: PlayerError) {
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
    generation += 1
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
      PlaybackState.PLAYING -> heartbeatPlaying(t, suspect)
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
    if (sample.bufferedPosition > lastBuffered + 0.01) {
      lastBuffered = sample.bufferedPosition
      lastBufferedAdvanceAt = t
    }
    val stalled = stallStartedAt ?: return
    if (network == NetworkState.OFFLINE) {
      if (t - lastBufferedAdvanceAt >= RecoveryPolicy.STALL_DEAD_MS) {
        if (!options.reconnect) return failStall("offline")
        if (recoveringSince == null) recoveringSince = stalled
        scheduleReconnect("offline")
      }
      return
    }
    val deadLimit = if (suspect) RecoveryPolicy.SUSPECT_STALL_DEAD_MS else RecoveryPolicy.STALL_DEAD_MS
    when {
      t - lastBufferedAdvanceAt >= deadLimit -> recoverStall("stalled ${t - stalled}ms with no data")
      t - stalled >= RecoveryPolicy.STALL_MAX_MS -> recoverStall("stalled ${t - stalled}ms")
      isLive && driftMs + (t - stalled) >= options.liveMaxDriftMs -> recoverStall("live drift during stall")
    }
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
    if (options.reconnect) attemptReconnect(reason) else failStall(reason)
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
    return candidates.minOrNull()
  }
}
