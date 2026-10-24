import type {
  FallbackPolicy,
  QualityPolicy,
  VideoEngineOptions,
} from './types';

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
  /** How often a fade (play, pause, stop, `fadeTo`, the sleep timer) updates the volume. */
  FADE_TICK_MS: 50,

  // ── Video ──
  /** A player without a view this long stops decoding the picture (a move between views keeps it). */
  VIEW_DETACH_GRACE_MS: 1_000,
  /** In the background, Picture in Picture may start (or the app return) this long after the event. */
  PIP_GRACE_MS: 1_000,
  /** A quality switch's new file must play within this, or the switch is dropped. */
  SWAP_TIMEOUT_MS: 12_000,
  /** A rendition that failed is not picked again for this long. */
  FAILED_RENDITION_MS: 60_000,
  /** How long a 401/403 waits for the app's new source before the backoff takes over. */
  REFRESH_TIMEOUT_MS: 10_000,
  /** A source with `expiresAt` asks for a new one this long ahead. */
  REFRESH_AHEAD_MS: 60_000,
  /** Automatic quality: a rendition fits a bandwidth this many times its bitrate. */
  ABR_FIT_RATIO: 0.7,
  /** A stall steps down when the bandwidth is under this × the current bitrate. */
  ABR_STALL_RATIO: 1.2,
  /** The bandwidth under the current bitrate for this long steps down. */
  ABR_LOW_MS: 10_000,
  /** The bandwidth above this × the next bitrate… */
  ABR_UP_RATIO: 1.5,
  /** …for this long steps up (and as long after any switch or stall). */
  ABR_UP_MS: 30_000,
  /** Two stalls in this window step down whatever the bandwidth. */
  ABR_STALL_WINDOW_MS: 30_000,
  /** Data Saver, Low Data Mode, `saveData`: the highest picture. */
  DATA_SAVER_MAX_HEIGHT: 480,
  /** Automatic start with no bandwidth reading: the lowest rendition at least this high. */
  START_MIN_HEIGHT: 480,
  /** Audio-only fallback without bandwidth readings: try the picture again after this long without a stall. */
  FALLBACK_PROBE_MS: 60_000,
} as const;

/** App-configurable engine knobs (`PlayerOptions`): recovery and fades. */
export interface EngineOptions {
  /** Reconnect automatically after recoverable failures while playback is wanted. */
  reconnect: boolean;
  /** Give up recovering after this long without stable playback (`null` = never). */
  giveUpAfterMs: number | null;
  /** Resume automatically when the system ends a transient interruption. */
  autoResumeAfterInterruption: boolean;
  /** Live drift (pauses + stalls since the open) that forces a live-edge re-open. */
  liveMaxDriftMs: number;
  /** Fade-in when playback starts (`0` = none). Starts when the audio does. */
  fadeInMs: number;
  /** Fade-out before a pause or a stop, and the sleep timer's default (`0` = none). */
  fadeOutMs: number;
  /** A video player's rules; `null` for an audio player. */
  video: VideoEngineOptions | null;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  reconnect: true,
  giveUpAfterMs: 600_000,
  autoResumeAfterInterruption: true,
  liveMaxDriftMs: 5_000,
  fadeInMs: 0,
  fadeOutMs: 0,
  video: null,
};

/** The audio-only fallback's default thresholds. */
export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = {
  dropBelowRatio: 1.2,
  dropAfterMs: 10_000,
  dropAfterStalls: 2,
  stallWindowMs: 30_000,
  returnAboveRatio: 1.5,
  returnAfterMs: 30_000,
};

export const DEFAULT_QUALITY_POLICY: QualityPolicy = {
  maxHeight: null,
  maxBitrate: null,
  cellularMaxHeight: null,
  cellularMaxBitrate: null,
  startQuality: 'auto',
  followDataSaver: true,
  capToView: true,
};

export const DEFAULT_VIDEO_OPTIONS: VideoEngineOptions = {
  whenBackgrounded: 'pause',
  ambient: false,
  keepAwake: true,
  focusWhenMuted: false,
  fallback: null,
  quality: DEFAULT_QUALITY_POLICY,
  tracks: { languages: [], followSystem: true },
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
