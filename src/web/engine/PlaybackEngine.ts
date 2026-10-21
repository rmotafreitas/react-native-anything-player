// The playback engine: one per player. A deterministic state machine that owns
// the play intent, the recovery policy and every timing decision. It never
// touches the DOM — it drives an `EngineDriver` (the <audio> adapter in
// production, a recorder in tests) and reads time from an `EngineClock`.
//
// Threading: single-threaded by nature (the browser's main thread). The engine
// never blocks and never sleeps; it asks its delegate for a single wake-up
// instant instead of owning timers.
//
// Stale-event protection: every source open gets a new `generation`; driver
// observations for any other generation are dropped (`accepts`).
//
// Twins: `ios/Core/PlaybackEngine.swift`, `android/.../core/PlaybackEngine.kt`.
// All three run `conformance/`.

import { PlayerError } from '../../errors';
import {
  Backoff,
  DEFAULT_ENGINE_OPTIONS,
  RecoveryPolicy,
  type EngineOptions,
} from './RecoveryPolicy';
import type {
  EngineClock,
  EngineDelegate,
  EngineDriver,
  LoadOutcome,
} from './contracts';
import { continuesIntent, statusEquals } from './status';
import {
  engineError,
  isNetworkSource,
  type EngineStatus,
  type FocusResult,
  type Interruption,
  type InterruptionReason,
  type NetworkState,
  type PlaybackState,
  type ReadyInfo,
  type SourceDescriptor,
} from './types';

export type {
  EngineClock,
  EngineDelegate,
  EngineDriver,
  LoadOutcome,
} from './contracts';

const READY: LoadOutcome = { kind: 'ready' };
const SUPERSEDED: LoadOutcome = { kind: 'superseded' };

function noSource(): PlayerError {
  return engineError('NO_SOURCE', 'No source loaded.', false);
}

function released(): PlayerError {
  return engineError('PLAYER_RELEASED', 'The player was released.', false);
}

export class PlaybackEngine {
  delegate: EngineDelegate | null = null;

  // ── Source & intent ──
  private _source: SourceDescriptor | null = null;
  private _generation = 0;
  private _loadId = 0;
  private pendingLoadId: number | null = null;
  private _state: PlaybackState = 'idle';
  private _playWhenReady = false;
  private isReleased = false;

  // ── Source facts ──
  private isLive = false;
  private duration: number | null = null;
  private seekable = false;
  private readyForGeneration = false;

  // ── System ──
  private _interruption: Interruption | null = null;
  private lastError: PlayerError | null = null;
  private network: NetworkState = 'unknown';
  private duckFactor = 1;
  private volume = 1;
  private muted = false;
  private rate = 1;

  // ── Timing (monotonic ms) ──
  private lastOpenAt: number | null = null;
  private flowedSinceOpen = false;
  private stallStartedAt: number | null = null;
  /** A stall waiting out `STALL_DEBOUNCE_MS` before it is published. */
  private stallPublishAt: number | null = null;
  private lastPosition = 0;
  private lastPositionAdvanceAt = 0;
  private lastBuffered = 0;
  private lastBufferedAdvanceAt = 0;
  private pausedAt: number | null = null;
  private driftMs = 0;
  private playingSince: number | null = null;
  private recoveringSince: number | null = null;
  /** Audio has flowed for `STABLE_PLAYBACK_MS`: the next loss reconnects at once. */
  private stable = false;
  private nextAttemptAt: number | null = null;
  private reconnectReason = '';
  private readonly backoff: Backoff;
  private offlineSkips = 0;
  private lastNetworkEdgeAt = -Infinity;
  private suspectUntil = -Infinity;
  private pauseReleaseAt: number | null = null;
  private connectionReleased = false;
  private resumePosition: number | null = null;
  private lastHeartbeatAt = 0;
  private lastPublished: EngineStatus | null = null;
  /** Discrete events wait until the status they imply was published. */
  private pendingEvents: Array<() => void> = [];

  constructor(
    private readonly driver: EngineDriver,
    private readonly clock: EngineClock,
    public options: EngineOptions = DEFAULT_ENGINE_OPTIONS,
    random: () => number = Math.random
  ) {
    this.backoff = new Backoff(random);
  }

  private get now(): number {
    return this.clock.monotonicMs;
  }

  // ── Queries ──

  get source(): SourceDescriptor | null {
    return this._source;
  }

  get generation(): number {
    return this._generation;
  }

  get loadId(): number {
    return this._loadId;
  }

  get state(): PlaybackState {
    return this._state;
  }

  get playWhenReady(): boolean {
    return this._playWhenReady;
  }

  get interruption(): Interruption | null {
    return this._interruption;
  }

  get status(): EngineStatus {
    const reconnecting =
      this._state === 'reconnecting' ||
      (this._state === 'loading' && this.backoff.attempts > 0);
    const reconnect = reconnecting
      ? {
          attempt: Math.max(1, this.backoff.attempts),
          nextAttemptAt:
            this.nextAttemptAt == null
              ? null
              : this.clock.wallMs + Math.max(0, this.nextAttemptAt - this.now),
          reason: this.reconnectReason,
        }
      : null;
    return {
      state: this._state,
      playWhenReady: this._playWhenReady,
      loadId: this._loadId,
      isLive: this.isLive,
      duration: this.duration,
      seekable: this.seekable,
      interruption: this._interruption,
      error: this._state === 'error' ? this.lastError : null,
      reconnect,
      network: this.network,
      volume: this.volume,
      muted: this.muted,
      rate: this.rate,
    };
  }

  /** Playback wanted but no audio rendered. */
  get wantsKeepalive(): boolean {
    return (
      this._playWhenReady &&
      (this._state === 'loading' ||
        this._state === 'buffering' ||
        this._state === 'reconnecting')
    );
  }

  /** Whether the player holds (or may soon re-take) audio focus. */
  get needsAudioFocus(): boolean {
    return this._playWhenReady || (this._interruption?.resumable ?? false);
  }

  /** Driver observations for any other generation are stale and must be dropped. */
  accepts(generation: number): boolean {
    return !this.isReleased && generation === this._generation;
  }

  // ── Commands ──

  load(
    newSource: SourceDescriptor,
    autoplay: boolean | null,
    startPosition: number | null
  ): void {
    this.ensureAlive();
    const wanted =
      autoplay ?? (this._playWhenReady && continuesIntent(this._state));
    if (this.pendingLoadId != null) {
      const superseded = this.pendingLoadId;
      this.pendingLoadId = null;
      this.delegate?.engineLoadSettled(superseded, SUPERSEDED);
    }
    this._source = newSource;
    this._loadId += 1;
    this.pendingLoadId = this._loadId;
    this.isLive = newSource.liveHint ?? false;
    this.duration = null;
    this.seekable = false;
    this.lastError = null;
    this._interruption = null;
    this.resetRecovery();
    this.resumePosition = startPosition;
    this._playWhenReady = wanted;
    if (wanted)
      this.applyFocus(this.delegate?.engineRequestsAudioFocus() ?? 'granted');
    this.log('load', {
      uri: newSource.uri,
      autoplay: `${this._playWhenReady}`,
    });
    this.open(startPosition, 'load');
    this.commit();
  }

  play(): void {
    this.ensureAlive();
    if (this._source == null) throw noSource();
    if (this._playWhenReady && continuesIntent(this._state)) {
      this.commit();
      return;
    }
    const focus = this.delegate?.engineRequestsAudioFocus() ?? 'granted';
    if (focus === 'denied') {
      this._interruption = {
        reason: 'audio-focus-denied',
        resumable: false,
        since: this.clock.wallMs,
      };
      this.log('play refused', { focus: 'denied' });
      this.commit();
      throw engineError(
        'AUDIO_FOCUS_DENIED',
        'The system refused audio focus (another app or a call holds it).',
        true
      );
    }
    if (focus === 'delayed') {
      this._interruption = {
        reason: 'audio-focus-delayed',
        resumable: true,
        since: this.clock.wallMs,
      };
      this.log('play deferred', { focus: 'delayed' });
      this.commit();
      return;
    }
    this._interruption = null;
    this.startPlayback('play');
    this.commit();
  }

  pause(): void {
    this.ensureAlive();
    const hadInterruption = this._interruption != null;
    this._interruption = null;
    if (!this._playWhenReady) {
      if (hadInterruption) this.log('pause', { note: 'cancels system resume' });
      this.commit();
      return;
    }
    this._playWhenReady = false;
    this.pauseIntent('pause');
    this.commit();
  }

  stop(): void {
    this.ensureAlive();
    if (this._source == null) return;
    this.settlePendingLoad(SUPERSEDED);
    this._playWhenReady = false;
    this._interruption = null;
    this.resetRecovery();
    this.pauseReleaseAt = null;
    this.stallStartedAt = null;
    this.pausedAt = null;
    this.driver.releaseConnection();
    this.connectionReleased = true;
    this.resumePosition = this.isLive ? null : 0;
    this.setState('stopped', 'stop');
    this.commit();
  }

  reset(): void {
    this.ensureAlive();
    this.settlePendingLoad(SUPERSEDED);
    this._generation += 1;
    this._source = null;
    this._playWhenReady = false;
    this._interruption = null;
    this.lastError = null;
    this.isLive = false;
    this.duration = null;
    this.seekable = false;
    this.resetRecovery();
    this.pauseReleaseAt = null;
    this.connectionReleased = false;
    this.driver.unload();
    this.setState('idle', 'reset');
    this.commit();
  }

  seek(seconds: number): void {
    this.ensureAlive();
    if (this._source == null) throw noSource();
    if (!this.seekable || this.isLive) {
      throw engineError('NOT_SEEKABLE', 'This source is not seekable.', false);
    }
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw engineError(
        'INVALID_ARGUMENT',
        'Seek position must be a finite number ≥ 0.',
        false
      );
    }
    const target =
      this.duration != null ? Math.min(seconds, this.duration) : seconds;
    this.resumePosition = target;
    this.lastPosition = target;
    this.lastPositionAdvanceAt = this.now;
    if (this._state === 'ended') this.setState('paused', 'seek after end');
    if (
      this.connectionReleased ||
      this._state === 'stopped' ||
      this._state === 'error'
    ) {
      this.commit();
      return;
    }
    this.driver.seek(target);
    this.commit();
  }

  setVolume(value: number): void {
    this.ensureAlive();
    if (!Number.isFinite(value)) {
      throw engineError(
        'INVALID_ARGUMENT',
        'Volume must be a finite number.',
        false
      );
    }
    this.volume = Math.min(1, Math.max(0, value));
    this.applyVolume();
    this.commit();
  }

  setMuted(value: boolean): void {
    this.ensureAlive();
    this.muted = value;
    this.applyVolume();
    this.commit();
  }

  setRate(value: number): void {
    this.ensureAlive();
    if (!Number.isFinite(value) || value <= 0) {
      throw engineError(
        'INVALID_ARGUMENT',
        'Rate must be a finite number > 0.',
        false
      );
    }
    this.rate = value;
    this.driver.setRate(value);
    this.commit();
  }

  /** Ducking requested by the system. */
  setDucked(ducked: boolean): void {
    if (this.isReleased) return;
    this.duckFactor = ducked ? 0.2 : 1;
    this.applyVolume();
  }

  release(): void {
    if (this.isReleased) return;
    this.settlePendingLoad({ kind: 'failed', error: released() });
    this._playWhenReady = false;
    this._interruption = null;
    this.resetRecovery();
    this.pauseReleaseAt = null;
    this.driver.unload();
    this.setState('idle', 'release');
    this.commit();
    this.isReleased = true;
    this.delegate?.engineWakeupAt(null);
  }

  // ── Driver observations (generation-guarded) ──

  onReady(generation: number, info: ReadyInfo): void {
    if (!this.accepts(generation)) return this.logStale('ready', generation);
    this.duration = info.duration;
    this.isLive = this._source?.liveHint ?? info.isLive;
    this.seekable = info.seekable && !this.isLive;
    this.readyForGeneration = true;
    if (this._state === 'loading') {
      if (this._playWhenReady) {
        this.setState('buffering', 'ready');
        this.beginWaiting();
      } else {
        this.setState('paused', 'ready');
        this.pausedAt = this.now;
        this.armPauseRelease();
      }
    }
    this.settlePendingLoad(READY);
    this.commit();
  }

  /** Audio is actually flowing. */
  onPlaying(generation: number): void {
    if (!this.accepts(generation)) return this.logStale('playing', generation);
    if (!this._playWhenReady) {
      this.log('native playing without intent', {});
      this.driver.pause();
      this.commit();
      return;
    }
    if (!this.readyForGeneration) {
      this.readyForGeneration = true;
      this.settlePendingLoad(READY);
    }
    const t = this.now;
    this.stallPublishAt = null;
    if (this.stallStartedAt != null) {
      this.driftMs += t - this.stallStartedAt;
      this.stallStartedAt = null;
    }
    this.flowedSinceOpen = true;
    this.lastOpenAt = null;
    this.nextAttemptAt = null;
    this.lastPosition = this.driver.sample().position;
    this.lastPositionAdvanceAt = t;
    this.playingSince = t;
    // Drift is only enforced at moments that are silent anyway (resuming from a
    // pause, or during a published stall), never by cutting audio that resumed.
    this.setState('playing', 'audio flowing');
    this.commit();
  }

  /** Playback wanted, waiting for data. */
  onBuffering(generation: number): void {
    if (!this.accepts(generation))
      return this.logStale('buffering', generation);
    if (this._state === 'playing' && this.stallPublishAt == null) {
      this.stallStartedAt = this.now;
      this.stallPublishAt = this.now + RecoveryPolicy.STALL_DEBOUNCE_MS;
      this.playingSince = null;
    }
    this.commit();
  }

  onFailed(generation: number, error: PlayerError): void {
    if (!this.accepts(generation)) return this.logStale('failed', generation);
    this.handleFailure(error);
    this.commit();
  }

  onEnded(generation: number): void {
    if (!this.accepts(generation)) return this.logStale('ended', generation);
    if (this.isLive || this.duration == null) {
      this.handleFailure(
        engineError('STREAM_ENDED', 'The stream closed the connection.', true)
      );
    } else {
      this._playWhenReady = false;
      this.resumePosition = 0;
      this.stallStartedAt = null;
      this.setState('ended', 'end of media');
      this.pendingEvents.push(() => this.delegate?.engineDidEnd());
    }
    this.commit();
  }

  /** The platform paused the player without being asked to. */
  onPausedExternally(generation: number, reason: InterruptionReason): void {
    if (!this.accepts(generation))
      return this.logStale('paused externally', generation);
    if (!this._playWhenReady) return;
    this.interruptionBegan(reason, false);
  }

  // ── System events ──

  interruptionBegan(reason: InterruptionReason, resumable: boolean): void {
    if (this.isReleased) return;
    if (!this._playWhenReady) {
      const current = this._interruption;
      if (current != null && current.resumable && !resumable) {
        this._interruption = { reason, resumable: false, since: current.since };
      }
      this.commit();
      return;
    }
    this._playWhenReady = false;
    this._interruption = { reason, resumable, since: this.clock.wallMs };
    this.pauseIntent(`system: ${reason}`);
    this.commit();
  }

  interruptionEnded(shouldResume: boolean): void {
    if (this.isReleased) return;
    const current = this._interruption;
    if (current == null) return;
    if (
      current.resumable &&
      shouldResume &&
      this.options.autoResumeAfterInterruption &&
      this._source != null
    ) {
      this._interruption = null;
      this.log('system resume', { reason: current.reason });
      this.startPlayback('system resume');
    } else {
      this._interruption = {
        reason: current.reason,
        resumable: false,
        since: current.since,
      };
    }
    this.commit();
  }

  networkChanged(next: NetworkState, interfaceChanged: boolean): void {
    if (this.isReleased) return;
    const previous = this.network;
    this.network = next;
    const t = this.now;
    if (previous === 'online' && next === 'offline') {
      this.markNetworkEdge(t);
      this.log('network lost', {});
    } else if (previous === 'offline' && next === 'online') {
      // (`unknown` → `online` is the first reading: a baseline, not an edge.)
      this.markNetworkEdge(t);
      this.backoff.reset();
      this.offlineSkips = 0;
      this.log('network restored', {});
      if (this._playWhenReady && this._state !== 'playing')
        this.attemptReconnect('network restored');
    } else if (previous === 'online' && next === 'online' && interfaceChanged) {
      this.markNetworkEdge(t);
      this.log('network handoff', {});
      if (
        this._playWhenReady &&
        (this._state === 'buffering' || this._state === 'reconnecting')
      ) {
        this.attemptReconnect('network handoff');
      }
    } else {
      // No edge: the first reading, or a repeat of the current state.
    }
    this.commit();
  }

  /** The app came to the foreground: recover wanted-but-silent audio now. */
  appForegrounded(): void {
    if (this.isReleased || !this._playWhenReady) return;
    if (
      this._state === 'reconnecting' ||
      this._state === 'buffering' ||
      this._state === 'loading'
    ) {
      this.attemptReconnect('app foregrounded');
    }
    this.commit();
  }

  /** The platform media stack was reset; the driver has been rebuilt. */
  platformReset(): void {
    if (this.isReleased || this._source == null || this._state === 'idle')
      return;
    this.log('platform reset', {});
    if (
      this._state === 'stopped' ||
      this._state === 'ended' ||
      this._state === 'error'
    ) {
      this.connectionReleased = true;
      this.commit();
      return;
    }
    this.reopen('media services reset');
    this.commit();
  }

  // ── Clock ──

  onWakeup(): void {
    if (this.isReleased) return;
    const t = this.now;
    this.releasePausedConnectionIfDue(t);
    this.publishStallIfDue(t);
    if (this._state === 'reconnecting') {
      const due = this.nextAttemptAt;
      if (due != null && due <= t) {
        this.nextAttemptAt = null;
        this.attemptReconnect('backoff elapsed');
      }
    }
    if (
      this._playWhenReady &&
      t - this.lastHeartbeatAt >= RecoveryPolicy.HEARTBEAT_MS - 50
    ) {
      this.lastHeartbeatAt = t;
      this.heartbeat(t);
    }
    this.commit();
  }

  private releasePausedConnectionIfDue(t: number): void {
    const due = this.pauseReleaseAt;
    if (due == null || due > t) return;
    this.pauseReleaseAt = null;
    if (
      this._state === 'paused' &&
      !this._playWhenReady &&
      !this.connectionReleased
    ) {
      this.driver.releaseConnection();
      this.connectionReleased = true;
      this.log('paused stream released', {});
    }
  }

  private publishStallIfDue(t: number): void {
    const due = this.stallPublishAt;
    if (due == null || due > t) return;
    this.stallPublishAt = null;
    const started = this.stallStartedAt;
    if (this._state === 'playing' && started != null) {
      this.setState('buffering', 'native stall');
      this.beginWaiting();
      this.stallStartedAt = started;
      this.lastBufferedAdvanceAt = started;
    }
  }

  // ── Internals ──

  private ensureAlive(): void {
    if (this.isReleased) throw released();
  }

  private applyFocus(focus: FocusResult): void {
    if (focus === 'granted') return;
    const delayed = focus === 'delayed';
    this._playWhenReady = false;
    this._interruption = {
      reason: delayed ? 'audio-focus-delayed' : 'audio-focus-denied',
      resumable: delayed,
      since: this.clock.wallMs,
    };
  }

  private startPlayback(cause: string): void {
    this._playWhenReady = true;
    this.pauseReleaseAt = null;
    if (this._state === 'error') this.lastError = null;
    switch (this._state) {
      case 'idle':
        this._playWhenReady = false;
        break;
      case 'loading':
        this.driver.play();
        break;
      case 'paused': {
        const pausedFor = this.pausedAt != null ? this.now - this.pausedAt : 0;
        this.pausedAt = null;
        if (this.connectionReleased || !this.readyForGeneration) {
          this.reopen(
            `${cause}: connection released`,
            this.isLive ? null : this.resumePosition
          );
        } else if (
          this.isLive &&
          this.driftMs + pausedFor >= this.options.liveMaxDriftMs
        ) {
          this.reopen(`${cause}: live edge after ${pausedFor}ms paused`);
        } else {
          this.driftMs += pausedFor;
          // State first: drivers may report "playing" re-entrantly from play().
          this.setState('buffering', cause);
          this.beginWaiting();
          this.driver.play();
        }
        break;
      }
      case 'stopped':
      case 'error':
        this.reopen(cause, this.isLive ? null : this.resumePosition);
        break;
      case 'ended':
        this.resumePosition = 0;
        this.setState('buffering', `${cause}: restart`);
        this.beginWaiting();
        this.driver.seek(0);
        this.driver.play();
        break;
      default:
        // buffering, playing, reconnecting: already on its way.
        break;
    }
  }

  private pauseIntent(cause: string): void {
    this.resetRecovery();
    this.stallStartedAt = null;
    this.playingSince = null;
    switch (this._state) {
      case 'playing':
      case 'buffering':
        this.rememberPosition();
        this.pausedAt = this.now;
        this.setState('paused', cause);
        this.armPauseRelease();
        break;
      case 'reconnecting':
        this.connectionReleased = true;
        this.pausedAt = this.now;
        this.setState('paused', cause);
        break;
      case 'loading':
        this.log('paused while loading', {});
        break;
      default:
        break;
    }
    this.driver.pause();
  }

  private open(startPosition: number | null, reason: string): void {
    const source = this._source;
    if (source == null) return;
    this._generation += 1;
    this.readyForGeneration = false;
    this.flowedSinceOpen = false;
    this.connectionReleased = false;
    this.stallStartedAt = null;
    this.pausedAt = null;
    this.playingSince = null;
    this.driftMs = 0;
    this.pauseReleaseAt = null;
    this.lastOpenAt = this.now;
    this.lastPosition = startPosition ?? 0;
    this.lastBuffered = 0;
    this.lastBufferedAdvanceAt = this.now;
    this.lastPositionAdvanceAt = this.now;
    this.lastHeartbeatAt = this.now;
    this.setState('loading', reason);
    this.driver.open({
      generation: this._generation,
      source,
      startPosition,
      playWhenReady: this._playWhenReady,
    });
  }

  private reopen(reason: string, startPosition: number | null = null): void {
    const position = this.isLive
      ? null
      : (startPosition ??
        this.resumePosition ??
        this.currentPositionEstimate());
    this.log('reopen', { reason });
    this.open(position, reason);
  }

  private currentPositionEstimate(): number | null {
    if (this.isLive) return null;
    return this.lastPosition > 0 ? this.lastPosition : null;
  }

  private rememberPosition(): void {
    if (this.isLive) return;
    const p = this.driver.sample().position;
    if (Number.isFinite(p) && p >= 0) {
      this.lastPosition = p;
      this.resumePosition = p;
    }
  }

  private beginWaiting(): void {
    this.stallStartedAt = this.now;
    this.playingSince = null;
    this.lastBufferedAdvanceAt = this.now;
    this.lastBuffered = this.driver.sample().bufferedPosition;
  }

  private handleFailure(error: PlayerError): void {
    this.lastError = error;
    const wasInitialLoad =
      !this.readyForGeneration && this.pendingLoadId != null;
    this.settlePendingLoad({ kind: 'failed', error });
    this.log('failure', {
      code: error.code,
      recoverable: `${error.recoverable}`,
      message: error.message,
    });
    if (!error.recoverable) {
      this.fail(error);
      return;
    }
    if (this._playWhenReady && this.options.reconnect) {
      this.pendingEvents.push(() => this.delegate?.engineError(error, false));
      if (!this.isLive) this.rememberPosition();
      this.scheduleReconnect(error.code);
    } else if (this._playWhenReady || wasInitialLoad) {
      this.fail(error);
    } else {
      this.connectionReleased = true;
      this.pauseReleaseAt = null;
      if (this._state === 'loading' || this._state === 'buffering') {
        this.setState('paused', 'died while paused');
      }
    }
  }

  private fail(error: PlayerError): void {
    this.lastError = error;
    this._playWhenReady = false;
    this.resetRecovery();
    this.pauseReleaseAt = null;
    this.stallStartedAt = null;
    this.driver.releaseConnection();
    this.connectionReleased = true;
    this.setState('error', error.code);
    this.pendingEvents.push(() => this.delegate?.engineError(error, true));
  }

  private scheduleReconnect(reason: string): void {
    const t = this.now;
    if (this.recoveringSince == null) this.recoveringSince = t;
    if (this._state === 'reconnecting' && this.nextAttemptAt != null) return;
    // A healthy stream that suddenly drops reconnects immediately; repeated failures back off.
    let delay: number;
    if (this.stable) {
      this.stable = false;
      delay = 0;
    } else {
      delay = this.backoff.next();
    }
    this.nextAttemptAt = t + delay;
    this.reconnectReason = reason;
    this.stallStartedAt = null;
    this.playingSince = null;
    this.setState(
      'reconnecting',
      `${reason} — attempt ${this.backoff.attempts} in ${delay}ms`
    );
  }

  private get openInFlight(): boolean {
    const opened = this.lastOpenAt;
    if (this._state !== 'loading' || opened == null || this.flowedSinceOpen)
      return false;
    return (
      opened > this.lastNetworkEdgeAt &&
      this.now - opened < RecoveryPolicy.OPEN_GRACE_MS
    );
  }

  private attemptReconnect(reason: string): void {
    if (!this._playWhenReady || this._source == null) return;
    if (this.openInFlight) {
      this.log('reconnect skipped', { reason, note: 'open in flight' });
      return;
    }
    if (this.recoveringSince == null) this.recoveringSince = this.now;
    if (
      this.network === 'offline' &&
      this.offlineSkips < RecoveryPolicy.OFFLINE_PROBE_EVERY
    ) {
      this.offlineSkips += 1;
      const delay = this.backoff.next();
      this.nextAttemptAt = this.now + delay;
      this.reconnectReason = 'offline';
      this.setState('reconnecting', `${reason}: offline, probe in ${delay}ms`);
      return;
    }
    this.offlineSkips = 0;
    if (this.backoff.attempts === 0) this.backoff.next();
    this.nextAttemptAt = null;
    this.reconnectReason = reason;
    this.reopen(`reconnect: ${reason}`);
  }

  private heartbeat(t: number): void {
    const since = this.recoveringSince;
    const limit = this.options.giveUpAfterMs;
    if (
      since != null &&
      limit != null &&
      t - since >= limit &&
      this._state !== 'playing'
    ) {
      const error =
        this.lastError ??
        engineError(
          'NETWORK_ERROR',
          `Recovery gave up after ${Math.trunc(limit / 1000)}s.`,
          true
        );
      this.log('giving up', { afterMs: `${t - since}` });
      this.fail(error);
      return;
    }
    const suspect = t < this.suspectUntil;
    switch (this._state) {
      case 'loading': {
        const opened = this.lastOpenAt;
        if (opened != null && t - opened >= RecoveryPolicy.OPEN_TIMEOUT_MS) {
          this.handleFailure(
            engineError('TIMEOUT', 'Opening the source timed out.', true)
          );
        }
        break;
      }
      case 'playing':
        this.heartbeatPlaying(t, suspect);
        break;
      case 'buffering':
        this.heartbeatBuffering(t, suspect);
        break;
      default:
        break;
    }
  }

  private heartbeatPlaying(t: number, suspect: boolean): void {
    const sample = this.driver.sample();
    if (!this.isLive) this.resumePosition = sample.position;
    if (
      sample.position > this.lastPosition + 0.05 ||
      sample.position < this.lastPosition - 0.5
    ) {
      this.lastPosition = sample.position;
      this.lastPositionAdvanceAt = t;
    } else {
      const stallLimit = suspect
        ? RecoveryPolicy.SUSPECT_SILENT_STALL_MS
        : RecoveryPolicy.SILENT_STALL_MS;
      if (t - this.lastPositionAdvanceAt >= stallLimit && this.rate > 0) {
        this.log('silent stall', {
          frozenMs: `${t - this.lastPositionAdvanceAt}`,
        });
        this.setState('buffering', 'silent stall');
        this.beginWaiting();
        this.stallStartedAt = this.lastPositionAdvanceAt;
      }
    }
    const playing = this.playingSince;
    if (playing != null && t - playing >= RecoveryPolicy.STABLE_PLAYBACK_MS) {
      this.playingSince = null;
      this.stable = true;
      this.backoff.reset();
      this.offlineSkips = 0;
      this.recoveringSince = null;
    }
  }

  private heartbeatBuffering(t: number, suspect: boolean): void {
    const sample = this.driver.sample();
    if (sample.bufferedPosition > this.lastBuffered + 0.01) {
      this.lastBuffered = sample.bufferedPosition;
      this.lastBufferedAdvanceAt = t;
    }
    const stalled = this.stallStartedAt;
    if (stalled == null) return;
    if (this.network === 'offline') {
      if (t - this.lastBufferedAdvanceAt >= RecoveryPolicy.STALL_DEAD_MS) {
        if (this.recoveringSince == null) this.recoveringSince = stalled;
        this.scheduleReconnect('offline');
      }
      return;
    }
    const deadLimit = suspect
      ? RecoveryPolicy.SUSPECT_STALL_DEAD_MS
      : RecoveryPolicy.STALL_DEAD_MS;
    if (t - this.lastBufferedAdvanceAt >= deadLimit) {
      this.attemptReconnect(`stalled ${t - stalled}ms with no data`);
    } else if (t - stalled >= RecoveryPolicy.STALL_MAX_MS) {
      this.attemptReconnect(`stalled ${t - stalled}ms`);
    } else if (
      this.isLive &&
      this.driftMs + (t - stalled) >= this.options.liveMaxDriftMs
    ) {
      this.attemptReconnect('live drift during stall');
    } else {
      // Data is arriving: give the buffer time to recover.
    }
  }

  private armPauseRelease(): void {
    const source = this._source;
    if (source == null) return;
    if (
      !isNetworkSource(source) ||
      !(this.isLive || this.duration == null) ||
      this.connectionReleased
    )
      return;
    this.pauseReleaseAt = this.now + RecoveryPolicy.PAUSED_STREAM_RELEASE_MS;
  }

  private resetRecovery(): void {
    this.stable = false;
    this.backoff.reset();
    this.nextAttemptAt = null;
    this.recoveringSince = null;
    this.offlineSkips = 0;
    this.reconnectReason = '';
  }

  private markNetworkEdge(t: number): void {
    this.lastNetworkEdgeAt = t;
    this.suspectUntil = t + RecoveryPolicy.NETWORK_SUSPECT_MS;
  }

  private applyVolume(): void {
    this.driver.setVolume(this.muted ? 0 : this.volume * this.duckFactor);
  }

  private settlePendingLoad(outcome: LoadOutcome): void {
    const id = this.pendingLoadId;
    if (id == null) return;
    this.pendingLoadId = null;
    this.delegate?.engineLoadSettled(id, outcome);
  }

  private setState(next: PlaybackState, cause: string): void {
    if (next === this._state) return;
    if (next !== 'playing') this.stallPublishAt = null;
    const previous = this._state;
    this._state = next;
    this.log('transition', { from: previous, to: next, cause });
  }

  private log(event: string, details: Record<string, string>): void {
    this.delegate?.engineDiagnostic({
      wallTime: this.clock.wallMs,
      generation: this._generation,
      state: this._state,
      event,
      details,
    });
  }

  private logStale(event: string, gen: number): void {
    this.log('stale event dropped', { event, eventGeneration: `${gen}` });
  }

  /** Publishes the status (if changed) and the next wake-up instant. */
  private commit(): void {
    const current = this.status;
    if (!statusEquals(current, this.lastPublished)) {
      this.lastPublished = current;
      this.delegate?.engineStatusChanged(current);
    }
    const events = this.pendingEvents;
    this.pendingEvents = [];
    events.forEach((event) => event());
    this.delegate?.engineWakeupAt(this.nextWakeup());
  }

  private nextWakeup(): number | null {
    if (this.isReleased) return null;
    const candidates: number[] = [];
    if (this.pauseReleaseAt != null) candidates.push(this.pauseReleaseAt);
    if (this.stallPublishAt != null) candidates.push(this.stallPublishAt);
    if (this._state === 'reconnecting' && this.nextAttemptAt != null)
      candidates.push(this.nextAttemptAt);
    if (this._playWhenReady)
      candidates.push(this.lastHeartbeatAt + RecoveryPolicy.HEARTBEAT_MS);
    return candidates.length > 0 ? Math.min(...candidates) : null;
  }
}
