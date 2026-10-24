package com.anythingplayer.platform

import com.anythingplayer.core.IcyDeinterleaver
import com.anythingplayer.core.IcyParser
import com.anythingplayer.core.SourceDescriptor
import com.anythingplayer.core.StreamMetadata
import com.anythingplayer.core.StreamTitleFormat
import java.io.IOException
import java.io.InputStream
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request

/** Waits between reconnects while the stream keeps failing; the last value repeats. */
private val RECONNECT_DELAYS_MS = longArrayOf(1_000, 2_000, 4_000, 8_000, 15_000, 30_000)
private const val CHUNK_BYTES = 8 * 1024

/**
 * Reads a live stream's titles on a connection of its own, discarding the
 * audio — for the time a Cast receiver plays the stream and the phone would
 * otherwise never see its ICY metadata. It reconnects with a backoff for as
 * long as it runs and never reports a failure: a broken reader leaves the
 * receiver (and the player) untouched. A server without ICY support ends it.
 *
 * [deliver] is called on the reader's thread, once per distinct title.
 */
internal class IcyMetadataReader(
  private val source: SourceDescriptor,
  private val userAgent: String,
  private val format: StreamTitleFormat,
  private val client: OkHttpClient = HttpConnections.client,
  private val deliver: (StreamMetadata) -> Unit,
) {
  private enum class Outcome { NO_ICY, STREAMED_TITLES, FAILED }

  @Volatile private var stopped = false
  @Volatile private var call: Call? = null
  private var thread: Thread? = null
  private var last: StreamMetadata? = null

  fun start() {
    thread = Thread(::loop, "rnap-icy").apply {
      isDaemon = true
      start()
    }
  }

  /** Closes the connection now (a read blocked on a dead socket included). */
  fun stop() {
    stopped = true
    call?.cancel()
    thread?.interrupt()
  }

  private fun loop() {
    var failures = 0
    while (!stopped) {
      val outcome =
        try {
          readOnce()
        } catch (_: IOException) {
          Outcome.FAILED
        } catch (_: RuntimeException) {
          // Never let a malformed response end the thread with an exception.
          Outcome.FAILED
        }
      if (stopped || outcome == Outcome.NO_ICY) return
      failures = if (outcome == Outcome.STREAMED_TITLES) 0 else failures + 1
      try {
        Thread.sleep(RECONNECT_DELAYS_MS[minOf(failures, RECONNECT_DELAYS_MS.size - 1)])
      } catch (_: InterruptedException) {
        return
      }
    }
  }

  private fun readOnce(): Outcome {
    val builder = Request.Builder().url(source.uri).header("Icy-MetaData", "1").header("User-Agent", userAgent)
    // The reader exists for the metadata: an app's `Icy-MetaData: 0` must not switch it off.
    source.headers.forEach { (key, value) ->
      if (!key.equals("User-Agent", ignoreCase = true) && !key.equals("Icy-MetaData", ignoreCase = true)) builder.header(key, value)
    }
    val call = client.newCall(builder.build())
    this.call = call
    if (stopped) call.cancel()
    call.execute().use { response ->
      if (!response.isSuccessful) return Outcome.FAILED
      val metaint = response.header("icy-metaint")?.toIntOrNull()?.takeIf { it > 0 } ?: return Outcome.NO_ICY
      val base =
        StreamMetadata(
          station = response.header("icy-name")?.trim()?.ifEmpty { null },
          genre = response.header("icy-genre")?.trim()?.ifEmpty { null },
        )
      // The station and genre ride along with each title: sent alone they would blank the title on screen.
      val stream = response.body?.byteStream() ?: return Outcome.FAILED
      return if (readTitles(stream, IcyDeinterleaver(metaint), base)) Outcome.STREAMED_TITLES else Outcome.FAILED
    }
  }

  /** Reads the body until it ends or the reader stops; whether any title came out of it. */
  private fun readTitles(stream: InputStream, framing: IcyDeinterleaver, base: StreamMetadata): Boolean {
    val buffer = ByteArray(CHUNK_BYTES)
    var titles = false
    while (!stopped) {
      val read = stream.read(buffer)
      if (read < 0) break
      for (block in framing.consume(buffer, read).blocks) {
        val metadata = IcyParser.metadataFromBlock(block.bytes, format)
        if (metadata.isEmpty) continue
        emit(metadata.copy(station = metadata.station ?: base.station, genre = metadata.genre ?: base.genre))
        titles = true
      }
    }
    return titles
  }

  private fun emit(metadata: StreamMetadata) {
    if (metadata == last || stopped) return
    last = metadata
    deliver(metadata)
  }
}
