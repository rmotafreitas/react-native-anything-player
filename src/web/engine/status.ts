// Status helpers for the engine (kept apart to keep the engine readable).

import type { EngineStatus, PlaybackState } from './types';

/** Shallow equality of two snapshots (nested values are compared field by field). */
function sameFields(a: object | null, b: object | null): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => left[key] === right[key])
  );
}

export function statusEquals(a: EngineStatus, b: EngineStatus | null): boolean {
  if (!b) return false;
  const { interruption, reconnect, route, ...scalars } = a;
  const {
    interruption: bInterruption,
    reconnect: bReconnect,
    route: bRoute,
    ...bScalars
  } = b;
  return (
    sameFields(scalars, bScalars) &&
    sameFields(interruption, bInterruption) &&
    sameFields(reconnect, bReconnect) &&
    sameFields(route, bRoute)
  );
}

/** States in which a new source or `play()` keeps the current play intent. */
const CONTINUES_INTENT: ReadonlySet<PlaybackState> = new Set<PlaybackState>([
  'loading',
  'buffering',
  'playing',
  'reconnecting',
  'paused',
]);

export function continuesIntent(state: PlaybackState): boolean {
  return CONTINUES_INTENT.has(state);
}
