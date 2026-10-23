package com.anythingplayer.core

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Runs `conformance/catalog/browse.json` against the Kotlin tree builder.
 * Twins: `src/__tests__/catalog.test.ts` (group helpers) and the Swift tests.
 */
class BrowseTreeTest {
  private val spec = JSONObject(File(ConformanceTest.conformanceDir, "catalog/browse.json").readText())

  @Test
  fun segments() {
    val cases = spec.getJSONArray("segments")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      assertEquals(c.getString("group"), c.getJSONArray("segments").strings(), BrowseTree.groupSegments(c.getString("group")))
    }
    assertEquals(emptyList<String>(), BrowseTree.groupSegments(null))
  }

  @Test
  fun membership() {
    val cases = spec.getJSONArray("membership")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      assertEquals(c.toString(), c.getBoolean("in"), BrowseTree.isInGroup(c.textOrNull("itemGroup"), c.textOrNull("group")))
    }
  }

  @Test
  fun searchInAGroup() {
    val search = spec.getJSONObject("search")
    val raw = search.getJSONArray("catalog")
    val ids = (0 until raw.length()).map { raw.getJSONObject(it).getString("id") }
    val items =
      (0 until raw.length()).map {
        val o = raw.getJSONObject(it)
        SearchableItem(title = o.getString("title"), kind = o.textOrNull("kind"), group = o.textOrNull("group"))
      }
    val cases = search.getJSONArray("cases")
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val r = c.getJSONObject("request")
      val outcome = CatalogSearch.search(items, CatalogQuery(query = r.getString("query"), group = r.textOrNull("group")))
      assertEquals(c.getString("name"), c.getJSONArray("expect").strings(), outcome.matches.map { ids[it] })
    }
  }

  @Test
  fun trees() {
    val trees = spec.getJSONArray("trees")
    for (i in 0 until trees.length()) {
      val c = trees.getJSONObject(i)
      val name = c.getString("name")
      val tree = build(c)
      val children = c.getJSONObject("children")
      for (id in children.keys()) {
        val expected = children.getJSONArray(id)
        val actual = tree.children(id)
        assertNotNull("$name: $id has children", actual)
        assertEquals(
          "$name: $id",
          (0 until expected.length()).map { expected.getJSONArray(it).strings() },
          actual!!.map { listOf(if (it.isFolder) "folder" else "item", it.id, it.title) },
        )
      }
      c.optJSONObject("styles")?.let { styles ->
        for (id in styles.keys()) {
          assertEquals("$name: style of $id", styles.getString(id).uppercase(), tree.style(id).name)
        }
      }
      c.optJSONObject("artworks")?.let { artworks ->
        for (id in artworks.keys()) {
          assertEquals("$name: artwork of $id", artworks.textOrNull(id), tree.node(id)?.artwork)
        }
      }
      c.optJSONArray("missing")?.strings()?.forEach { id ->
        assertNull("$name: $id has no children", tree.children(id))
        assertTrue("$name: $id is not a folder", tree.node(id)?.isFolder != true)
      }
    }
  }

  @Test
  fun anItemKnowsItsId() {
    val tree = BrowseTree(listOf(BrowseItem("a", "A", group = "G")))
    assertEquals("a", tree.node("a")!!.itemId)
    assertFalse(tree.node("a")!!.isFolder)
    assertNull(tree.node("rnap:group:G")!!.itemId)
    assertNull(tree.node("nothing"))
  }

  private fun build(c: JSONObject): BrowseTree {
    val raw = c.getJSONArray("items")
    val items =
      (0 until raw.length()).map {
        val o = raw.getJSONObject(it)
        BrowseItem(o.getString("id"), o.getString("title"), o.optString("kind", "station"), o.textOrNull("group"), o.textOrNull("artwork"))
      }
    val o = c.optJSONObject("options") ?: JSONObject()
    val titles = o.optJSONObject("titles") ?: JSONObject()
    val defaults = BrowseTitles()
    val options =
      BrowseOptions(
        recentLimit = o.optInt("recentLimit", 0),
        favorites = o.optJSONArray("favorites")?.strings() ?: emptyList(),
        rootOrder = o.optJSONArray("rootOrder")?.strings() ?: emptyList(),
        titles = BrowseTitles(titles.optString("recent", defaults.recent), titles.optString("favorites", defaults.favorites), titles.optString("more", defaults.more)),
        rootLimit = o.optInt("rootLimit", BrowseTree.DEFAULT_ROOT_LIMIT),
        foldersOnly = o.optBoolean("foldersOnly", false),
        folderLimit = o.optInt("folderLimit", 0),
      )
    return BrowseTree(items, options, c.optJSONArray("recent")?.strings() ?: emptyList())
  }

  private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }

  private fun JSONObject.textOrNull(key: String): String? = if (has(key) && !isNull(key)) getString(key) else null
}
