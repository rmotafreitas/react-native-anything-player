package com.anythingplayer.core

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs `conformance/catalog/same-media.json` (shared with Swift and the web). */
class SameMediaTest {
  private fun source(json: JSONObject): SourceDescriptor {
    val files = json.optJSONArray("renditions")
    return SourceDescriptor(
      json.getString("uri"),
      renditions = files?.let { list -> (0 until list.length()).map { Rendition(list.getString(it)) } },
    )
  }

  @Test
  fun cases() {
    val cases = JSONArray(File(ConformanceTest.conformanceDir, "catalog/same-media.json").readText())
    assertTrue(cases.length() > 3)
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      assertEquals(c.getString("name"), c.getBoolean("same"), source(c.getJSONObject("a")).sameMedia(source(c.getJSONObject("b"))))
    }
  }
}
