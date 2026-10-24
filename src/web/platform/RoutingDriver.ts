// The driver the engine commands: it forwards every command to the player's
// current output — the local <audio> element, or the Cast receiver — and
// switches between them on the engine's `switchOutput` (a handoff). Twin of
// the native `RoutingDriver`s.

import type { EngineDriver } from '../engine/PlaybackEngine';
import type { OpenRequest, PlaybackSample } from '../engine/types';
import type { CastDriver } from './CastDriver';
import type { MediaElementDriver, ProgressReading } from './MediaElementDriver';

export class RoutingDriver implements EngineDriver {
  private target: MediaElementDriver | CastDriver;
  /** Made on the first handoff to Cast (its code loads with the Cast SDK). */
  private cast: CastDriver | null = null;
  private volume = 1;
  private rate = 1;

  constructor(
    readonly local: MediaElementDriver,
    private readonly makeCast: () => CastDriver | null
  ) {
    this.target = local;
  }

  /** The player was released: free the element and stop observing the receiver. */
  destroy(): void {
    this.local.destroy();
    this.cast?.dispose();
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

  seek(seconds: number): void {
    this.target.seek(seconds);
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
