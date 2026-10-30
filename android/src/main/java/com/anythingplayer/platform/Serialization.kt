package com.anythingplayer.platform

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableMap
import com.anythingplayer.core.BackgroundMode
import com.anythingplayer.core.DiagnosticEntry
import com.anythingplayer.core.DrmDescriptor
import com.anythingplayer.core.EngineOptions
import com.anythingplayer.core.FallbackPolicy
import com.anythingplayer.core.Interruption
import com.anythingplayer.core.LicenseServer
import com.anythingplayer.core.MediaTrack
import com.anythingplayer.core.PlayerError
import com.anythingplayer.core.QualityPolicy
import com.anythingplayer.core.ReconnectInfo
import com.anythingplayer.core.Rendition
import com.anythingplayer.core.SourceDescriptor
import com.anythingplayer.core.StartQuality
import com.anythingplayer.core.Status
import com.anythingplayer.core.StreamMetadata
import com.anythingplayer.core.StreamTitleFormat
import com.anythingplayer.core.TrackKind
import com.anythingplayer.core.TrackPolicy
import com.anythingplayer.core.VideoEngineOptions
import com.anythingplayer.core.VideoStatus

/** Parsed `PlayerOptions` (src/types.ts). Defaults live in JS and here. */
internal data class PlayerOptions(
  val engine: EngineOptions = EngineOptions(),
  val mediaSession: Boolean = true,
  /** Remote commands forwarded to JS (play/pause/stop are always handled natively). */
  val remoteCommands: Set<String> = emptySet(),
  val speech: Boolean = false,
  val mixWithOthers: Boolean = false,
  val titleFormat: StreamTitleFormat = StreamTitleFormat.ARTIST_TITLE,
  val useStreamMetadata: Boolean = true,
  val stopOnTaskRemoved: Boolean = false,
  /** `progress` events while playing, this often (ms); 0 = off. */
  val progressIntervalMs: Long = 0,
)

/** Lock-screen fields given by the app (source metadata or overrides). */
internal data class NowPlayingFields(
  val title: String? = null,
  val artist: String? = null,
  val album: String? = null,
  val artwork: String? = null,
  /** The song's length and position (seconds) — a progress bar for a live stream. */
  val duration: Double? = null,
  val elapsed: Double? = null,
  /** The "live" badge; null follows the stream. */
  val live: Boolean? = null,
)

/** What the media session shows (merged). */
internal data class NowPlaying(
  val title: String?,
  val artist: String?,
  val album: String?,
  val artwork: String?,
  /** Set when the app gave a song duration: overrides the stream's own timeline. */
  val track: TrackProgress? = null,
  /** The app's "live" badge choice; null follows the stream. */
  val live: Boolean? = null,
)

/** The song's progress at [atMonotonic] (seconds); advances only while playing. */
internal data class TrackProgress(val duration: Double, val elapsed: Double, val atMonotonic: Long)

/** A progress reading stamped with when it was taken (for extrapolation). */
internal data class ProgressSnapshot(
  val reading: ProgressReading,
  val takenAtMonotonic: Long,
  val takenAtWall: Long,
)

internal fun ReadableMap.optString(key: String): String? =
  if (hasKey(key) && getType(key) == ReadableType.String) getString(key) else null

internal fun ReadableMap.optBoolean(key: String): Boolean? =
  if (hasKey(key) && getType(key) == ReadableType.Boolean) getBoolean(key) else null

internal fun ReadableMap.optDouble(key: String): Double? =
  if (hasKey(key) && getType(key) == ReadableType.Number) getDouble(key) else null

internal fun ReadableMap.optMap(key: String): ReadableMap? =
  if (hasKey(key) && getType(key) == ReadableType.Map) getMap(key) else null

internal fun ReadableMap.optArray(key: String): ReadableArray? =
  if (hasKey(key) && getType(key) == ReadableType.Array) getArray(key) else null

private fun ReadableMap.stringMap(key: String): Map<String, String>? {
  val m = optMap(key) ?: return null
  val out = mutableMapOf<String, String>()
  val it = m.keySetIterator()
  while (it.hasNextKey()) {
    val k = it.nextKey()
    m.optString(k)?.let { out[k] = it }
  }
  return out
}

private fun ReadableArray.maps(): List<ReadableMap> =
  (0 until size()).mapNotNull { if (getType(it) == ReadableType.Map) getMap(it) else null }

/** A `fade` side (`in` / `out`, seconds) in ms; absent or ≤ 0 = no fade. */
internal fun fadeMs(fade: ReadableMap?, key: String): Long {
  val seconds = fade?.optDouble(key) ?: return 0L
  return if (seconds > 0) Math.round(seconds * 1000) else 0L
}

internal fun parseOptions(map: ReadableMap): PlayerOptions {
  val recovery = map.optMap("recovery")
  val giveUp =
    if (recovery != null && recovery.hasKey("giveUpAfterMs") && recovery.getType("giveUpAfterMs") == ReadableType.Null) null
    else recovery?.optDouble("giveUpAfterMs")?.toLong() ?: EngineOptions().giveUpAfterMs
  val engine =
    EngineOptions(
      reconnect = recovery?.optBoolean("reconnect") ?: true,
      giveUpAfterMs = giveUp,
      autoResumeAfterInterruption = map.optMap("interruptions")?.optBoolean("autoResume") ?: true,
      liveMaxDriftMs = recovery?.optDouble("liveMaxDriftMs")?.toLong() ?: EngineOptions().liveMaxDriftMs,
      fadeInMs = fadeMs(map.optMap("fade"), "in"),
      fadeOutMs = fadeMs(map.optMap("fade"), "out"),
      // Without the video module there is no video player: JS sees
      // `status.video == null` and throws VIDEO_UNAVAILABLE.
      video = if (VideoSupport.AVAILABLE) parseVideo(map) else null,
    )
  val session = map.optMap("mediaSession")
  val commands = mutableSetOf<String>()
  session?.getArray("commands")?.let { array ->
    for (i in 0 until array.size()) array.getString(i)?.let(commands::add)
  }
  val audio = map.optMap("audio")
  val metadata = map.optMap("metadata")
  return PlayerOptions(
    engine = engine,
    mediaSession = session?.optBoolean("enabled") ?: true,
    remoteCommands = commands,
    speech = audio?.optString("contentType") == "speech",
    mixWithOthers = audio?.optBoolean("mixWithOthers") ?: false,
    titleFormat = StreamTitleFormat.fromWire(metadata?.optString("streamTitleFormat")),
    useStreamMetadata = metadata?.optBoolean("useStreamMetadataForNowPlaying") ?: true,
    stopOnTaskRemoved = map.optMap("android")?.optBoolean("stopOnTaskRemoved") ?: false,
    progressIntervalMs = map.optDouble("progressInterval")?.takeIf { it.isFinite() && it > 0 }?.toLong() ?: 0,
  )
}

/** `PlayerOptions.video`: `true` takes every default; absent or `false`, an audio player. */
private fun parseVideo(options: ReadableMap): VideoEngineOptions? {
  if (!options.hasKey("video")) return null
  if (options.getType("video") == ReadableType.Boolean) return if (options.getBoolean("video")) VideoEngineOptions() else null
  val map = options.optMap("video") ?: return null
  return VideoEngineOptions(
    whenBackgrounded = BackgroundMode.fromWire(map.optString("whenBackgrounded")),
    ambient = map.optBoolean("ambient") ?: false,
    keepAwake = map.optBoolean("keepAwake") ?: true,
    focusWhenMuted = map.optBoolean("focusWhenMuted") ?: false,
    fallback = parseFallback(map),
    quality = parseQuality(map.optMap("quality")),
    tracks = parseTrackPolicy(map.optMap("tracks")),
  )
}

private fun parseFallback(video: ReadableMap): FallbackPolicy? {
  if (!video.hasKey("fallbackToAudio")) return null
  if (video.getType("fallbackToAudio") == ReadableType.Boolean) return if (video.getBoolean("fallbackToAudio")) FallbackPolicy() else null
  val map = video.optMap("fallbackToAudio") ?: return null
  val d = FallbackPolicy()
  return FallbackPolicy(
    dropBelowRatio = map.optDouble("dropBelowRatio") ?: d.dropBelowRatio,
    dropAfterMs = map.optDouble("dropAfterMs")?.toLong() ?: d.dropAfterMs,
    dropAfterStalls = map.optDouble("dropAfterStalls")?.toInt() ?: d.dropAfterStalls,
    stallWindowMs = map.optDouble("stallWindowMs")?.toLong() ?: d.stallWindowMs,
    returnAboveRatio = map.optDouble("returnAboveRatio") ?: d.returnAboveRatio,
    returnAfterMs = map.optDouble("returnAfterMs")?.toLong() ?: d.returnAfterMs,
  )
}

private fun parseQuality(map: ReadableMap?): QualityPolicy {
  if (map == null) return QualityPolicy()
  val cellular = map.optMap("cellular")
  val start =
    when {
      map.optString("startQuality") == "lowest" -> StartQuality.Lowest
      map.optString("startQuality") == "highest" -> StartQuality.Highest
      map.optDouble("startQuality") != null -> StartQuality.Height(map.getDouble("startQuality").toInt())
      else -> StartQuality.Auto
    }
  return QualityPolicy(
    maxHeight = map.optDouble("maxResolution")?.toInt(),
    maxBitrate = map.optDouble("maxBitrate")?.toLong(),
    cellularMaxHeight = cellular?.optDouble("maxResolution")?.toInt(),
    cellularMaxBitrate = cellular?.optDouble("maxBitrate")?.toLong(),
    startQuality = start,
    followDataSaver = map.optBoolean("followDataSaver") ?: true,
    capToView = map.optBoolean("capToView") ?: true,
  )
}

private fun parseTrackPolicy(map: ReadableMap?): TrackPolicy {
  if (map == null) return TrackPolicy()
  val languages = map.optArray("languages")?.let { a -> (0 until a.size()).mapNotNull { if (a.getType(it) == ReadableType.String) a.getString(it) else null } }
  return TrackPolicy(languages ?: emptyList(), map.optBoolean("followSystem") ?: true)
}

private fun parseRenditions(map: ReadableMap): List<Rendition>? {
  val list = map.optArray("renditions")?.maps() ?: return null
  if (list.isEmpty()) return null
  return list.map {
    Rendition(
      uri = it.optString("uri") ?: "",
      headers = it.stringMap("headers"),
      height = it.optDouble("height")?.toInt(),
      bitrate = it.optDouble("bitrate")?.toLong(),
      label = it.optString("label"),
      audioOnly = it.optBoolean("audioOnly") ?: false,
    )
  }
}

/** The app's subtitle files as tracks (`sub:<n>`, from JS). */
internal fun parseSubtitleTracks(array: ReadableArray?): List<MediaTrack> =
  array?.maps()?.map {
    val captions = it.optString("kind") == "captions"
    MediaTrack(
      id = it.optString("id") ?: "",
      kind = if (captions) TrackKind.CAPTIONS else TrackKind.SUBTITLES,
      language = it.optString("language"),
      label = it.optString("label"),
      forced = it.optBoolean("forced") ?: false,
      isDefault = it.optBoolean("default") ?: false,
      sdh = captions,
    )
  } ?: emptyList()

/** A video source's poster, subtitle files and their session. */
internal fun parseVideoParts(map: ReadableMap): VideoLoadParts =
  VideoLoadParts(map.optString("poster"), map.optString("subtitleSession"), parseSubtitleTracks(map.optArray("subtitles")))

internal fun parseSource(map: ReadableMap): Pair<SourceDescriptor, NowPlayingFields> {
  val descriptor =
    SourceDescriptor(
      map.optString("uri") ?: "",
      map.stringMap("headers") ?: emptyMap(),
      map.optBoolean("live"),
      renditions = parseRenditions(map),
      refreshable = map.optBoolean("refreshable") ?: false,
      expiresAt = map.optDouble("expiresAt")?.toLong(),
      drm = map.optMap("drm")?.let(::parseDrm),
    )
  return descriptor to parseNowPlaying(map.optMap("metadata"))
}

private fun parseDrm(map: ReadableMap): DrmDescriptor {
  fun server(name: String) =
    map.optMap(name)?.let { LicenseServer(it.optString("licenseUrl"), it.stringMap("headers") ?: emptyMap()) }
  return DrmDescriptor(
    widevine = server("widevine"),
    playready = server("playready"),
    clearkey = server("clearkey"),
    clearKeys = map.optMap("clearkey")?.stringMap("keys"),
    fairplay = map.optMap("fairplay") != null,
    hook = map.optBoolean("hook") == true,
  )
}

internal fun parseNowPlaying(map: ReadableMap?): NowPlayingFields {
  if (map == null) return NowPlayingFields()
  val artwork = map.optString("artwork") ?: map.optMap("artwork")?.optString("uri")
  return NowPlayingFields(
    map.optString("title"), map.optString("artist"), map.optString("album"), artwork,
    duration = map.optDouble("duration"), elapsed = map.optDouble("elapsed"), live = map.optBoolean("live"),
  )
}

private fun WritableMap.putNullableDouble(key: String, value: Double?) {
  if (value == null || !value.isFinite()) putNull(key) else putDouble(key, value)
}

private fun WritableMap.putNullableString(key: String, value: String?) {
  if (value == null) putNull(key) else putString(key, value)
}

internal fun errorToMap(error: PlayerError): WritableMap =
  Arguments.createMap().apply {
    putString("code", error.code.wire)
    putString("message", error.message)
    putBoolean("recoverable", error.recoverable)
    putString("platform", "android")
    error.httpStatus?.let { putInt("httpStatus", it) }
    error.platformDomain?.let { putString("platformDomain", it) }
    error.platformCode?.let { putInt("platformCode", it) }
    error.causeDescription?.let { putString("cause", it) }
  }

private fun WritableMap.putInterruption(interruption: Interruption?) {
  if (interruption == null) {
    putNull("interruption")
  } else {
    putMap(
      "interruption",
      Arguments.createMap().apply {
        putString("reason", interruption.reason.wire)
        putBoolean("resumable", interruption.resumable)
        putDouble("since", interruption.since.toDouble())
      },
    )
  }
}

private fun WritableMap.putReconnect(reconnect: ReconnectInfo?) {
  if (reconnect == null) {
    putNull("reconnect")
  } else {
    putMap(
      "reconnect",
      Arguments.createMap().apply {
        putInt("attempt", reconnect.attempt)
        if (reconnect.nextAttemptAt == null) putNull("nextAttemptAt") else putDouble("nextAttemptAt", reconnect.nextAttemptAt.toDouble())
        putString("reason", reconnect.reason)
      },
    )
  }
}

internal fun statusToMap(status: Status, seq: Long): WritableMap =
  Arguments.createMap().apply {
    putDouble("seq", seq.toDouble())
    putString("state", status.state.wire)
    putBoolean("playWhenReady", status.playWhenReady)
    putInt("loadId", status.loadId)
    putBoolean("isLive", status.isLive)
    putNullableDouble("duration", status.duration)
    putBoolean("seekable", status.seekable)
    putInterruption(status.interruption)
    val error = status.error
    if (error == null) putNull("error") else putMap("error", errorToMap(error))
    putReconnect(status.reconnect)
    putString("network", status.network.wire)
    putDouble("volume", status.volume)
    putBoolean("muted", status.muted)
    putDouble("rate", status.rate)
    putMap(
      "route",
      Arguments.createMap().apply {
        putString("kind", status.route.kind.wire)
        if (status.route.name == null) putNull("name") else putString("name", status.route.name)
      },
    )
    val sleepAt = status.sleepAt
    if (sleepAt == null) putNull("sleepAt") else putDouble("sleepAt", sleepAt.toDouble())
    putArray(
      "qualities",
      Arguments.createArray().apply {
        status.qualities.forEach { q ->
          pushMap(
            Arguments.createMap().apply {
              putString("id", q.id)
              putNullableInt("height", q.height)
              putNullableInt("bitrate", q.bitrate)
              putBoolean("audioOnly", q.audioOnly)
              putNullableString("label", q.label)
            }
          )
        }
      },
    )
    putNullableString("quality", status.quality)
    putNullableString("selectedQuality", status.selectedQuality)
    val video = status.video
    if (video == null) putNull("video") else putMap("video", videoToMap(video))
  }

private fun WritableMap.putNullableInt(key: String, value: Number?) {
  if (value == null) putNull(key) else putDouble(key, value.toDouble())
}

private fun videoToMap(video: VideoStatus): WritableMap =
  Arguments.createMap().apply {
    putNullableInt("width", video.width)
    putNullableInt("height", video.height)
    putBoolean("hdr", video.hdr)
    putBoolean("firstFrame", video.firstFrame)
    putNullableString("audioOnly", video.audioOnly?.wire)
    putBoolean("pictureInPicture", video.pictureInPicture)
    putArray(
      "tracks",
      Arguments.createArray().apply {
        video.tracks.forEach { t ->
          pushMap(
            Arguments.createMap().apply {
              putString("id", t.id)
              putString("kind", t.kind.wire)
              putNullableString("language", t.language)
              putNullableString("label", t.label)
              putBoolean("forced", t.forced)
              putBoolean("default", t.isDefault)
              putBoolean("sdh", t.sdh)
              putBoolean("describesVideo", t.describesVideo)
            }
          )
        }
      },
    )
    putNullableString("audioTrack", video.audioTrack)
    putNullableString("textTrack", video.textTrack)
    putDouble("subtitleDelay", video.subtitleDelay)
    putBoolean("fullscreen", video.fullscreen)
  }

internal fun metadataToMap(metadata: StreamMetadata, timestamp: Long): WritableMap =
  Arguments.createMap().apply {
    putNullableString("title", metadata.title)
    putNullableString("artist", metadata.artist)
    putNullableString("album", metadata.album)
    putNullableString("station", metadata.station)
    putNullableString("genre", metadata.genre)
    if (metadata.artworkUri == null) {
      putNull("artwork")
    } else {
      putMap("artwork", Arguments.createMap().apply { putString("uri", metadata.artworkUri) })
    }
    putMap("raw", Arguments.createMap().apply { metadata.raw.forEach { (k, v) -> putString(k, v) } })
    putDouble("timestamp", timestamp.toDouble())
  }

internal fun progressToMap(snapshot: ProgressSnapshot, nowMonotonic: Long, nowWall: Long): WritableMap {
  val r = snapshot.reading
  val elapsed = (nowMonotonic - snapshot.takenAtMonotonic).coerceAtLeast(0) / 1000.0
  var position = if (r.isPlaying) r.position + elapsed * r.rate else r.position
  r.duration?.let { position = position.coerceAtMost(it) }
  return Arguments.createMap().apply {
    putDouble("position", position)
    putNullableDouble("duration", r.duration)
    putDouble("buffered", maxOf(r.buffered, position))
    putDouble("bufferedAhead", (r.buffered - position).coerceAtLeast(0.0))
    putNullableDouble("liveOffset", r.liveOffset)
    putDouble("timestamp", nowWall.toDouble())
  }
}

internal fun diagnosticToMap(entry: DiagnosticEntry): WritableMap =
  Arguments.createMap().apply {
    putDouble("time", entry.wallTime.toDouble())
    putInt("generation", entry.generation)
    putString("state", entry.state.wire)
    putString("event", entry.event)
    putMap("details", Arguments.createMap().apply { entry.details.forEach { (k, v) -> putString(k, v) } })
  }
