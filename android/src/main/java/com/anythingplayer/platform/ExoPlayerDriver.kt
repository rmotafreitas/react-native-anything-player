package com.anythingplayer.platform

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.Surface
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ColorInfo
import androidx.media3.common.Format
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Metadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.DecoderReuseEvaluation
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.metadata.icy.IcyInfo
import androidx.media3.extractor.metadata.id3.TextInformationFrame
import com.anythingplayer.core.EngineDriver
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.InterruptionReason
import com.anythingplayer.core.MediaTrack
import com.anythingplayer.core.OpenRequest
import com.anythingplayer.core.PlaybackSample
import com.anythingplayer.core.PlayerError
import com.anythingplayer.core.QualityConstraints
import com.anythingplayer.core.VideoInfo
import com.anythingplayer.core.VideoVariant
import com.anythingplayer.core.ReadyInfo
import com.anythingplayer.core.IcyParser
import com.anythingplayer.core.StreamMetadata
import com.anythingplayer.core.StreamTitleFormat
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
  /**
   * A live stream's audio jumped, now audible: playback moved onto a fresh
   * connection of the same source (see `onPositionDiscontinuity`).
   * [position] is the media position (s) the new connection starts at.
   */
  fun onDiscontinuity(generation: Int, position: Double)
  fun isOffline(): Boolean

  /** Video: the picture's size, HDR, and the variant playing. */
  fun onVideoInfo(generation: Int, info: VideoInfo) {
    // Audio players have no picture.
  }

  /** Video: the first frame was rendered. */
  fun onFirstFrame(generation: Int) {
    // Audio players have no picture.
  }

  /** Video: the source's own audio and text tracks, and its variants. */
  fun onTracks(generation: Int, tracks: List<MediaTrack>, variants: List<VideoVariant>) {
    // Audio players keep their one track.
  }

  /** Video: the cues of the text track ExoPlayer renders, now. */
  fun onSourceCues(generation: Int, cues: List<OverlayCue>) {
    // Audio players show no subtitles.
  }

  /** Video: a bandwidth estimate, bits per second. */
  fun onBandwidth(generation: Int, bitsPerSecond: Double) {
    // Audio players need none.
  }

  /** A problem that does not stop playback (a video's sound it cannot decode). */
  fun onWarning(generation: Int, error: PlayerError) {
    // Nothing to tell by default.
  }

  /** The source's `drm.getLicense` must answer a key request (see [LicenseRequests]). */
  fun onLicenseRequest(generation: Int, ask: LicenseAsk) {
    LicenseRequests.cancel(ask.requestId, "Nothing can answer the license request.")
  }

  /** Video: playback jumped (a seek, a loop): subtitles place themselves again. */
  fun onPositionJump(generation: Int) {
    // Audio players show no subtitles.
  }
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

private const val MEDIA_ID_PREFIX = "anythingplayer:"
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
  /** A video player: a picture, tracks, variants and cues. */
  private val video: Boolean = false,
) : Output {
  private var player: ExoPlayer? = null
  // ── Video ──
  /** Where the picture goes (its [PictureSurface]; `null`: none yet). */
  private var surface: Surface? = null
  private var mapped: MappedTracks? = null
  private var quality: QualityConstraints? = null
  private var videoDisabled = false
  private var chosenAudio: String? = null
  private var chosenText: String? = null
  private var looping = false
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
  /** What the engine was last told about the item: a later change is told again. */
  private var reportedInfo: ReadyInfo? = null
  private var playedGeneration = -1
  private var volume = 1f
  private var rate = 1f
  private var stationName: String? = null
  private var stationGenre: String? = null
  private var lastStream: StreamMetadata? = null
  private var currentRequest: OpenRequest? = null
  /** HTTP calls per playlist item (media id), cancelled when the item goes. */
  private val itemCalls = LinkedHashMap<String, CallRegistry>()
  /** The generation whose unplayable tracks were reported (once per item). */
  private var reportedGeneration = -1
  /** The current source's DRM (`null`: a clear source), and the key system it uses here. */
  private var sourceDrm: SourceDrm? = null
  private var keySystem: KeySystem? = null
  /** License requests carry the key system's headers only, never the source's. */
  private val licenseHttp by lazy {
    OkHttpDataSource.Factory(HttpConnections.client).setUserAgent(Util.getUserAgent(context, "RNAP"))
  }
  private var continuationCount = 0
  private val continuationTimes = ArrayDeque<Long>()
  /**
   * A fresh connection playback moved onto before any of its audio could
   * play (generation, media position in s): reported once it plays.
   */
  private var pendingDiscontinuity: Pair<Int, Double>? = null

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

      // The item's duration or seek range became known, or changed (a file's
      // total read later, a playlist that ended): the engine follows.
      override fun onTimelineChanged(timeline: Timeline, reason: Int) {
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        if (readyGeneration != gen) return
        val info = readyInfo(p)
        if (info == reportedInfo) return
        reportedInfo = info
        report { observer.onReady(gen, info) }
      }

      override fun onIsPlayingChanged(isPlaying: Boolean) {
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        if (isPlaying) {
          reportReady(p, gen)
          playedGeneration = gen
          report { observer.onPlaying(gen) }
          pendingDiscontinuity?.let { (pendingGen, position) ->
            pendingDiscontinuity = null
            if (pendingGen == gen) report { observer.onDiscontinuity(gen, position) }
          }
        } else if (p.playWhenReady && p.playbackState == Player.STATE_BUFFERING) {
          report { observer.onBuffering(gen) }
        }
      }

      override fun onPlayerError(error: PlaybackException) {
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        // Past readiness ExoPlayer took the container and the codecs: a
        // decoding or parsing failure now is the pipeline's, worth a re-open.
        val pastReady = playedGeneration == gen || readyGeneration == gen
        report { observer.onFailed(gen, mapPlaybackException(error, observer.isOffline(), pastReady)) }
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

      override fun onPositionDiscontinuity(
        oldPosition: Player.PositionInfo,
        newPosition: Player.PositionInfo,
        reason: Int,
      ) {
        // Playback moved onto a fresh connection: a queued continuation took
        // over (auto transition), or the loader restarted an unseekable live
        // stream from a new connection after an error (internal). A new
        // Icecast/Shoutcast connection starts with the server's burst of
        // recent audio, so what is heard jumps — apps keeping a position
        // against the station's timeline must place it again. Reported when
        // the jump is audible, not when the connection opened: here if the new
        // connection's audio plays on, else (an outage outlasted the buffer:
        // nothing of it has arrived yet) once playback resumes.
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        if (video) report { observer.onPositionJump(gen) }
        if (reason != Player.DISCONTINUITY_REASON_AUTO_TRANSITION && reason != Player.DISCONTINUITY_REASON_INTERNAL) return
        if (playedGeneration != gen) return
        val position = newPosition.positionMs / 1000.0
        if (p.isPlaying) {
          pendingDiscontinuity = null
          report { observer.onDiscontinuity(gen, position) }
        } else {
          pendingDiscontinuity = gen to position
        }
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

      override fun onVideoSizeChanged(videoSize: VideoSize) {
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        if (!video || videoSize.width <= 0 || videoSize.height <= 0) return
        val info = videoInfo(p, videoSize)
        report { observer.onVideoInfo(gen, info) }
      }

      override fun onRenderedFirstFrame() {
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        report { observer.onFirstFrame(gen) }
      }

      override fun onTracksChanged(tracks: Tracks) {
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        if (reportUnplayable(tracks, gen)) return
        if (!video) return
        val found = ExoVideo.map(tracks)
        mapped = found
        // Picks made before the tracks were known apply now.
        applyTrackParameters()
        report { observer.onTracks(gen, found.tracks, found.variants) }
        // The variant playing, now that the variants are known.
        val format = p.videoFormat
        val size = p.videoSize.takeIf { it.width > 0 } ?: format?.takeIf { it.width > 0 }?.let { VideoSize(it.width, it.height) }
        if (size != null) report { observer.onVideoInfo(gen, videoInfo(p, size, format)) }
      }

      override fun onCues(cueGroup: CueGroup) {
        val p = player ?: return
        val gen = currentGeneration(p) ?: return
        if (!video) return
        val position = p.currentPosition / 1000.0
        val cues = cueGroup.cues.map { ExoVideo.overlayCue(it, position) }
        report { observer.onSourceCues(gen, cues) }
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
        .setContentType(
          when {
            video -> C.AUDIO_CONTENT_TYPE_MOVIE
            speech -> C.AUDIO_CONTENT_TYPE_SPEECH
            else -> C.AUDIO_CONTENT_TYPE_MUSIC
          }
        )
        .build()
    val created =
      ExoPlayer.Builder(context, sampler.renderersFactory(context, video))
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
    // Every player's bandwidth: the engine steps renditions by it (a sound's too).
    created.addAnalyticsListener(
      object : AnalyticsListener {
        override fun onBandwidthEstimate(
          eventTime: AnalyticsListener.EventTime,
          totalLoadTimeMs: Int,
          totalBytesLoaded: Long,
          bitrateEstimate: Long,
        ) {
          val gen = currentGeneration(created) ?: return
          if (bitrateEstimate > 0) report { observer.onBandwidth(gen, bitrateEstimate.toDouble()) }
        }
      },
    )
    if (video) setUpVideo(created)
    player = created
    return created
  }

  private fun setUpVideo(created: ExoPlayer) {
    surface?.let { created.setVideoSurface(it) }
    created.repeatMode = if (looping) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
    created.addAnalyticsListener(
      object : AnalyticsListener {
        // An adaptive source moved to another variant: the quality playing now.
        override fun onVideoInputFormatChanged(
          eventTime: AnalyticsListener.EventTime,
          format: Format,
          decoderReuseEvaluation: DecoderReuseEvaluation?,
        ) {
          val gen = currentGeneration(created) ?: return
          val size = created.videoSize
          val info =
            if (size.width > 0 && size.height > 0) videoInfo(created, size, format)
            else if (format.width > 0 && format.height > 0) videoInfo(created, VideoSize(format.width, format.height), format)
            else return
          report { observer.onVideoInfo(gen, info) }
        }
      },
    )
    applyTrackParameters(created)
  }

  private fun videoInfo(p: ExoPlayer, size: VideoSize, format: Format? = p.videoFormat): VideoInfo {
    val width = (size.width * size.pixelWidthHeightRatio).toInt()
    val hdr = format?.colorInfo?.let { ColorInfo.isTransferHdr(it) } ?: false
    val variant = mapped?.variantOf(format)
    return VideoInfo(width, size.height, hdr, variant)
  }

  // ── Video commands ──

  /** Renders the picture into `next` (`null`: nowhere). */
  fun attachSurface(next: Surface?) {
    if (next === surface) return
    surface = next
    player?.setVideoSurface(next)
  }

  /** The tracks ExoPlayer found in the current item (`null` until known). */
  val mappedTracks: MappedTracks?
    get() = mapped

  /** Frames the video decoder dropped in the current item, `null` before it decodes. */
  val droppedFrames: Int?
    get() = player?.videoDecoderCounters?.droppedBufferCount

  /** The picture's size in pixels (square pixels), `null` before the first frame's format. */
  val pictureSize: Pair<Int, Int>?
    get() {
      val size = player?.videoSize ?: return null
      if (size.width <= 0 || size.height <= 0) return null
      return (size.width * size.pixelWidthHeightRatio).toInt() to size.height
    }

  override fun setVideoEnabled(enabled: Boolean) {
    videoDisabled = !enabled
    applyTrackParameters()
  }

  override fun setQuality(constraints: QualityConstraints) {
    quality = constraints
    applyTrackParameters()
  }

  override fun selectTracks(audio: String?, text: String?) {
    chosenAudio = audio
    chosenText = text
    applyTrackParameters()
  }

  override fun setLoop(loop: Boolean) {
    looping = loop
    player?.repeatMode = if (loop) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
  }

  /** The caps, the pinned variant, audio only, and the engine's track picks. */
  private fun applyTrackParameters(p: ExoPlayer? = player) {
    if (p == null || !video) return
    val c = quality
    val locations = mapped?.locations ?: emptyMap()
    val audioOnly = c?.audioOnly == true || c?.pinned == ExoVideo.AUDIO_ONLY_VARIANT
    val b =
      p.trackSelectionParameters.buildUpon()
        .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, videoDisabled || audioOnly)
        .setMaxVideoSize(Int.MAX_VALUE, c?.maxHeight ?: Int.MAX_VALUE)
        .setMaxVideoBitrate(c?.maxBitrate?.coerceAtMost(Int.MAX_VALUE.toLong())?.toInt() ?: Int.MAX_VALUE)
        .clearOverridesOfType(C.TRACK_TYPE_VIDEO)
        .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
        .clearOverridesOfType(C.TRACK_TYPE_TEXT)
    // ExoPlayer renders a text track only when it is the source's: none, or an
    // app file (the overlay draws it), turns the source's text off.
    val sourceText = chosenText?.let { locations[it] }
    b.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, sourceText == null)
    c?.pinned?.let { id -> locations[id]?.let { (group, i) -> b.addOverride(TrackSelectionOverride(group, i)) } }
    chosenAudio?.let { id -> locations[id]?.let { (group, i) -> b.addOverride(TrackSelectionOverride(group, i)) } }
    sourceText?.let { (group, i) -> b.addOverride(TrackSelectionOverride(group, i)) }
    p.trackSelectionParameters = b.build()
  }

  private fun currentGeneration(p: Player): Int? {
    val id = p.currentMediaItem?.mediaId ?: return null
    if (!id.startsWith(MEDIA_ID_PREFIX)) return null
    return id.removePrefix(MEDIA_ID_PREFIX).substringBefore(':').toIntOrNull()
  }

  private fun reportReady(p: ExoPlayer, gen: Int) {
    if (readyGeneration == gen) return
    readyGeneration = gen
    val info = readyInfo(p)
    reportedInfo = info
    report { observer.onReady(gen, info) }
  }

  private fun readyInfo(p: ExoPlayer): ReadyInfo {
    val duration = p.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.let { it / 1000.0 }
    val seekable = p.isCurrentMediaItemSeekable
    val live = p.isCurrentMediaItemLive || (duration == null && !seekable)
    // A live window's length is no duration (and changes on every refresh), as on iOS.
    return ReadyInfo(if (live) null else duration, live, seekable)
  }

  // ── EngineDriver ──

  override fun open(request: OpenRequest) {
    val p = ensurePlayer()
    // Close the previous item's sockets now, even a read blocked on a dead one.
    cancelCallsExcept(emptySet())
    generation = request.generation
    currentRequest = request
    continuationCount = 0
    pendingDiscontinuity = null
    continuationTimes.clear()
    readyGeneration = -1
    reportedInfo = null
    lastStream = null
    stationName = null
    stationGenre = null
    mapped = null
    // Without Media3's DASH module a manifest would be read as a file and
    // fail as unreadable: say what is missing instead.
    if (isDashUri(request.source.uri) && !dashBuiltIn) {
      return refuse(
        p,
        request.generation,
        ErrorCode.UNSUPPORTED_FORMAT,
        "DASH is not built into this app: video apps have it, or set `rnapDash=true` in android/gradle.properties and rebuild.",
      )
    }
    sourceDrm?.close()
    sourceDrm = null
    keySystem = null
    val drm = request.source.drm
    if (drm != null) {
      val system =
        chooseKeySystem(drm, SourceDrm::isSupported)
          ?: return refuse(p, request.generation, ErrorCode.DRM_UNSUPPORTED, noKeySystemMessage(drm))
      val gen = request.generation
      keySystem = system
      sourceDrm = SourceDrm.create(drm, system, licenseHttp) { ask -> report { observer.onLicenseRequest(gen, ask) } }
    }
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

  /**
   * Tracks this device cannot play, which ExoPlayer would leave out, playing
   * the rest (or nothing) as if all were well. Encrypted ones, the picture, or
   * the sound of what has no picture fail the source; a video's sound alone
   * is reported once, and the picture plays. `true`: the source failed.
   */
  private fun reportUnplayable(tracks: Tracks, gen: Int): Boolean {
    if (reportedGeneration == gen) return false
    val picture = if (video) unplayable(tracks, C.TRACK_TYPE_VIDEO) else null
    val sound = unplayable(tracks, C.TRACK_TYPE_AUDIO)
    val hasPicture = video && tracks.groups.any { it.type == C.TRACK_TYPE_VIDEO }
    val installed = DecoderExtensions.installed
    val error =
      when {
        picture?.drm == true || sound?.drm == true -> PlayerError(ErrorCode.DRM_UNSUPPORTED, lockedOutMessage(), false)
        picture != null -> PlayerError(ErrorCode.UNSUPPORTED_FORMAT, unplayableMessage("the picture", picture, installed), false)
        sound != null && !hasPicture ->
          PlayerError(ErrorCode.UNSUPPORTED_FORMAT, unplayableMessage("the sound", sound, installed), false)
        else -> null
      }
    if (error == null && sound == null) return false
    reportedGeneration = gen
    if (error != null) {
      report { observer.onFailed(gen, error) }
      return true
    }
    val warning =
      PlayerError(ErrorCode.UNSUPPORTED_FORMAT, unplayableMessage("the sound", sound!!, installed, "The picture plays without it."), false)
    report { observer.onWarning(gen, warning) }
    return false
  }

  private fun lockedOutMessage(): String {
    val system = keySystem
    return if (system == null) {
      "The source is encrypted (DRM): give its key systems and license servers in `drm`."
    } else {
      "The source is not packaged for ${system.wire}, the key system of its `drm` this device uses."
    }
  }

  /** An item this player cannot open: nothing plays, and the engine learns why. */
  private fun refuse(p: ExoPlayer, gen: Int, code: ErrorCode, message: String) {
    p.stop()
    p.clearMediaItems()
    val error = PlayerError(code, message, false)
    report { observer.onFailed(gen, error) }
  }

  private fun buildMediaSource(request: OpenRequest, mediaId: String): MediaSource {

    val headers = request.source.headers
    val userAgent = headers.entries.firstOrNull { it.key.equals("User-Agent", ignoreCase = true) }?.value
    val calls = CallRegistry().also { itemCalls[mediaId] = it }
    val http =
      OkHttpDataSource.Factory(calls)
        .setUserAgent(userAgent ?: Util.getUserAgent(context, "RNAP"))
        .setDefaultRequestProperties(headers.filterKeys { !it.equals("User-Agent", ignoreCase = true) })
    // CBR seeking: MP3s without a Xing/VBRI header are seekable too (like iOS).
    var extractors = DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true)
    if (video) extractors = VideoSupport.subtitles(extractors)
    val factory =
      DefaultMediaSourceFactory(DefaultDataSource.Factory(context, http), extractors)
        .setLoadErrorHandlingPolicy(AnythingPlayerLoadErrorPolicy())
    sourceDrm?.let { drm -> factory.setDrmSessionManagerProvider { drm.manager } }
    return factory.createMediaSource(MediaItem.Builder().setUri(resolveUri(request.source.uri)).setMediaId(mediaId).build())
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
    // A source the app called a file (`live: false`) ends where it ends, and
    // with `reconnect: false` nothing reconnects on its own.
    if (request.source.liveHint == false || !request.allowReconnect) return
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

  override fun seek(seconds: Double) = seek(seconds, false)

  /** A video's scrub lands on the nearest keyframe (fast) unless `exact`; audio is always exact. */
  override fun seek(seconds: Double, exact: Boolean) {
    val p = player ?: return
    p.setSeekParameters(if (exact || !video) SeekParameters.EXACT else SeekParameters.CLOSEST_SYNC)
    p.seekTo((seconds * 1000).toLong())
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
    sourceDrm?.close()
    sourceDrm = null
  }

  override fun setVolume(effective: Double) {
    volume = effective.toFloat().coerceIn(0f, 1f)
    player?.volume = volume
  }

  override fun setRate(rate: Double) {
    this.rate = rate.toFloat()
    player?.setPlaybackSpeed(this.rate)
  }

  override fun switchOutput(outputId: String) {
    // The local player is one output; the routing driver switches between outputs.
  }

  override fun sample(): PlaybackSample {
    val p = player ?: return PlaybackSample()
    return PlaybackSample(p.currentPosition / 1000.0, p.bufferedPosition / 1000.0)
  }

  override fun progress(): ProgressReading {
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
    sourceDrm?.close()
    sourceDrm = null
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

/** A DASH manifest, by its extension (Media3 picks its source the same way). */
internal fun isDashUri(uri: String): Boolean = uri.substringBefore('#').substringBefore('?').lowercase().endsWith(".mpd")

/** Whether Media3's DASH module is in this build (`rnapDash`). */
private val dashBuiltIn: Boolean by lazy {
  runCatching { Class.forName("androidx.media3.exoplayer.dash.DashMediaSource") }.isSuccess
}
