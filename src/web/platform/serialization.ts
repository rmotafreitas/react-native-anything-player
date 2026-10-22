// Parsing of what `Player` sends and the shapes the web module returns.
// Twin of `android/.../platform/Serialization.kt`: the same wire format, so
// `Player` cannot tell the engines apart.

import type { PlayerError } from '../../errors';
import {
  DEFAULT_ENGINE_OPTIONS,
  type EngineOptions,
} from '../engine/RecoveryPolicy';
import type {
  StreamMetadata,
  StreamTitleFormat,
} from '../engine/StreamMetadata';
import type {
  EngineDiagnostic,
  EngineStatus,
  SourceDescriptor,
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
    },
    mediaSession: bool(session?.enabled) ?? true,
    remoteCommands: new Set(commands),
    titleFormat:
      format === 'title-artist' || format === 'title' ? format : 'artist-title',
    useStreamMetadata: bool(metadata?.useStreamMetadataForNowPlaying) ?? true,
    progressIntervalMs: interval != null && interval > 0 ? interval : 0,
  };
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
