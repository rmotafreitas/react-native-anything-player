package com.anythingplayer.core

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

/** The native subtitle pieces against `conformance/subtitles/` and `conformance/tracks/`. */
class SubtitleTest {
  private fun load(name: String) = JSONArray(File(ConformanceTest.conformanceDir, name).readText())

  private fun objects(array: JSONArray): List<JSONObject> = (0 until array.length()).map { array.getJSONObject(it) }

  private fun hex(value: String): ByteArray = ByteArray(value.length / 2) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

  @Test
  fun charsets() {
    for (c in objects(load("subtitles/charset.json"))) {
      assertEquals(c.getString("name"), c.getString("expect"), SubtitleCharset.detect(hex(c.getString("hex"))))
    }
  }

  @Test
  fun schedule() {
    for (c in objects(load("subtitles/schedule.json"))) {
      val pairs = c.getJSONArray("cues")
      val cues = (0 until pairs.length()).map { CueTime(pairs.getJSONArray(it).getDouble(0), pairs.getJSONArray(it).getDouble(1)) }
      for (check in objects(c.getJSONArray("checks"))) {
        val position = check.getDouble("position")
        val delay = check.optDouble("delay", 0.0)
        val label = "${c.getString("name")} @ $position"
        val active = check.getJSONArray("active")
        assertEquals(label, (0 until active.length()).map { active.getInt(it) }, CueSchedule.active(cues, position, delay))
        val next = if (check.isNull("next")) null else check.getDouble("next")
        assertEquals(label, next, CueSchedule.nextChange(cues, position, delay))
      }
    }
  }

  @Test
  fun trackChoice() {
    for (c in objects(load("tracks/select.json"))) {
      val p = c.getJSONObject("preferences")
      fun strings(key: String) = p.getJSONArray(key).let { a -> (0 until a.length()).map { a.getString(it) } }
      val preferences =
        TrackPreferences(
          languages = strings("languages"),
          followSystem = p.getBoolean("followSystem"),
          systemLanguages = strings("systemLanguages"),
          systemCaptions = p.getBoolean("systemCaptions"),
          systemAudioDescriptions = p.getBoolean("systemAudioDescriptions"),
        )
      val tracks = objects(c.getJSONArray("tracks")).map { track(it) }
      val expect = c.getJSONObject("expect")
      fun id(key: String) = if (expect.isNull(key)) null else expect.getString(key)
      assertEquals(c.getString("name"), TrackChoice(id("audio"), id("text")), TrackSelection.select(tracks, preferences))
    }
  }
}
