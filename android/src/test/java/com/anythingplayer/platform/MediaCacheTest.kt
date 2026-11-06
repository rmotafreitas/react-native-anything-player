package com.anythingplayer.platform

import androidx.media3.common.StreamKey
import org.junit.Assert.assertEquals
import org.junit.Test

/** A download keeps one quality of an adaptive source. */
class MediaCacheTest {
  @Test
  fun `HLS - the highest-bandwidth variant and the first audio rendition`() {
    val text =
      """
      #EXTM3U
      #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/en.m3u8"
      #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="pt",URI="audio/pt.m3u8"
      #EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="a"
      low.m3u8
      #EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=900000,BANDWIDTH=4000000,AUDIO="a"
      high.m3u8
      #EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="a"
      mid.m3u8
      """.trimIndent()
    assertEquals(listOf(StreamKey(0, 1), StreamKey(1, 0)), MediaCache.hlsKeys(text))
    assertEquals(emptyList<StreamKey>(), MediaCache.hlsKeys("#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n"))
  }

  @Test
  fun `DASH - per period, the best video representation and the first audio one`() {
    val text =
      """
      <MPD xmlns="urn:mpeg:dash:schema:mpd:2011">
        <Period>
          <AdaptationSet contentType="video">
            <Representation id="v1" bandwidth="1000000"/>
            <Representation id="v2" bandwidth="5000000"/>
          </AdaptationSet>
          <AdaptationSet mimeType="audio/mp4">
            <Representation id="a1" bandwidth="128000"/>
            <Representation id="a2" bandwidth="64000"/>
          </AdaptationSet>
          <AdaptationSet mimeType="audio/mp4"><Representation id="a3" bandwidth="96000"/></AdaptationSet>
          <AdaptationSet mimeType="text/vtt"><Representation id="t" bandwidth="1"/></AdaptationSet>
        </Period>
        <Period>
          <AdaptationSet><Representation mimeType="video/mp4" bandwidth="2"/><Representation mimeType="video/mp4" bandwidth="1"/></AdaptationSet>
        </Period>
      </MPD>
      """.trimIndent()
    assertEquals(listOf(StreamKey(0, 0, 1), StreamKey(0, 1, 0), StreamKey(1, 0, 0)), MediaCache.dashKeys(text))
  }
}
