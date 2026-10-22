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
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import okhttp3.Request

/**
 * Sounds on Android: one [SoundPool] per sound (its `maxStreams` is the sound's
 * voices, so the pools together hold the total), decoded into memory at load.
 * No audio focus and no media session: the sounds mix with whatever plays.
 *
 * Playing, stopping and the bookkeeping run on one handler thread, so the JS
 * thread never waits for audio. Reading and downloading run on a pool, because
 * they can take a while. A new voice that finds the sound's voices busy stops
 * the oldest itself ([VoiceAllocator]), so SoundPool never has to pick.
 */
internal class SoundPoolBackend(private val context: Context) : SoundBackend {
  private class Entry(val pool: SoundPool, val poolSoundId: Int, val durationMs: Long?, voices: Int) {
    val allocator = VoiceAllocator(voices)
  }

  private val thread = HandlerThread("rnap-sound").apply { start() }
  private val handler = Handler(thread.looper)
  private val io = Executors.newCachedThreadPool { runnable -> Thread(runnable, "rnap-sound-io").apply { isDaemon = true } }

  // Handler thread only.
  private val sounds = HashMap<String, Entry>()
  private val voiceOwner = HashMap<Long, Entry>()
  private var released = false

  private val attributes =
    AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_GAME)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()

  override fun load(uri: String, voices: Int, done: (Result<LoadedSound>) -> Unit) {
    io.execute {
      var temp: File? = null
      try {
        val source = SoundUri.parse(uri)
        if (source is SoundUri.Remote) temp = download(source.url)
        val downloaded = temp
        val open = { if (downloaded != null) openFile(downloaded) else open(source) }
        // SoundPool and the retriever each read their own copy of the descriptor.
        val durationMs = open().use(::durationOf)
        val pool = SoundPool.Builder().setMaxStreams(voices).setAudioAttributes(attributes).build()
        val poolSoundId =
          try {
            open().use { decode(pool, it) }
          } catch (error: Exception) {
            pool.release()
            throw error
          }
        register(pool, poolSoundId, durationMs, voices, done)
      } catch (error: SoundException) {
        done(Result.failure(error))
      } catch (error: Exception) {
        done(Result.failure(SoundException("INTERNAL_ERROR", error.message ?: error.javaClass.simpleName, causeDescription = error.toString())))
      } finally {
        // SoundPool has decoded (or failed) by now; the downloaded copy is not needed.
        temp?.delete()
      }
    }
  }

  /** Hands the bytes to SoundPool and waits for it to decode them. */
  private fun decode(pool: SoundPool, afd: AssetFileDescriptor): Int {
    val finished = CompletableFuture<Int>()
    // Set before `load`: it can finish before `load` returns. This pool loads one sound, so any completion is ours.
    pool.setOnLoadCompleteListener { _, _, status -> finished.complete(status) }
    val poolSoundId = pool.load(afd, 1)
    val status =
      try {
        finished.get(LOAD_TIMEOUT_S, TimeUnit.SECONDS)
      } catch (_: TimeoutException) {
        -1
      }
    if (poolSoundId == 0 || status != 0) {
      throw SoundException("UNSUPPORTED_FORMAT", "Android could not decode this sound. Use a WAV, MP3, OGG or AAC file of a few seconds.")
    }
    return poolSoundId
  }

  private fun register(pool: SoundPool, poolSoundId: Int, durationMs: Long?, voices: Int, done: (Result<LoadedSound>) -> Unit) {
    val id = UUID.randomUUID().toString()
    handler.post {
      if (released) {
        pool.release()
        done(Result.failure(SoundException("PLAYER_RELEASED", "The app is shutting down.")))
      } else {
        sounds[id] = Entry(pool, poolSoundId, durationMs, voices)
        done(Result.success(LoadedSound(id, durationMs?.let { it / 1000.0 })))
      }
    }
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
    handler.post {
      sounds.remove(soundId)?.let { entry ->
        stopAll(entry)
        entry.pool.unload(entry.poolSoundId)
        entry.pool.release()
      }
      done()
    }
  }

  override fun play(soundId: String, voiceId: Long, volume: Double, rate: Double, pan: Double, loop: Boolean) {
    handler.post {
      val entry = sounds[soundId] ?: return@post
      val now = SystemClock.elapsedRealtime()
      val endsAt = SoundMath.endsAt(now, entry.durationMs, rate, loop)
      entry.allocator.begin(voiceId, now, endsAt)?.let { stolen ->
        entry.pool.stop(stolen.streamId)
        voiceOwner.remove(stolen.voiceId)
      }
      val (left, right) = SoundMath.gains(volume, pan)
      val stream = entry.pool.play(entry.poolSoundId, left, right, 1, if (loop) -1 else 0, SoundMath.rate(rate).toFloat())
      if (stream == 0) {
        entry.allocator.remove(voiceId)
      } else {
        entry.allocator.slot(voiceId)?.streamId = stream
        voiceOwner[voiceId] = entry
      }
    }
  }

  override fun setVoice(voiceId: Long, volume: Double, rate: Double, pan: Double) {
    handler.post {
      val entry = voiceOwner[voiceId] ?: return@post
      val stream = entry.allocator.slot(voiceId)?.streamId ?: return@post
      val (left, right) = SoundMath.gains(volume, pan)
      entry.pool.setVolume(stream, left, right)
      entry.pool.setRate(stream, SoundMath.rate(rate).toFloat())
    }
  }

  override fun stopVoice(voiceId: Long) {
    handler.post {
      val entry = voiceOwner.remove(voiceId) ?: return@post
      entry.allocator.remove(voiceId)?.let { entry.pool.stop(it.streamId) }
    }
  }

  override fun stopSound(soundId: String) {
    handler.post { sounds[soundId]?.let(::stopAll) }
  }

  override fun stopAll() {
    handler.post { sounds.values.forEach(::stopAll) }
  }

  private fun stopAll(entry: Entry) {
    entry.allocator.clear().forEach {
      entry.pool.stop(it.streamId)
      voiceOwner.remove(it.voiceId)
    }
  }

  override fun release() {
    handler.post {
      released = true
      sounds.values.forEach {
        stopAll(it)
        it.pool.release()
      }
      sounds.clear()
      thread.quitSafely()
    }
    io.shutdown()
  }

  private companion object {
    const val LOAD_TIMEOUT_S = 15L
  }
}
