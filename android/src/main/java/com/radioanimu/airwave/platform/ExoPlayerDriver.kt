package com.radioanimu.airwave.platform

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Metadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.metadata.icy.IcyInfo
import androidx.media3.extractor.metadata.id3.TextInformationFrame
import com.radioanimu.airwave.core.EngineDriver
import com.radioanimu.airwave.core.InterruptionReason
import com.radioanimu.airwave.core.OpenRequest
import com.radioanimu.airwave.core.PlaybackSample
import com.radioanimu.airwave.core.PlayerError
import com.radioanimu.airwave.core.ReadyInfo
import com.radioanimu.airwave.core.IcyParser
import com.radioanimu.airwave.core.StreamMetadata
import com.radioanimu.airwave.core.StreamTitleFormat
import java.io.File

/** What the ExoPlayer adapter reports, always tagged with the generation it belongs to. */
internal interface DriverObserver {
  fun onReady(generation: Int, info: ReadyInfo)
  fun onPlaying(generation: Int)
  fun onBuffering(generation: Int)
  fun onEnded(generation: Int)
  fun onFailed(generation: Int, error: PlayerError)
  fun onPausedExternally(generation: Int, reason: InterruptionReason)
  fun onStreamMetadata(generation: Int, metadata: StreamMetadata)
  fun isOffline(): Boolean
}

/** Extra readings for the progress snapshot (not needed by the engine). */
internal data class ProgressReading(
  val position: Double,
  val buffered: Double,
  val duration: Double?,
  /** Seconds behind the live edge, when the platform can measure it. */
  val liveOffset: Double?,
  val isPlaying: Boolean,
  val rate: Double,
)

private const val MEDIA_ID_PREFIX = "airwave:"
/** Circuit breaker for live continuations (see `maybeQueueContinuation`). */
private const val MAX_CONTINUATIONS_PER_WINDOW = 4
private const val CONTINUATION_WINDOW_MS = 10_000L

/**
 * [EngineDriver] over one ExoPlayer instance. Main-thread only (ExoPlayer's
 * application looper is the thread it is built on — the main looper here).
 *
 * Stale protection: every open sets a media item whose id carries the engine
 * generation; each callback reads the generation from the *current* item, so
 * the engine can drop anything that belongs to an older open. ExoPlayer itself
 * masks internal events from operations that were superseded.
 *
 * Audio focus is NOT handled by ExoPlayer: one app-wide coordinator owns it
 * (several players share one focus), and every resume must go through the
 * engine (live-edge policy). Becoming-noisy IS handled by ExoPlayer (it
 * pauses on the broadcast) and reported as a system pause.
 */
@OptIn(UnstableApi::class)
internal class ExoPlayerDriver(
  private val context: Context,
  private val speech: Boolean,
  private val titleFormat: StreamTitleFormat,
  private val observer: DriverObserver,
) : EngineDriver {
  private var player: ExoPlayer? = null
  /**
   * ExoPlayer invokes some listeners synchronously from inside commands
   * (`setPlayWhenReady` → `onIsPlayingChanged`). Observations are therefore
   * posted to the next main-loop turn so the engine never sees one in the
   * middle of its own command. FIFO order is kept; the generation travels
   * with each observation, so staleness is still checked by the engine.
   */
  private val main = Handler(Looper.getMainLooper())
  /** Decoded-PCM tap for visualizers (installed always, silent until enabled). */
  val sampler = AudioSampler(context)
  private var generation = 0
  private var readyGeneration = -1
  private var playedGeneration = -1
  private var volume = 1f
  private var rate = 1f
  private var stationName: String? = null
  private var stationGenre: String? = null
  private var lastStream: StreamMetadata? = null
  private var currentRequest: OpenRequest? = null
  /** HTTP calls per playlist item (media id), cancelled when the item goes. */
  private val itemCalls = LinkedHashMap<String, CallRegistry>()
  private var continuationCount = 0
  private val continuationTimes = ArrayDeque<Long>()

  private val listener =
    object : Player.Listener {
      override fun onPlaybackStateChanged(playbackState: Int) {
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        when (playbackState) {
          Player.STATE_READY -> reportReady(p, gen)
          Player.STATE_BUFFERING -> if (p.playWhenReady && readyGeneration == gen) report { observer.onBuffering(gen) }
          Player.STATE_ENDED -> report { observer.onEnded(gen) }
          else -> Unit
        }
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        if (isPlaying) {
          reportReady(p, gen)
          playedGeneration = gen
          report { observer.onPlaying(gen) }
        } else if (p.playWhenReady && p.playbackState == Player.STATE_BUFFERING) {
          report { observer.onBuffering(gen) }
        }
      }

      override fun onPlayerError(error: PlaybackException) {
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        report { observer.onFailed(gen, mapPlaybackException(error, observer.isOffline(), playedGeneration == gen)) }
      }

      override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_AUDIO_BECOMING_NOISY) {
          report { observer.onPausedExternally(gen, InterruptionReason.OUTPUT_DISCONNECTED) }
        }
      }

      override fun onIsLoadingChanged(isLoading: Boolean) {
        if (!isLoading) maybeQueueContinuation()
      }

      override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
        // A continuation took over seamlessly: drop the finished item.
        val p = player ?: return
        if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO && p.currentMediaItemIndex > 0) {
          p.removeMediaItems(0, p.currentMediaItemIndex)
          cancelCallsExcept((0 until p.mediaItemCount).map { p.getMediaItemAt(it).mediaId }.toSet())
        }
        // Queueing may have been deferred by the "two ahead" guard while the
        // queued connections had already ended: re-evaluate now.
        if (!p.isLoading) maybeQueueContinuation()
      }

      override fun onMediaMetadataChanged(mediaMetadata: MediaMetadata) {
        // ICY response headers (icy-name / icy-genre) surface here as station/genre.
        val station = mediaMetadata.station?.toString()?.trim()?.ifEmpty { null }
        val genre = mediaMetadata.genre?.toString()?.trim()?.ifEmpty { null }
        if (station == stationName && genre == stationGenre) return
        stationName = station
        stationGenre = genre
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        val base = lastStream ?: StreamMetadata()
        publish(gen, base.copy(station = station ?: base.station, genre = genre ?: base.genre))
      }

      override fun onMetadata(metadata: Metadata) {
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        var merged: StreamMetadata? = null
        for (i in 0 until metadata.length()) {
          when (val entry = metadata.get(i)) {
            is IcyInfo -> merged = IcyParser.metadataFromBlock(entry.rawMetadata, titleFormat)
            is TextInformationFrame -> {
              val value = entry.values.firstOrNull()?.trim()?.ifEmpty { null } ?: continue
              val base = merged ?: StreamMetadata()
              merged =
                when (entry.id) {
                  "TIT2", "TT2" -> base.copy(title = value, raw = base.raw + (entry.id to value))
                  "TPE1", "TP1" -> base.copy(artist = value, raw = base.raw + (entry.id to value))
                  "TALB", "TAL" -> base.copy(album = value, raw = base.raw + (entry.id to value))
                  else -> base.copy(raw = base.raw + (entry.id to value))
                }
            }
            else -> Unit
          }
        }
        merged?.let { publish(gen, it.copy(station = it.station ?: stationName, genre = it.genre ?: stationGenre)) }
      }
    }

  private fun report(block: () -> Unit) {
    main.post(block)
  }

  private fun publish(gen: Int, metadata: StreamMetadata) {
    if (metadata == lastStream) return
    lastStream = metadata
    report { observer.onStreamMetadata(gen, metadata) }
  }

  /** Builds the ExoPlayer ahead of the first load (construction costs ~0.5 s). */
  fun prewarm() {
    ensurePlayer()
  }

  private fun ensurePlayer(): ExoPlayer {
    player?.let { return it }
    val attributes =
      AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(if (speech) C.AUDIO_CONTENT_TYPE_SPEECH else C.AUDIO_CONTENT_TYPE_MUSIC)
        .build()
    val created =
      ExoPlayer.Builder(context, sampler.renderersFactory(context))
        .setLooper(context.mainLooper)
        .setAudioAttributes(attributes, /* handleAudioFocus= */ false)
        .setHandleAudioBecomingNoisy(true)
        // Partial wake lock + Wi-Fi lock while playing: screen-off power saving
        // otherwise starves a live stream's loader into stalls.
        .setWakeMode(C.WAKE_MODE_NETWORK)
        // Start after 1 s of audio (default 2.5 s): radio start latency
        // matters more than the rare extra rebuffer; after a rebuffer wait
        // for 2.5 s (default 5 s) so a weak link does not flap.
        .setLoadControl(
          DefaultLoadControl.Builder()
            .setBufferDurationsMs(
              DefaultLoadControl.DEFAULT_MIN_BUFFER_MS,
              DefaultLoadControl.DEFAULT_MAX_BUFFER_MS,
              1_000,
              2_500,
            )
            .build()
        )
        .build()
    created.addListener(listener)
    created.volume = volume
    created.setPlaybackSpeed(rate)
    player = created
    return created
  }

  private fun currentGeneration(p: Player): Int? {
    val id = p.currentMediaItem?.mediaId ?: return null
    if (!id.startsWith(MEDIA_ID_PREFIX)) return null
    return id.removePrefix(MEDIA_ID_PREFIX).substringBefore(':').toIntOrNull()
  }

  private fun reportReady(p: ExoPlayer, gen: Int) {
    if (readyGeneration == gen) return
    readyGeneration = gen
    val duration = p.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.let { it / 1000.0 }
    val seekable = p.isCurrentMediaItemSeekable
    val live = p.isCurrentMediaItemLive || (duration == null && !seekable)
    report { observer.onReady(gen, ReadyInfo(duration, live, seekable)) }
  }

  // ── EngineDriver ──

  override fun open(request: OpenRequest) {
    val p = ensurePlayer()
    // Close the previous item's sockets now, even a read blocked on a dead one.
    cancelCallsExcept(emptySet())
    generation = request.generation
    currentRequest = request
    continuationCount = 0
    continuationTimes.clear()
    readyGeneration = -1
    lastStream = null
    stationName = null
    stationGenre = null
    val mediaSource = buildMediaSource(request, "$MEDIA_ID_PREFIX${request.generation}")
    val start = request.startPosition
    if (start != null && start > 0) {
      p.setMediaSource(mediaSource, (start * 1000).toLong())
    } else {
      p.setMediaSource(mediaSource, /* resetPosition= */ true)
    }
    p.playWhenReady = request.playWhenReady
    p.prepare()
  }

  private fun buildMediaSource(request: OpenRequest, mediaId: String): MediaSource {
    val headers = request.source.headers
    val userAgent = headers.entries.firstOrNull { it.key.equals("User-Agent", ignoreCase = true) }?.value
    val calls = CallRegistry().also { itemCalls[mediaId] = it }
    val http =
      OkHttpDataSource.Factory(calls)
        .setUserAgent(userAgent ?: Util.getUserAgent(context, "Airwave"))
        .setDefaultRequestProperties(headers.filterKeys { !it.equals("User-Agent", ignoreCase = true) })
    // CBR seeking: MP3s without a Xing/VBRI header are seekable too (like iOS).
    val extractors = DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true)
    return DefaultMediaSourceFactory(DefaultDataSource.Factory(context, http), extractors)
      .setLoadErrorHandlingPolicy(AirwaveLoadErrorPolicy())
      .createMediaSource(MediaItem.Builder().setUri(resolveUri(request.source.uri)).setMediaId(mediaId).build())
  }

  /**
   * A live stream's connection ended (server kick, proxy timeout) while the
   * buffer still holds audio: ExoPlayer would play it out and only then report
   * the end — an audible gap before any reconnect. Instead, queue a fresh
   * connection to the same stream as the next playlist item; ExoPlayer
   * pre-buffers it and transitions without a gap. Bounded by a circuit
   * breaker so a server that keeps closing cannot cause a connection storm —
   * past it the item ends normally and the engine's backoff takes over.
   */
  private fun maybeQueueContinuation() {
    val p = player ?: return
    val request = currentRequest ?: return
    val gen = currentGeneration(p) ?: return
    if (gen != generation || readyGeneration != gen || !p.playWhenReady) return
    if (!(p.isCurrentMediaItemLive || (p.duration == C.TIME_UNSET && !p.isCurrentMediaItemSeekable))) return
    if (p.playbackState != Player.STATE_READY && p.playbackState != Player.STATE_BUFFERING) return
    // Items load sequentially: "not loading" means the LAST queued item's
    // connection ended, so append after it (never more than two ahead).
    if (p.mediaItemCount - p.currentMediaItemIndex > 2 || p.playerError != null) return
    val now = android.os.SystemClock.elapsedRealtime()
    while (continuationTimes.isNotEmpty() && now - continuationTimes.first() > CONTINUATION_WINDOW_MS) continuationTimes.removeFirst()
    if (continuationTimes.size >= MAX_CONTINUATIONS_PER_WINDOW) return
    continuationTimes.addLast(now)
    continuationCount += 1
    p.addMediaSource(buildMediaSource(request, "$MEDIA_ID_PREFIX$gen:c$continuationCount"))
  }

  override fun play() {
    player?.playWhenReady = true
  }

  override fun pause() {
    player?.playWhenReady = false
  }

  override fun seek(seconds: Double) {
    player?.seekTo((seconds * 1000).toLong())
  }

  override fun releaseConnection() {
    val p = player ?: return
    p.playWhenReady = false
    p.stop()
    // A queued continuation would reconnect on the next prepare.
    if (p.mediaItemCount > 1) p.removeMediaItems(1, p.mediaItemCount)
    cancelCallsExcept((0 until p.mediaItemCount).map { p.getMediaItemAt(it).mediaId }.toSet())
    cancelAllCalls()
  }

  override fun unload() {
    val p = player ?: return
    p.playWhenReady = false
    p.stop()
    p.clearMediaItems()
    cancelCallsExcept(emptySet())
    lastStream = null
  }

  override fun setVolume(effective: Double) {
    volume = effective.toFloat().coerceIn(0f, 1f)
    player?.volume = volume
  }

  override fun setRate(rate: Double) {
    this.rate = rate.toFloat()
    player?.setPlaybackSpeed(this.rate)
  }

  override fun sample(): PlaybackSample {
    val p = player ?: return PlaybackSample()
    return PlaybackSample(p.currentPosition / 1000.0, p.bufferedPosition / 1000.0)
  }

  fun progress(): ProgressReading {
    val p = player ?: return ProgressReading(0.0, 0.0, null, null, false, rate.toDouble())
    val duration = p.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.let { it / 1000.0 }
    val offset = p.currentLiveOffset.takeIf { it != C.TIME_UNSET && it >= 0 }?.let { it / 1000.0 }
    return ProgressReading(
      p.currentPosition / 1000.0,
      p.bufferedPosition / 1000.0,
      duration,
      offset,
      p.isPlaying,
      rate.toDouble(),
    )
  }

  /** Destroys the native player (frees codecs, sockets and wake locks). */
  fun destroy() {
    player?.removeListener(listener)
    player?.release()
    player = null
    cancelCallsExcept(emptySet())
  }

  /** Retires the HTTP calls of every item not in [keep]: those items are gone. */
  private fun cancelCallsExcept(keep: Set<String>) {
    val gone = itemCalls.keys.filter { it !in keep }
    gone.forEach { itemCalls.remove(it)?.cancelAll(retire = true) }
  }

  /** Closes every socket of this player; kept items can still be prepared again. */
  private fun cancelAllCalls() {
    itemCalls.values.forEach { it.cancelAll(retire = false) }
  }

  private fun resolveUri(uri: String): Uri {
    val lower = uri.lowercase()
    return when {
      lower.startsWith("/") -> Uri.fromFile(File(uri))
      lower.contains("://") || lower.startsWith("content:") || lower.startsWith("android.resource:") -> Uri.parse(uri)
      else -> {
        // A React Native release asset (`require('./a.mp3')`) is a raw resource name.
        @Suppress("DiscouragedApi")
        val id = context.resources.getIdentifier(uri, "raw", context.packageName)
        if (id != 0) Uri.Builder().scheme("android.resource").authority(context.packageName).path(id.toString()).build() else Uri.parse(uri)
      }
    }
  }
}
