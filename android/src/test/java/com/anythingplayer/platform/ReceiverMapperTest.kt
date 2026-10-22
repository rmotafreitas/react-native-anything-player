package com.anythingplayer.platform

import com.anythingplayer.core.InterruptionReason
import com.anythingplayer.core.PlayerError
import com.anythingplayer.core.ReadyInfo
import com.anythingplayer.core.StreamMetadata
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

private class RecordingObserver(val log: MutableList<String>) : DriverObserver {
  var failure: PlayerError? = null
  override fun onReady(generation: Int, info: ReadyInfo) { log += "ready($generation,${info.duration},live=${info.isLive},seek=${info.seekable})" }
  override fun onPlaying(generation: Int) { log += "playing($generation)" }
  override fun onBuffering(generation: Int) { log += "buffering($generation)" }
  override fun onEnded(generation: Int) { log += "ended($generation)" }
  override fun onFailed(generation: Int, error: PlayerError) { failure = error; log += "failed($generation,${error.code.wire})" }
  override fun onPausedExternally(generation: Int, reason: InterruptionReason) { log += "paused-externally($generation,${reason.wire})" }
  override fun onStreamMetadata(generation: Int, metadata: StreamMetadata) = Unit
  override fun onDiscontinuity(generation: Int, position: Double) = Unit
  override fun isOffline(): Boolean = false
}

class ReceiverMapperTest {
  private val log = mutableListOf<String>()
  private val observer = RecordingObserver(log)
  private var now = 1_000L
  private var plays = 0
  private var readies = 0
  private val mapper =
    ReceiverMapper(
      observer,
      object : ReceiverActions {
        override fun playAgain() { plays += 1 }
        override fun receiverReady() { readies += 1 }
      },
      { now },
    )

  private fun status(state: ReceiverState, idle: IdleReason = IdleReason.NONE, id: String? = "anythingplayer:2", duration: Double? = null, live: Boolean = false, seekable: Boolean = false) =
    ReceiverStatus(id, state, idle, duration, live, seekable)

  private fun open(play: Boolean = true, liveHint: Boolean? = null) = mapper.open(2, "anythingplayer:2", liveHint, play)

  @Test
  fun `a stream loads, becomes ready and plays`() {
    open(liveHint = true)
    mapper.evaluate(status(ReceiverState.LOADING))
    mapper.evaluate(status(ReceiverState.PLAYING, live = true))
    mapper.evaluate(status(ReceiverState.PLAYING, live = true))
    assertEquals(listOf("ready(2,null,live=true,seek=false)", "playing(2)"), log)
    assertEquals(1, readies)
  }

  @Test
  fun `a file reports its duration and seekability`() {
    open()
    mapper.evaluate(status(ReceiverState.PLAYING, duration = 215.5, seekable = true))
    assertEquals(listOf("ready(2,215.5,live=false,seek=true)", "playing(2)"), log)
    assertEquals(215.5, mapper.ready!!.duration!!, 0.0)
  }

  @Test
  fun `the app's live hint wins over what the receiver says`() {
    open(liveHint = false)
    mapper.evaluate(status(ReceiverState.PLAYING, duration = null, live = true))
    assertEquals(false, mapper.ready!!.isLive)
  }

  @Test
  fun `a stream with no duration is live`() {
    open()
    mapper.evaluate(status(ReceiverState.PLAYING, duration = null))
    assertTrue(mapper.ready!!.isLive)
  }

  @Test
  fun `buffering is reported only once the item was ready, and once`() {
    open()
    mapper.evaluate(status(ReceiverState.BUFFERING))
    assertTrue(log.isEmpty())
    mapper.evaluate(status(ReceiverState.PLAYING, duration = 10.0))
    log.clear()
    mapper.evaluate(status(ReceiverState.BUFFERING))
    mapper.evaluate(status(ReceiverState.LOADING))
    mapper.evaluate(status(ReceiverState.PLAYING, duration = 10.0))
    assertEquals(listOf("buffering(2)", "playing(2)"), log)
  }

  @Test
  fun `the previous item or other content is ignored`() {
    open()
    mapper.evaluate(status(ReceiverState.PLAYING, id = "anythingplayer:1"))
    mapper.evaluate(status(ReceiverState.IDLE, IdleReason.FINISHED, id = "someone-else"))
    mapper.evaluate(status(ReceiverState.PLAYING, id = null))
    assertTrue(log.isEmpty())
  }

  @Test
  fun `a load that runs paused after a play was sent is asked to play again`() {
    open(play = true)
    mapper.evaluate(status(ReceiverState.PAUSED, duration = 60.0))
    assertEquals(listOf("ready(2,60.0,live=false,seek=false)"), log)
    assertEquals(1, plays)
    mapper.evaluate(status(ReceiverState.PLAYING, duration = 60.0))
    assertEquals("playing(2)", log.last())
  }

  @Test
  fun `a receiver that keeps pausing is eventually someone else's doing`() {
    open(play = true)
    repeat(ReceiverMapper.MAX_PLAY_RETRIES) { mapper.evaluate(status(ReceiverState.PAUSED, duration = 60.0)) }
    assertEquals(ReceiverMapper.MAX_PLAY_RETRIES, plays)
    mapper.evaluate(status(ReceiverState.PAUSED, duration = 60.0))
    assertEquals("paused-externally(2,interruption)", log.last())
  }

  @Test
  fun `a pause after playing, past the grace period, is external`() {
    open(play = true)
    mapper.evaluate(status(ReceiverState.PLAYING, duration = 60.0))
    now += ReceiverMapper.PLAY_GRACE_MS + 1
    mapper.evaluate(status(ReceiverState.PAUSED, duration = 60.0))
    assertEquals("paused-externally(2,interruption)", log.last())
    assertEquals(0, plays)
  }

  @Test
  fun `a pause the engine asked for is not reported`() {
    open(play = true)
    mapper.evaluate(status(ReceiverState.PLAYING, duration = 60.0))
    mapper.pauseRequested()
    log.clear()
    mapper.evaluate(status(ReceiverState.PAUSED, duration = 60.0))
    assertTrue(log.isEmpty())
    mapper.playRequested()
    mapper.evaluate(status(ReceiverState.PAUSED, duration = 60.0))
    assertEquals(1, plays)
  }

  @Test
  fun `a load without play intent stays paused`() {
    open(play = false)
    mapper.evaluate(status(ReceiverState.PAUSED, duration = 60.0))
    assertEquals(listOf("ready(2,60.0,live=false,seek=false)"), log)
    assertEquals(0, plays)
  }

  @Test
  fun `idle reasons map to ended, failed and taken over`() {
    open()
    mapper.evaluate(status(ReceiverState.PLAYING, duration = 60.0))
    log.clear()
    mapper.evaluate(status(ReceiverState.IDLE, IdleReason.FINISHED))
    assertEquals(listOf("ended(2)"), log)

    log.clear()
    open()
    mapper.mediaError("LOAD_FAILED", 905)
    mapper.evaluate(status(ReceiverState.IDLE, IdleReason.ERROR))
    assertEquals(listOf("failed(2,NETWORK_ERROR)"), log)
    val error = observer.failure!!
    assertTrue(error.recoverable)
    assertEquals("cast", error.platformDomain)
    assertEquals(905, error.platformCode)
    assertTrue(error.message.contains("LOAD_FAILED"))

    log.clear()
    open()
    mapper.evaluate(status(ReceiverState.IDLE, IdleReason.INTERRUPTED))
    assertEquals(listOf("paused-externally(2,interruption)"), log)
  }

  @Test
  fun `idle before the receiver started the load says nothing`() {
    open()
    mapper.evaluate(status(ReceiverState.IDLE, IdleReason.NONE))
    assertTrue(log.isEmpty())
  }

  @Test
  fun `after the output stopped the receiver its own cancel is not news`() {
    open()
    mapper.evaluate(status(ReceiverState.PLAYING, duration = 60.0))
    mapper.stopped()
    log.clear()
    mapper.evaluate(status(ReceiverState.IDLE, IdleReason.CANCELED))
    mapper.evaluate(status(ReceiverState.IDLE, IdleReason.CANCELED))
    assertTrue(log.isEmpty())
  }

  @Test
  fun `a new open starts clean`() {
    open()
    mapper.evaluate(status(ReceiverState.IDLE, IdleReason.FINISHED))
    log.clear()
    mapper.open(3, "anythingplayer:3", null, true)
    mapper.evaluate(ReceiverStatus("anythingplayer:3", ReceiverState.PLAYING, duration = 5.0))
    assertEquals(listOf("ready(3,5.0,live=false,seek=false)", "playing(3)"), log)
    assertNotNull(mapper.ready)
  }
}
