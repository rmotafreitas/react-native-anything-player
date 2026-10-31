package com.anythingplayer.platform

import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class CatalogStoreTest {
  @get:Rule val folder = TemporaryFolder()

  private fun file() = File(folder.root, "rnap/catalog.json")

  private fun item(id: String, title: String, vararg extra: Pair<String, Any>) =
    JSONObject(
      """{"id":"$id","title":"$title","keywords":["Radio $title"],"kind":"station",
          "source":{"uri":"https://stream.example/$id","live":true,"headers":{"X-Token":"a"},
          "metadata":{"title":"$title"}}}"""
    ).also { json -> extra.forEach { (key, value) -> json.put(key, value) } }

  @Test
  fun `the bundled catalog answers until the app stores its own`() {
    val seed =
      JSONObject()
        .put("version", CatalogStore.VERSION)
        .put("playerId", "radio")
        .put("items", org.json.JSONArray().put(item("jazz", "Jazz FM")))
        .toString()
    var reads = 0
    val bundled = { reads++; seed }

    val fresh = CatalogStore(file(), bundled).snapshot()
    assertEquals("radio", fresh.playerId)
    assertEquals(listOf("jazz"), fresh.items.map { it.id })
    assertEquals(false, file().exists())

    // What the app stores wins, also over a restart.
    CatalogStore(file(), bundled).replace(listOf(item("news", "World News")), "main", null)
    reads = 0
    val stored = CatalogStore(file(), bundled).snapshot()
    assertEquals(listOf("news"), stored.items.map { it.id })
    assertEquals(0, reads)

    // No bundled catalog, nothing stored: empty, as before.
    file().delete()
    assertEquals(emptyList<String>(), CatalogStore(file()).snapshot().items.map { it.id })
  }

  @Test
  fun `a catalog survives a restart with its player and last played item`() {
    val store = CatalogStore(file())
    store.replace(
      listOf(item("jazz", "Jazz FM", "genre" to "Jazz", "artist" to "Various"), item("news", "World News")),
      "main",
      JSONObject("""{"mediaSession":{"commands":["next"]}}"""),
    )
    store.played("news")

    val reloaded = CatalogStore(file()).snapshot()
    assertEquals("main", reloaded.playerId)
    assertEquals("news", reloaded.lastPlayedId)
    assertEquals(listOf("jazz", "news"), reloaded.items.map { it.id })
    val jazz = reloaded.items[0]
    assertEquals("Jazz FM", jazz.title)
    assertEquals("Jazz", jazz.genre)
    assertEquals(listOf("Radio Jazz FM"), jazz.keywords)
    assertEquals("https://stream.example/jazz", jazz.uri)
    assertEquals("a", jazz.source.getJSONObject("headers").getString("X-Token"))
    assertEquals("next", reloaded.playerOptions!!.getJSONObject("mediaSession").getJSONArray("commands").getString(0))
  }

  @Test
  fun `a failed write keeps the previous catalog, in memory and on disk`() {
    val store = CatalogStore(file())
    store.replace(listOf(item("jazz", "Jazz FM")), "main", null)
    val dir = file().parentFile!!
    assertTrue(dir.setWritable(false))
    try {
      assertTrue(runCatching { store.replace(listOf(item("news", "World News")), "other", null) }.isFailure)
      assertEquals(listOf("jazz"), store.snapshot().items.map { it.id })
      assertEquals("main", store.snapshot().playerId)
    } finally {
      dir.setWritable(true)
    }
    assertEquals(listOf("jazz"), CatalogStore(file()).snapshot().items.map { it.id })
  }

  @Test
  fun `a missing file is an empty catalog with the default player`() {
    val snapshot = CatalogStore(file()).snapshot()
    assertTrue(snapshot.items.isEmpty())
    assertEquals("default", snapshot.playerId)
    assertNull(snapshot.playerOptions)
    assertNull(snapshot.lastPlayedId)
  }

  @Test
  fun `the last played item is forgotten when a new catalog drops it`() {
    val store = CatalogStore(file())
    store.replace(listOf(item("a", "A"), item("b", "B")), "default", null)
    store.played("b")
    store.replace(listOf(item("a", "A")), "default", null)
    assertNull(CatalogStore(file()).snapshot().lastPlayedId)
    store.played("zzz")
    assertNull(store.snapshot().lastPlayedId)
  }

  @Test
  fun `items without an id, a title or a source are skipped`() {
    val store = CatalogStore(file())
    store.replace(listOf(JSONObject("""{"title":"No id","source":{"uri":"x"}}"""), JSONObject("""{"id":"x","source":{"uri":"x"}}"""), JSONObject("""{"id":"y","title":"Y"}"""), item("ok", "OK")), "default", null)
    assertEquals(listOf("ok"), store.snapshot().items.map { it.id })
  }

  @Test
  fun `a catalog written by a newer version reads as empty and is left alone`() {
    file().parentFile!!.mkdirs()
    val newer = """{"version":99,"playerId":"x","items":[{"id":"a","title":"A","source":{"uri":"u"}}]}"""
    file().writeText(newer)
    val store = CatalogStore(file())
    assertTrue(store.snapshot().items.isEmpty())
    assertEquals(newer, file().readText())
    store.replace(listOf(item("a", "A")), "default", null)
    assertEquals(CatalogStore.VERSION, JSONObject(file().readText()).getInt("version"))
  }

  @Test
  fun `a damaged file reads as empty instead of crashing`() {
    file().parentFile!!.mkdirs()
    file().writeText("{\"version\":1,\"items\":[{")
    assertTrue(CatalogStore(file()).snapshot().items.isEmpty())
  }

  @Test
  fun `writes go through a temp file that does not stay behind`() {
    val store = CatalogStore(file())
    store.replace(listOf(item("a", "A")), "default", null)
    store.played("a")
    assertTrue(file().exists())
    assertFalse(File(file().parentFile, "catalog.json.tmp").exists())
  }

  @Test
  fun `an entry reads the optional fields`() {
    val entry = CatalogEntry(item("a", "A", "album" to "Alb", "kind" to "podcast", "artwork" to "https://x/a.png"))
    assertEquals("Alb", entry.album)
    assertEquals("podcast", entry.kind)
    assertEquals("https://x/a.png", entry.artwork)
    assertNull(entry.artist)
    assertEquals("podcast", entry.searchable.kind)
  }

  @Test
  fun `recent items and favorites are kept, newest first, and follow the catalog`() {
    val store = CatalogStore(file())
    val browse = JSONObject("""{"recent":2,"favorites":["b","a","gone"],"rootOrder":["Music"],"titles":{"recent":"Last"}}""")
    store.replace(listOf(item("a", "A"), item("b", "B"), item("c", "C")), "default", null, browse)
    store.played("a")
    store.played("b")
    store.played("a")
    store.played("c")
    val snapshot = CatalogStore(file()).snapshot()
    assertEquals(listOf("c", "a"), snapshot.recentIds)
    assertEquals(2, snapshot.browse.recentLimit)
    assertEquals(listOf("b", "a", "gone"), snapshot.browse.favorites)
    assertEquals(listOf("Music"), snapshot.browse.rootOrder)
    assertEquals("Last", snapshot.browse.titles.recent)
    assertEquals("Favorites", snapshot.browse.titles.favorites)

    store.replace(listOf(item("a", "A"), item("b", "B")), "default", null, browse)
    assertEquals(listOf("a"), store.snapshot().recentIds)
  }

  @Test
  fun `recent items are not kept unless the app asked`() {
    val store = CatalogStore(file())
    store.replace(listOf(item("a", "A")), "default", null)
    store.played("a")
    assertTrue(store.snapshot().recentIds.isEmpty())
    assertEquals("a", store.snapshot().lastPlayedId)
  }

  @Test
  fun `setFavorites changes the folder without touching the catalog`() {
    val store = CatalogStore(file())
    store.replace(listOf(item("a", "A"), item("b", "B")), "default", null, JSONObject("""{"recent":0,"favorites":["a"]}"""))
    val before = store.snapshot().revision
    store.setFavorites(listOf("b", "b", "zzz"))
    val after = CatalogStore(file()).snapshot()
    assertEquals(listOf("b"), after.browse.favorites)
    assertEquals(listOf("a", "b"), after.items.map { it.id })
    assertTrue(store.snapshot().revision > before)
  }

  @Test
  fun `items keep their group`() {
    val store = CatalogStore(file())
    store.replace(listOf(item("a", "A", "group" to "Podcasts/Daily")), "default", null)
    assertEquals("Podcasts/Daily", CatalogStore(file()).snapshot().items[0].group)
    assertEquals("Podcasts/Daily", store.snapshot().items[0].searchable.group)
  }
}
