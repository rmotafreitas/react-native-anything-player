// The driver the engine commands: it forwards every command to the player's
// current output — the local <audio> element, or the Cast receiver — and
// switches between them on the engine's `switchOutput` (a handoff). Twin of
// the native `RoutingDriver`s.

import type { EngineDriver } from '../engine/PlaybackEngine';
import type {
  OpenRequest,
  PlaybackSample,
  QualityConstraints,
} from '../engine/types';
import type { CastDriver } from './CastDriver';
import type { ProgressReading } from './MediaElementDriver';
import type { LocalDriver } from './SwapDriver';

export class RoutingDriver implements EngineDriver {
  private target: LocalDriver | CastDriver;
  /** Made on the first handoff to Cast (its code loads with the Cast SDK). */
  private cast: CastDriver | null = null;
  private volume = 1;
  private rate = 1;

  constructor(
    readonly local: LocalDriver,
    private readonly makeCast: () => CastDriver | null
  ) {
    this.target = local;
  }

  /** The player was released: free the element and stop observing the receiver. */
  destroy(): void {
    this.local.destroy();
    this.cast?.dispose();
  }

  /** The current output, as the engine sees drivers (the video calls are optional). */
  private get engineTarget(): EngineDriver {
    return this.target;
  }

  /** Whether the audio plays on the Cast receiver. */
  get casting(): boolean {
    return this.target !== this.local;
  }

  open(request: OpenRequest): void {
    this.target.open(request);
  }

  play(): void {
    this.target.play();
  }

  pause(): void {
    this.target.pause();
  }

  seek(seconds: number, exact = false): void {
    this.target.seek(seconds, exact);
  }

  setVideoEnabled(enabled: boolean): void {
    this.engineTarget.setVideoEnabled?.(enabled);
  }

  setQuality(constraints: QualityConstraints): void {
    this.engineTarget.setQuality?.(constraints);
  }

  setLoop(loop: boolean): void {
    this.engineTarget.setLoop?.(loop);
  }

  /** The local output on Safari's AirPlay plays one item: switches re-open in place. */
  get swapsInPlace(): boolean {
    return this.target === this.local && this.local.swapsInPlace === true;
  }

  cancelSwap(generation: number): void {
    this.engineTarget.cancelSwap?.(generation);
  }

  selectTracks(audio: string | null, text: string | null): void {
    this.engineTarget.selectTracks?.(audio, text);
  }

  releaseConnection(): void {
    this.target.releaseConnection();
  }

  unload(): void {
    this.target.unload();
  }

  setVolume(effective: number): void {
    this.volume = effective;
    this.target.setVolume(effective);
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.target.setRate(rate);
  }

  /** `'local'` or `'cast:<device>'`; the new output takes over the settings. */
  switchOutput(outputId: string): void {
    this.target = outputId.startsWith('cast:')
      ? (this.castDriver() ?? this.local)
      : this.local;
    this.target.setVolume(this.volume);
    // An element resets its rate when emptied; the receiver ignores it.
    if (this.rate !== 1) this.target.setRate(this.rate);
  }

  private castDriver(): CastDriver | null {
    this.cast ??= this.makeCast();
    return this.cast;
  }

  sample(): PlaybackSample {
    return this.target.sample();
  }

  progress(): ProgressReading {
    return this.target.progress();
  }
}
