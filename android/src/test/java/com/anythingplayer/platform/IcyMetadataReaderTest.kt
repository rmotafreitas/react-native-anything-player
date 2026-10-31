package com.anythingplayer.platform

import com.anythingplayer.core.SourceDescriptor
import com.anythingplayer.core.StreamMetadata
import com.anythingplayer.core.StreamTitleFormat
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The metadata-only reader against a real socket speaking ICY. */
class IcyMetadataReaderTest {
  /**
   * On the IPv4 loopback only, where the reader connects: on all interfaces,
   * other software that probes new local ports (seen: a dev tool on `[::1]`)
   * would take a scripted answer and count as a reconnect.
   */
  private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
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

  /**
   * Answers the reader's connections in turn, each with the next scripted
   * body, then closes it. Each connection is handled on its own thread, and
   * anything without the reader's User-Agent is turned away uncounted: other
   * software probing new local ports (seen: a Node tool) may connect and
   * never send its request, which must not hold up the reader's.
   */
  private fun serve(vararg bodies: ByteArray, headers: String = "icy-metaint:16\r\nicy-name:Test FM\r\nicy-genre:Jazz\r\n") {
    val next = AtomicInteger()
    Thread {
      while (next.get() < bodies.size) {
        val socket: Socket = try { server.accept() } catch (_: Exception) { return@Thread }
        Thread { answer(socket, bodies, next, headers) }.apply { isDaemon = true }.start()
      }
    }.apply { isDaemon = true }.start()
  }

  private fun answer(socket: Socket, bodies: Array<out ByteArray>, next: AtomicInteger, headers: String) {
    socket.use {
      val seen = HashMap<String, String>()
      try {
        val request = it.getInputStream().bufferedReader()
        while (true) {
          val line = request.readLine() ?: break
          if (line.isEmpty()) break
          line.split(": ", limit = 2).takeIf { parts -> parts.size == 2 }?.let { parts -> seen[parts[0].lowercase()] = parts[1] }
        }
      } catch (_: java.io.IOException) {
        return
      }
      if (seen["user-agent"] != "RNAP-test") return
      val index = next.getAndIncrement()
      if (index >= bodies.size) return
      connections.add(seen)
      it.getOutputStream().apply {
        write("ICY 200 OK\r\n$headers\r\n".toByteArray())
        write(bodies[index])
        flush()
      }
    }
  }

  private fun read(
    expected: Int,
    headers: Map<String, String> = mapOf("X-Token" to "t"),
    onStart: (IcyMetadataReader) -> Unit = { it.start() },
  ): List<StreamMetadata> {
    val delivered = CopyOnWriteArrayList<StreamMetadata>()
    val done = CountDownLatch(expected)
    val source = SourceDescriptor("http://127.0.0.1:${server.localPort}/live", headers, true)
    reader = IcyMetadataReader(source, "RNAP-test", StreamTitleFormat.ARTIST_TITLE) { delivered.add(it); done.countDown() }
    onStart(reader!!)
    val finished = done.await(10, TimeUnit.SECONDS)
    assertTrue("timed out with ${delivered.size} of $expected", finished)
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
  fun `an app's Icy-MetaData header cannot switch the metadata off`() {
    serve(body(16, listOf("Miles Davis - So What")))
    read(expected = 1, headers = mapOf("icy-metadata" to "0", "X-Token" to "t"))
    assertEquals("1", connections[0]["icy-metadata"])
    assertEquals("t", connections[0]["x-token"])
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
    // A second connection would be served too: it must not happen.
    serve(ByteArray(64), ByteArray(64), headers = "content-type:audio/mpeg\r\n")
    reader = IcyMetadataReader(SourceDescriptor("http://127.0.0.1:${server.localPort}/live"), "RNAP-test", StreamTitleFormat.ARTIST_TITLE) { }
    reader!!.start()
    Thread.sleep(2_500)
    assertEquals(1, connections.size)
  }
}
