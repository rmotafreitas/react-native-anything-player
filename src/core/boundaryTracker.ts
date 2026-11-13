import type { AudioSample, MediaMetadata, StreamBoundary } from '../types';
import { BoundaryFinder } from './boundaries';

/** Waveform points sampled for boundary detection alone (~0.7 ms apart in a 4096-frame window). */
const DETECTION_POINTS = 128;

/**
 * A player's boundary detection (`setBoundaryDetection`): feeds its
 * {@link BoundaryFinder} with the titles and audio windows heard, and shares
 * the native sampling with the app's own `setAudioSampling` (its points win).
 *
 * A connection's first title names the item playing where its audio begins,
 * which may have been under way: see {@link BoundaryFinder.first}.
 */
export class BoundaryTracker {
  private readonly finder = new BoundaryFinder();
  private app = { enabled: false, points: 1024 };
  private detecting = false;
  private lastTitle: string | null = null;
  /** No title was heard on this connection yet. */
  private fresh = true;

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
    const first = this.fresh;
    this.fresh = false;
    this.lastTitle = title;
    this.report(
      first
        ? this.finder.first(title, metadata.timestamp)
        : this.finder.title(title, metadata.timestamp)
    );
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

  /** A new item: what was heard before says nothing about it. */
  reset(): void {
    this.finder.reset();
    this.lastTitle = null;
    this.fresh = true;
  }

  /**
   * A fresh connection replaced the one playing (a reconnect, a switch not
   * lined up): its audio starts over, and its first title is a connection's
   * first again. A player does not repeat a title it already reported, so the
   * item playing keeps its title: only a different one is heard next.
   */
  reconnected(): void {
    this.finder.reset();
    this.fresh = true;
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
