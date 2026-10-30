// Parsing of what `Player` sends and the shapes the web module returns.
// Twin of `android/.../platform/Serialization.kt`: the same wire format, so
// `Player` cannot tell the engines apart.

import type { PlayerError } from '../../errors';
import {
  DEFAULT_ENGINE_OPTIONS,
  DEFAULT_FALLBACK_POLICY,
  DEFAULT_VIDEO_OPTIONS,
  type EngineOptions,
} from '../engine/RecoveryPolicy';
import type {
  StreamMetadata,
  StreamTitleFormat,
} from '../engine/StreamMetadata';
import type {
  BackgroundMode,
  EngineDiagnostic,
  EngineStatus,
  EngineVideoStatus,
  FallbackPolicy,
  MediaTrack,
  QualityPolicy,
  Rendition,
  SourceDescriptor,
  VideoEngineOptions,
  DrmDescriptor,
} from '../engine/types';
import type { ProgressReading } from './MediaElementDriver';

type Dict = Record<string, unknown>;

const dict = (value: unknown): Dict | null =>
  value != null && typeof value === 'object' ? (value as Dict) : null;
const str = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;
const bool = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Parsed `PlayerOptions` (the fields the web engine honours). */
export interface WebPlayerOptions {
  engine: EngineOptions;
  mediaSession: boolean;
  /** Remote commands forwarded to JS (play/pause/stop/seek are always handled here). */
  remoteCommands: Set<string>;
  titleFormat: StreamTitleFormat;
  useStreamMetadata: boolean;
  /** `progress` events while playing, this often (ms); 0 = off. */
  progressIntervalMs: number;
}

/** Lock-screen fields given by the app (source metadata or overrides). */
export interface NowPlayingFields {
  title: string | null;
  artist: string | null;
  album: string | null;
  artwork: string | null;
  /** The song's length and position (seconds): a progress bar for a live stream. */
  duration: number | null;
  elapsed: number | null;
  /** The "live" badge; `null` follows the stream. */
  live: boolean | null;
}

export const NO_FIELDS: NowPlayingFields = {
  title: null,
  artist: null,
  album: null,
  artwork: null,
  duration: null,
  elapsed: null,
  live: null,
};

/** `PlayerOptions.video`: `true` takes every default; absent or `false`, an audio player. */
export function parseVideo(value: unknown): VideoEngineOptions | null {
  if (value === true)
    return { ...DEFAULT_VIDEO_OPTIONS, whenBackgrounded: 'audio' };
  const map = dict(value);
  if (map == null) return null;
  const mode = str(map.whenBackgrounded);
  // A hidden tab plays on, as browsers do: the web's default is `audio`.
  const whenBackgrounded: BackgroundMode =
    mode === 'pause' || mode === 'pip' ? mode : 'audio';
  return {
    whenBackgrounded,
    ambient: bool(map.ambient) ?? false,
    keepAwake: bool(map.keepAwake) ?? true,
    focusWhenMuted: bool(map.focusWhenMuted) ?? false,
    fallback: parseFallback(map.fallbackToAudio),
    quality: parseQuality(map.quality),
    tracks: parseTracks(map.tracks),
  };
}

function parseTracks(value: unknown): VideoEngineOptions['tracks'] {
  const map = dict(value) ?? {};
  const languages = Array.isArray(map.languages)
    ? map.languages.filter((l): l is string => typeof l === 'string')
    : [];
  return { languages, followSystem: bool(map.followSystem) ?? true };
}

function parseFallback(value: unknown): FallbackPolicy | null {
  if (value === true) return DEFAULT_FALLBACK_POLICY;
  const map = dict(value);
  if (map == null) return null;
  const d = DEFAULT_FALLBACK_POLICY;
  return {
    dropBelowRatio: num(map.dropBelowRatio) ?? d.dropBelowRatio,
    dropAfterMs: num(map.dropAfterMs) ?? d.dropAfterMs,
    dropAfterStalls: num(map.dropAfterStalls) ?? d.dropAfterStalls,
    stallWindowMs: num(map.stallWindowMs) ?? d.stallWindowMs,
    returnAboveRatio: num(map.returnAboveRatio) ?? d.returnAboveRatio,
    returnAfterMs: num(map.returnAfterMs) ?? d.returnAfterMs,
  };
}

function parseQuality(value: unknown): QualityPolicy {
  const map = dict(value) ?? {};
  const cellular = dict(map.cellular);
  const start = map.startQuality;
  const startQuality: QualityPolicy['startQuality'] =
    start === 'lowest' || start === 'highest' ? start : (num(start) ?? 'auto');
  return {
    maxHeight: num(map.maxResolution),
    maxBitrate: num(map.maxBitrate),
    cellularMaxHeight: num(cellular?.maxResolution),
    cellularMaxBitrate: num(cellular?.maxBitrate),
    startQuality,
    followDataSaver: bool(map.followDataSaver) ?? true,
    capToView: bool(map.capToView) ?? true,
  };
}

export function parseOptions(value: unknown): WebPlayerOptions {
  const map = dict(value) ?? {};
  const recovery = dict(map.recovery);
  // `giveUpAfterMs: null` means "never give up"; absent means the default.
  const never = recovery?.giveUpAfterMs === null;
  const giveUp = never
    ? null
    : (num(recovery?.giveUpAfterMs) ?? DEFAULT_ENGINE_OPTIONS.giveUpAfterMs);
  const session = dict(map.mediaSession);
  const metadata = dict(map.metadata);
  const format = str(metadata?.streamTitleFormat);
  const commands = Array.isArray(session?.commands)
    ? session.commands.filter((c): c is string => typeof c === 'string')
    : [];
  const interval = num(map.progressInterval);
  return {
    engine: {
      reconnect: bool(recovery?.reconnect) ?? true,
      giveUpAfterMs: giveUp,
      autoResumeAfterInterruption:
        bool(dict(map.interruptions)?.autoResume) ?? true,
      liveMaxDriftMs:
        num(recovery?.liveMaxDriftMs) ?? DEFAULT_ENGINE_OPTIONS.liveMaxDriftMs,
      ...parseFade(map.fade),
      video: parseVideo(map.video),
    },
    mediaSession: bool(session?.enabled) ?? true,
    remoteCommands: new Set(commands),
    titleFormat:
      format === 'title-artist' || format === 'title' ? format : 'artist-title',
    useStreamMetadata: bool(metadata?.useStreamMetadataForNowPlaying) ?? true,
    progressIntervalMs: interval != null && interval > 0 ? interval : 0,
  };
}

/** `{ in?, out? }` in seconds (what `PlayerOptions.fade` and `setFade` send) → ms. */
export function parseFade(value: unknown): {
  fadeInMs: number;
  fadeOutMs: number;
} {
  const fade = dict(value);
  const ms = (seconds: number | null) =>
    seconds != null && seconds > 0 ? Math.round(seconds * 1000) : 0;
  return { fadeInMs: ms(num(fade?.in)), fadeOutMs: ms(num(fade?.out)) };
}

function strings(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, header] of Object.entries(dict(value) ?? {})) {
    if (typeof header === 'string') out[key] = header;
  }
  return out;
}

function parseRenditions(value: unknown): Rendition[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map((r) => {
    const map = dict(r) ?? {};
    return {
      uri: str(map.uri) ?? '',
      headers: map.headers != null ? strings(map.headers) : null,
      height: num(map.height),
      bitrate: num(map.bitrate),
      label: str(map.label),
      audioOnly: bool(map.audioOnly) ?? false,
    };
  });
}

export function parseSource(
  value: unknown
): [SourceDescriptor, NowPlayingFields] {
  const map = dict(value) ?? {};
  const descriptor: SourceDescriptor = {
    uri: str(map.uri) ?? '',
    headers: strings(map.headers),
    liveHint: bool(map.live),
  };
  // Only what the source uses: an audio source stays as it was.
  const renditions = parseRenditions(map.renditions);
  if (renditions != null) descriptor.renditions = renditions;
  if (bool(map.refreshable) === true) descriptor.refreshable = true;
  const expiresAt = num(map.expiresAt);
  if (expiresAt != null) descriptor.expiresAt = expiresAt;
  // Validated by normalizeDrm on the way in.
  const drm = dict(map.drm);
  if (drm != null) descriptor.drm = drm as unknown as DrmDescriptor;
  return [descriptor, parseNowPlaying(map.metadata)];
}

/** What a video load brings besides the source: its poster, subtitle files and their session. */
export interface VideoLoadParts {
  poster: string | null;
  session: string | null;
  subtitles: MediaTrack[];
}

export function parseSubtitleTracks(value: unknown): MediaTrack[] {
  if (!Array.isArray(value)) return [];
  return value.map((t) => {
    const map = dict(t) ?? {};
    return {
      id: str(map.id) ?? '',
      kind: map.kind === 'captions' ? 'captions' : 'subtitles',
      language: str(map.language),
      label: str(map.label),
      forced: bool(map.forced) ?? false,
      default: bool(map.default) ?? false,
      sdh: map.kind === 'captions',
      describesVideo: false,
    };
  });
}

export function parseVideoParts(value: unknown): VideoLoadParts {
  const map = dict(value) ?? {};
  return {
    poster: str(map.poster),
    session: str(map.subtitleSession),
    subtitles: parseSubtitleTracks(map.subtitles),
  };
}

export function parseNowPlaying(value: unknown): NowPlayingFields {
  const map = dict(value);
  if (!map) return NO_FIELDS;
  return {
    title: str(map.title),
    artist: str(map.artist),
    album: str(map.album),
    artwork: str(map.artwork) ?? str(dict(map.artwork)?.uri),
    duration: num(map.duration),
    elapsed: num(map.elapsed),
    live: bool(map.live),
  };
}

export function errorToMap(error: PlayerError): Dict {
  return { ...error.toJSON(), platform: error.platform ?? 'web' };
}

export function statusToMap(status: EngineStatus, seq: number): Dict {
  return {
    seq,
    state: status.state,
    playWhenReady: status.playWhenReady,
    loadId: status.loadId,
    isLive: status.isLive,
    duration: status.duration,
    seekable: status.seekable,
    interruption: status.interruption ? { ...status.interruption } : null,
    error: status.error ? errorToMap(status.error) : null,
    reconnect: status.reconnect ? { ...status.reconnect } : null,
    network: status.network,
    volume: status.volume,
    muted: status.muted,
    rate: status.rate,
    route: { ...status.route },
    sleepAt: status.sleepAt,
    video: status.video ? videoToMap(status.video) : null,
  };
}

function videoToMap(video: EngineVideoStatus): Dict {
  return {
    ...video,
    qualities: video.qualities.map((q) => ({ ...q })),
    tracks: video.tracks.map((t) => ({ ...t })),
  };
}

export function metadataToMap(
  metadata: StreamMetadata,
  timestamp: number
): Dict {
  return {
    title: metadata.title,
    artist: metadata.artist,
    album: metadata.album,
    station: metadata.station,
    genre: metadata.genre,
    artwork: metadata.artworkUri ? { uri: metadata.artworkUri } : null,
    raw: { ...metadata.raw },
    timestamp,
  };
}

export function progressToMap(reading: ProgressReading, wallMs: number): Dict {
  const position =
    reading.duration != null
      ? Math.min(reading.position, reading.duration)
      : reading.position;
  return {
    position,
    duration: reading.duration,
    buffered: Math.max(reading.buffered, position),
    bufferedAhead: Math.max(0, reading.buffered - position),
    liveOffset: reading.liveOffset,
    timestamp: wallMs,
  };
}

export function diagnosticToMap(entry: EngineDiagnostic): Dict {
  return {
    time: entry.wallTime,
    generation: entry.generation,
    state: entry.state,
    event: entry.event,
    details: { ...entry.details },
  };
}
