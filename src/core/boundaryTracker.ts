import type { AudioSample, MediaMetadata, StreamBoundary } from '../types';
import { BoundaryFinder } from './boundaries';

/** Waveform points sampled for boundary detection alone (~0.7 ms apart in a 4096-frame window). */
const DETECTION_POINTS = 128;

/**
 * A player's boundary detection (`setBoundaryDetection`): feeds its
 * {@link BoundaryFinder} with the titles and audio windows heard, and shares
 * the native sampling with the app's own `setAudioSampling` (its points win).
 *
 * The first title of a connection names an item already playing (a tune-in,
 * a reconnect): it has no boundary to find, so only later ones are searched.
 */
export class BoundaryTracker {
  private readonly finder = new BoundaryFinder();
  private app = { enabled: false, points: 1024 };
  private detecting = false;
  private lastTitle: string | null = null;

  constructor(
    private readonly onBoundary: (boundary: StreamBoundary) => void,
    private readonly configure: (enabled: boolean, points: number) => boolean
  ) {}

  /** The app's `setAudioSampling`. */
  setAppSampling(enabled: boolean, points: number): boolean {
    this.app = { enabled, points };
    return this.apply();
  }

  /** `setBoundaryDetection`: whether the platform can sample audio. */
  setDetection(enabled: boolean): boolean {
    if (this.detecting !== enabled) this.reset();
    this.detecting = enabled;
    return this.apply();
  }

  /** New metadata heard: a title change opens a search. */
  metadata(metadata: MediaMetadata): void {
    if (!this.detecting) return;
    const title = metadata.raw?.StreamTitle?.trim();
    if (!title || title === this.lastTitle) return;
    const first = this.lastTitle == null;
    this.lastTitle = title;
    if (!first) this.report(this.finder.title(title, metadata.timestamp));
  }

  /** A window of decoded audio. */
  sample(sample: AudioSample): void {
    if (!this.detecting) return;
    this.report(
      this.finder.push({
        at: sample.timestamp + sample.outputLatency * 1000,
        duration: sample.duration * 1000,
        points: sample.waveform,
      })
    );
  }

  /** A new connection or item: what was heard before says nothing about it. */
  reset(): void {
    this.finder.reset();
    this.lastTitle = null;
  }

  private apply(): boolean {
    const on = this.app.enabled || this.detecting;
    return this.configure(
      on,
      this.app.enabled ? this.app.points : DETECTION_POINTS
    );
  }

  private report(boundary: StreamBoundary | null): void {
    if (boundary) this.onBoundary(boundary);
  }
}
