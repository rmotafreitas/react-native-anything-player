package com.anythingplayer.platform

import android.provider.MediaStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AssistantIntentsTest {
  @Test
  fun `what the assistant understood becomes the request's focus`() {
    assertEquals("song", AssistantIntents.focus(MediaStore.Audio.Media.ENTRY_CONTENT_TYPE))
    assertEquals("artist", AssistantIntents.focus(MediaStore.Audio.Artists.ENTRY_CONTENT_TYPE))
    assertEquals("album", AssistantIntents.focus(MediaStore.Audio.Albums.ENTRY_CONTENT_TYPE))
    assertEquals("genre", AssistantIntents.focus(MediaStore.Audio.Genres.ENTRY_CONTENT_TYPE))
    assertEquals("playlist", AssistantIntents.focus(MediaStore.Audio.Playlists.ENTRY_CONTENT_TYPE))
    assertEquals("any", AssistantIntents.focus("vnd.android.cursor.item/*"))
    assertNull(AssistantIntents.focus(null))
    assertNull(AssistantIntents.focus(""))
  }

  @Test
  fun `an intent's fields become an assistant request`() {
    val request =
      AssistantIntents.request(" jazz radio ", MediaStore.Audio.Genres.ENTRY_CONTENT_TYPE, "", "Miles Davis", " Kind of Blue", "Jazz")
    assertEquals(
      SearchRequest(
        query = "jazz radio",
        title = null,
        artist = "Miles Davis",
        album = "Kind of Blue",
        genre = "Jazz",
        focus = "genre",
        origin = "assistant",
      ),
      request,
    )
  }

  @Test
  fun `a request with nothing in it is an empty query`() {
    val request = AssistantIntents.request(null, null, null, null, null, null)
    assertEquals(SearchRequest(query = "", origin = "assistant"), request)
    assertEquals("", request.toQuery().query)
  }

  @Test
  fun `the query carries the structured fields to the matcher`() {
    val query = AssistantIntents.request("blue", MediaStore.Audio.Albums.ENTRY_CONTENT_TYPE, null, "Miles", null, null).toQuery()
    assertEquals("blue", query.query)
    assertEquals("Miles", query.artist)
    assertEquals("album", query.focus)
  }
}
