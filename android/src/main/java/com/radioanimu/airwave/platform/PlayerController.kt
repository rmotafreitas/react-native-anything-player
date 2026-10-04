package com.radioanimu.airwave.platform

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.WritableMap
import com.radioanimu.airwave.core.DiagnosticEntry
import com.radioanimu.airwave.core.EngineClock
import com.radioanimu.airwave.core.EngineDelegate
import com.radioanimu.airwave.core.FocusResult
import com.radioanimu.airwave.core.InterruptionReason
import com.radioanimu.airwave.core.LoadOutcome
import com.radioanimu.airwave.core.PlaybackEngine
import com.radioanimu.airwave.core.PlayerError
import com.radioanimu.airwave.core.ReadyInfo
import com.radioanimu.airwave.core.SourceDescriptor
import com.radioanimu.airwave.core.Status
import com.radioanimu.airwave.core.StreamMetadata

/** Where a player's events go (the TurboModule's `onPlayerEvent` emitter). */
internal fun interface EventSink {
  fun emit(event: WritableMap)
}

internal object AndroidClock : EngineClock {
  override val monotonicMs: Long
    get() = SystemClock.elapsedRealtime()
  override val wallMs: Long
    get() = System.currentTimeMillis()
}

private const val TAG = "Airwave"
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
  private val runtime: AirwaveRuntime,
  private val sink: EventSink,
) : EngineDelegate, DriverObserver {
  private val handler = Handler(Looper.getMainLooper())
  private val driver = ExoPlayerDriver(context, options.speech, options.titleFormat, this)
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
  private val pendingLoads = HashMap<Int, Promise>()
  private var released = false

  private val wakeup = Runnable { engine.onWakeup() }

  init {
    engine.delegate = this
  }

  val status: Status
    get() = statusSnapshot.first

  // ── Commands (main thread) ──

  fun load(source: SourceDescriptor, fields: NowPlayingFields, autoplay: Boolean?, start: Double?, promise: Promise) {
    sourceFields = fields
    overrides = NowPlayingFields()
    streamMetadata = null
    engine.load(source, autoplay, start)
    // `load` settles synchronously only when it supersedes; this load is pending.
    pendingLoads[engine.loadId] = promise
    runtime.onNowPlayingChanged(this)
  }

  /** Main thread. Builds the native player once the main looper is idle. */
  fun prewarm() {
    Looper.myQueue().addIdleHandler {
      if (!released) driver.prewarm()
      false
    }
  }

  fun updateNowPlaying(fields: NowPlayingFields) {
    overrides = fields
    runtime.onNowPlayingChanged(this)
  }

  fun release() {
    if (released) return
    released = true
    handler.removeCallbacks(wakeup)
    engine.release()
    driver.destroy()
    pendingLoads.clear()
  }

  // ── Snapshots (any thread) ──

  fun statusMap(): WritableMap {
    val (status, seq) = statusSnapshot
    return statusToMap(status, seq)
  }

  fun progressMap(): WritableMap = progressToMap(progressSnapshot, AndroidClock.monotonicMs, AndroidClock.wallMs)

  fun progress(): ProgressSnapshot = progressSnapshot

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
    )
  }

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

  private fun emit(type: String, payload: WritableMap) {
    if (released && type != "status") return
    eventSeq += 1
    payload.putString("playerId", id)
    payload.putString("type", type)
    payload.putDouble("seq", eventSeq.toDouble())
    sink.emit(payload)
  }

  // ── EngineDelegate (main thread) ──

  override fun engineRequestsAudioFocus(): FocusResult = runtime.requestFocus(this)

  override fun engineStatusChanged(status: Status) {
    eventSeq += 1
    statusSnapshot = status to eventSeq
    val event = statusToMap(status, eventSeq)
    event.putString("playerId", id)
    event.putString("type", "status")
    sink.emit(event)
    runtime.onStatusChanged(this)
  }

  override fun engineLoadSettled(loadId: Int, outcome: LoadOutcome) {
    val promise = pendingLoads.remove(loadId) ?: return
    when (outcome) {
      is LoadOutcome.Ready, is LoadOutcome.Superseded -> {
        // Resolve after the current status event was emitted (same thread, in order).
        handler.post { promise.resolve(statusMap()) }
      }
      is LoadOutcome.Failed -> handler.post { promise.reject(outcome.error.code.wire, outcome.error.message, errorToMap(outcome.error)) }
    }
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

  override fun engineWakeupAt(at: Long?) {
    handler.removeCallbacks(wakeup)
    if (!released && at != null) {
      handler.postDelayed(wakeup, (at - AndroidClock.monotonicMs).coerceAtLeast(0))
    }
    // Every engine entry ends here: refresh the progress snapshot JS reads.
    progressSnapshot = ProgressSnapshot(driver.progress(), AndroidClock.monotonicMs, AndroidClock.wallMs)
  }

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

  override fun isOffline(): Boolean = runtime.networkState == com.radioanimu.airwave.core.NetworkState.OFFLINE
}
