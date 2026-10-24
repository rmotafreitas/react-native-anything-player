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
  QualityConstraints,
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

/** `loaded`: the whole file is buffered: the playhead advances, the buffer stays where it is. */
export type Motion = 'flowing' | 'frozen' | 'trickle' | 'loaded';

const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);
const orDash = (v: number | string | null) => (v == null ? '-' : `${v}`);

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
  /** The item an `open({ swap: true })` is preparing, and where it starts. */
  swapGeneration: number | null = null;
  private swapStart = 0;

  constructor(private readonly clock: FakeClock) {}

  setMotion(next: Motion, buffered?: number): void {
    const current = this.sample();
    this.anchorPosition = current.position;
    this.anchorBuffered = buffered ?? current.bufferedPosition;
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
      case 'loaded':
        return {
          position: this.anchorPosition + elapsed,
          bufferedPosition: this.anchorBuffered,
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
    const rendition =
      request.rendition != null ? `,r=${request.rendition}` : '';
    const swap = request.swap === true ? ',swap' : '';
    this.commands.push(
      `open(gen=${request.generation},start=${start},play=${request.playWhenReady}${rendition}${swap})`
    );
    if (request.swap === true) {
      // Prepared behind the current item: its playhead is not this one's.
      this.swapGeneration = request.generation;
      this.swapStart = request.startPosition ?? 0;
      return;
    }
    this.swapGeneration = null;
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

  seek(seconds: number, exact?: boolean): void {
    this.commands.push(`seek(${f1(seconds)}${exact === true ? ',exact' : ''})`);
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

  setVideoEnabled(enabled: boolean): void {
    this.commands.push(`video(${enabled ? 'on' : 'off'})`);
  }

  setQuality(c: QualityConstraints): void {
    this.commands.push(
      `quality(maxH=${orDash(c.maxHeight)},maxBps=${orDash(c.maxBitrate)},pin=${orDash(c.pinned)},audioOnly=${c.audioOnly})`
    );
  }

  setLoop(loop: boolean): void {
    this.commands.push(`loop(${loop})`);
  }

  selectTracks(audio: string | null, text: string | null): void {
    this.commands.push(`tracks(audio=${orDash(audio)},text=${orDash(text)})`);
  }

  cancelSwap(generation: number): void {
    this.commands.push(`cancelSwap(gen=${generation})`);
    if (this.swapGeneration === generation) this.swapGeneration = null;
  }

  /** The swap's item shows its first frame: its playhead becomes the one. */
  completeSwap(): void {
    this.swapGeneration = null;
    this.anchorPosition = this.swapStart;
    this.anchorBuffered = this.swapStart + 10;
    this.anchorTime = this.clock.monotonicMs;
    this.motion = 'flowing';
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
  /** Source refreshes asked for, `loadId:reason`. */
  refreshes: string[] = [];
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
    const last = this.statuses[this.statuses.length - 1];
    if (last == null) {
      this.violations.push('sleep event before its status');
    } else {
      if (last.sleepAt != null)
        this.violations.push('sleep event before its status');
      // The timer always leaves the player paused: a playing player is
      // paused, and a paused one stays paused, so `playWhenReady` is false.
      if (last.playWhenReady)
        this.violations.push('sleep event while playWhenReady');
    }
    this.sleeps += 1;
  }

  engineDiagnostic(entry: EngineDiagnostic): void {
    this.diagnostics.push(entry);
  }

  engineWakeupAt(at: number | null): void {
    this.wakeupAt = at;
  }

  engineRequestsSourceRefresh(
    loadId: number,
    reason: 'unauthorized' | 'expiring'
  ): void {
    this.refreshes.push(`${loadId}:${reason}`);
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
