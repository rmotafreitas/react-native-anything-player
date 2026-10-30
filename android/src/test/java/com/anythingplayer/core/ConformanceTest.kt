package com.anythingplayer.core

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** A track from a fixture (shared with `SubtitleTest`). */
internal fun track(t: JSONObject): MediaTrack =
  MediaTrack(
    id = t.getString("id"),
    kind = TrackKind.fromWire(t.getString("kind")),
    language = if (t.has("language") && !t.isNull("language")) t.getString("language") else null,
    forced = t.optBoolean("forced", false),
    isDefault = t.optBoolean("default", false),
    sdh = t.optBoolean("sdh", false),
    describesVideo = t.optBoolean("describesVideo", false),
  )

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
      if (o.has("fadeInMs")) options = options.copy(fadeInMs = o.getLong("fadeInMs"))
      if (o.has("fadeOutMs")) options = options.copy(fadeOutMs = o.getLong("fadeOutMs"))
      if (o.has("video")) options = options.copy(video = videoOptions(o.get("video")))
    }
    val h = EngineHarness(options)
    val steps = scenario.getJSONArray("steps")
    for (i in 0 until steps.length()) apply(steps.getJSONObject(i), h, "$name [step $i]")
    assertEquals("$name: event ordering", emptyList<String>(), h.recorder.violations)
  }

  /** `"video": true` or partial `VideoEngineOptions` (`"fallback": true` takes its defaults). */
  private fun videoOptions(value: Any): VideoEngineOptions {
    val o = value as? JSONObject ?: return VideoEngineOptions()
    val fallback =
      when (val f = o.opt("fallback")) {
        true -> FallbackPolicy()
        is JSONObject -> FallbackPolicy(dropAfterMs = f.optLong("dropAfterMs", 10_000L))
        else -> null
      }
    val q = o.optJSONObject("quality") ?: JSONObject()
    val start =
      when (val v = q.opt("startQuality")) {
        "lowest" -> StartQuality.Lowest
        "highest" -> StartQuality.Highest
        is Number -> StartQuality.Height(v.toInt())
        else -> StartQuality.Auto
      }
    val t = o.optJSONObject("tracks") ?: JSONObject()
    return VideoEngineOptions(
      tracks = TrackPolicy(strings(t.optJSONArray("languages")), t.optBoolean("followSystem", true)),
      whenBackgrounded = BackgroundMode.fromWire(o.optString("whenBackgrounded", "pause")),
      ambient = o.optBoolean("ambient", false),
      keepAwake = o.optBoolean("keepAwake", true),
      focusWhenMuted = o.optBoolean("focusWhenMuted", false),
      fallback = fallback,
      quality =
        QualityPolicy(
          maxHeight = intOrNull(q, "maxHeight"),
          maxBitrate = longOrNull(q, "maxBitrate"),
          cellularMaxHeight = intOrNull(q, "cellularMaxHeight"),
          cellularMaxBitrate = longOrNull(q, "cellularMaxBitrate"),
          startQuality = start,
          followDataSaver = q.optBoolean("followDataSaver", true),
          capToView = q.optBoolean("capToView", true),
        ),
    )
  }

  private fun intOrNull(o: JSONObject, key: String): Int? = if (o.has(key) && !o.isNull(key)) o.getInt(key) else null

  private fun longOrNull(o: JSONObject, key: String): Long? = if (o.has(key) && !o.isNull(key)) o.getLong(key) else null

  private fun renditions(value: JSONArray?): List<Rendition>? =
    value?.let { array ->
      (0 until array.length()).map {
        val r = array.getJSONObject(it)
        Rendition(
          r.getString("uri"), null, intOrNull(r, "height"), longOrNull(r, "bitrate"), null, r.optBoolean("audioOnly", false),
          id = if (r.has("id")) r.getString("id") else null,
        )
      }
    }

  private fun strings(array: JSONArray?): List<String> =
    if (array == null) emptyList() else (0 until array.length()).map { array.getString(it) }

  private fun tracks(array: JSONArray): List<MediaTrack> = (0 until array.length()).map { track(array.getJSONObject(it)) }

  private fun variants(array: JSONArray): List<VideoVariant> =
    (0 until array.length()).map {
      val v = array.getJSONObject(it)
      VideoVariant(v.getString("id"), intOrNull(v, "height"), longOrNull(v, "bitrate"), v.optBoolean("audioOnly", false))
    }

  private fun source(step: JSONObject, h: EngineHarness, refreshable: Boolean) =
    SourceDescriptor(
      step.getString("uri"),
      emptyMap(),
      if (step.has("live")) step.getBoolean("live") else null,
      renditions = renditions(step.optJSONArray("renditions")),
      refreshable = refreshable,
      expiresAt = longOrNull(step, "expiresIn")?.let { h.clock.wallMs + it },
    )

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
        if (step.getString("native") == "playing" && gen == h.driver.swapGeneration) {
          h.driver.completeSwap()
          h.engine.onPlaying(gen)
          return
        }
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
            h.engine.onFailed(
              gen,
              PlayerError(code, "test", step.optBoolean("recoverable", false), httpStatus = intOrNull(step, "httpStatus")),
            )
          }
          "bandwidth" -> h.engine.onBandwidth(gen, step.getDouble("bps"))
          "variants" -> h.engine.onVariants(gen, variants(step.getJSONArray("variants")))
          "videoInfo" ->
            h.engine.onVideoInfo(
              gen,
              VideoInfo(step.getInt("width"), step.getInt("height"), step.optBoolean("hdr", false), text(step, "variant")),
            )
          "firstFrame" -> h.engine.onFirstFrame(gen)
          "tracks" -> h.engine.onTracks(gen, tracks(step.getJSONArray("tracks")))
          "renditionInfo" ->
            h.engine.renditionInfo(step.getInt("index"), intOrNull(step, "height"), longOrNull(step, "bitrate"))
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
          "loaded" -> h.driver.setMotion(FakeDriver.Motion.LOADED, step.optDouble("value", 0.0))
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
      step.has("route") -> h.engine.routeChanged(
        AudioRoute(
          AudioRouteKind.fromWire(step.getString("route")) ?: error("$at: bad route kind"),
          text(step, "name"),
        ),
      )
      step.has("view") -> {
        val v = step.getJSONObject("view")
        h.engine.viewChanged(
          ViewState(v.optBoolean("attached", true), v.optBoolean("visible", true), v.optInt("width", 0), v.optInt("height", 0)),
        )
      }
      step.has("pip") -> h.engine.pictureInPictureChanged(step.getBoolean("pip"))
      step.has("system") -> {
        val p = step.getJSONObject("system")
        h.engine.systemPreferencesChanged(
          SystemPreferences(strings(p.optJSONArray("languages")), p.optBoolean("captions", false), p.optBoolean("audioDescriptions", false)),
        )
      }
      step.has("fullscreen") -> h.engine.fullscreenChanged(step.getBoolean("fullscreen"))
      step.has("networkCost") -> {
        val c = step.getJSONObject("networkCost")
        h.engine.networkCostChanged(c.optBoolean("metered", false), c.optBoolean("saveData", false))
      }
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
          source(step, h, step.optBoolean("refreshable", false)),
          if (step.has("autoplay")) step.getBoolean("autoplay") else null,
          if (step.has("start")) step.getDouble("start") else null,
          // `"quality"`: an id, `null` for automatic; absent: keep the pick.
          qualityGiven = step.has("quality"),
          quality = text(step, "quality"),
        )
      "background" -> h.engine.appBackgrounded()
      "selectQuality" -> h.engine.selectQuality(text(step, "id"))
      "listenOnly" -> h.engine.setListenOnly(step.optBoolean("value", false))
      "loop" -> h.engine.setLoop(step.optBoolean("value", false))
      "sourceRefreshed" -> h.engine.sourceRefreshed(h.engine.loadId, source(step, h, true))
      "sourceRefreshFailed" -> h.engine.sourceRefreshFailed(h.engine.loadId)
      "appTracks" -> h.engine.setAppTracks(tracks(step.getJSONArray("tracks")))
      "selectAudioTrack" -> h.engine.selectAudioTrack(text(step, "id"))
      "selectTextTrack" -> h.engine.selectTextTrack(text(step, "id"))
      "subtitleDelay" -> h.engine.setSubtitleDelay(value)
      "play" -> h.engine.play()
      "pause" -> h.engine.pause()
      "stop" -> h.engine.stop()
      "reset" -> h.engine.reset()
      "release" -> h.engine.release()
      "seek" -> h.engine.seek(value, step.optBoolean("exact", false))
      "volume" -> h.engine.setVolume(value)
      "muted" -> h.engine.setMuted(step.optBoolean("value", false))
      "rate" -> h.engine.setRate(value)
      "duck" -> h.engine.setDucked(step.optBoolean("value", false))
      "foreground" -> h.engine.appForegrounded()
      "fadeTo" -> h.engine.fadeTo(value, step.getDouble("ms")) { h.recorder.fades += 1 }
      "sleep" ->
        h.engine.sleep(
          if (step.has("after") && !step.isNull("after")) step.getDouble("after") else null,
          if (step.has("fadeOut")) step.getDouble("fadeOut") else null,
        )
      "setFades" -> h.engine.setFades(step.getDouble("in"), step.getDouble("out"))
      "handoff" ->
        h.engine.handoff(
          AudioRoute(
            AudioRouteKind.fromWire(step.getString("route")) ?: error("bad route kind"),
            text(step, "name"),
          ),
          step.getString("output"),
          step.optBoolean("resume", false),
        )
      else -> fail("unknown call $call")
    }
  }

  /** A string field that may be absent or JSON-null. */
  private fun text(step: JSONObject, key: String): String? =
    if (step.has(key) && !step.isNull(key)) step.getString(key) else null

  private fun stringList(array: JSONArray): List<String> = (0 until array.length()).map { array.getString(it) }

  /**
   * Ordered commands: each entry must match (as a string prefix) a recorded
   * command at or after the previous match — a subsequence, not a run.
   */
  private fun orderedCommands(at: String, expected: List<String>, actual: List<String>) {
    var cursor = 0
    for (pattern in expected) {
      while (cursor < actual.size && !actual[cursor].startsWith(pattern)) cursor += 1
      if (cursor >= actual.size) {
        fail("$at: orderedCommands: no command starting with \"$pattern\" at or after index $cursor in $actual")
      }
      cursor += 1
    }
  }

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
        "route" -> assertEquals("$at: route", v, s.route.kind.wire)
        "routeName" -> assertEquals("$at: routeName", v, s.route.name)
        "volume" -> assertEquals("$at: volume", (v as Number).toDouble(), s.volume, 0.0)
        "sleepAt" -> assertEquals("$at: sleepAt", (v as Number?)?.toLong(), s.sleepAt?.let { it - WALL_BASE })
        "sleeps" -> assertEquals("$at: sleeps", (v as Number).toInt(), h.recorder.sleeps)
        "fades" -> assertEquals("$at: fades", (v as Number).toInt(), h.recorder.fades)
        "orderedCommands" -> orderedCommands(at, stringList(v as JSONArray), h.driver.commands)
        "video" -> videoExpect(at, s.video, v as JSONObject?)
        "qualities" -> assertEquals("$at: qualities", stringList(v as JSONArray), s.qualities.map { it.id })
        "quality" -> assertEquals("$at: quality", v, s.quality)
        "selectedQuality" -> assertEquals("$at: selectedQuality", v, s.selectedQuality)
        "wantsMediaSession" -> assertEquals("$at: wantsMediaSession", v, h.engine.wantsMediaSession)
        "wantsScreenAwake" -> assertEquals("$at: wantsScreenAwake", v, h.engine.wantsScreenAwake)
        "refreshes" -> assertEquals("$at: refreshes", stringList(v as JSONArray), h.recorder.refreshes)
        "gen" -> assertEquals("$at: gen", (v as Number).toInt(), h.engine.generation)
        "stats" -> statsExpect(at, h.engine.stats, v as JSONObject)
        else -> fail("$at: unknown expectation $key")
      }
    }
    h.driver.commands.clear()
    h.recorder.loads.clear()
    h.recorder.errors.clear()
    h.recorder.ended = 0
    h.recorder.sleeps = 0
    h.recorder.fades = 0
    h.recorder.refreshes.clear()
  }

  /** Compares the listed `status.video` fields (`tracks` as their ids). */
  private fun videoExpect(at: String, video: VideoStatus?, expected: JSONObject?) {
    if (expected == null) return assertEquals("$at: video", null, video)
    if (video == null) fail("$at: no status.video")
    val vs = video!!
    for (key in expected.keys()) {
      val want = nullable(expected, key)
      val label = "$at: video.$key"
      when (key) {
        "width" -> assertEquals(label, (want as Number?)?.toInt(), vs.width)
        "height" -> assertEquals(label, (want as Number?)?.toInt(), vs.height)
        "hdr" -> assertEquals(label, want, vs.hdr)
        "firstFrame" -> assertEquals(label, want, vs.firstFrame)
        "audioOnly" -> assertEquals(label, want, vs.audioOnly?.wire)
        "pictureInPicture" -> assertEquals(label, want, vs.pictureInPicture)
        "tracks" -> assertEquals(label, stringList(want as JSONArray), vs.tracks.map { it.id })
        "audioTrack" -> assertEquals(label, want, vs.audioTrack)
        "textTrack" -> assertEquals(label, want, vs.textTrack)
        "subtitleDelay" -> assertEquals(label, (want as Number).toDouble(), vs.subtitleDelay, 0.0)
        "fullscreen" -> assertEquals(label, want, vs.fullscreen)
        else -> fail("$at: unknown video expectation $key")
      }
    }
  }

  private fun statsExpect(at: String, stats: EngineStats, expected: JSONObject) {
    for (key in expected.keys()) {
      val want = (nullable(expected, key) as Number?)?.toLong()
      val actual =
        when (key) {
          "startupMs" -> stats.startupMs
          "rebufferCount" -> stats.rebufferCount.toLong()
          "rebufferMs" -> stats.rebufferMs
          "qualitySwitches" -> stats.qualitySwitches.toLong()
          "audioOnlySwitches" -> stats.audioOnlySwitches.toLong()
          else -> fail("$at: unknown stats expectation $key")
        }
      assertEquals("$at: stats.$key", want, actual)
    }
  }
}
