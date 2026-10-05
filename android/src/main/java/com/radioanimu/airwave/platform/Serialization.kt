package com.radioanimu.airwave.platform

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableMap
import com.radioanimu.airwave.core.DiagnosticEntry
import com.radioanimu.airwave.core.EngineOptions
import com.radioanimu.airwave.core.PlayerError
import com.radioanimu.airwave.core.SourceDescriptor
import com.radioanimu.airwave.core.Status
import com.radioanimu.airwave.core.StreamMetadata
import com.radioanimu.airwave.core.StreamTitleFormat

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
)

/** What the media session shows (merged). */
internal data class NowPlaying(
  val title: String?,
  val artist: String?,
  val album: String?,
  val artwork: String?,
  /** Set when the app gave a song duration: overrides the stream's own timeline. */
  val track: TrackProgress? = null,
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

internal fun parseSource(map: ReadableMap): Pair<SourceDescriptor, NowPlayingFields> {
  val headers = mutableMapOf<String, String>()
  map.optMap("headers")?.let { h ->
    val it = h.keySetIterator()
    while (it.hasNextKey()) {
      val key = it.nextKey()
      h.optString(key)?.let { value -> headers[key] = value }
    }
  }
  val descriptor = SourceDescriptor(map.optString("uri") ?: "", headers, map.optBoolean("live"))
  return descriptor to parseNowPlaying(map.optMap("metadata"))
}

internal fun parseNowPlaying(map: ReadableMap?): NowPlayingFields {
  if (map == null) return NowPlayingFields()
  val artwork = map.optString("artwork") ?: map.optMap("artwork")?.optString("uri")
  fun number(key: String) = if (map.hasKey(key) && map.getType(key) == ReadableType.Number) map.getDouble(key) else null
  return NowPlayingFields(
    map.optString("title"), map.optString("artist"), map.optString("album"), artwork,
    duration = number("duration"), elapsed = number("elapsed"),
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

internal fun statusToMap(status: Status, seq: Long): WritableMap =
  Arguments.createMap().apply {
    putDouble("seq", seq.toDouble())
    putString("state", status.state.wire)
    putBoolean("playWhenReady", status.playWhenReady)
    putInt("loadId", status.loadId)
    putBoolean("isLive", status.isLive)
    putNullableDouble("duration", status.duration)
    putBoolean("seekable", status.seekable)
    val interruption = status.interruption
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
    val error = status.error
    if (error == null) putNull("error") else putMap("error", errorToMap(error))
    val reconnect = status.reconnect
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
    putString("network", status.network.wire)
    putDouble("volume", status.volume)
    putBoolean("muted", status.muted)
    putDouble("rate", status.rate)
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
