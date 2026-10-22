package com.anythingplayer.platform

import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.InterruptionReason
import com.anythingplayer.core.PlayerError
import com.anythingplayer.core.ReadyInfo

/** A Cast receiver's player state (`MediaStatus.PLAYER_STATE_*`). */
internal enum class ReceiverState { UNKNOWN, IDLE, LOADING, BUFFERING, PLAYING, PAUSED }

/** Why a receiver went idle (`MediaStatus.IDLE_REASON_*`). */
internal enum class IdleReason { NONE, FINISHED, CANCELED, INTERRUPTED, ERROR }

/** What a receiver's `MediaStatus` says, reduced to what the mapping needs. */
internal data class ReceiverStatus(
  /** The content the receiver reports playing; ours is `anythingplayer:<generation>`. */
  val contentId: String?,
  val state: ReceiverState,
  val idle: IdleReason = IdleReason.NONE,
  /** Seconds; `null` when the receiver does not know (or the stream is live). */
  val duration: Double? = null,
  /** The receiver's stream type is live. */
  val live: Boolean = false,
  val seekable: Boolean = false,
)

/** What the mapper asks of the Cast session. */
internal interface ReceiverActions {
  /** Sends `play` to the receiver again. */
  fun playAgain()

  /** The receiver is ready: carry the stream volume over. */
  fun receiverReady()
}

/**
 * Maps what a Cast receiver reports to the engine's driver callbacks, for the
 * generation one open belongs to. Pure; the Cast SDK is behind [ReceiverStatus].
 *
 * - loading / buffering → buffering (once ready),
 * - playing → ready + playing,
 * - paused → ready; a pause the engine did not ask for (the TV remote, Google
 *   Home) → paused externally,
 * - idle: finished → ended, error → failed (recoverable: the engine
 *   reconnects with its backoff, against the receiver), cancelled /
 *   interrupted (another sender took over) → paused externally.
 *
 * Each change is reported once. Only the content this open loaded is read: the
 * receiver may still report the previous item. Other content once ours has
 * started means it was replaced (another sender) → paused externally.
 */
internal class ReceiverMapper(
  private val observer: DriverObserver,
  private val actions: ReceiverActions,
  private val monotonicMs: () -> Long,
) {
  private enum class Report { NONE, READY, BUFFERING, PLAYING, PAUSED, TERMINAL }

  private var generation = 0
  private var contentId = ""
  private var liveHint: Boolean? = null
  private var wantsPlay = false
  private var last = Report.NONE
  private var playedThisGeneration = false
  private var graceUntil = 0L
  private var playRetries = 0
  private var errorDetail: String? = null
  private var errorCode: Int? = null

  /** What the receiver told us when it became ready; `null` before. */
  var ready: ReadyInfo? = null
    private set

  val playing: Boolean
    get() = last == Report.PLAYING

  fun open(generation: Int, contentId: String, liveHint: Boolean?, wantsPlay: Boolean) {
    this.generation = generation
    this.contentId = contentId
    this.liveHint = liveHint
    this.wantsPlay = wantsPlay
    last = Report.NONE
    ready = null
    playedThisGeneration = false
    errorDetail = null
    errorCode = null
    expectPlay()
  }

  fun playRequested() {
    wantsPlay = true
    expectPlay()
  }

  fun pauseRequested() {
    wantsPlay = false
  }

  /** The output stopped the receiver's media itself: whatever it reports next is ours. */
  fun stopped() {
    wantsPlay = false
    last = Report.TERMINAL
  }

  fun mediaError(detail: String?, code: Int?) {
    errorDetail = detail
    errorCode = code
  }

  private fun expectPlay() {
    graceUntil = monotonicMs() + PLAY_GRACE_MS
    playRetries = 0
  }

  fun evaluate(status: ReceiverStatus) {
    if (status.contentId != contentId) {
      replacedBy(status)
      return
    }
    when (status.state) {
      ReceiverState.LOADING, ReceiverState.BUFFERING -> if (last != Report.NONE) report(Report.BUFFERING) { observer.onBuffering(generation) }
      ReceiverState.PLAYING -> {
        becomeReady(status)
        playedThisGeneration = true
        report(Report.PLAYING) { observer.onPlaying(generation) }
      }
      ReceiverState.PAUSED -> {
        becomeReady(status)
        onPaused()
      }
      ReceiverState.IDLE -> onIdle(status.idle)
      ReceiverState.UNKNOWN -> Unit
    }
  }

  /**
   * Before our item started, another content id is the previous item still
   * reported. After, it is someone else's media (another sender, the TV's own
   * UI) replacing ours: the engine must not stay `playing`.
   */
  private fun replacedBy(status: ReceiverStatus) {
    if (ready == null || last == Report.TERMINAL || status.contentId == null) return
    if (status.state == ReceiverState.IDLE || status.state == ReceiverState.UNKNOWN) return
    report(Report.TERMINAL) {
      if (wantsPlay) observer.onPausedExternally(generation, InterruptionReason.INTERRUPTION)
    }
  }

  private fun becomeReady(status: ReceiverStatus) {
    if (ready != null) return
    val live = liveHint ?: (status.live || status.duration == null)
    val info = ReadyInfo(if (live) null else status.duration, live, !live && status.seekable)
    ready = info
    if (last == Report.NONE) last = Report.READY
    actions.receiverReady()
    observer.onReady(generation, info)
  }

  private fun onPaused() {
    if (!wantsPlay) {
      last = Report.PAUSED
      return
    }
    // A play sent before the receiver finished loading is lost; the load ran
    // paused. Ask again a few times before calling the pause someone else's.
    val inGrace = monotonicMs() < graceUntil || !playedThisGeneration
    if (inGrace && playRetries < MAX_PLAY_RETRIES) {
      playRetries += 1
      actions.playAgain()
      return
    }
    report(Report.PAUSED) { observer.onPausedExternally(generation, InterruptionReason.INTERRUPTION) }
  }

  private fun onIdle(reason: IdleReason) {
    when (reason) {
      IdleReason.FINISHED -> report(Report.TERMINAL) { observer.onEnded(generation) }
      IdleReason.ERROR -> report(Report.TERMINAL) { observer.onFailed(generation, receiverError()) }
      IdleReason.CANCELED, IdleReason.INTERRUPTED ->
        report(Report.TERMINAL) { if (wantsPlay) observer.onPausedExternally(generation, InterruptionReason.INTERRUPTION) }
      // The receiver has not started the load yet.
      IdleReason.NONE -> Unit
    }
  }

  private fun receiverError(): PlayerError =
    PlayerError(
      ErrorCode.NETWORK_ERROR,
      "The Cast receiver could not play the stream" + (errorDetail?.let { " ($it)" } ?: "."),
      true,
      platformDomain = "cast",
      platformCode = errorCode,
    )

  private fun report(kind: Report, block: () -> Unit) {
    if (last == kind) return
    last = kind
    block()
  }

  companion object {
    /** The receiver loads before it plays: a pause seen this soon after a play request is ours, not someone else's. */
    const val PLAY_GRACE_MS = 3_000L

    /** How many times a play the receiver dropped (sent before its load finished) is repeated. */
    const val MAX_PLAY_RETRIES = 3
  }
}
