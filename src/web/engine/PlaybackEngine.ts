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

import { EngineVideo } from './EngineVideo';
import { RecoveryPolicy } from './RecoveryPolicy';
import { continuesIntent } from './status';
import {
  engineError,
  type AudioRoute,
  type InterruptionReason,
  type NetworkState,
  type PlaybackState,
} from './types';

export type {
  EngineClock,
  EngineDelegate,
  EngineDriver,
  LoadOutcome,
} from './contracts';

/** Playback wanted, nothing heard yet: the foreground recovers these at once. */
const WAITING_STATES: ReadonlySet<PlaybackState> = new Set<PlaybackState>([
  'reconnecting',
  'buffering',
  'loading',
]);

export class PlaybackEngine extends EngineVideo {
  // ── Output ──

  /** The local output changed (headphones, AirPlay, Bluetooth). Ignored while casting. */
  routeChanged(route: AudioRoute): void {
    if (this.isReleased) return;
    if (this.remote) {
      this.log('route ignored', { kind: route.kind, note: 'remote output' });
      return;
    }
    this.route = route;
    this.commit();
  }

  /**
   * The audio moves to another output: a Cast receiver, or back to the
   * device. The item is unloaded from the previous output and, if it was
   * active, re-opened on the new one at the same position. `resume` keeps the
   * play intent; without it the item arrives paused. An inactive item
   * (stopped, ended, failed) re-opens on the new output at the next `play()`.
   */
  handoff(route: AudioRoute, outputId: string, resume: boolean): void {
    if (this.isReleased) return;
    if (outputId === this.outputId) {
      this.route = route;
      this.commit();
      return;
    }
    // A fade-out lands first: the pause belongs to the old output.
    this.completeFadeOut();
    const position = this.handoffPosition();
    // A paused stream whose connection was released stays released.
    const active =
      this._source != null &&
      continuesIntent(this._state) &&
      !(this._state === 'paused' && this.connectionReleased);
    if (this._source != null) this.driver.unload();
    this.driver.switchOutput(outputId);
    this.outputId = outputId;
    this.route = route;
    this.remote = route.kind === 'cast';
    this.log('handoff', { to: outputId, resume: `${resume}` });
    this.settleFades();
    this.applyVolume();
    if (active) {
      this._playWhenReady = resume && this._playWhenReady;
      this.resetRecovery();
      this.resumePosition = position;
      if (this._playWhenReady) this.applyFocus(this.requestFocus());
      this.open(position, 'handoff');
    } else {
      // Old-output callbacks are stale; nothing is loaded on the new one.
      this.cancelSwap('handoff');
      this._generation = this.issueGeneration();
      this.readyForGeneration = false;
      if (this._source != null) this.connectionReleased = true;
    }
    this.commit();
  }

  // ── System events ──

  interruptionBegan(reason: InterruptionReason, resumable: boolean): void {
    if (this.isReleased) return;
    if (this.remote) {
      // A call on the phone does not pause the living-room speaker.
      this.log('interruption ignored', { reason, note: 'remote output' });
      return;
    }
    this.systemPause(reason, resumable);
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
    if (this.remote) {
      // The receiver has its own network: the phone's must not reload it.
      this.commit();
      return;
    }
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
      if (this.autoReconnect && this._state !== 'playing')
        this.attemptReconnect('network restored');
    } else if (previous === 'online' && next === 'online' && interfaceChanged) {
      this.markNetworkEdge(t);
      this.log('network handoff', {});
      if (
        this.autoReconnect &&
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
    if (this.isReleased) return;
    // Read before a video player resumes: its resume is not a stall.
    const stalled =
      this.autoReconnect && !this.remote && WAITING_STATES.has(this._state);
    this.videoForegrounded();
    if (stalled) this.attemptReconnect('app foregrounded');
    this.commit();
  }

  /** The platform media stack was reset; the driver has been rebuilt. */
  platformReset(): void {
    if (
      this.isReleased ||
      this.remote ||
      this._source == null ||
      this._state === 'idle'
    )
      return;
    this.log('platform reset', {});
    this.completeFadeOut();
    if (
      this._state === 'stopped' ||
      this._state === 'ended' ||
      this._state === 'error' ||
      this.connectionReleased
    ) {
      // Nothing was open (a paused stream may have released its connection):
      // `play()` opens it, as before the reset.
      this.connectionReleased = true;
      this.commit();
      return;
    }
    if (!this.options.reconnect) {
      // Re-opening on its own is what `reconnect: false` turns off.
      this.handleFailure(
        engineError('NETWORK_ERROR', 'The media services were reset.', true)
      );
      this.commit();
      return;
    }
    this.reopen('media services reset');
    this.commit();
  }

  // ── Watchdog (every heartbeat while playback is wanted or an open is outstanding) ──

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
        this.videoHeartbeat(t);
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
      // A native stall awaiting publication is not silent.
      if (
        this.stallPublishAt == null &&
        t - this.lastPositionAdvanceAt >= stallLimit &&
        this.rate > 0
      ) {
        this.log('silent stall', {
          frozenMs: `${t - this.lastPositionAdvanceAt}`,
        });
        this.setState('buffering', 'silent stall');
        this.beginWaiting();
        this.stallStartedAt = this.lastPositionAdvanceAt;
        this.silentStall = true;
        this.stallPublished(t);
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
    const p = sample.position;
    this.trackResumePosition(p);
    if (this.silentStall && p > this.lastPosition + 0.05) {
      // The stall was ours (native never left playing): the playhead moving
      // again is the only sign it is over.
      this.endSilentStall(t, p);
      return;
    }
    if (this.playheadPlays(t, p)) {
      // The platform plays but never said so: the playhead is the proof.
      this.log('playhead moving', { at: p.toFixed(1) });
      this.onPlaying(this.generation);
      return;
    }
    if (sample.bufferedPosition > this.lastBuffered + 0.01) {
      this.lastBuffered = sample.bufferedPosition;
      this.lastBufferedAdvanceAt = t;
    }
    const stalled = this.stallStartedAt;
    if (stalled == null) return;
    if (this.network === 'offline') return this.offlineStall(t, stalled);
    const deadLimit = suspect
      ? RecoveryPolicy.SUSPECT_STALL_DEAD_MS
      : RecoveryPolicy.STALL_DEAD_MS;
    if (t - this.lastBufferedAdvanceAt >= deadLimit) {
      this.recoverStall(`stalled ${t - stalled}ms with no data`);
    } else if (t - stalled >= RecoveryPolicy.STALL_MAX_MS) {
      this.recoverStall(`stalled ${t - stalled}ms`);
    } else if (
      this.isLive &&
      this.driftMs + (t - stalled) >= this.options.liveMaxDriftMs
    ) {
      this.recoverStall('live drift during stall');
    } else {
      // Data is arriving: give the buffer time to recover.
    }
  }

  /**
   * Whether the playhead has run on, reading after reading, at about the
   * playback rate for `PLAYHEAD_PROOF_S` (a jump, like a live edge or a
   * seek, or a frozen playhead, starts the run again).
   */
  protected playheadPlays(t: number, p: number): boolean {
    const last = this.waitingLast;
    if (last == null || this.waitingFrom == null || this.remote) return false;
    const dt = (t - last.at) / 1000;
    const dp = p - last.position;
    const rate = Math.max(this.rate, 0.1);
    const runs =
      dt > 0 && dp >= 0.5 * rate * dt && dp <= 1.5 * rate * dt + 0.25;
    this.waitingLast = { position: p, at: t };
    if (!runs) this.waitingFrom = { position: p, at: t };
    return (
      runs && p - this.waitingFrom.position >= RecoveryPolicy.PLAYHEAD_PROOF_S
    );
  }

  /**
   * A re-open resumes where the playhead got to during a stall; a reading
   * behind the last trusted position (a start seek still pending) is not one.
   */
  protected trackResumePosition(p: number): void {
    if (
      !this.isLive &&
      Number.isFinite(p) &&
      p >= Math.max(this.lastPosition, this.resumePosition ?? 0)
    )
      this.resumePosition = p;
  }

  /** Offline: no data for `STALL_DEAD_MS` waits for the network, in the backoff. */
  protected offlineStall(t: number, stalled: number): void {
    if (t - this.lastBufferedAdvanceAt < RecoveryPolicy.STALL_DEAD_MS) return;
    if (!this.options.reconnect) return this.failStall('offline');
    this.recoveringSince ??= stalled;
    this.scheduleReconnect('offline');
  }

  /** No buffer to watch on a receiver: only a stall that lasts too long. */
  protected heartbeatRemoteBuffering(t: number): void {
    const stalled = this.stallStartedAt;
    if (stalled != null && t - stalled >= RecoveryPolicy.STALL_MAX_MS)
      this.recoverStall(`stalled ${t - stalled}ms`);
  }

  /** A stall the watchdog gave up waiting on: re-open, or fail with reconnecting off. */
  protected recoverStall(reason: string): void {
    if (this.stalledAtEnd()) {
      // A re-open would land at the end and stall again, in a loop.
      this.log('stall at the end', { reason });
      this.onEnded(this.generation);
    } else if (this.options.reconnect) this.attemptReconnect(reason);
    else this.failStall(reason);
  }

  /** The playhead and the buffer are at a file's end: no data is coming because there is none left. */
  protected stalledAtEnd(): boolean {
    const duration = this.duration;
    if (this.isLive || duration == null || this.remote) return false;
    const end = duration - RecoveryPolicy.END_SLACK_S;
    const sample = this.driver.sample();
    return sample.position >= end && sample.bufferedPosition >= end;
  }

  protected failStall(reason: string): void {
    this.log('stall, reconnect off', { reason });
    this.fail(
      engineError(
        'NETWORK_ERROR',
        `Playback stalled (${reason}) and reconnecting is off.`,
        true
      )
    );
  }

  /** Native kept saying playing through a silent stall: the audio flows again. */
  protected endSilentStall(t: number, position: number): void {
    this.silentStall = false;
    if (this.stallStartedAt != null) this.driftMs += t - this.stallStartedAt;
    this.stallStartedAt = null;
    this.lastPosition = position;
    this.lastPositionAdvanceAt = t;
    this.playingSince = t;
    this.videoPlaying(t);
    this.setState('playing', 'silent stall over');
  }
}
