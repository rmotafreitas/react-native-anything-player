package com.anythingplayer.core

import java.io.File
import kotlin.math.abs
import kotlin.math.floor
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live aligner against `conformance/align/live.json` (twins:
 * `src/web/__tests__/liveAligner.test.ts`, `LiveAlignerTests.swift`): each case
 * runs a simulated pair of connections, the old one heard and the new one
 * muted, and checks how the aligner lines them up.
 */
class LiveAlignerTest {
  private data class Outcome(val outcome: String, val at: Long, val actions: List<String>, val residual: Double?, val jumps: Int)

  @Test
  fun fixtures() {
    val cases = JSONArray(File(ConformanceTest.conformanceDir, "align/live.json").readText())
    assertTrue(cases.length() > 0)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val name = c.getString("name")
      val result = simulate(caps(c.getJSONObject("caps")), c.getJSONObject("world"))
      val expect = c.getJSONObject("expect")
      assertEquals(name, expect.getString("outcome"), result.outcome)
      assertEquals(name, expect.getLong("at"), result.at)
      val actions = expect.getJSONArray("actions").let { a -> (0 until a.length()).map { a.getString(it) } }
      assertEquals(name, actions, result.actions)
      if (expect.has("maxJumps")) assertTrue("$name: ${result.jumps} jumps", result.jumps <= expect.getInt("maxJumps"))
      if (expect.has("maxResidual")) {
        assertTrue("$name: residual ${result.residual}", abs(result.residual!!) <= expect.getDouble("maxResidual"))
      }
    }
  }

  private fun caps(o: JSONObject) =
    LiveAligner.Caps(
      maxRate = o.getDouble("maxRate"),
      minRate = o.getDouble("minRate"),
      jump = LiveAligner.Jump.valueOf(o.getString("jump").uppercase()),
      startLead = o.getDouble("startLead"),
      jumpLead = o.getDouble("jumpLead"),
    )

  /** The readings every tick, the aligner's answers applied (see the TypeScript twin). */
  private fun simulate(caps: LiveAligner.Caps, w: JSONObject): Outcome {
    val aligner = LiveAligner(caps)
    val actions = mutableListOf<String>()
    fun note(kind: String) {
      if (actions.lastOrNull() != kind) actions.add(kind)
    }
    val oldPositionAt0 = w.getDouble("oldPosition")
    val oldLag = w.getDouble("oldLag")
    val burst = w.getDouble("burst")
    val burstSpeed = w.getDouble("burstSpeed")
    val chunkMs = w.getLong("chunkMs")
    val startLatencyMs = w.getLong("startLatencyMs")
    val endsAfterBurst = w.optBoolean("endsAfterBurst", false)
    val stallAt = if (w.has("oldStallAt")) w.getLong("oldStallAt") else null
    val reconnectingAt = if (w.has("oldReconnectingAt")) w.getLong("oldReconnectingAt") else null
    val interruptAt = if (w.has("interruptAt")) w.getLong("interruptAt") else null
    val readyAt = if (w.has("nextReadyAt")) w.getLong("nextReadyAt") else null
    val oldChunkMs = w.optLong("oldChunkMs", chunkMs)
    val nextChunkMs = w.optLong("nextChunkMs", chunkMs)
    val oldPhaseMs = w.optLong("oldPhaseMs", 0)
    val nextPhaseMs = w.optLong("nextPhaseMs", 0)
    val jitter = w.optDouble("positionJitter", 0.0)
    val appRate = w.optDouble("appRate", 1.0)
    val arrival = w.optBoolean("edgeArrival", false)
    // The stream clock's epoch seconds at the old connection's live point at t 0.
    val dates = w.optBoolean("programDates", false)
    val ticks = w.optJSONArray("ticksMs")?.let { a -> (0 until a.length()).map { a.getLong(it) } } ?: listOf(TICK_MS)
    var i = 0
    val nextStart = w.optDouble("nextStartAt", 0.0)
    val k = burst - oldPositionAt0 - oldLag + nextStart
    var x = nextStart
    var jumps = 0
    var rate = 0.0
    var moveFrom: Long? = null
    var lastT = 0L
    var t = 0L
    while (t <= LIMIT_MS) {
      val from = moveFrom
      if (rate > 0 && from != null) {
        val start = maxOf(lastT, from)
        if (t > start) x += (rate * appRate * (t - start)) / 1000
      }
      val tq = maxOf(0L, lastChunk(t, nextChunkMs, nextPhaseMs))
      val arrived = (burstSpeed * tq) / 1000
      val received = nextStart + if (endsAfterBurst) minOf(arrived, burst) else minOf(arrived, burst + tq / 1000.0)
      x = minOf(x, received)
      val stalled = stallAt != null && t >= stallAt
      val oldT = if (stalled) stallAt!! else t
      val oldTq = lastChunk(oldT, oldChunkMs, oldPhaseMs)
      val oldPosition = oldPositionAt0 + (appRate * oldT) / 1000
      val old =
        LiveAligner.Reading(
          position = oldPosition,
          edge = oldPositionAt0 + oldLag + oldTq / 1000.0,
          playing = !stalled,
          reconnecting = reconnectingAt != null && t >= reconnectingAt,
          edgeAt = if (arrival) oldTq else null,
          clock = if (dates) EPOCH - oldPositionAt0 - oldLag else null,
        )
      val moving = moveFrom
      val next =
        LiveAligner.Reading(
          position = x + if (i % 2 == 0) jitter else -jitter,
          edge = received,
          playing = rate > 0 && moving != null && t >= moving && x < received,
          ready = readyAt == null || t >= readyAt,
          edgeAt = if (arrival) tq else null,
          clock = if (dates) EPOCH - burst - nextStart else null,
          start = if (dates) w.optDouble("nextWindowStart", 0.0) else null,
        )
      val action = if (interruptAt != null && t >= interruptAt) aligner.interrupt() else aligner.step(t, old, next)
      lastT = t
      when (action) {
        LiveAligner.Action.Wait -> Unit
        is LiveAligner.Action.Rate -> {
          note("rate")
          if (action.rate == 0.0) {
            rate = 0.0
            moveFrom = null
          } else {
            if (rate == 0.0) moveFrom = t + action.afterMs + startLatencyMs
            rate = action.rate
          }
        }
        is LiveAligner.Action.JumpTo -> {
          note("jump")
          jumps += 1
          x = minOf(action.to, received)
        }
        is LiveAligner.Action.TakeOver -> {
          note("takeOver")
          return Outcome("takeOver", t, actions, x - (oldPosition + k), jumps)
        }
        is LiveAligner.Action.Fallback -> {
          note("fallback")
          return Outcome("fallback:${action.reason}", t, actions, null, jumps)
        }
      }
      t += ticks[i % ticks.size]
      i += 1
    }
    return Outcome("none", LIMIT_MS, actions, null, jumps)
  }

  /** The time of the last chunk at [t]: chunks arrive every [every] ms from [phase]. */
  private fun lastChunk(t: Long, every: Long, phase: Long): Long = floor((t - phase).toDouble() / every).toLong() * every + phase

  private companion object {
    private const val EPOCH = 1_700_000_000.0
    const val TICK_MS = 40L
    const val LIMIT_MS = 60_000L
  }
}
