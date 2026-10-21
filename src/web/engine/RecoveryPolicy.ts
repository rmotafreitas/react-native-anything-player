/**
 * Every recovery constant, in one place. Twins: `ios/Core/RecoveryPolicy.swift`,
 * `android/.../core/RecoveryPolicy.kt`; `docs/recovery.md` documents the
 * production failure each one exists for. Only the fields in
 * {@link EngineOptions} are app-configurable.
 */
export const RecoveryPolicy = {
  /** Engine heartbeat while playback is wanted (drives the watchdogs). */
  HEARTBEAT_MS: 1_000,
  /** A stall shorter than this is not published (no spinner flicker, no event spam). */
  STALL_DEBOUNCE_MS: 500,
  /** One open attempt (open → ready) may take this long before it times out. */
  OPEN_TIMEOUT_MS: 12_000,
  /** An open younger than this is not re-issued by another trigger. */
  OPEN_GRACE_MS: 4_000,
  /** "Playing" with a playhead that has not advanced for this long is a stall. */
  SILENT_STALL_MS: 4_000,
  SUSPECT_SILENT_STALL_MS: 2_000,
  /** A stall with no buffered progress for this long while online: dead socket. */
  STALL_DEAD_MS: 3_000,
  SUSPECT_STALL_DEAD_MS: 1_500,
  /** A stall that trickles data but never recovers is re-opened after this. */
  STALL_MAX_MS: 20_000,
  /** How long after a connectivity edge the link is treated as suspect. */
  NETWORK_SUSPECT_MS: 20_000,
  /** Reconnect backoff: base delay, doubled per attempt, capped, ±jitter. */
  RECONNECT_BASE_MS: 1_000,
  RECONNECT_MAX_MS: 30_000,
  RECONNECT_JITTER: 0.2,
  /** Every Nth skipped (offline) attempt runs anyway as a probe. */
  OFFLINE_PROBE_EVERY: 3,
  /** Audio must flow this long before the backoff resets. */
  STABLE_PLAYBACK_MS: 10_000,
  /** A paused network live stream's connection is released after this. */
  PAUSED_STREAM_RELEASE_MS: 30_000,
} as const;

/** App-configurable recovery knobs (`PlayerOptions`). */
export interface EngineOptions {
  /** Reconnect automatically after recoverable failures while playback is wanted. */
  reconnect: boolean;
  /** Give up recovering after this long without stable playback (`null` = never). */
  giveUpAfterMs: number | null;
  /** Resume automatically when the system ends a transient interruption. */
  autoResumeAfterInterruption: boolean;
  /** Live drift (pauses + stalls since the open) that forces a live-edge re-open. */
  liveMaxDriftMs: number;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  reconnect: true,
  giveUpAfterMs: 600_000,
  autoResumeAfterInterruption: true,
  liveMaxDriftMs: 5_000,
};

/** Deterministic exponential backoff with injectable jitter. */
export class Backoff {
  private _attempts = 0;

  constructor(private readonly random: () => number = Math.random) {}

  get attempts(): number {
    return this._attempts;
  }

  /** Delay for the next attempt; increments the attempt counter. */
  next(): number {
    const exponent = Math.min(this._attempts, 30);
    const raw = Math.min(
      RecoveryPolicy.RECONNECT_BASE_MS * 2 ** exponent,
      RecoveryPolicy.RECONNECT_MAX_MS
    );
    this._attempts += 1;
    const jitter = (this.random() * 2 - 1) * RecoveryPolicy.RECONNECT_JITTER;
    return Math.max(0, Math.round(raw * (1 + jitter)));
  }

  reset(): void {
    this._attempts = 0;
  }
}
