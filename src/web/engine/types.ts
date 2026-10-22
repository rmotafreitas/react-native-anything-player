// Value types shared by the web engine and its browser layer. Everything in
// `engine/` is free of DOM and React Native imports, so it runs under Jest.
// Twins: `ios/Core/Types.swift`, `android/.../core/Types.kt` — keep names and
// semantics identical.

import { PlayerError } from '../../errors';
import type {
  AudioRoute,
  InterruptionReason,
  NetworkState,
  PlaybackState,
  PlayerErrorCode,
} from '../../types';

export type { AudioRoute, InterruptionReason, NetworkState, PlaybackState };

/** The route before the platform reports one: the engine never guesses. */
export const UNKNOWN_ROUTE: AudioRoute = { kind: 'unknown', name: null };

export type FocusResult = 'granted' | 'delayed' | 'denied';

export interface Interruption {
  reason: InterruptionReason;
  /** Whether the system may end it by resuming playback on its own. */
  resumable: boolean;
  /** Wall-clock epoch ms when it began. */
  since: number;
}

/** An engine error: the public `PlayerError`, reported by the web platform. */
export function engineError(
  code: PlayerErrorCode,
  message: string,
  recoverable: boolean,
  details: {
    httpStatus?: number;
    platformDomain?: string;
    platformCode?: number;
    cause?: string;
  } = {}
): PlayerError {
  return new PlayerError({
    code,
    message,
    recoverable,
    platform: 'web',
    ...details,
  });
}

/** What the app asked to play. */
export interface SourceDescriptor {
  uri: string;
  headers: Record<string, string>;
  /** App hint. `null` = detect (indefinite duration ⇒ live). */
  liveHint: boolean | null;
}

export function isNetworkSource(source: SourceDescriptor): boolean {
  const lower = source.uri.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

/** What the engine asks the driver to open. */
export interface OpenRequest {
  generation: number;
  source: SourceDescriptor;
  /** Seconds to start at; `null` = default (live edge / beginning). */
  startPosition: number | null;
  playWhenReady: boolean;
}

/** A point-in-time reading of the media element, taken on demand. */
export interface PlaybackSample {
  position: number;
  /** End of the buffered range, in the same timeline as `position`. */
  bufferedPosition: number;
}

/** What the driver learned when the item became ready. */
export interface ReadyInfo {
  /** Seconds; `null` when indefinite (live) or unknown. */
  duration: number | null;
  isLive: boolean;
  seekable: boolean;
}

export interface ReconnectInfo {
  /** 1-based attempt number of the next/current attempt. */
  attempt: number;
  /** Wall-clock epoch ms of the next attempt, `null` while an attempt runs. */
  nextAttemptAt: number | null;
  reason: string;
}

/** The authoritative snapshot published to JS. Mirrors `PlayerStatus`. */
export interface EngineStatus {
  state: PlaybackState;
  playWhenReady: boolean;
  /** Increments on every `load()`; identifies the source this status describes. */
  loadId: number;
  isLive: boolean;
  duration: number | null;
  seekable: boolean;
  interruption: Interruption | null;
  error: PlayerError | null;
  reconnect: ReconnectInfo | null;
  network: NetworkState;
  volume: number;
  muted: boolean;
  rate: number;
  route: AudioRoute;
}

/** One structured diagnostic line (ring-buffered, optionally streamed). */
export interface EngineDiagnostic {
  wallTime: number;
  generation: number;
  state: PlaybackState;
  event: string;
  details: Record<string, string>;
}
