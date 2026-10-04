package com.radioanimu.airwave.core

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
  /** Effective output volume (volume × mute × duck), 0..1. */
  fun setVolume(effective: Double)
  fun setRate(rate: Double)
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
  private var lastNetworkEdgeAt = Long.MIN_VALUE
  private var suspectUntil = Long.MIN_VALUE
  private var pauseReleaseAt: Long? = null
  private var connectionReleased = false
  private var resumePosition: Double? = null
  private var lastHeartbeatAt = 0L
  private var lastPublished: Status? = null
  /** Discrete events wait until the status they imply was published. */
  private val pendingEvents = mutableListOf<() -> Unit>()

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
      )
    }

  /** Playback wanted but no audio rendered (see the iOS keepalive). */
  val wantsKeepalive: Boolean
    get() =
      playWhenReady &&
        (state == PlaybackState.LOADING || state == PlaybackState.BUFFERING || state == PlaybackState.RECONNECTING)

  /** Whether the player holds (or may soon re-take) audio focus. */
  val needsAudioFocus: Boolean
    get() = playWhenReady || (interruption?.resumable ?: false)

  /** Native observations for any other generation are stale and must be dropped. */
  fun accepts(generation: Int): Boolean = !released && generation == this.generation

  // ── Commands ──

  fun load(newSource: SourceDescriptor, autoplay: Boolean?, startPosition: Double?) {
    ensureAlive()
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
    if (wanted) applyFocus(delegate?.engineRequestsAudioFocus() ?: FocusResult.GRANTED)
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
    when (delegate?.engineRequestsAudioFocus() ?: FocusResult.GRANTED) {
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
    val hadInterruption = interruption != null
    interruption = null
    if (!playWhenReady) {
      if (hadInterruption) log("pause", mapOf("note" to "cancels system resume"))
      commit()
      return
    }
    playWhenReady = false
    pauseIntent("pause")
    commit()
  }

  fun stop() {
    ensureAlive()
    if (source == null) return
    settlePendingLoad(LoadOutcome.Superseded)
    playWhenReady = false
    interruption = null
    resetRecovery()
    pauseReleaseAt = null
    stallStartedAt = null
    pausedAt = null
    driver.releaseConnection()
    connectionReleased = true
    resumePosition = if (isLive) null else 0.0
    setState(PlaybackState.STOPPED, "stop")
    commit()
  }

  fun reset() {
    ensureAlive()
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
    volume = value.coerceIn(0.0, 1.0)
    applyVolume()
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
    applyVolume()
  }

  fun release() {
    if (released) return
    settlePendingLoad(LoadOutcome.Failed(PlayerError(ErrorCode.PLAYER_RELEASED, "The player was released.", false)))
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
    lastOpenAt = null
    nextAttemptAt = null
    lastPosition = driver.sample().position
    lastPositionAdvanceAt = t
    playingSince = t
    // Drift is only enforced at moments that are silent anyway (resuming from a
    // pause, or during a published stall), never by cutting audio that resumed.
    setState(PlaybackState.PLAYING, "audio flowing")
    commit()
  }

  /** Playback wanted, waiting for data. */
  fun onBuffering(generation: Int) {
    if (!accepts(generation)) return logStale("buffering", generation)
    if (state == PlaybackState.PLAYING && stallPublishAt == null) {
      stallStartedAt = now
      stallPublishAt = now + RecoveryPolicy.STALL_DEBOUNCE_MS
      playingSince = null
    }
    commit()
  }

  fun onFailed(generation: Int, error: PlayerError) {
    if (!accepts(generation)) return logStale("failed", generation)
    handleFailure(error)
    commit()
  }

  fun onEnded(generation: Int) {
    if (!accepts(generation)) return logStale("ended", generation)
    if (isLive || duration == null) {
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
    if (!playWhenReady) return
    interruptionBegan(reason, false)
  }

  // ── System events ──

  fun interruptionBegan(reason: InterruptionReason, resumable: Boolean) {
    if (released) return
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
    val t = now
    if (previous == NetworkState.ONLINE && next == NetworkState.OFFLINE) {
      markNetworkEdge(t)
      log("network lost", emptyMap())
    } else if (previous == NetworkState.OFFLINE && next == NetworkState.ONLINE) {
      // (`unknown` → `online` is the first reading: a baseline, not an edge.)
      markNetworkEdge(t)
      backoff.reset()
      offlineSkips = 0
      log("network restored", emptyMap())
      if (playWhenReady && state != PlaybackState.PLAYING) attemptReconnect("network restored")
    } else if (previous == NetworkState.ONLINE && next == NetworkState.ONLINE && interfaceChanged) {
      markNetworkEdge(t)
      log("network handoff", emptyMap())
      if (playWhenReady && (state == PlaybackState.BUFFERING || state == PlaybackState.RECONNECTING)) {
        attemptReconnect("network handoff")
      }
    }
    commit()
  }

  /** The app came to the foreground: recover wanted-but-silent audio now. */
  fun appForegrounded() {
    if (released || !playWhenReady) return
    if (state == PlaybackState.RECONNECTING || state == PlaybackState.BUFFERING || state == PlaybackState.LOADING) {
      attemptReconnect("app foregrounded")
    }
    commit()
  }

  /** The platform media stack was reset; the driver has been rebuilt. */
  fun platformReset() {
    if (released || source == null || state == PlaybackState.IDLE) return
    log("platform reset", emptyMap())
    if (state == PlaybackState.STOPPED || state == PlaybackState.ENDED || state == PlaybackState.ERROR) {
      connectionReleased = true
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
    pauseReleaseAt?.let { due ->
      if (due <= t) {
        pauseReleaseAt = null
        if (state == PlaybackState.PAUSED && !playWhenReady && !connectionReleased) {
          driver.releaseConnection()
          connectionReleased = true
          log("paused stream released", emptyMap())
        }
      }
    }
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
    if (state == PlaybackState.RECONNECTING) {
      val due = nextAttemptAt
      if (due != null && due <= t) {
        nextAttemptAt = null
        attemptReconnect("backoff elapsed")
      }
    }
    if (playWhenReady && t - lastHeartbeatAt >= RecoveryPolicy.HEARTBEAT_MS - 50) {
      lastHeartbeatAt = t
      heartbeat(t)
    }
    commit()
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
      PlaybackState.ENDED -> {
        resumePosition = 0.0
        setState(PlaybackState.BUFFERING, "$cause: restart")
        beginWaiting()
        driver.seek(0.0)
        driver.play()
      }
      PlaybackState.BUFFERING, PlaybackState.PLAYING, PlaybackState.RECONNECTING -> Unit
    }
  }

  private fun pauseIntent(cause: String) {
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
    connectionReleased = false
    stallStartedAt = null
    pausedAt = null
    playingSince = null
    driftMs = 0
    pauseReleaseAt = null
    lastOpenAt = now
    lastPosition = startPosition ?: 0.0
    lastBuffered = 0.0
    lastBufferedAdvanceAt = now
    lastPositionAdvanceAt = now
    lastHeartbeatAt = now
    setState(PlaybackState.LOADING, reason)
    driver.open(OpenRequest(generation, source, startPosition, playWhenReady))
  }

  private fun reopen(reason: String, startPosition: Double? = null) {
    val position = if (isLive) null else (startPosition ?: resumePosition ?: currentPositionEstimate())
    log("reopen", mapOf("reason" to reason))
    open(position, reason)
  }

  private fun currentPositionEstimate(): Double? =
    if (isLive) null else if (lastPosition > 0) lastPosition else null

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
    driver.releaseConnection()
    connectionReleased = true
    setState(PlaybackState.ERROR, error.code.wire)
    pendingEvents.add { delegate?.engineError(error, true) }
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
      return opened > lastNetworkEdgeAt && now - opened < RecoveryPolicy.OPEN_GRACE_MS
    }

  private fun attemptReconnect(reason: String) {
    if (!playWhenReady || source == null) return
    if (openInFlight) {
      log("reconnect skipped", mapOf("reason" to reason, "note" to "open in flight"))
      return
    }
    if (recoveringSince == null) recoveringSince = now
    if (network == NetworkState.OFFLINE && offlineSkips < RecoveryPolicy.OFFLINE_PROBE_EVERY) {
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
        val sample = driver.sample()
        if (!isLive) resumePosition = sample.position
        if (sample.position > lastPosition + 0.05 || sample.position < lastPosition - 0.5) {
          lastPosition = sample.position
          lastPositionAdvanceAt = t
        } else {
          val stallLimit = if (suspect) RecoveryPolicy.SUSPECT_SILENT_STALL_MS else RecoveryPolicy.SILENT_STALL_MS
          if (t - lastPositionAdvanceAt >= stallLimit && rate > 0) {
            log("silent stall", mapOf("frozenMs" to "${t - lastPositionAdvanceAt}"))
            setState(PlaybackState.BUFFERING, "silent stall")
            beginWaiting()
            stallStartedAt = lastPositionAdvanceAt
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
      PlaybackState.BUFFERING -> {
        val sample = driver.sample()
        if (sample.bufferedPosition > lastBuffered + 0.01) {
          lastBuffered = sample.bufferedPosition
          lastBufferedAdvanceAt = t
        }
        val stalled = stallStartedAt ?: return
        if (network == NetworkState.OFFLINE) {
          if (t - lastBufferedAdvanceAt >= RecoveryPolicy.STALL_DEAD_MS) {
            if (recoveringSince == null) recoveringSince = stalled
            scheduleReconnect("offline")
          }
          return
        }
        val deadLimit = if (suspect) RecoveryPolicy.SUSPECT_STALL_DEAD_MS else RecoveryPolicy.STALL_DEAD_MS
        if (t - lastBufferedAdvanceAt >= deadLimit) {
          attemptReconnect("stalled ${t - stalled}ms with no data")
        } else if (t - stalled >= RecoveryPolicy.STALL_MAX_MS) {
          attemptReconnect("stalled ${t - stalled}ms")
        } else if (isLive && driftMs + (t - stalled) >= options.liveMaxDriftMs) {
          attemptReconnect("live drift during stall")
        }
      }
      else -> Unit
    }
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
    lastNetworkEdgeAt = t
    suspectUntil = t + RecoveryPolicy.NETWORK_SUSPECT_MS
  }

  private fun applyVolume() {
    driver.setVolume(if (muted) 0.0 else volume * duckFactor)
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
    if (playWhenReady) candidates.add(lastHeartbeatAt + RecoveryPolicy.HEARTBEAT_MS)
    return candidates.minOrNull()
  }
}
