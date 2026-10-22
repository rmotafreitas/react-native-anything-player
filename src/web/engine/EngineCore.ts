// The engine's core: state, commands, driver observations, recovery and the
// clock. `PlaybackEngine` (PlaybackEngine.ts) adds the system inputs —
// interruptions, connectivity, the foreground, outputs. The split only keeps
// each file readable; the twins (`ios/Core/PlaybackEngine.swift`,
// `android/.../core/PlaybackEngine.kt`) are one type each.

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
  UNKNOWN_ROUTE,
  type AudioRoute,
  type EngineStatus,
  type FocusResult,
  type Interruption,
  type InterruptionReason,
  type NetworkState,
  type PlaybackState,
  type ReadyInfo,
  type SourceDescriptor,
} from './types';

const READY: LoadOutcome = { kind: 'ready' };
const SUPERSEDED: LoadOutcome = { kind: 'superseded' };

function noSource(): PlayerError {
  return engineError('NO_SOURCE', 'No source loaded.', false);
}

function released(): PlayerError {
  return engineError('PLAYER_RELEASED', 'The player was released.', false);
}

export abstract class EngineCore {
  delegate: EngineDelegate | null = null;

  // ── Source & intent ──
  protected _source: SourceDescriptor | null = null;
  protected _generation = 0;
  protected _loadId = 0;
  protected pendingLoadId: number | null = null;
  protected _state: PlaybackState = 'idle';
  protected _playWhenReady = false;
  protected isReleased = false;

  // ── Source facts ──
  protected isLive = false;
  protected duration: number | null = null;
  protected seekable = false;
  protected readyForGeneration = false;

  // ── System ──
  protected _interruption: Interruption | null = null;
  protected lastError: PlayerError | null = null;
  protected network: NetworkState = 'unknown';
  protected duckFactor = 1;
  protected volume = 1;
  protected muted = false;
  protected rate = 1;

  // ── Output ──
  protected route: AudioRoute = UNKNOWN_ROUTE;
  protected outputId = 'local';
  /** The audio plays on another device (Cast): the local audio rules are off. */
  protected remote = false;

  // ── Timing (monotonic ms) ──
  protected lastOpenAt: number | null = null;
  protected flowedSinceOpen = false;
  protected stallStartedAt: number | null = null;
  /** A stall waiting out `STALL_DEBOUNCE_MS` before it is published. */
  protected stallPublishAt: number | null = null;
  protected lastPosition = 0;
  protected lastPositionAdvanceAt = 0;
  protected lastBuffered = 0;
  protected lastBufferedAdvanceAt = 0;
  protected pausedAt: number | null = null;
  protected driftMs = 0;
  protected playingSince: number | null = null;
  protected recoveringSince: number | null = null;
  /** Audio has flowed for `STABLE_PLAYBACK_MS`: the next loss reconnects at once. */
  protected stable = false;
  protected nextAttemptAt: number | null = null;
  protected reconnectReason = '';
  protected readonly backoff: Backoff;
  protected offlineSkips = 0;
  protected lastNetworkEdgeAt = -Infinity;
  protected suspectUntil = -Infinity;
  protected pauseReleaseAt: number | null = null;
  protected connectionReleased = false;
  protected resumePosition: number | null = null;
  protected lastHeartbeatAt = 0;
  protected lastPublished: EngineStatus | null = null;
  /** Discrete events wait until the status they imply was published. */
  protected pendingEvents: Array<() => void> = [];

  constructor(
    protected readonly driver: EngineDriver,
    protected readonly clock: EngineClock,
    public options: EngineOptions = DEFAULT_ENGINE_OPTIONS,
    random: () => number = Math.random
  ) {
    this.backoff = new Backoff(random);
  }

  protected get now(): number {
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
      route: this.route,
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
    if (this.remote) return false;
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
    if (wanted) this.applyFocus(this.requestFocus());
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
    const focus = this.requestFocus();
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
    if (!this.remote) this.applyVolume();
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
    this.systemPause(reason, false);
  }

  // ── System pause (shared by the system inputs and the driver) ──

  protected systemPause(reason: InterruptionReason, resumable: boolean): void {
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

  protected releasePausedConnectionIfDue(t: number): void {
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

  protected publishStallIfDue(t: number): void {
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

  protected ensureAlive(): void {
    if (this.isReleased) throw released();
  }

  /** Audio focus is the device's: a remote output always has it. */
  protected requestFocus(): FocusResult {
    if (this.remote) return 'granted';
    return this.delegate?.engineRequestsAudioFocus() ?? 'granted';
  }

  protected applyFocus(focus: FocusResult): void {
    if (focus === 'granted') return;
    const delayed = focus === 'delayed';
    this._playWhenReady = false;
    this._interruption = {
      reason: delayed ? 'audio-focus-delayed' : 'audio-focus-denied',
      resumable: delayed,
      since: this.clock.wallMs,
    };
  }

  protected startPlayback(cause: string): void {
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
        this.restartFromEnd(cause);
        break;
      default:
        // buffering, playing, reconnecting: already on its way.
        break;
    }
  }

  protected restartFromEnd(cause: string): void {
    this.resumePosition = 0;
    if (this.connectionReleased) {
      // The item left its output (a handoff): open it again.
      this.reopen(`${cause}: restart`, 0);
      return;
    }
    this.setState('buffering', `${cause}: restart`);
    this.beginWaiting();
    this.driver.seek(0);
    this.driver.play();
  }

  protected pauseIntent(cause: string): void {
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

  protected open(startPosition: number | null, reason: string): void {
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

  protected reopen(reason: string, startPosition: number | null = null): void {
    const position = this.isLive
      ? null
      : (startPosition ??
        this.resumePosition ??
        this.currentPositionEstimate());
    this.log('reopen', { reason });
    this.open(position, reason);
  }

  protected currentPositionEstimate(): number | null {
    if (this.isLive) return null;
    return this.lastPosition > 0 ? this.lastPosition : null;
  }

  /** Where the item is, read before it leaves its output. */
  protected handoffPosition(): number | null {
    if (this.isLive) return null;
    const sampled =
      this._state === 'playing' ||
      this._state === 'buffering' ||
      this._state === 'paused';
    if (sampled && this.readyForGeneration && !this.connectionReleased)
      this.rememberPosition();
    return this.resumePosition ?? this.currentPositionEstimate();
  }

  protected rememberPosition(): void {
    if (this.isLive) return;
    const p = this.driver.sample().position;
    if (Number.isFinite(p) && p >= 0) {
      this.lastPosition = p;
      this.resumePosition = p;
    }
  }

  protected beginWaiting(): void {
    this.stallStartedAt = this.now;
    this.playingSince = null;
    this.lastBufferedAdvanceAt = this.now;
    this.lastBuffered = this.driver.sample().bufferedPosition;
  }

  protected handleFailure(error: PlayerError): void {
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

  protected fail(error: PlayerError): void {
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

  protected scheduleReconnect(reason: string): void {
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

  protected get openInFlight(): boolean {
    const opened = this.lastOpenAt;
    if (this._state !== 'loading' || opened == null || this.flowedSinceOpen)
      return false;
    return (
      opened > this.lastNetworkEdgeAt &&
      this.now - opened < RecoveryPolicy.OPEN_GRACE_MS
    );
  }

  protected attemptReconnect(reason: string): void {
    if (!this._playWhenReady || this._source == null) return;
    if (this.openInFlight) {
      this.log('reconnect skipped', { reason, note: 'open in flight' });
      return;
    }
    if (this.recoveringSince == null) this.recoveringSince = this.now;
    if (
      !this.remote &&
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

  protected heartbeat(t: number): void {
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
        if (this.remote) this.heartbeatRemoteBuffering(t);
        else this.heartbeatBuffering(t, suspect);
        break;
      default:
        break;
    }
  }

  protected heartbeatPlaying(t: number, suspect: boolean): void {
    const sample = this.driver.sample();
    if (!this.isLive) this.resumePosition = sample.position;
    if (
      sample.position > this.lastPosition + 0.05 ||
      sample.position < this.lastPosition - 0.5
    ) {
      this.lastPosition = sample.position;
      this.lastPositionAdvanceAt = t;
    } else if (this.remote) {
      // A receiver's position is interpolated between its reports: only the
      // state it reports (buffering, failed) counts.
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

  protected heartbeatBuffering(t: number, suspect: boolean): void {
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

  /** No buffer to watch on a receiver: only a stall that lasts too long. */
  protected heartbeatRemoteBuffering(t: number): void {
    const stalled = this.stallStartedAt;
    if (stalled != null && t - stalled >= RecoveryPolicy.STALL_MAX_MS)
      this.attemptReconnect(`stalled ${t - stalled}ms`);
  }

  protected armPauseRelease(): void {
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

  protected resetRecovery(): void {
    this.stable = false;
    this.backoff.reset();
    this.nextAttemptAt = null;
    this.recoveringSince = null;
    this.offlineSkips = 0;
    this.reconnectReason = '';
  }

  protected markNetworkEdge(t: number): void {
    this.lastNetworkEdgeAt = t;
    this.suspectUntil = t + RecoveryPolicy.NETWORK_SUSPECT_MS;
  }

  protected applyVolume(): void {
    const duck = this.remote ? 1 : this.duckFactor;
    this.driver.setVolume(this.muted ? 0 : this.volume * duck);
  }

  protected settlePendingLoad(outcome: LoadOutcome): void {
    const id = this.pendingLoadId;
    if (id == null) return;
    this.pendingLoadId = null;
    this.delegate?.engineLoadSettled(id, outcome);
  }

  protected setState(next: PlaybackState, cause: string): void {
    if (next === this._state) return;
    if (next !== 'playing') this.stallPublishAt = null;
    const previous = this._state;
    this._state = next;
    this.log('transition', { from: previous, to: next, cause });
  }

  protected log(event: string, details: Record<string, string>): void {
    this.delegate?.engineDiagnostic({
      wallTime: this.clock.wallMs,
      generation: this._generation,
      state: this._state,
      event,
      details,
    });
  }

  protected logStale(event: string, gen: number): void {
    this.log('stale event dropped', { event, eventGeneration: `${gen}` });
  }

  /** Publishes the status (if changed) and the next wake-up instant. */
  protected commit(): void {
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

  protected nextWakeup(): number | null {
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
