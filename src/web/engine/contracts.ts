// The engine's contracts with its platform: the driver it commands, the
// clock it reads and the delegate it reports to. Twins: the top of
// `ios/Core/PlaybackEngine.swift` and `android/.../core/PlaybackEngine.kt`.

import type { PlayerError } from '../../errors';
import type {
  EngineDiagnostic,
  EngineStatus,
  FocusResult,
  OpenRequest,
  PlaybackSample,
  QualityConstraints,
} from './types';

export interface EngineDriver {
  open(request: OpenRequest): void;
  /** Start/resume the current item (latched until the item is ready). */
  play(): void;
  pause(): void;
  /** `exact`: frame-accurate; otherwise the nearest keyframe is fine. */
  seek(seconds: number, exact?: boolean): void;
  /** Drop the network connection / decoder but keep nothing playing. */
  releaseConnection(): void;
  /** Remove the current item entirely. */
  unload(): void;
  /** Effective output volume (volume × mute × duck × fades), 0..1. */
  setVolume(effective: number): void;
  setRate(rate: number): void;
  /**
   * Send what follows to another output (`'local'`, `'cast:<device>'`). Only
   * the platform's routing driver implements a real switch; the engine calls
   * it from `handoff`, after unloading the item from the previous output.
   */
  switchOutput(outputId: string): void;
  sample(): PlaybackSample;
  /** Video players: decode and show the picture, or not (the sound plays on). */
  setVideoEnabled?(enabled: boolean): void;
  /** Video players with an adaptive source: what its own ABR must keep to. */
  setQuality?(constraints: QualityConstraints): void;
  /** Repeat a finite item from the start, seamlessly where the platform can. */
  setLoop?(loop: boolean): void;
  /** Drop the item an `open({ swap: true })` was preparing. */
  cancelSwap?(generation: number): void;
}

export interface EngineClock {
  /** Monotonic milliseconds. */
  readonly monotonicMs: number;
  /** Wall-clock epoch milliseconds. */
  readonly wallMs: number;
}

export type LoadOutcome =
  | { kind: 'ready' }
  | { kind: 'superseded' }
  | { kind: 'failed'; error: PlayerError };

export interface EngineDelegate {
  engineRequestsAudioFocus(): FocusResult;
  engineStatusChanged(status: EngineStatus): void;
  engineLoadSettled(loadId: number, outcome: LoadOutcome): void;
  engineError(error: PlayerError, fatal: boolean): void;
  engineDidEnd(): void;
  /** The sleep timer paused the player (`sleep` event). */
  engineSleepFired(): void;
  engineDiagnostic(entry: EngineDiagnostic): void;
  /** The engine wants `onWakeup()` at this monotonic instant (`null` = none). */
  engineWakeupAt(at: number | null): void;
  /**
   * The source needs a new URL (`'unauthorized'`: a 401/403; `'expiring'`:
   * `expiresAt` is near). Answer with `sourceRefreshed` or
   * `sourceRefreshFailed` for the same `loadId`.
   */
  engineRequestsSourceRefresh?(
    loadId: number,
    reason: 'unauthorized' | 'expiring'
  ): void;
}
