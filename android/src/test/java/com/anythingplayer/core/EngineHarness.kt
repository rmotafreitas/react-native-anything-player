package com.anythingplayer.core

import java.util.Locale

/** The fake wall clock reads this at monotonic 0. */
const val WALL_BASE = 1_700_000_000_000L

/** Deterministic clock: time only moves when a test advances it. */
class FakeClock : EngineClock {
  override var monotonicMs: Long = 0
  override val wallMs: Long
    get() = WALL_BASE + monotonicMs
}

/** Records every driver call and simulates a playhead. */
class FakeDriver(private val clock: FakeClock) : EngineDriver {
  /** `LOADED`: the whole file is buffered: the playhead advances, the buffer stays where it is. */
  enum class Motion { FLOWING, FROZEN, TRICKLE, LOADED }

  val commands = mutableListOf<String>()
  /** Like ExoPlayer: report readiness/playing synchronously from inside commands. */
  var reentrant = false
  var engine: PlaybackEngine? = null
  private var openGeneration = 0
  private var motion = Motion.FROZEN
  private var anchorTime = 0L
  private var anchorPosition = 0.0
  private var anchorBuffered = 0.0
  /** The item an `open(swap = true)` is preparing, and where it starts. */
  var swapGeneration: Int? = null
    private set
  private var swapStart = 0.0

  fun setMotion(next: Motion, buffered: Double? = null) {
    val current = sample()
    anchorPosition = current.position
    anchorBuffered = buffered ?: current.bufferedPosition
    anchorTime = clock.monotonicMs
    motion = next
    if (next == Motion.FLOWING) anchorBuffered = maxOf(anchorBuffered, anchorPosition + 10)
  }

  fun setPosition(value: Double) {
    val current = sample()
    anchorBuffered = maxOf(current.bufferedPosition, value)
    anchorPosition = value
    anchorTime = clock.monotonicMs
  }

  override fun sample(): PlaybackSample {
    val elapsed = (clock.monotonicMs - anchorTime) / 1000.0
    return when (motion) {
      Motion.FLOWING -> PlaybackSample(anchorPosition + elapsed, anchorBuffered + elapsed)
      Motion.FROZEN -> PlaybackSample(anchorPosition, anchorBuffered)
      Motion.TRICKLE -> PlaybackSample(anchorPosition, anchorBuffered + elapsed * 0.5)
      Motion.LOADED -> PlaybackSample(anchorPosition + elapsed, anchorBuffered)
    }
  }

  private fun f1(v: Double) = String.format(Locale.US, "%.1f", v)
  private fun f2(v: Double) = String.format(Locale.US, "%.2f", v)

  override fun open(request: OpenRequest) {
    val start = request.startPosition?.let(::f1) ?: "-"
    val rendition = request.rendition?.let { ",r=$it" } ?: ""
    val swap = if (request.swap) ",swap" else ""
    commands.add("open(gen=${request.generation},start=$start,play=${request.playWhenReady}$rendition$swap)")
    if (request.swap) {
      // Prepared behind the current item: its playhead is not this one's.
      swapGeneration = request.generation
      swapStart = request.startPosition ?: 0.0
      return
    }
    swapGeneration = null
    anchorPosition = request.startPosition ?: 0.0
    anchorBuffered = anchorPosition
    anchorTime = clock.monotonicMs
    motion = Motion.FROZEN
    openGeneration = request.generation
    if (reentrant && request.playWhenReady) {
      engine?.onReady(request.generation, ReadyInfo(30.0, false, true))
      setMotion(Motion.FLOWING)
      engine?.onPlaying(request.generation)
    }
  }
  override fun play() {
    commands.add("play")
    if (reentrant) {
      setMotion(Motion.FLOWING)
      engine?.onPlaying(openGeneration)
    }
  }
  override fun pause() { commands.add("pause") }
  override fun seek(seconds: Double) = seek(seconds, false)
  override fun seek(seconds: Double, exact: Boolean) {
    commands.add("seek(${f1(seconds)}${if (exact) ",exact" else ""})")
    setPosition(seconds)
  }
  override fun setVideoEnabled(enabled: Boolean) { commands.add("video(${if (enabled) "on" else "off"})") }
  override fun setQuality(constraints: QualityConstraints) {
    val c = constraints
    commands.add(
      "quality(maxH=${c.maxHeight ?: "-"},maxBps=${c.maxBitrate ?: "-"},pin=${c.pinned ?: "-"},audioOnly=${c.audioOnly})",
    )
  }
  override fun setLoop(loop: Boolean) { commands.add("loop($loop)") }
  override fun selectTracks(audio: String?, text: String?) { commands.add("tracks(audio=${audio ?: "-"},text=${text ?: "-"})") }
  override fun cancelSwap(generation: Int) {
    commands.add("cancelSwap(gen=$generation)")
    if (swapGeneration == generation) swapGeneration = null
  }

  /** The swap's item shows its first frame: its playhead becomes the one. */
  fun completeSwap() {
    swapGeneration = null
    anchorPosition = swapStart
    anchorBuffered = swapStart + 10
    anchorTime = clock.monotonicMs
    motion = Motion.FLOWING
  }
  override fun releaseConnection() { commands.add("release") }
  override fun unload() { commands.add("unload") }
  override fun setVolume(effective: Double) { commands.add("volume(${f2(effective)})") }
  override fun setRate(rate: Double) { commands.add("rate(${f2(rate)})") }
  override fun switchOutput(outputId: String) {
    commands.add("switchOutput($outputId)")
    // The playhead stops where it is; the engine re-opens at a position.
    setMotion(Motion.FROZEN)
  }
}

/** Collects everything the engine reports. */
class Recorder : EngineDelegate {
  var focus = FocusResult.GRANTED
  val statuses = mutableListOf<Status>()
  val loads = mutableListOf<String>()
  val errors = mutableListOf<String>()
  var ended = 0
  /** Sleep timers that fired. */
  var sleeps = 0
  /** `fadeTo` calls that settled. */
  var fades = 0
  val diagnostics = mutableListOf<DiagnosticEntry>()
  var wakeupAt: Long? = null
  /** Source refreshes asked for, `loadId:reason`. */
  val refreshes = mutableListOf<String>()
  /** Ordering invariant breaches (an event delivered before its status). */
  val violations = mutableListOf<String>()

  override fun engineRequestsAudioFocus() = focus
  override fun engineStatusChanged(status: Status) { statuses.add(status) }
  override fun engineLoadSettled(loadId: Int, outcome: LoadOutcome) {
    loads.add(
      when (outcome) {
        is LoadOutcome.Ready -> "$loadId:ready"
        is LoadOutcome.Superseded -> "$loadId:superseded"
        is LoadOutcome.Failed -> "$loadId:failed:${outcome.error.code.wire}"
      }
    )
  }
  override fun engineError(error: PlayerError, fatal: Boolean) {
    if (fatal && statuses.lastOrNull()?.state != PlaybackState.ERROR) violations.add("fatal error before error status")
    if (!fatal && statuses.lastOrNull()?.state != PlaybackState.RECONNECTING) violations.add("recoverable error before reconnecting status")
    errors.add("${error.code.wire}:${if (fatal) "fatal" else "recoverable"}")
  }
  override fun engineDidEnd() {
    if (statuses.lastOrNull()?.state != PlaybackState.ENDED) violations.add("ended before ended status")
    ended += 1
  }
  override fun engineSleepFired() {
    when (val last = statuses.lastOrNull()) {
      null -> violations.add("sleep event before its status")
      else -> {
        if (last.sleepAt != null) violations.add("sleep event before its status")
        // The timer always leaves the player paused: a playing player is
        // paused, and a paused one stays paused, so `playWhenReady` is false.
        if (last.playWhenReady) violations.add("sleep event while playWhenReady")
      }
    }
    sleeps += 1
  }
  override fun engineDiagnostic(entry: DiagnosticEntry) { diagnostics.add(entry) }
  override fun engineWakeupAt(at: Long?) { wakeupAt = at }
  override fun engineRequestsSourceRefresh(loadId: Int, reason: RefreshReason) { refreshes.add("$loadId:${reason.wire}") }
}

/** Engine + fakes wired together, with a clock that fires wake-ups in order. */
class EngineHarness(options: EngineOptions = EngineOptions()) {
  val clock = FakeClock()
  val driver = FakeDriver(clock)
  val recorder = Recorder()
  val engine = PlaybackEngine(driver, clock, options) { 0.5 }

  init {
    engine.delegate = recorder
    driver.engine = engine
  }

  fun advance(ms: Long) {
    val target = clock.monotonicMs + ms
    var guard = 0
    while (true) {
      val wake = recorder.wakeupAt ?: break
      if (wake > target) break
      guard += 1
      check(guard < 100_000) { "wake-up loop" }
      clock.monotonicMs = maxOf(clock.monotonicMs, wake)
      engine.onWakeup()
    }
    clock.monotonicMs = target
  }
}
