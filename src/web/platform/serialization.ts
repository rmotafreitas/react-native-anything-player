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
  FallbackPolicy,
  QualityPolicy,
  SourceDescriptor,
  VideoEngineOptions,
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
  if (value === true) return DEFAULT_VIDEO_OPTIONS;
  const map = dict(value);
  if (map == null) return null;
  const mode = str(map.whenBackgrounded);
  const whenBackgrounded: BackgroundMode =
    mode === 'audio' || mode === 'pip' ? mode : 'pause';
  return {
    whenBackgrounded,
    ambient: bool(map.ambient) ?? false,
    keepAwake: bool(map.keepAwake) ?? true,
    focusWhenMuted: bool(map.focusWhenMuted) ?? false,
    fallback: parseFallback(map.fallbackToAudio),
    quality: parseQuality(map.quality),
  };
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

export function parseSource(
  value: unknown
): [SourceDescriptor, NowPlayingFields] {
  const map = dict(value) ?? {};
  const headers: Record<string, string> = {};
  for (const [key, header] of Object.entries(dict(map.headers) ?? {})) {
    if (typeof header === 'string') headers[key] = header;
  }
  return [
    { uri: str(map.uri) ?? '', headers, liveHint: bool(map.live) },
    parseNowPlaying(map.metadata),
  ];
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
