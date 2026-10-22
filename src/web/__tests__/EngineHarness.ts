// Twin of `android/src/test/.../EngineHarness.kt` and
// `ios/Tests/AnythingPlayerCoreTests/EngineHarness.swift`.

import type { PlayerError } from '../../errors';
import {
  PlaybackEngine,
  type EngineClock,
  type EngineDelegate,
  type EngineDriver,
  type LoadOutcome,
} from '../engine/PlaybackEngine';
import {
  DEFAULT_ENGINE_OPTIONS,
  type EngineOptions,
} from '../engine/RecoveryPolicy';
import type {
  EngineDiagnostic,
  EngineStatus,
  FocusResult,
  OpenRequest,
  PlaybackSample,
} from '../engine/types';

/** The fake wall clock reads this at monotonic 0. */
export const WALL_BASE = 1_700_000_000_000;

/** Deterministic clock: time only moves when a test advances it. */
export class FakeClock implements EngineClock {
  monotonicMs = 0;
  get wallMs(): number {
    return WALL_BASE + this.monotonicMs;
  }
}

export type Motion = 'flowing' | 'frozen' | 'trickle';

const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);

/** Records every driver call and simulates a playhead. */
export class FakeDriver implements EngineDriver {
  commands: string[] = [];
  /** Like ExoPlayer: report readiness/playing synchronously from inside commands. */
  reentrant = false;
  engine: PlaybackEngine | null = null;
  private openGeneration = 0;
  private motion: Motion = 'frozen';
  private anchorTime = 0;
  private anchorPosition = 0;
  private anchorBuffered = 0;

  constructor(private readonly clock: FakeClock) {}

  setMotion(next: Motion): void {
    const current = this.sample();
    this.anchorPosition = current.position;
    this.anchorBuffered = current.bufferedPosition;
    this.anchorTime = this.clock.monotonicMs;
    this.motion = next;
    if (next === 'flowing')
      this.anchorBuffered = Math.max(
        this.anchorBuffered,
        this.anchorPosition + 10
      );
  }

  setPosition(value: number): void {
    const current = this.sample();
    this.anchorBuffered = Math.max(current.bufferedPosition, value);
    this.anchorPosition = value;
    this.anchorTime = this.clock.monotonicMs;
  }

  sample(): PlaybackSample {
    const elapsed = (this.clock.monotonicMs - this.anchorTime) / 1000;
    switch (this.motion) {
      case 'flowing':
        return {
          position: this.anchorPosition + elapsed,
          bufferedPosition: this.anchorBuffered + elapsed,
        };
      case 'trickle':
        return {
          position: this.anchorPosition,
          bufferedPosition: this.anchorBuffered + elapsed * 0.5,
        };
      default:
        return {
          position: this.anchorPosition,
          bufferedPosition: this.anchorBuffered,
        };
    }
  }

  open(request: OpenRequest): void {
    const start =
      request.startPosition != null ? f1(request.startPosition) : '-';
    this.commands.push(
      `open(gen=${request.generation},start=${start},play=${request.playWhenReady})`
    );
    this.anchorPosition = request.startPosition ?? 0;
    this.anchorBuffered = this.anchorPosition;
    this.anchorTime = this.clock.monotonicMs;
    this.motion = 'frozen';
    this.openGeneration = request.generation;
    if (this.reentrant && request.playWhenReady) {
      this.engine?.onReady(request.generation, {
        duration: 30,
        isLive: false,
        seekable: true,
      });
      this.setMotion('flowing');
      this.engine?.onPlaying(request.generation);
    }
  }

  play(): void {
    this.commands.push('play');
    if (this.reentrant) {
      this.setMotion('flowing');
      this.engine?.onPlaying(this.openGeneration);
    }
  }

  pause(): void {
    this.commands.push('pause');
  }

  seek(seconds: number): void {
    this.commands.push(`seek(${f1(seconds)})`);
    this.setPosition(seconds);
  }

  releaseConnection(): void {
    this.commands.push('release');
  }

  unload(): void {
    this.commands.push('unload');
  }

  setVolume(effective: number): void {
    this.commands.push(`volume(${f2(effective)})`);
  }

  setRate(rate: number): void {
    this.commands.push(`rate(${f2(rate)})`);
  }

  switchOutput(outputId: string): void {
    this.commands.push(`switchOutput(${outputId})`);
    // The playhead stops where it is; the engine re-opens at a position.
    this.setMotion('frozen');
  }
}

/** Collects everything the engine reports. */
export class Recorder implements EngineDelegate {
  focus: FocusResult = 'granted';
  statuses: EngineStatus[] = [];
  loads: string[] = [];
  errors: string[] = [];
  ended = 0;
  /** Sleep timers that fired. */
  sleeps = 0;
  /** `fadeTo` calls that settled. */
  fades = 0;
  diagnostics: EngineDiagnostic[] = [];
  wakeupAt: number | null = null;
  /** Ordering invariant breaches (an event delivered before its status). */
  violations: string[] = [];

  engineRequestsAudioFocus(): FocusResult {
    return this.focus;
  }

  engineStatusChanged(status: EngineStatus): void {
    this.statuses.push(status);
  }

  engineLoadSettled(loadId: number, outcome: LoadOutcome): void {
    if (outcome.kind === 'failed')
      this.loads.push(`${loadId}:failed:${outcome.error.code}`);
    else this.loads.push(`${loadId}:${outcome.kind}`);
  }

  engineError(error: PlayerError, fatal: boolean): void {
    const last = this.statuses[this.statuses.length - 1]?.state;
    if (fatal && last !== 'error')
      this.violations.push('fatal error before error status');
    if (!fatal && last !== 'reconnecting')
      this.violations.push('recoverable error before reconnecting status');
    this.errors.push(`${error.code}:${fatal ? 'fatal' : 'recoverable'}`);
  }

  engineDidEnd(): void {
    if (this.statuses[this.statuses.length - 1]?.state !== 'ended')
      this.violations.push('ended before ended status');
    this.ended += 1;
  }

  engineSleepFired(): void {
    if (this.statuses[this.statuses.length - 1]?.sleepAt != null)
      this.violations.push('sleep event before its status');
    this.sleeps += 1;
  }

  engineDiagnostic(entry: EngineDiagnostic): void {
    this.diagnostics.push(entry);
  }

  engineWakeupAt(at: number | null): void {
    this.wakeupAt = at;
  }
}

/** Engine + fakes wired together, with a clock that fires wake-ups in order. */
export class EngineHarness {
  readonly clock = new FakeClock();
  readonly driver = new FakeDriver(this.clock);
  readonly recorder = new Recorder();
  readonly engine: PlaybackEngine;

  constructor(options: EngineOptions = DEFAULT_ENGINE_OPTIONS) {
    this.engine = new PlaybackEngine(
      this.driver,
      this.clock,
      options,
      () => 0.5
    );
    this.engine.delegate = this.recorder;
    this.driver.engine = this.engine;
  }

  advance(ms: number): void {
    const target = this.clock.monotonicMs + ms;
    let guard = 0;
    for (;;) {
      const wake = this.recorder.wakeupAt;
      if (wake == null || wake > target) break;
      guard += 1;
      if (guard >= 100_000) throw new Error('wake-up loop');
      this.clock.monotonicMs = Math.max(this.clock.monotonicMs, wake);
      this.engine.onWakeup();
    }
    this.clock.monotonicMs = target;
  }
}
