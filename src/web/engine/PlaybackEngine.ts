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

import { EngineFades } from './EngineFades';
import { continuesIntent } from './status';
import type { AudioRoute, InterruptionReason, NetworkState } from './types';

export type {
  EngineClock,
  EngineDelegate,
  EngineDriver,
  LoadOutcome,
} from './contracts';

export class PlaybackEngine extends EngineFades {
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
      this._generation += 1;
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
    if (this.isReleased || !this._playWhenReady || this.remote) return;
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
      this._state === 'error'
    ) {
      this.connectionReleased = true;
      this.commit();
      return;
    }
    this.reopen('media services reset');
    this.commit();
  }
}
