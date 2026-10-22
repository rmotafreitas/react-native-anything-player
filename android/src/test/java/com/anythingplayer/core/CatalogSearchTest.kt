package com.anythingplayer.core

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Runs the `conformance/catalog` JSON fixtures against the Kotlin matcher. Twins: `src/__tests__/catalog.test.ts` and the Swift tests. */
class CatalogSearchTest {
  @Test
  fun normalization() {
    val cases = JSONArray(catalogFile("normalize.json").readText())
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      assertEquals(c.optString("name"), c.getJSONArray("tokens").toList(), CatalogSearch.tokenize(c.getString("text")))
    }
  }

  @Test
  fun search() {
    val spec = JSONObject(catalogFile("search.json").readText())
    val raw = spec.getJSONArray("catalog")
    val ids = mutableListOf<String>()
    val items = mutableListOf<SearchableItem>()
    for (i in 0 until raw.length()) {
      val o = raw.getJSONObject(i)
      ids.add(o.getString("id"))
      val keywords = o.optJSONArray("keywords")?.let { a -> (0 until a.length()).map { a.getString(it) } }
      items.add(
        SearchableItem(
          title = o.getString("title"),
          artist = o.textOrNull("artist"),
          album = o.textOrNull("album"),
          genre = o.textOrNull("genre"),
          keywords = keywords,
          kind = o.textOrNull("kind"),
        ),
      )
    }
    val cases = spec.getJSONArray("cases")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val r = c.getJSONObject("request")
      val request = CatalogQuery(
        query = r.optString("query") ?: "",
        title = r.textOrNull("title"),
        artist = r.textOrNull("artist"),
        album = r.textOrNull("album"),
        genre = r.textOrNull("genre"),
        focus = r.textOrNull("focus"),
      )
      val outcome = CatalogSearch.search(items, request)
      assertEquals(
        c.optString("name"),
        c.getJSONArray("expect").toList(),
        outcome.matches.map { ids[it] },
      )
      if (c.has("emptyQuery")) assertTrue(c.optString("name"), c.getBoolean("emptyQuery") == outcome.emptyQuery)
      else assertFalse(c.optString("name"), outcome.emptyQuery)
    }
  }

  companion object {
    /** The conformance files live next to the scenarios ([ConformanceTest] finds them the same way). */
    private fun catalogFile(name: String): File = File(ConformanceTest.conformanceDir, "catalog/$name")

    private fun JSONArray.toList(): List<String> = (0 until length()).map { getString(it) }

    /** A string field that may be absent or JSON-null. */
    private fun JSONObject.textOrNull(key: String): String? =
      if (has(key) && !isNull(key)) getString(key) else null
  }
}
