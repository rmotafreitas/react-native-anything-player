package com.anythingplayer.platform

import com.anythingplayer.core.CatalogQuery
import com.anythingplayer.core.SearchableItem
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * One catalog item: the JSON JS serialized (`src/core/system.ts`) — `id`,
 * `title`, `artist?`, `album?`, `genre?`, `artwork?`, `keywords`, `kind`,
 * `source {uri, headers?, live?, metadata}` — plus the view search reads.
 */
internal class CatalogEntry(val json: JSONObject) {
  val id: String = json.getString("id")
  val title: String = json.getString("title")
  val artist: String? = json.optNonEmpty("artist")
  val album: String? = json.optNonEmpty("album")
  val genre: String? = json.optNonEmpty("genre")
  val artwork: String? = json.optNonEmpty("artwork")
  val kind: String = json.optNonEmpty("kind") ?: "station"
  val keywords: List<String> =
    json.optJSONArray("keywords")?.let { array -> (0 until array.length()).mapNotNull { array.optString(it).takeIf { s -> s.isNotEmpty() } } } ?: emptyList()
  val source: JSONObject = json.getJSONObject("source")
  val uri: String = source.optString("uri", "")

  val searchable = SearchableItem(title, artist, album, genre, keywords, kind)
}

private fun JSONObject.optNonEmpty(key: String): String? = if (has(key) && !isNull(key)) optString(key).takeIf { it.isNotEmpty() } else null

/** A search a person (or an assistant) made. `origin` is `app`, `siri` or `assistant`. */
internal data class SearchRequest(
  val query: String,
  val title: String? = null,
  val artist: String? = null,
  val album: String? = null,
  val genre: String? = null,
  val focus: String? = null,
  val origin: String = "app",
) {
  fun toQuery() = CatalogQuery(query, title, artist, album, genre, focus)
}

/** What the store holds, as one consistent reading. */
internal data class CatalogSnapshot(
  /** The player voice requests use when the app has none. */
  val playerId: String,
  /** `PlayerOptions` (JSON, as JS sent them) that player is created with. */
  val playerOptions: JSONObject?,
  val lastPlayedId: String?,
  val items: List<CatalogEntry>,
)

/**
 * The catalog on disk (`filesDir/rnap/catalog.json`): voice assistants search
 * it while the app is not running, so it never depends on JS. Loaded lazily
 * (also by the media service with no JS in the process); written atomically
 * (a temp file, then a rename) so a kill mid-write keeps the previous catalog.
 * A file from a newer library version is read as empty and left alone until
 * the app sets a catalog again. Twin: `CatalogStore.swift`.
 */
internal class CatalogStore(private val file: File) {
  private var loaded = false
  private var playerId = DEFAULT_PLAYER_ID
  private var playerOptions: JSONObject? = null
  private var lastPlayedId: String? = null
  private var items: List<CatalogEntry> = emptyList()

  @Synchronized
  fun snapshot(): CatalogSnapshot {
    ensureLoaded()
    return CatalogSnapshot(playerId, playerOptions, lastPlayedId, items)
  }

  /** Replaces the catalog (the app's `setCatalog`) and persists it. Items without an id, title or source are skipped. */
  @Synchronized
  fun replace(newItems: List<JSONObject>, newPlayerId: String, newPlayerOptions: JSONObject?) {
    ensureLoaded()
    val entries = newItems.mapNotNull { runCatching { CatalogEntry(it) }.getOrNull() }
    val id = newPlayerId.ifEmpty { DEFAULT_PLAYER_ID }
    val last = lastPlayedId?.takeIf { played -> entries.any { it.id == played } }
    // Saved first: a failed write rejects setCatalog and keeps the previous catalog.
    write(id, newPlayerOptions, last, entries)
    items = entries
    playerId = id
    playerOptions = newPlayerOptions
    lastPlayedId = last
  }

  /** Remembers what played last: an empty request ("play something") plays it again. */
  @Synchronized
  fun played(id: String) {
    ensureLoaded()
    if (lastPlayedId == id || items.none { it.id == id }) return
    lastPlayedId = id
    // Best effort: losing "what played last" only changes an empty request.
    runCatching { write(playerId, playerOptions, id, items) }
  }

  private fun ensureLoaded() {
    if (loaded) return
    loaded = true
    if (!file.exists()) return
    try {
      val root = JSONObject(file.readText())
      if (root.optInt("version", 0) > VERSION) return
      playerId = root.optNonEmpty("playerId") ?: DEFAULT_PLAYER_ID
      playerOptions = root.optJSONObject("playerOptions")
      lastPlayedId = root.optNonEmpty("lastPlayedId")
      val array = root.optJSONArray("items") ?: JSONArray()
      items = (0 until array.length()).mapNotNull { index -> array.optJSONObject(index)?.let { runCatching { CatalogEntry(it) }.getOrNull() } }
    } catch (_: JSONException) {
      // A damaged file is an empty catalog; the next setCatalog rewrites it.
      items = emptyList()
    }
  }

  private fun write(playerId: String, playerOptions: JSONObject?, lastPlayedId: String?, items: List<CatalogEntry>) {
    val root =
      JSONObject()
        .put("version", VERSION)
        .put("playerId", playerId)
        .put("playerOptions", playerOptions ?: JSONObject.NULL)
        .put("lastPlayedId", lastPlayedId ?: JSONObject.NULL)
        .put("items", JSONArray().also { array -> items.forEach { array.put(it.json) } })
    file.parentFile?.mkdirs()
    val temp = File(file.parentFile, "${file.name}.tmp")
    FileOutputStream(temp).use {
      it.write(root.toString().toByteArray(Charsets.UTF_8))
      it.fd.sync()
    }
    // rename(2) replaces the old file in one step. Never delete it first: a
    // failure then would leave no catalog at all.
    if (!temp.renameTo(file)) {
      temp.delete()
      throw IOException("Could not save the catalog to ${file.path}.")
    }
  }

  companion object {
    /** The file format. Bump it when a field's meaning changes. */
    const val VERSION = 1
    const val DEFAULT_PLAYER_ID = "default"
  }
}
