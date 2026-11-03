package com.anythingplayer.core

import java.io.File
import kotlin.math.abs
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The live offset estimator against `conformance/align/offset.json` (twins: `liveOffset.test.ts`, `LiveOffsetTests.swift`). */
class LiveOffsetTest {
  @Test
  fun fixtures() {
    val cases = JSONArray(File(ConformanceTest.conformanceDir, "align/offset.json").readText())
    assertTrue(cases.length() > 0)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val name = c.getString("name")
      val estimator = LiveOffset()
      val steps = c.getJSONArray("steps")
      for (j in 0 until steps.length()) {
        val s = steps.getJSONObject(j)
        val value =
          estimator.read(
            s.getLong("t"),
            LiveOffset.Reading(
              position = s.getDouble("position"),
              edge = if (s.isNull("edge")) null else s.getDouble("edge"),
              native = if (s.isNull("native")) null else s.getDouble("native"),
              live = s.getBoolean("live"),
            ),
          )
        val expect = s.optJSONObject("expect") ?: continue
        assertEquals("$name @${s.getLong("t")}", expect.getBoolean("settled"), value.settled)
        if (expect.isNull("offset")) {
          assertNull(name, value.offset)
        } else {
          assertTrue("$name @${s.getLong("t")}: ${value.offset}", abs(value.offset!! - expect.getDouble("offset")) < 1e-6)
        }
      }
    }
  }
}
