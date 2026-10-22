package com.anythingplayer.platform

import com.anythingplayer.core.SourceDescriptor
import com.anythingplayer.core.StreamMetadata
import com.anythingplayer.core.StreamTitleFormat
import java.io.ByteArrayOutputStream
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The metadata-only reader against a real socket speaking ICY. */
class IcyMetadataReaderTest {
  private val server = ServerSocket(0)
  private val connections = CopyOnWriteArrayList<Map<String, String>>()
  private var reader: IcyMetadataReader? = null

  @After
  fun tearDown() {
    reader?.stop()
    server.close()
  }

  private fun block(title: String): ByteArray {
    val payload = "StreamTitle='$title';".toByteArray(Charsets.UTF_8)
    val length = (payload.size + 15) / 16
    return byteArrayOf(length.toByte()) + payload.copyOf(length * 16)
  }

  private fun body(metaint: Int, titles: List<String>): ByteArray {
    val out = ByteArrayOutputStream()
    titles.forEach { title ->
      out.write(ByteArray(metaint) { 7 })
      out.write(block(title))
    }
    return out.toByteArray()
  }

  /** Accepts connections in turn; each is answered with the next scripted body, then closed. */
  private fun serve(vararg bodies: ByteArray, headers: String = "icy-metaint:16\r\nicy-name:Test FM\r\nicy-genre:Jazz\r\n") {
    Thread {
      for (script in bodies) {
        val socket: Socket = try { server.accept() } catch (_: Exception) { return@Thread }
        val request = socket.getInputStream().bufferedReader()
        val seen = HashMap<String, String>()
        while (true) {
          val line = request.readLine() ?: break
          if (line.isEmpty()) break
          line.split(": ", limit = 2).takeIf { it.size == 2 }?.let { seen[it[0].lowercase()] = it[1] }
        }
        connections.add(seen)
        socket.getOutputStream().apply {
          write("ICY 200 OK\r\n$headers\r\n".toByteArray())
          write(script)
          flush()
        }
        socket.close()
      }
    }.apply { isDaemon = true }.start()
  }

  private fun read(expected: Int, onStart: (IcyMetadataReader) -> Unit = { it.start() }): List<StreamMetadata> {
    val delivered = CopyOnWriteArrayList<StreamMetadata>()
    val done = CountDownLatch(expected)
    val source = SourceDescriptor("http://127.0.0.1:${server.localPort}/live", mapOf("X-Token" to "t"), true)
    reader = IcyMetadataReader(source, "RNAP-test", StreamTitleFormat.ARTIST_TITLE) { delivered.add(it); done.countDown() }
    onStart(reader!!)
    assertTrue("timed out with ${delivered.size} of $expected", done.await(10, TimeUnit.SECONDS))
    return delivered
  }

  @Test
  fun `titles come out of the stream, with the station from the headers`() {
    serve(body(16, listOf("Miles Davis - So What", "Coltrane - Naima")))
    val got = read(expected = 2)
    assertEquals("So What", got[0].title)
    assertEquals("Miles Davis", got[0].artist)
    assertEquals("Test FM", got[0].station)
    assertEquals("Jazz", got[0].genre)
    assertEquals("Naima", got[1].title)
    val request = connections.first()
    assertEquals("1", request["icy-metadata"])
    assertEquals("RNAP-test", request["user-agent"])
    assertEquals("t", request["x-token"])
  }

  @Test
  fun `the same title twice is delivered once`() {
    serve(body(16, listOf("A - B", "A - B", "C - D")))
    val got = read(expected = 2)
    assertEquals(listOf("B", "D"), got.map { it.title })
  }

  @Test
  fun `a dropped connection is reopened`() {
    serve(body(16, listOf("A - One")), body(16, listOf("A - Two")))
    val got = read(expected = 2)
    assertEquals(listOf("One", "Two"), got.map { it.title })
    assertEquals(2, connections.size)
  }

  @Test
  fun `a server without ICY ends the reader instead of retrying`() {
    serve(ByteArray(64), headers = "content-type:audio/mpeg\r\n")
    reader = IcyMetadataReader(SourceDescriptor("http://127.0.0.1:${server.localPort}/live"), "RNAP-test", StreamTitleFormat.ARTIST_TITLE) { }
    reader!!.start()
    Thread.sleep(1_500)
    assertEquals(1, connections.size)
  }
}
