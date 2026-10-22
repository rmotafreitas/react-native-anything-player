package anythingplayer.example

import android.content.ComponentName
import android.os.Bundle
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaControllerCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

/**
 * What Google Assistant and Gemini do, from a media client's side: browse and
 * search the catalog through the legacy MediaBrowser API, then `playFromSearch`
 * — with no JavaScript running. Needs the streams of [catalog] served on the
 * host (`python3 -m http.server`, default port 18765; `-e streamBase <url>`).
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class VoiceLibraryTest {
  companion object {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val service = ComponentName(context, "com.anythingplayer.platform.AnythingPlayerPlaybackService")
    private val base = InstrumentationRegistry.getArguments().getString("streamBase", "http://10.0.2.2:18765")
    private lateinit var browser: MediaBrowserCompat
    private lateinit var controller: MediaControllerCompat

    @BeforeClass
    @JvmStatic
    fun connect() {
      // A catalog on disk is all the service needs: no JS, no player yet.
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

    private fun catalog() =
      """{"version":1,"playerId":"default","playerOptions":null,"lastPlayedId":null,"items":[
        {"id":"jazz","title":"Jazz FM","genre":"Jazz","keywords":["Jazz Radio"],"kind":"station",
         "source":{"uri":"$base/jazz.wav","metadata":{"title":"Jazz FM","artist":"Various"}}},
        {"id":"news","title":"World News","kind":"podcast","keywords":[],
         "source":{"uri":"$base/news.wav","metadata":{"title":"World News"}}}]}"""
  }

  private fun waitForState(vararg states: Int): PlaybackStateCompat {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25)
    while (System.nanoTime() < deadline) {
      val state = controller.playbackState
      if (state != null && state.state in states) return state
      Thread.sleep(100)
    }
    throw AssertionError("playback state stayed ${controller.playbackState?.state}, wanted ${states.toList()}")
  }

  @Test
  fun test1_rootChildrenSearchAndItem() {
    assertNotNull("a library root", browser.root)
    val children = CountDownLatch(1)
    var listed = emptyList<MediaBrowserCompat.MediaItem>()
    instrumentation.runOnMainSync {
      browser.subscribe(
        browser.root,
        object : MediaBrowserCompat.SubscriptionCallback() {
          override fun onChildrenLoaded(parentId: String, items: MutableList<MediaBrowserCompat.MediaItem>) {
            listed = items
            children.countDown()
          }
        },
      )
    }
    assertTrue(children.await(10, TimeUnit.SECONDS))
    assertEquals(listOf("jazz", "news"), listed.map { it.mediaId })
    assertTrue(listed.all { it.isPlayable })
    assertEquals("Jazz FM", listed[0].description.title)

    val found = CountDownLatch(1)
    var matches = emptyList<MediaBrowserCompat.MediaItem>()
    instrumentation.runOnMainSync {
      browser.search(
        "jazz radio",
        null,
        object : MediaBrowserCompat.SearchCallback() {
          override fun onSearchResult(query: String, extras: Bundle?, items: MutableList<MediaBrowserCompat.MediaItem>) {
            matches = items
            found.countDown()
          }
        },
      )
    }
    assertTrue(found.await(10, TimeUnit.SECONDS))
    assertEquals(listOf("jazz"), matches.map { it.mediaId })

    val item = CountDownLatch(1)
    var fetched: MediaBrowserCompat.MediaItem? = null
    instrumentation.runOnMainSync {
      browser.getItem(
        "news",
        object : MediaBrowserCompat.ItemCallback() {
          override fun onItemLoaded(result: MediaBrowserCompat.MediaItem?) {
            fetched = result
            item.countDown()
          }
        },
      )
    }
    assertTrue(item.await(10, TimeUnit.SECONDS))
    assertEquals("World News", fetched?.description?.title)
  }

  @Test
  fun test2_aBarePlayStartsTheCatalogWithNothingLoaded() {
    instrumentation.runOnMainSync { controller.transportControls.play() }
    waitForState(PlaybackStateCompat.STATE_PLAYING, PlaybackStateCompat.STATE_BUFFERING)
    val title = controller.metadata?.getString(MediaMetadataCompat.METADATA_KEY_TITLE)
    assertEquals("Jazz FM", title)
  }

  @Test
  fun test3_playFromSearchSwitchesToTheBestMatch() {
    instrumentation.runOnMainSync {
      controller.transportControls.playFromSearch("play the world news", Bundle().apply { putString("android.intent.extra.focus", "vnd.android.cursor.item/*") })
    }
    waitForState(PlaybackStateCompat.STATE_PLAYING)
    assertEquals("World News", controller.metadata?.getString(MediaMetadataCompat.METADATA_KEY_TITLE))
  }

  @Test
  fun test4_aSearchWithNoMatchStartsNothingNew() {
    instrumentation.runOnMainSync { controller.transportControls.playFromSearch("zzzz qqqq", null) }
    Thread.sleep(1500)
    assertEquals("World News", controller.metadata?.getString(MediaMetadataCompat.METADATA_KEY_TITLE))
  }
}
