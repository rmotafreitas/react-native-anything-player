package com.radioanimu.airwave.core

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Runs every scenario in the `conformance` JSON files (shared with the Swift engine). */
class ConformanceTest {
  companion object {
    /** Gradle runs unit tests with the module directory (`android/`) as cwd. */
    val conformanceDir: File by lazy {
      var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
      while (dir != null) {
        val candidate = File(dir, "conformance")
        if (File(candidate, "basics.json").exists()) return@lazy candidate
        dir = dir.parentFile
      }
      error("conformance/ not found from ${System.getProperty("user.dir")}")
    }
  }

  @Test
  fun allScenarios() {
    val files = conformanceDir.listFiles { f -> f.extension == "json" }!!.sortedBy { it.name }
    assertTrue("no conformance files", files.isNotEmpty())
    var count = 0
    for (file in files) {
      val scenarios = JSONArray(file.readText())
      for (i in 0 until scenarios.length()) {
        val scenario = scenarios.getJSONObject(i)
        count += 1
        run(scenario, "${file.name} › ${scenario.optString("name")}")
      }
    }
    println("conformance: $count scenarios")
  }

  private fun run(scenario: JSONObject, name: String) {
    var options = EngineOptions()
    scenario.optJSONObject("options")?.let { o ->
      if (o.has("giveUpAfterMs")) options = options.copy(giveUpAfterMs = o.getLong("giveUpAfterMs"))
      if (o.has("reconnect")) options = options.copy(reconnect = o.getBoolean("reconnect"))
      if (o.has("autoResumeAfterInterruption")) {
        options = options.copy(autoResumeAfterInterruption = o.getBoolean("autoResumeAfterInterruption"))
      }
      if (o.has("liveMaxDriftMs")) options = options.copy(liveMaxDriftMs = o.getLong("liveMaxDriftMs"))
    }
    val h = EngineHarness(options)
    val steps = scenario.getJSONArray("steps")
    for (i in 0 until steps.length()) apply(steps.getJSONObject(i), h, "$name [step $i]")
    assertEquals("$name: event ordering", emptyList<String>(), h.recorder.violations)
  }

  private fun apply(step: JSONObject, h: EngineHarness, at: String) {
    when {
      step.has("call") -> {
        val expected = if (step.has("throws")) step.getString("throws") else null
        try {
          perform(step.getString("call"), step, h)
          if (expected != null) fail("$at: expected $expected to be thrown")
        } catch (e: PlayerError) {
          assertEquals("$at: unexpected throw", expected, e.code.wire)
        }
      }
      step.has("focus") ->
        h.recorder.focus =
          when (step.getString("focus")) {
            "denied" -> FocusResult.DENIED
            "delayed" -> FocusResult.DELAYED
            else -> FocusResult.GRANTED
          }
      step.has("native") -> {
        var gen = h.engine.generation
        if (step.has("gen")) {
          val g = step.get("gen")
          gen = if (g == "prev") h.engine.generation - 1 else (g as Number).toInt()
        }
        val accepted = h.engine.accepts(gen)
        when (val native = step.getString("native")) {
          "ready" ->
            h.engine.onReady(
              gen,
              ReadyInfo(
                if (step.has("duration")) step.getDouble("duration") else null,
                step.optBoolean("live", false),
                step.optBoolean("seekable", false),
              ),
            )
          "playing" -> {
            if (accepted) h.driver.setMotion(FakeDriver.Motion.FLOWING)
            h.engine.onPlaying(gen)
          }
          "buffering" -> {
            if (accepted) h.driver.setMotion(FakeDriver.Motion.FROZEN)
            h.engine.onBuffering(gen)
          }
          "ended" -> {
            if (accepted) h.driver.setMotion(FakeDriver.Motion.FROZEN)
            h.engine.onEnded(gen)
          }
          "failed" -> {
            if (accepted) h.driver.setMotion(FakeDriver.Motion.FROZEN)
            val code = ErrorCode.fromWire(step.getString("code")) ?: error("$at: bad code")
            h.engine.onFailed(gen, PlayerError(code, "test", step.optBoolean("recoverable", false)))
          }
          "pausedExternally" ->
            h.engine.onPausedExternally(gen, InterruptionReason.fromWire(step.optString("reason")) ?: InterruptionReason.SYSTEM)
          else -> fail("$at: unknown native step $native")
        }
      }
      step.has("driver") ->
        when (val d = step.getString("driver")) {
          "flowing" -> h.driver.setMotion(FakeDriver.Motion.FLOWING)
          "frozen" -> h.driver.setMotion(FakeDriver.Motion.FROZEN)
          "trickle" -> h.driver.setMotion(FakeDriver.Motion.TRICKLE)
          "reentrant" -> h.driver.reentrant = true
          "position" -> h.driver.setPosition(step.optDouble("value", 0.0))
          else -> fail("$at: unknown driver step $d")
        }
      step.has("interruption") ->
        if (step.getString("interruption") == "began") {
          val reason = InterruptionReason.fromWire(step.getString("reason")) ?: error("$at: bad reason")
          h.engine.interruptionBegan(reason, step.optBoolean("resumable", false))
        } else {
          h.engine.interruptionEnded(step.optBoolean("shouldResume", false))
        }
      step.has("network") ->
        h.engine.networkChanged(
          when (step.getString("network")) {
            "online" -> NetworkState.ONLINE
            "offline" -> NetworkState.OFFLINE
            else -> NetworkState.UNKNOWN
          },
          step.optBoolean("handoff", false),
        )
      step.has("platformReset") -> h.engine.platformReset()
      step.has("advance") -> h.advance(step.getLong("advance"))
      step.has("expect") -> check(step.getJSONObject("expect"), h, at)
      else -> fail("$at: unknown step $step")
    }
  }

  private fun perform(call: String, step: JSONObject, h: EngineHarness) {
    val value = step.optDouble("value", 0.0)
    when (call) {
      "load" ->
        h.engine.load(
          SourceDescriptor(step.getString("uri"), emptyMap(), if (step.has("live")) step.getBoolean("live") else null),
          if (step.has("autoplay")) step.getBoolean("autoplay") else null,
          if (step.has("start")) step.getDouble("start") else null,
        )
      "play" -> h.engine.play()
      "pause" -> h.engine.pause()
      "stop" -> h.engine.stop()
      "reset" -> h.engine.reset()
      "release" -> h.engine.release()
      "seek" -> h.engine.seek(value)
      "volume" -> h.engine.setVolume(value)
      "muted" -> h.engine.setMuted(step.optBoolean("value", false))
      "rate" -> h.engine.setRate(value)
      "duck" -> h.engine.setDucked(step.optBoolean("value", false))
      "foreground" -> h.engine.appForegrounded()
      else -> fail("unknown call $call")
    }
  }

  private fun stringList(array: JSONArray): List<String> = (0 until array.length()).map { array.getString(it) }

  private fun nullable(o: JSONObject, key: String): Any? = if (o.isNull(key)) null else o.get(key)

  private fun check(expect: JSONObject, h: EngineHarness, at: String) {
    val s = h.engine.status
    for (key in expect.keys()) {
      val v = nullable(expect, key)
      when (key) {
        "state" -> assertEquals("$at: state", v, s.state.wire)
        "playWhenReady" -> assertEquals("$at: playWhenReady", v, s.playWhenReady)
        "isLive" -> assertEquals("$at: isLive", v, s.isLive)
        "seekable" -> assertEquals("$at: seekable", v, s.seekable)
        "duration" -> assertEquals("$at: duration", (v as Number?)?.toDouble(), s.duration)
        "interruption" -> assertEquals("$at: interruption", v, s.interruption?.reason?.wire)
        "interruptionResumable" -> assertEquals("$at: interruptionResumable", v, s.interruption?.resumable)
        "error" -> assertEquals("$at: error", v, s.error?.code?.wire)
        "reconnectAttempt" -> assertEquals("$at: reconnectAttempt", (v as Number?)?.toInt(), s.reconnect?.attempt)
        "commands" -> assertEquals("$at: commands", stringList(v as JSONArray), h.driver.commands)
        "loads" -> assertEquals("$at: loads", stringList(v as JSONArray), h.recorder.loads)
        "errors" -> assertEquals("$at: errors", stringList(v as JSONArray), h.recorder.errors)
        "ended" -> assertEquals("$at: ended", (v as Number).toInt(), h.recorder.ended)
        "wantsKeepalive" -> assertEquals("$at: wantsKeepalive", v, h.engine.wantsKeepalive)
        "needsAudioFocus" -> assertEquals("$at: needsAudioFocus", v, h.engine.needsAudioFocus)
        else -> fail("$at: unknown expectation $key")
      }
    }
    h.driver.commands.clear()
    h.recorder.loads.clear()
    h.recorder.errors.clear()
    h.recorder.ended = 0
  }
}
