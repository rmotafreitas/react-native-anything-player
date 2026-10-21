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
} from './types';

export interface EngineDriver {
  open(request: OpenRequest): void;
  /** Start/resume the current item (latched until the item is ready). */
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  /** Drop the network connection / decoder but keep nothing playing. */
  releaseConnection(): void;
  /** Remove the current item entirely. */
  unload(): void;
  /** Effective output volume (volume × mute × duck), 0..1. */
  setVolume(effective: number): void;
  setRate(rate: number): void;
  sample(): PlaybackSample;
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
  engineDiagnostic(entry: EngineDiagnostic): void;
  /** The engine wants `onWakeup()` at this monotonic instant (`null` = none). */
  engineWakeupAt(at: number | null): void;
}
