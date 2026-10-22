package com.anythingplayer.sound

import android.content.Context
import android.content.res.AssetFileDescriptor
import android.media.AudioAttributes
import android.media.MediaMetadataRetriever
import android.media.SoundPool
import android.net.Uri
import android.os.Handler
import android.os.HandlerThread
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import com.anythingplayer.platform.HttpConnections
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Request

/**
 * Sounds on Android: one [SoundPool] shared by every sound, with at most
 * [MAX_STREAMS] streams at once, each sound decoded into memory at load. (A
 * pool per sound would give every sound its own decoding threads.) No audio
 * focus and no media session: the sounds mix with whatever plays.
 *
 * Playing, stopping and the bookkeeping run on one handler thread, so the JS
 * thread never waits for audio. Reading and downloading run on a pool, because
 * they can take a while. A sound's voice limit, and the cap on the pool, are
 * enforced by [VoiceAllocator], which stops the oldest voice itself, so
 * SoundPool never has to pick. A load settles through [PendingLoads], so it
 * settles even when the module is invalidated while it is decoding.
 */
internal class SoundPoolBackend(private val context: Context) : SoundBackend {
  private class Entry(val sampleId: Int, val durationMs: Long?, val voices: Int)

  private val thread = HandlerThread("rnap-sound").apply { start() }
  private val handler = Handler(thread.looper)
  private val io = Executors.newCachedThreadPool { runnable -> Thread(runnable, "rnap-sound-io").apply { isDaemon = true } }
  private val loads = PendingLoads()
  private val closed = AtomicBoolean(false)

  // Handler thread only.
  private val sounds = HashMap<String, Entry>()
  private val allocator = VoiceAllocator(MAX_STREAMS)
  private var released = false

  // Created at the first load, under the lock, so a release never misses it.
  private var pool: SoundPool? = null

  // Decoding SoundPool samples, by sample id; either side may arrive first.
  private val decoding = ConcurrentHashMap<Int, CompletableFuture<Int>>()

  private val attributes =
    AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_GAME)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()

  @Synchronized
  private fun pool(): SoundPool {
    if (closed.get()) throw releasedError()
    return pool
      ?: SoundPool.Builder().setMaxStreams(MAX_STREAMS).setAudioAttributes(attributes).build().also { created ->
        created.setOnLoadCompleteListener { _, sampleId, status -> decoding.computeIfAbsent(sampleId) { CompletableFuture() }.complete(status) }
        pool = created
      }
  }

  @Synchronized private fun existingPool(): SoundPool? = pool

  @Synchronized
  private fun releasePool() {
    pool?.release()
    pool = null
  }

  private fun releasedError() = SoundException("PLAYER_RELEASED", "The app is shutting down.")

  override fun load(uri: String, voices: Int, done: (Result<LoadedSound>) -> Unit) {
    val ticket = loads.begin(done) ?: return
    try {
      io.execute { decodeAndRegister(ticket, uri, voices) }
    } catch (_: RejectedExecutionException) {
      loads.finish(ticket, Result.failure(releasedError()))
    }
  }

  private fun decodeAndRegister(ticket: Long, uri: String, voices: Int) {
    var temp: File? = null
    try {
      val source = SoundUri.parse(uri)
      if (source is SoundUri.Remote) temp = download(source.url)
      val downloaded = temp
      val open = { if (downloaded != null) openFile(downloaded) else open(source) }
      // SoundPool and the retriever each read their own copy of the descriptor.
      val durationMs = open().use(::durationOf)
      val sampleId = open().use { decode(it) }
      register(ticket, sampleId, durationMs, voices)
    } catch (error: SoundException) {
      loads.finish(ticket, Result.failure(error))
    } catch (error: Exception) {
      loads.finish(ticket, Result.failure(SoundException("INTERNAL_ERROR", error.message ?: error.javaClass.simpleName, causeDescription = error.toString())))
    } finally {
      // SoundPool has decoded (or failed) by now; the downloaded copy is not needed.
      temp?.delete()
    }
  }

  /** Hands the bytes to SoundPool and waits for it to decode them. */
  private fun decode(afd: AssetFileDescriptor): Int {
    val pool = pool()
    val sampleId = pool.load(afd, 1)
    if (sampleId == 0) throw unsupported()
    val status =
      try {
        decoding.computeIfAbsent(sampleId) { CompletableFuture() }.get(LOAD_TIMEOUT_S, TimeUnit.SECONDS)
      } catch (_: TimeoutException) {
        -1
      } finally {
        decoding.remove(sampleId)
      }
    if (status != 0) {
      pool.unload(sampleId)
      throw unsupported()
    }
    return sampleId
  }

  private fun unsupported() =
    SoundException("UNSUPPORTED_FORMAT", "Android could not decode this sound. Use a WAV, MP3, OGG or AAC file of a few seconds.")

  private fun register(ticket: Long, sampleId: Int, durationMs: Long?, voices: Int) {
    val id = UUID.randomUUID().toString()
    val accepted =
      handler.post {
        if (released) {
          loads.finish(ticket, Result.failure(releasedError()))
        } else {
          sounds[id] = Entry(sampleId, durationMs, voices)
          if (!loads.finish(ticket, Result.success(LoadedSound(id, durationMs?.let { it / 1000.0 })))) {
            // Rejected while it decoded: nobody will ever use this sound.
            sounds.remove(id)
            existingPool()?.unload(sampleId)
          }
        }
      }
    // The handler thread already quit (the module was invalidated): the pool is released with it.
    if (!accepted) loads.finish(ticket, Result.failure(releasedError()))
  }

  private fun open(source: SoundUri): AssetFileDescriptor =
    when (source) {
      is SoundUri.LocalFile -> openFile(File(source.path))
      is SoundUri.Content ->
        try {
          context.contentResolver.openAssetFileDescriptor(Uri.parse(source.uri), "r")
            ?: throw SoundException("SOURCE_NOT_FOUND", "${source.uri} could not be opened.")
        } catch (error: FileNotFoundException) {
          throw SoundException("SOURCE_NOT_FOUND", "${source.uri} was not found.", causeDescription = error.toString())
        }
      is SoundUri.RawResource -> {
        @Suppress("DiscouragedApi")
        val id = context.resources.getIdentifier(source.name, "raw", context.packageName)
        if (id == 0) throw SoundException("SOURCE_NOT_FOUND", "No bundled sound named \"${source.name}\" (res/raw).")
        context.resources.openRawResourceFd(id)
      }
      is SoundUri.Remote -> throw IllegalStateException("downloaded first")
    }

  private fun openFile(file: File): AssetFileDescriptor {
    if (!file.isFile) throw SoundException("SOURCE_NOT_FOUND", "${file.path} was not found.")
    return try {
      AssetFileDescriptor(ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY), 0, AssetFileDescriptor.UNKNOWN_LENGTH)
    } catch (error: IOException) {
      throw SoundException("SOURCE_NOT_FOUND", "${file.path} could not be opened.", causeDescription = error.toString())
    }
  }

  /** Downloads to the app's cache: SoundPool reads files, not URLs. */
  private fun download(url: String): File {
    val dir = File(context.cacheDir, "rnap-sound").apply { mkdirs() }
    val file = File(dir, "${UUID.randomUUID()}.snd")
    try {
      HttpConnections.client.newCall(Request.Builder().url(url).build()).execute().use { response ->
        if (!response.isSuccessful) {
          val missing = response.code == 404 || response.code == 410
          throw SoundException(
            if (missing) "SOURCE_NOT_FOUND" else "HTTP_ERROR",
            "The server returned HTTP ${response.code}.",
            recoverable = response.code >= 500 || response.code == 408 || response.code == 429,
            httpStatus = response.code,
          )
        }
        val body = response.body ?: throw SoundException("NETWORK_ERROR", "The server sent no body.", recoverable = true)
        file.outputStream().use { out -> body.byteStream().copyTo(out) }
      }
    } catch (error: SoundException) {
      file.delete()
      throw error
    } catch (error: IllegalArgumentException) {
      file.delete()
      throw SoundException("INVALID_SOURCE", "$url is not a valid URL.", causeDescription = error.toString())
    } catch (error: IOException) {
      file.delete()
      throw SoundException("NETWORK_ERROR", "Could not download the sound (${error.message}).", recoverable = true, causeDescription = error.toString())
    }
    return file
  }

  /** The length SoundPool does not tell; `null` when the platform cannot read it. */
  private fun durationOf(afd: AssetFileDescriptor): Long? {
    val retriever = MediaMetadataRetriever()
    return try {
      retriever.setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
      retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
    } catch (_: Exception) {
      null
    } finally {
      retriever.release()
    }
  }

  override fun unload(soundId: String, done: () -> Unit) {
    val accepted =
      handler.post {
        sounds.remove(soundId)?.let { entry ->
          stop(allocator.clear(soundId))
          existingPool()?.unload(entry.sampleId)
        }
        done()
      }
    // The module was invalidated: everything is gone already.
    if (!accepted) done()
  }

  override fun play(soundId: String, voiceId: Long, volume: Double, rate: Double, pan: Double, loop: Boolean) {
    handler.post {
      val entry = sounds[soundId] ?: return@post
      val pool = existingPool() ?: return@post
      val now = SystemClock.elapsedRealtime()
      val endsAt = SoundMath.endsAt(now, entry.durationMs, rate, loop)
      allocator.begin(soundId, entry.voices, voiceId, now, endsAt).stolen?.let { pool.stop(it.streamId) }
      val (left, right) = SoundMath.gains(volume, pan)
      val stream = pool.play(entry.sampleId, left, right, 1, if (loop) -1 else 0, SoundMath.rate(rate).toFloat())
      if (stream == 0) allocator.remove(voiceId) else allocator.slot(voiceId)?.streamId = stream
    }
  }

  override fun setVoice(voiceId: Long, volume: Double, rate: Double, pan: Double) {
    handler.post {
      val pool = existingPool() ?: return@post
      val stream = allocator.slot(voiceId)?.streamId?.takeIf { it != 0 } ?: return@post
      val (left, right) = SoundMath.gains(volume, pan)
      pool.setVolume(stream, left, right)
      pool.setRate(stream, SoundMath.rate(rate).toFloat())
    }
  }

  override fun stopVoice(voiceId: Long) {
    handler.post { allocator.remove(voiceId)?.let { existingPool()?.stop(it.streamId) } }
  }

  override fun stopSound(soundId: String) {
    handler.post { stop(allocator.clear(soundId)) }
  }

  override fun stopAll() {
    handler.post { stop(allocator.clear()) }
  }

  private fun stop(slots: List<VoiceAllocator.Slot>) {
    val pool = existingPool() ?: return
    slots.forEach { pool.stop(it.streamId) }
  }

  override fun release() {
    if (!closed.compareAndSet(false, true)) return
    // Loads still decoding fail now, whatever the worker threads do next.
    loads.close(releasedError())
    io.shutdownNow()
    if (!handler.post(::shutdown)) shutdown()
  }

  private fun shutdown() {
    released = true
    sounds.clear()
    allocator.clear()
    releasePool()
    thread.quitSafely()
  }

  private companion object {
    const val LOAD_TIMEOUT_S = 15L

    /** Streams playing at once, over every sound (a sound's `voices` go up to the same 32). */
    const val MAX_STREAMS = 32
  }
}
