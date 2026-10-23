package anythingplayer.example

import android.content.ComponentName
import android.os.Bundle
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.session.MediaControllerCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

/**
 * The browse tree of cars and watches, from a media client's side (what Android
 * Auto, Android Automotive OS and Wear OS do): folders from the catalog's
 * groups, content-style hints, a pick that plays, and the "Recently played"
 * folder that pick creates. No JavaScript runs.
 *
 * Run it alone, in a fresh process (the catalog is read once per process):
 * `./gradlew :app:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=anythingplayer.example.BrowseTreeLibraryTest`
 * with the streams served on the host (`python3 -m http.server 18765`).
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class BrowseTreeLibraryTest {
  companion object {
    /** More than the 100 children a car browser gets in one folder: this client is not a car, so it sees them all (and may page). */
    private const val BIG = 250
    private const val STYLE_PLAYABLE = "android.media.browse.CONTENT_STYLE_PLAYABLE_HINT"
    private const val STYLE_BROWSABLE = "android.media.browse.CONTENT_STYLE_BROWSABLE_HINT"
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val service = ComponentName(context, "com.anythingplayer.platform.AnythingPlayerPlaybackService")
    private val base = InstrumentationRegistry.getArguments().getString("streamBase", "http://10.0.2.2:18765")
    private lateinit var browser: MediaBrowserCompat
    private lateinit var controller: MediaControllerCompat

    @BeforeClass
    @JvmStatic
    fun connect() {
      File(context.filesDir, "rnap").mkdirs()
      File(context.filesDir, "rnap/catalog.json").writeText(catalog())
      val connected = CountDownLatch(1)
      instrumentation.runOnMainSync {
        browser =
          MediaBrowserCompat(
            context,
            service,
            object : MediaBrowserCompat.ConnectionCallback() {
              override fun onConnected() = connected.countDown()
            },
            null,
          )
        browser.connect()
      }
      assertTrue("the library service did not accept the connection", connected.await(20, TimeUnit.SECONDS))
      instrumentation.runOnMainSync { controller = MediaControllerCompat(context, browser.sessionToken) }
    }

    private fun item(id: String, title: String, kind: String, group: String?): JSONObject =
      JSONObject()
        .put("id", id)
        .put("title", title)
        .put("kind", kind)
        .put("keywords", JSONArray())
        .put("source", JSONObject().put("uri", "$base/jazz.wav").put("metadata", JSONObject().put("title", title)))
        .also { if (group != null) it.put("group", group) }

    private fun catalog(): String =
      JSONObject()
        .put("version", 1)
        .put("playerId", "default")
        .put("lastPlayedId", JSONObject.NULL)
        .put("recentIds", JSONArray())
        .put(
          "browse",
          JSONObject().put("recent", 3).put("favorites", JSONArray(listOf("rock", "gone"))).put("rootOrder", JSONArray(listOf("Podcasts"))),
        )
        .put(
          "items",
          JSONArray(
            listOf(
              item("jazz1", "Jazz FM", "station", "Music/Jazz"),
              item("jazz2", "Smooth Jazz", "station", "Music/Jazz"),
              item("rock", "Rock Radio", "station", "Music"),
              item("news", "World News", "podcast", "Podcasts"),
              item("loose", "Loose Station", "station", null),
            ) + (1..BIG).map { item("z$it", "Zoo $it", "station", "Zoo") }
          ),
        )
        .toString()
  }

  private fun children(parent: String, options: Bundle? = null): List<MediaBrowserCompat.MediaItem> {
    val loaded = CountDownLatch(1)
    var listed = emptyList<MediaBrowserCompat.MediaItem>()
    val callback =
      object : MediaBrowserCompat.SubscriptionCallback() {
        override fun onChildrenLoaded(parentId: String, items: MutableList<MediaBrowserCompat.MediaItem>) {
          listed = items
          loaded.countDown()
        }

        // A subscription with options (a page) is answered here.
        override fun onChildrenLoaded(parentId: String, items: MutableList<MediaBrowserCompat.MediaItem>, options: Bundle) = onChildrenLoaded(parentId, items)
      }
    instrumentation.runOnMainSync { if (options == null) browser.subscribe(parent, callback) else browser.subscribe(parent, options, callback) }
    assertTrue("children of $parent", loaded.await(10, TimeUnit.SECONDS))
    instrumentation.runOnMainSync { browser.unsubscribe(parent) }
    return listed
  }

  @Test
  fun test1_rootFoldersFollowTheGroups() {
    assertNotNull("a library root", browser.root)
    val root = children(browser.root)
    assertEquals(listOf("rnap:favorites", "rnap:group:Podcasts", "rnap:group:Music", "rnap:group:Zoo", "rnap:more"), root.map { it.mediaId })
    assertTrue(root.all { it.isBrowsable && !it.isPlayable })
    assertEquals(listOf("Favorites", "Podcasts", "Music", "Zoo", "More"), root.map { it.description.title.toString() })
    assertEquals(true, browser.extras?.getBoolean("android.media.browse.CONTENT_STYLE_SUPPORTED"))
  }

  @Test
  fun test2_foldersHoldSubfoldersThenItems_withContentStyleHints() {
    val music = children("rnap:group:Music")
    assertEquals(listOf("rnap:group:Music/Jazz", "rock"), music.map { it.mediaId })
    assertTrue(music[0].isBrowsable)
    assertTrue(music[1].isPlayable)

    val jazz = children("rnap:group:Music/Jazz")
    assertEquals(listOf("jazz1", "jazz2"), jazz.map { it.mediaId })
    // A folder that directly holds only stations or albums is a grid; podcasts are a list.
    val musicFolder = children(browser.root).first { it.mediaId == "rnap:group:Music" }
    assertEquals(2, musicFolder.description.extras?.getInt(STYLE_PLAYABLE))
    val jazzFolder = music[0]
    assertEquals(2, jazzFolder.description.extras?.getInt(STYLE_PLAYABLE))
    assertEquals(1, jazzFolder.description.extras?.getInt(STYLE_BROWSABLE))
    val podcasts = children(browser.root).first { it.mediaId == "rnap:group:Podcasts" }
    assertEquals(1, podcasts.description.extras?.getInt(STYLE_PLAYABLE))

    assertEquals(listOf("rock"), children("rnap:favorites").map { it.mediaId })
    assertEquals(listOf("loose"), children("rnap:more").map { it.mediaId })
  }

  @Test
  fun test3_aLongFolderIsWholeAndPagesOnRequest() {
    // This client is neither Android Auto nor Automotive, so no slicing: everything, in catalog order, or the pages it asks for.
    val all = children("rnap:group:Zoo")
    assertEquals((1..BIG).map { "z$it" }, all.map { it.mediaId })
    fun page(n: Int, size: Int) = children("rnap:group:Zoo", Bundle().apply { putInt(MediaBrowserCompat.EXTRA_PAGE, n); putInt(MediaBrowserCompat.EXTRA_PAGE_SIZE, size) })
    assertEquals((1..100).map { "z$it" }, page(0, 100).map { it.mediaId })
    assertEquals((201..BIG).map { "z$it" }, page(2, 100).map { it.mediaId })
  }

  @Test
  fun test4_aPickedItemPlaysAndJoinsRecentlyPlayed() {
    instrumentation.runOnMainSync { controller.transportControls.playFromMediaId("jazz2", null) }
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25)
    while (System.nanoTime() < deadline && controller.playbackState?.state !in listOf(PlaybackStateCompat.STATE_PLAYING, PlaybackStateCompat.STATE_BUFFERING)) {
      Thread.sleep(100)
    }
    assertTrue("playback state ${controller.playbackState?.state}", controller.playbackState?.state in listOf(PlaybackStateCompat.STATE_PLAYING, PlaybackStateCompat.STATE_BUFFERING))
    assertEquals("Smooth Jazz", controller.metadata?.getString("android.media.metadata.TITLE"))
    // The catalog file is written off the main thread: give it a moment.
    Thread.sleep(500)
    val root = children(browser.root)
    assertEquals("rnap:recent", root.first().mediaId)
    assertEquals(listOf("jazz2"), children("rnap:recent").map { it.mediaId })
  }
}
