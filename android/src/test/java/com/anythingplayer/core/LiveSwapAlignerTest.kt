package com.anythingplayer.core

import java.io.File
import java.util.Locale
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs `conformance/quality/live-align.json`. */
class LiveSwapAlignerTest {
  private fun reading(list: JSONArray) =
    LiveSwapAligner.Reading(
      list.getDouble(0),
      list.getDouble(1),
      if (list.length() > 2) list.getBoolean(2) else true,
      if (list.length() > 3) list.getInt(3) else 0,
    )

  private fun name(step: LiveSwapAligner.Step) =
    when (step) {
      LiveSwapAligner.Step.Measure -> "measure"
      LiveSwapAligner.Step.Hold -> "hold"
      LiveSwapAligner.Step.Play -> "play"
      is LiveSwapAligner.Step.Steer -> "steer:" + String.format(Locale.ROOT, "%.2f", step.rate)
      is LiveSwapAligner.Step.Fallback -> "fallback"
    }

  @Test
  fun cases() {
    val cases = JSONArray(File(ConformanceTest.conformanceDir, "quality/live-align.json").readText())
    assertTrue(cases.length() >= 5)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val aligner = LiveSwapAligner(startedAt = 0)
      val readings = c.getJSONArray("readings")
      val expect = c.getJSONArray("expect")
      for (j in 0 until readings.length()) {
        val r = readings.getJSONObject(j)
        val step = aligner.step(r.getLong("t"), reading(r.getJSONArray("old")), reading(r.getJSONArray("new")))
        assertEquals("${c.getString("name")} › reading $j", expect.getString(j), name(step))
      }
    }
  }
}
