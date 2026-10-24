// Fades and the sleep timer, the layer between the engine's core
// (EngineCore.ts) and its system inputs (PlaybackEngine.ts). The twins
// (`ios/Core/PlaybackEngine.swift`, `android/.../core/PlaybackEngine.kt`)
// hold the same code in their one type.
//
// The output volume is volume × duck × gain × sleep attenuation (or 0 when
// muted). The gain is the play/pause/stop fade; the sleep attenuation is the
// sleep timer's fade-out. Fades never change the app's `volume`, except
// `fadeTo`, whose target is the new volume. Every fade moves in steps of
// `FADE_TICK_MS` on the engine's own wake-ups, so it runs with JS frozen.

import type { PlayerError } from '../../errors';
import { EngineCore, type FadeOutEnd } from './EngineCore';
import { RecoveryPolicy } from './RecoveryPolicy';
import { engineError, rampValue, type Ramp } from './types';

/** The longest sleep timer or fade: 24 h (larger values overflow native timers). */
export const MAX_TIMER_MS = 86_400_000;

function invalidDuration(what: string): PlayerError {
  return engineError(
    'INVALID_ARGUMENT',
    `${what} must be a finite number from 0 to 24 h.`,
    false
  );
}

function validDuration(ms: number): boolean {
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_TIMER_MS;
}

export abstract class EngineFades extends EngineCore {
  // ── State (monotonic ms) ──
  /** `volume` still on its way to a `fadeTo` target. */
  protected levelRamp: Ramp | null = null;
  protected fadeToDone: (() => void) | null = null;
  /** The play/pause/stop fade, 0…1 (`gainRamp` while it moves). */
  protected gain = 1;
  protected gainRamp: Ramp | null = null;
  /** A fade-out under way: the intent is already off; at silence it pauses or stops. */
  protected fadeOutThen: FadeOutEnd | null = null;
  /** Playback was asked for with a fade-in: it starts when the audio does. */
  protected fadeInPending = false;
  protected fadeTickAt: number | null = null;
  /** What the driver was last given. */
  protected appliedVolume = 1;
  protected sleepAt: number | null = null;
  /** The sleep timer's fade-out: the last `sleepFadeMs` before `sleepAt`. */
  protected sleepFadeMs = 0;
  protected sleepWallAt: number | null = null;

  // ── Commands ──

  /**
   * Moves the volume to `value` over `durationMs`; `done` runs when it gets
   * there, or when `setVolume`, another `fadeTo` or `release` replaces it.
   * `volume` is the target from the start. Instant on a remote output.
   */
  fadeTo(value: number, durationMs: number, done: () => void): void {
    this.ensureAlive();
    if (!Number.isFinite(value)) {
      throw engineError(
        'INVALID_ARGUMENT',
        'Volume must be a finite number.',
        false
      );
    }
    if (!validDuration(durationMs)) throw invalidDuration('A fade duration');
    const t = this.now;
    const from = this.levelAt(t);
    this.cancelFadeTo();
    this.volume = Math.min(1, Math.max(0, value));
    this.fadeToDone = done;
    const ms = Math.round(durationMs);
    if (ms > 0 && !this.remote && from !== this.volume) {
      this.levelRamp = { from, to: this.volume, startAt: t, endAt: t + ms };
      this.log('fade', { to: `${this.volume}`, ms: `${ms}` });
    } else {
      this.applyVolume();
      this.settleFadeTo();
    }
    this.commit();
  }

  /**
   * Pauses after `afterMs` of wall time (counting while paused too), fading
   * out over its last `fadeOutMs` (default `options.fadeOutMs`). `null`
   * cancels; a new timer replaces the previous one.
   */
  sleep(afterMs: number | null, fadeOutMs: number | null): void {
    this.ensureAlive();
    if (afterMs != null) {
      if (!validDuration(afterMs)) throw invalidDuration('The sleep delay');
      if (fadeOutMs != null && !validDuration(fadeOutMs))
        throw invalidDuration('The sleep fade-out');
    }
    this.endSleep();
    if (afterMs == null) {
      this.log('sleep timer', { note: 'cancelled' });
    } else {
      const after = Math.round(afterMs);
      this.sleepAt = this.now + after;
      this.sleepWallAt = this.clock.wallMs + after;
      this.sleepFadeMs = Math.min(
        Math.round(fadeOutMs ?? this.options.fadeOutMs),
        after
      );
      this.log('sleep timer', {
        afterMs: `${after}`,
        fadeOutMs: `${this.sleepFadeMs}`,
      });
    }
    this.commit();
  }

  /**
   * The fades of play (in) and of pause and stop (out), in ms; `0` = none.
   * A fade under way keeps its course.
   */
  setFades(inMs: number, outMs: number): void {
    this.ensureAlive();
    if (!validDuration(inMs)) throw invalidDuration('A fade-in');
    if (!validDuration(outMs)) throw invalidDuration('A fade-out');
    this.options = {
      ...this.options,
      fadeInMs: Math.round(inMs),
      fadeOutMs: Math.round(outMs),
    };
    this.commit();
  }

  // ── Hooks for EngineCore ──

  protected get fadingOut(): boolean {
    return this.fadeOutThen != null;
  }

  protected playFades(cause: string): void {
    if (this.fadeOutThen != null) {
      // Playing again during a fade-out: the audio never stopped.
      this.fadeOutThen = null;
      this.playingSince = this.now;
      this.log('fade-out cancelled', { cause });
    }
    this.startFadeIn(this._state === 'playing');
  }

  protected startPendingFadeIn(): void {
    if (!this.fadeInPending) return;
    this.fadeInPending = false;
    this.rampGain(1, this.options.fadeInMs);
  }

  protected holdGain(): void {
    this.fadeInPending = false;
    this.freezeGain();
  }

  protected releaseFades(): void {
    this.cancelFadeOut();
    this.cancelFadeTo();
    this.sleepAt = null;
    this.sleepWallAt = null;
  }

  protected fadeWakeup(t: number): void {
    this.fireSleepIfDue(t);
    this.stepFades(t);
  }

  // ── Volume ──

  protected applyVolume(): void {
    const value = this.outputVolume(this.now);
    this.appliedVolume = value;
    this.driver.setVolume(value);
  }

  /** Sends the output volume only when it changed (fade steps). */
  protected refreshVolume(): void {
    if (this.outputVolume(this.now) !== this.appliedVolume) this.applyVolume();
  }

  protected outputVolume(t: number): number {
    if (this.muted) return 0;
    const duck = this.remote ? 1 : this.duckFactor;
    return this.levelAt(t) * duck * this.gainAt(t) * this.sleepGainAt(t);
  }

  // ── Fades ──

  protected levelAt(t: number): number {
    return this.levelRamp == null ? this.volume : rampValue(this.levelRamp, t);
  }

  protected gainAt(t: number): number {
    return this.gainRamp == null ? this.gain : rampValue(this.gainRamp, t);
  }

  /** In the sleep timer's last `sleepFadeMs`: the fade-out (local output only). */
  protected sleepFading(t: number): boolean {
    const at = this.sleepAt;
    return (
      at != null &&
      this.sleepFadeMs > 0 &&
      !this.remote &&
      t >= at - this.sleepFadeMs
    );
  }

  protected sleepGainAt(t: number): number {
    const at = this.sleepAt;
    if (at == null || !this.sleepFading(t)) return 1;
    return Math.min(1, Math.max(0, (at - t) / this.sleepFadeMs));
  }

  protected setGain(value: number): void {
    this.gainRamp = null;
    this.gain = value;
    this.refreshVolume();
  }

  /** Stops the gain where it is. */
  protected freezeGain(): void {
    this.gain = this.gainAt(this.now);
    this.gainRamp = null;
  }

  /** Moves the gain to `to` at `fullScaleMs` per 0…1 (instant when `0`). */
  protected rampGain(to: number, fullScaleMs: number): void {
    const t = this.now;
    const from = this.gainAt(t);
    const ms = Math.round(fullScaleMs * Math.abs(to - from));
    if (ms <= 0) {
      this.setGain(to);
      return;
    }
    this.gain = from;
    this.gainRamp = { from, to, startAt: t, endAt: t + ms };
  }

  /** The intent turns on: from silence when a fade-in is set, else full. */
  protected startFadeIn(flowing: boolean): void {
    this.fadeInPending = false;
    const ms = this.remote ? 0 : this.options.fadeInMs;
    if (ms > 0 && !flowing) {
      // Silent until the audio flows, then `onPlaying` starts the ramp.
      this.fadeInPending = true;
      this.setGain(0);
    } else {
      this.rampGain(1, ms);
    }
  }

  /** Starts the fade-out of a pause or a stop; `false` when there is nothing to fade. */
  protected beginFadeOut(end: FadeOutEnd): boolean {
    const ms = this.remote ? 0 : this.options.fadeOutMs;
    if (ms <= 0 || this._state !== 'playing' || this.stallPublishAt != null)
      return false;
    this.fadeInPending = false;
    this.rampGain(0, ms);
    const ramp = this.gainRamp;
    if (ramp == null) return false;
    this.fadeOutThen = end;
    this.resetRecovery();
    this.playingSince = null;
    this.log('fade-out', { end, ms: `${ramp.endAt - ramp.startAt}` });
    return true;
  }

  /** Lands a fade-out now: silence, then the pause or the stop. */
  protected completeFadeOut(override?: FadeOutEnd): void {
    if (this.fadeOutThen == null) return;
    const end = override ?? this.fadeOutThen;
    this.fadeOutThen = null;
    this.setGain(0);
    if (end === 'stop') this.stopNow();
    else this.pauseIntent('pause: faded out');
  }

  protected cancelFadeOut(): void {
    this.fadeOutThen = null;
    this.fadeInPending = false;
    this.freezeGain();
  }

  protected cancelFadeTo(): void {
    if (this.levelRamp == null) return;
    this.levelRamp = null;
    this.settleFadeTo();
  }

  protected settleFadeTo(): void {
    const done = this.fadeToDone;
    this.fadeToDone = null;
    if (done != null) this.pendingEvents.push(done);
  }

  /** Fades belong to the output: a handoff lands them where they were going. */
  protected settleFades(): void {
    this.fadeInPending = false;
    this.gainRamp = null;
    this.gain = 1;
    this.cancelFadeTo();
  }

  /**
   * Clears the sleep timer. Its fade-out, if under way, becomes the gain: it
   * climbs back at the speed it went down (or keeps falling into a pause).
   */
  protected endSleep(): void {
    if (this.sleepAt == null) return;
    const t = this.now;
    const attenuation = this.sleepGainAt(t);
    const fadeMs = this.sleepFadeMs;
    this.sleepAt = null;
    this.sleepWallAt = null;
    this.sleepFadeMs = 0;
    if (attenuation >= 1) return;
    const combined = this.gainAt(t) * attenuation;
    const ramp = this.gainRamp;
    if (this.fadeOutThen != null && ramp != null) {
      this.gainRamp = { from: combined, to: 0, startAt: t, endAt: ramp.endAt };
      return;
    }
    this.gain = combined;
    this.gainRamp = null;
    if (this._playWhenReady && !this.fadeInPending) this.rampGain(1, fadeMs);
  }

  protected fireSleepIfDue(t: number): void {
    const due = this.sleepAt;
    if (due == null || due > t) return;
    const attenuation = this.sleepGainAt(t);
    this.sleepAt = null;
    this.sleepWallAt = null;
    this.sleepFadeMs = 0;
    this.log('sleep timer', { note: 'fired' });
    // Like a user pause: a pending system resume is cancelled too.
    this._interruption = null;
    if (this.fadeOutThen != null) {
      this.completeFadeOut();
    } else if (this._playWhenReady) {
      this.gain = this.gainAt(t) * attenuation;
      this.gainRamp = null;
      this.refreshVolume();
      this._playWhenReady = false;
      this.pauseIntent('sleep timer');
    } else {
      // Nothing playing: the timer just ends.
    }
    this.pendingEvents.push(() => this.delegate?.engineSleepFired());
  }

  protected stepFades(t: number): void {
    if (this.fadeTickAt != null && this.fadeTickAt <= t) this.fadeTickAt = null;
    const level = this.levelRamp;
    if (level != null && t >= level.endAt) {
      this.levelRamp = null;
      this.settleFadeTo();
    }
    const gain = this.gainRamp;
    if (gain != null && t >= gain.endAt) {
      this.gain = gain.to;
      this.gainRamp = null;
    }
    this.refreshVolume();
    if (this.fadeOutThen != null && this.gainRamp == null)
      this.completeFadeOut();
  }

  protected get fading(): boolean {
    return (
      this.levelRamp != null ||
      this.gainRamp != null ||
      (this._playWhenReady && this.sleepFading(this.now))
    );
  }

  protected fadeWakeups(candidates: number[]): void {
    if (this.fading) {
      this.fadeTickAt ??= this.now + RecoveryPolicy.FADE_TICK_MS;
      candidates.push(this.fadeTickAt);
    } else {
      this.fadeTickAt = null;
    }
    if (this.levelRamp != null) candidates.push(this.levelRamp.endAt);
    if (this.gainRamp != null) candidates.push(this.gainRamp.endAt);
    const sleepAt = this.sleepAt;
    if (sleepAt == null) return;
    candidates.push(sleepAt);
    const fadeFrom = sleepAt - this.sleepFadeMs;
    if (this.sleepFadeMs > 0 && fadeFrom > this.now) candidates.push(fadeFrom);
  }
}
