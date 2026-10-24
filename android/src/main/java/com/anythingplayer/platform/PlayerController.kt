package com.anythingplayer.platform

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.anythingplayer.core.AudioRoute
import com.anythingplayer.core.AudioRouteKind
import com.anythingplayer.core.DiagnosticEntry
import com.anythingplayer.core.EngineClock
import com.anythingplayer.core.EngineDelegate
import com.anythingplayer.core.EngineStats
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.FocusResult
import com.anythingplayer.core.InterruptionReason
import com.anythingplayer.core.LoadOutcome
import com.anythingplayer.core.PlaybackEngine
import com.anythingplayer.core.PlayerError
import com.anythingplayer.core.ReadyInfo
import com.anythingplayer.core.SourceDescriptor
import com.anythingplayer.core.RefreshReason
import com.anythingplayer.core.Status
import com.anythingplayer.core.StreamMetadata
import com.anythingplayer.core.TrackClock
import com.anythingplayer.core.PlaybackState
import com.anythingplayer.core.MediaTrack
import com.anythingplayer.core.VideoInfo
import com.anythingplayer.core.VideoVariant

/**
 * Where events go: the TurboModule's `onPlayerEvent` emitter. The runtime holds
 * the current one (see [AnythingPlayerRuntime.attachModule]), so a player
 * outlives the JS that created it.
 */
internal fun interface EventSink {
  fun emit(event: WritableMap)
}

/** The activity React Native runs in (dialogs and Picture in Picture need one). */
internal fun interface ActivitySource {
  fun current(): android.app.Activity?
}

/** Settles a `load()`; called on the main thread once the engine decided. */
internal fun interface LoadCompletion {
  fun settled(outcome: LoadOutcome)
}

internal object AndroidClock : EngineClock {
  override val monotonicMs: Long
    get() = SystemClock.elapsedRealtime()
  override val wallMs: Long
    get() = System.currentTimeMillis()
}

private const val TAG = "RNAP"
private const val DIAGNOSTICS_CAPACITY = 300

/**
 * One player: the engine, its ExoPlayer driver and everything that crosses to
 * JS. Engine and driver run on the main thread; the `@Volatile` snapshots are
 * what the synchronous JS getters read from the JS thread.
 */
internal class PlayerController(
  val id: String,
  context: Context,
  val options: PlayerOptions,
  private val runtime: AnythingPlayerRuntime,
  /**
   * The app chose this id (`PlayerOptions.id`): the player outlives a JS
   * reload and a new `Player({ id })` attaches to it.
   */
  val appId: Boolean = false,
) : EngineDelegate, DriverObserver, CastTarget {
  private val handler = Handler(Looper.getMainLooper())
  private val appContext = context.applicationContext
  /** `audioSample` windows: on, and how many points (applied to every ExoPlayer, also a quality switch's). */
  private var sampling = false
  private var samplingPoints = 0
  /** A video player's picture side (`null`: an audio player). */
  val picture: VideoPicture? =
    if (options.engine.video == null) null
    else VideoSupport.create(appContext, this) { observer ->
      ExoPlayerDriver(appContext, options.speech, options.titleFormat, observer, video = true).also {
        if (sampling) configureSampler(it)
      }
    }
  private val audioDriver: ExoPlayerDriver? =
    if (picture == null) ExoPlayerDriver(context, options.speech, options.titleFormat, this) else null
  /** The ExoPlayer the audio (and the picture) plays from now. */
  private val localDriver: ExoPlayerDriver
    get() = picture?.primary ?: audioDriver!!
  private val driver = RoutingDriver(picture?.output ?: audioDriver!!) { runtime.newRemoteOutput(this) }
  val engine = PlaybackEngine(driver, AndroidClock, options.engine)

  private var eventSeq = 0L
  @Volatile private var statusSnapshot: Pair<Status, Long> = Status() to 0L
  @Volatile private var progressSnapshot =
    ProgressSnapshot(ProgressReading(0.0, 0.0, null, null, false, 1.0), AndroidClock.monotonicMs, AndroidClock.wallMs)
  @Volatile var streamMetadata: StreamMetadata? = null
    private set
  @Volatile private var streamMetadataAt = 0L
  @Volatile var diagnosticsEnabled = false
  private val diagnostics = ArrayDeque<DiagnosticEntry>()

  private var sourceFields = NowPlayingFields()
  private var overrides = NowPlayingFields()
  /** Song progress set by the app (`updateNowPlaying` with a duration). */
  private var trackClock: TrackClock? = null
  private val pendingLoads = HashMap<Int, LoadCompletion>()
  private var released = false
  val isReleased: Boolean
    get() = released

  private val wakeup = Runnable { engine.onWakeup() }

  /**
   * `progress` events while playing (`progressInterval`). A native timer: it
   * runs JS even while the app's JS timers are frozen (Android background).
   */
  private var progressTicking = false
  private val progressTick =
    object : Runnable {
      override fun run() {
        if (released || !progressTicking) return
        progressSnapshot = ProgressSnapshot(driver.progress(), AndroidClock.monotonicMs, AndroidClock.wallMs)
        emit("progress", progressMap())
        handler.postDelayed(this, options.progressIntervalMs)
      }
    }

  private fun updateProgressTicks(state: PlaybackState) {
    val wanted = options.progressIntervalMs > 0 && state == PlaybackState.PLAYING && !released
    if (wanted == progressTicking) return
    progressTicking = wanted
    handler.removeCallbacks(progressTick)
    if (wanted) handler.post(progressTick)
  }

  init {
    engine.delegate = this
    // JS reads the status right after creating the player, before the engine
    // published one: a video player's starts with its `video` part.
    statusSnapshot = engine.status to 0L
  }

  val status: Status
    get() = statusSnapshot.first

  // ── Commands (main thread) ──

  fun load(
    source: SourceDescriptor,
    fields: NowPlayingFields,
    autoplay: Boolean?,
    start: Double?,
    parts: VideoLoadParts? = null,
    completion: LoadCompletion? = null,
  ) {
    runtime.beforeLoad(this, source.isNetwork)
    sourceFields = fields
    overrides = NowPlayingFields()
    trackClock = null
    streamMetadata = null
    lastBandwidth = null
    picture?.load(parts ?: VideoLoadParts())
    engine.load(source, autoplay, start)
    // The app's subtitle files are tracks from the start (their cues follow).
    if (picture != null && parts != null && parts.subtitles.isNotEmpty()) engine.setAppTracks(parts.subtitles)
    // `load` settles synchronously only when it supersedes; this load is pending.
    if (completion != null) pendingLoads[engine.loadId] = completion
    runtime.onNowPlayingChanged(this)
  }

  /** Main thread. Builds the native player once the main looper is idle. */
  fun prewarm() {
    Looper.myQueue().addIdleHandler {
      if (!released) localDriver.prewarm()
      false
    }
  }

  fun updateNowPlaying(fields: NowPlayingFields) {
    overrides = fields
    trackClock = fields.duration?.let {
      TrackClock(fields.elapsed ?: 0.0, it, AndroidClock.monotonicMs, statusSnapshot.first.state == PlaybackState.PLAYING)
    }
    runtime.onNowPlayingChanged(this)
  }

  fun release() {
    if (released) return
    released = true
    stopTitleReader()
    drivers.forEach {
      it.sampler.enabled = false
      it.sampler.onWindow = null
    }
    handler.removeCallbacks(wakeup)
    progressTicking = false
    handler.removeCallbacks(progressTick)
    engine.release()
    driver.destroyRemote()
    picture?.destroy() ?: audioDriver?.destroy()
    pendingLoads.clear()
  }

  // ── Snapshots (any thread) ──

  fun statusMap(): WritableMap {
    val (status, seq) = statusSnapshot
    return statusToMap(status, seq)
  }

  fun progressMap(): WritableMap = progressToMap(progressSnapshot, AndroidClock.monotonicMs, AndroidClock.wallMs)

  fun progress(): ProgressSnapshot = progressSnapshot

  /** The output's reading now (main thread): the subtitles and the controls follow it. */
  fun currentProgress(): ProgressReading = driver.progress()

  fun metadataMap(): WritableMap =
    Arguments.createMap().apply {
      val meta = streamMetadata
      if (meta == null) putNull("metadata") else putMap("metadata", metadataToMap(meta, streamMetadataAt))
    }

  fun diagnosticsArray() =
    Arguments.createArray().apply { synchronized(diagnostics) { diagnostics.forEach { pushMap(diagnosticToMap(it)) } } }

  /** Lock-screen fields: app overrides > stream metadata > source metadata. */
  fun nowPlaying(): NowPlaying {
    val stream = if (options.useStreamMetadata) streamMetadata else null
    return NowPlaying(
      title = overrides.title ?: stream?.title ?: sourceFields.title,
      artist = overrides.artist ?: stream?.artist ?: sourceFields.artist,
      album = overrides.album ?: stream?.album ?: sourceFields.album ?: stream?.station,
      artwork = overrides.artwork ?: stream?.artworkUri ?: sourceFields.artwork,
      track = trackClock?.let {
        val now = AndroidClock.monotonicMs
        TrackProgress(it.duration, it.elapsed(now), now)
      },
      live = overrides.live ?: sourceFields.live,
    )
  }

  /** A player event with a payload of its own (`searchPlay`), ordered like every other. */
  fun emitEvent(type: String, payload: WritableMap) = emit(type, payload)

  /** A second `Player({ id })` found this player running and attached to it. */
  fun noteAttach() =
    engineDiagnostic(DiagnosticEntry(AndroidClock.wallMs, engine.generation, engine.state, "attach (options ignored)", emptyMap()))

  /** Forwards a remote command (lock screen, headset, car) the app opted into. */
  fun emitRemoteCommand(command: String, position: Double? = null) {
    emit(
      "remoteCommand",
      Arguments.createMap().apply {
        putString("command", command)
        position?.let { putDouble("position", it) }
      },
    )
  }

  /**
   * Decoded-audio windows as `audioSample` events. Emitted straight from the
   * playback thread (no main-thread hop at ~40–100 Hz) and outside the status
   * sequence: a sample is a stream, never a state to order.
   */
  fun setAudioSampling(enabled: Boolean, points: Int) {
    sampling = enabled
    samplingPoints = points
    drivers.forEach { configureSampler(it) }
  }

  /** Every ExoPlayer: the audio player's one, or a video player's two. */
  private val drivers: List<ExoPlayerDriver>
    get() = picture?.drivers ?: listOfNotNull(audioDriver)

  private fun configureSampler(source: ExoPlayerDriver) {
    val sampler = source.sampler
    sampler.points = samplingPoints
    sampler.onWindow =
      if (!sampling) null
      else { window ->
        // A quality switch's ExoPlayer plays muted until it takes over: only the one heard counts.
        if (!released && source === localDriver) {
          val waveform = Arguments.createArray()
          window.waveform.forEach { waveform.pushDouble(it.toDouble()) }
          runtime.emit(
            Arguments.createMap().apply {
              putString("playerId", id)
              putString("type", "audioSample")
              putArray("waveform", waveform)
              putDouble("level", window.level)
              putDouble("duration", window.durationSeconds)
              putDouble("outputLatency", window.outputLatencySeconds)
              putDouble("timestamp", window.timestampMs.toDouble())
            }
          )
        }
      }
    sampler.enabled = sampling
  }

  private fun emit(type: String, payload: WritableMap) {
    if (released && type != "status") return
    eventSeq += 1
    payload.putString("playerId", id)
    payload.putString("type", type)
    payload.putDouble("seq", eventSeq.toDouble())
    runtime.emit(payload)
  }

  // ── EngineDelegate (main thread) ──

  override fun engineRequestsAudioFocus(): FocusResult = runtime.requestFocus(this)

  override fun engineStatusChanged(status: Status) {
    eventSeq += 1
    statusSnapshot = status to eventSeq
    val event = statusToMap(status, eventSeq)
    event.putString("playerId", id)
    event.putString("type", "status")
    runtime.emit(event)
    updateTitleReader(status)
    // The song advances with the audio, not the wall clock.
    trackClock?.setRunning(status.state == PlaybackState.PLAYING, AndroidClock.monotonicMs)
    updateProgressTicks(status.state)
    picture?.statusChanged(status)
    runtime.onStatusChanged(this)
  }

  // ── Cast ──

  override val castableSource: Boolean?
    get() = engine.source?.isNetwork

  override fun handoff(route: AudioRoute, outputId: String, resume: Boolean) = engine.handoff(route, outputId, resume)

  override fun castRefused() =
    engineError(
      PlayerError(
        ErrorCode.CAST_UNSUPPORTED_SOURCE,
        "A Cast receiver can only play http(s) sources; local files, content:// URIs and bundled assets stay on this device.",
        false,
      ),
      fatal = false,
    )

  /**
   * While a live stream plays on a Cast receiver, the phone reads its ICY
   * titles on a connection of its own (the receiver's connection is not ours
   * to read). Runs for the current load only, and only while playback is
   * wanted; the audio it downloads is discarded.
   */
  private var titleReader: IcyMetadataReader? = null
  private var titleReaderLoad = -1

  /** Whether the title reader is running (it needs the CPU awake). */
  val readsTitles: Boolean
    get() = titleReader != null

  private fun updateTitleReader(status: Status) {
    val source = engine.source
    val wanted =
      !released &&
        status.route.kind == AudioRouteKind.CAST &&
        source != null &&
        source.isNetwork &&
        status.isLive &&
        status.playWhenReady &&
        (status.state == PlaybackState.LOADING ||
          status.state == PlaybackState.BUFFERING ||
          status.state == PlaybackState.PLAYING ||
          status.state == PlaybackState.RECONNECTING)
    if (!wanted) {
      stopTitleReader()
      return
    }
    if (titleReader != null && titleReaderLoad == status.loadId) return
    stopTitleReader()
    var reader: IcyMetadataReader? = null
    reader =
      IcyMetadataReader(source, titleReaderUserAgent(source), options.titleFormat) { metadata ->
        // A title read for a load that has since changed is dropped.
        handler.post { if (titleReader === reader && !released) onStreamMetadata(engine.generation, metadata) }
      }
    titleReader = reader
    titleReaderLoad = status.loadId
    reader.start()
  }

  /** The same user agent the player itself sends. */
  @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
  private fun titleReaderUserAgent(source: SourceDescriptor): String =
    source.headers.entries.firstOrNull { it.key.equals("User-Agent", ignoreCase = true) }?.value
      ?: androidx.media3.common.util.Util.getUserAgent(appContext, "RNAP")

  private fun stopTitleReader() {
    titleReader?.stop()
    titleReader = null
    titleReaderLoad = -1
  }

  override fun engineLoadSettled(loadId: Int, outcome: LoadOutcome) {
    val completion = pendingLoads.remove(loadId) ?: return
    // Settle after the current status event was emitted (same thread, in order).
    handler.post { completion.settled(outcome) }
  }

  override fun engineError(error: PlayerError, fatal: Boolean) {
    emit(
      "error",
      Arguments.createMap().apply {
        putMap("error", errorToMap(error))
        putBoolean("fatal", fatal)
      },
    )
  }

  override fun engineDidEnd() {
    emit("ended", Arguments.createMap())
  }

  override fun engineSleepFired() {
    emit(
      "sleep",
      Arguments.createMap().apply {
        putString("reason", "fired")
        putDouble("timestamp", AndroidClock.wallMs.toDouble())
      },
    )
  }

  override fun engineDiagnostic(entry: DiagnosticEntry) {
    synchronized(diagnostics) {
      diagnostics.addLast(entry)
      while (diagnostics.size > DIAGNOSTICS_CAPACITY) diagnostics.removeFirst()
    }
    if (diagnosticsEnabled) {
      Log.d(TAG, "[$id] ${entry.event} ${entry.details} (gen=${entry.generation} state=${entry.state.wire})")
      emit("diagnostic", Arguments.createMap().apply { putMap("entry", diagnosticToMap(entry)) })
    }
  }

  override fun engineRequestsSourceRefresh(loadId: Int, reason: RefreshReason) {
    emit(
      "refreshRequest",
      Arguments.createMap().apply {
        putInt("loadId", loadId)
        putString("reason", reason.wire)
      },
    )
  }

  /** `getStats()`: the engine's counters (any thread). */
  fun statsMap(): WritableMap {
    val stats = statsSnapshot
    return Arguments.createMap().apply {
      stats.startupMs?.let { putDouble("startupMs", it.toDouble()) } ?: putNull("startupMs")
      putInt("rebufferCount", stats.rebufferCount)
      putDouble("rebufferMs", stats.rebufferMs.toDouble())
      putInt("qualitySwitches", stats.qualitySwitches)
      putInt("audioOnlySwitches", stats.audioOnlySwitches)
      droppedSnapshot?.let { putInt("droppedFrames", it) } ?: putNull("droppedFrames")
      lastBandwidth?.let { putDouble("bandwidth", it) } ?: putNull("bandwidth")
    }
  }

  /** The last bandwidth estimate and dropped frames, for `getStats()` (read from the JS thread). */
  @Volatile private var lastBandwidth: Double? = null
  @Volatile private var droppedSnapshot: Int? = null

  override fun engineWakeupAt(at: Long?) {
    handler.removeCallbacks(wakeup)
    if (!released && at != null) {
      handler.postDelayed(wakeup, (at - AndroidClock.monotonicMs).coerceAtLeast(0))
    }
    // Every engine entry ends here: refresh the progress snapshot JS reads.
    progressSnapshot = ProgressSnapshot(driver.progress(), AndroidClock.monotonicMs, AndroidClock.wallMs)
    statsSnapshot = engine.stats
    if (picture != null) droppedSnapshot = localDriver.droppedFrames
  }

  /** The engine's counters as of its last entry (read from the JS thread). */
  @Volatile private var statsSnapshot = EngineStats()

  // ── DriverObserver (main thread) ──

  override fun onReady(generation: Int, info: ReadyInfo) = engine.onReady(generation, info)
  override fun onPlaying(generation: Int) = engine.onPlaying(generation)
  override fun onBuffering(generation: Int) = engine.onBuffering(generation)
  override fun onEnded(generation: Int) = engine.onEnded(generation)
  override fun onFailed(generation: Int, error: PlayerError) = engine.onFailed(generation, error)
  override fun onPausedExternally(generation: Int, reason: InterruptionReason) =
    engine.onPausedExternally(generation, reason)

  override fun onStreamMetadata(generation: Int, metadata: StreamMetadata) {
    if (!engine.accepts(generation)) return
    streamMetadata = metadata
    streamMetadataAt = AndroidClock.wallMs
    emit("metadata", Arguments.createMap().apply { putMap("metadata", metadataToMap(metadata, streamMetadataAt)) })
    runtime.onNowPlayingChanged(this)
  }

  override fun onDiscontinuity(generation: Int, position: Double) {
    if (!engine.accepts(generation)) return
    // Listeners read the progress to place themselves again: the snapshot
    // from the last tick still describes the item playback just left.
    progressSnapshot = ProgressSnapshot(driver.progress(), AndroidClock.monotonicMs, AndroidClock.wallMs)
    emit(
      "discontinuity",
      Arguments.createMap().apply {
        putDouble("position", position)
        putDouble("timestamp", AndroidClock.wallMs.toDouble())
      },
    )
  }

  override fun isOffline(): Boolean = runtime.networkState == com.anythingplayer.core.NetworkState.OFFLINE

  // ── DriverObserver: video (main thread) ──

  override fun onVideoInfo(generation: Int, info: VideoInfo) {
    engine.onVideoInfo(generation, info)
    picture?.pictureChanged()
  }

  override fun onFirstFrame(generation: Int) = engine.onFirstFrame(generation)

  override fun onTracks(generation: Int, tracks: List<MediaTrack>, variants: List<VideoVariant>) {
    engine.onTracks(generation, tracks)
    engine.onVariants(generation, variants)
  }

  override fun onSourceCues(generation: Int, cues: List<OverlayCue>) {
    if (engine.accepts(generation)) picture?.sourceCues(cues)
  }

  override fun onBandwidth(generation: Int, bitsPerSecond: Double) {
    if (bitsPerSecond > 0 && bitsPerSecond.isFinite()) lastBandwidth = bitsPerSecond
    engine.onBandwidth(generation, bitsPerSecond)
  }

  override fun onPositionJump(generation: Int) {
    if (engine.accepts(generation)) picture?.positionJumped()
  }
}
