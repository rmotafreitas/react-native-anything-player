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
 * a reconnect): it is reported only when its start is in the audio the
 * connection opens with, from before live (its first `lag` ms heard). The lag
 * grows while the server's burst arrives (seconds on a slow link), and the
 * search with it, until it is settled.
 */
export class BoundaryTracker {
  private readonly finder = new BoundaryFinder();
  private app = { enabled: false, points: 1024 };
  private detecting = false;
  private lastTitle: string | null = null;
  /** The connection's first title, until the lag that bounds its search (the audio from before live) is settled. */
  private opening: { title: string; at: number; searching: boolean } | null =
    null;
  /** When the connection's first audio is heard (epoch ms). */
  private firstAudioAt: number | null = null;

  constructor(
    private readonly onBoundary: (boundary: StreamBoundary) => void,
    private readonly configure: (enabled: boolean, points: number) => boolean,
    /** How far behind live what is heard is (ms), when known, and whether it has settled. */
    private readonly lag: () => { ms: number; settled: boolean } | null = () =>
      null
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
    this.opening = null;
    if (!first) {
      this.report(this.finder.title(title, metadata.timestamp));
      return;
    }
    // An item already playing: found only if it started in the audio the
    // connection opens with (from before live).
    this.opening = { title, at: metadata.timestamp, searching: false };
    this.searchOpening();
  }

  /** A window of decoded audio. */
  sample(sample: AudioSample): void {
    if (!this.detecting) return;
    const at = sample.timestamp + sample.outputLatency * 1000;
    this.firstAudioAt ??= at;
    this.searchOpening();
    this.report(
      this.finder.push({
        at,
        duration: sample.duration * 1000,
        points: sample.waveform,
      })
    );
  }

  /** A new connection or item: what was heard before says nothing about it. */
  reset(): void {
    this.finder.reset();
    this.lastTitle = null;
    this.opening = null;
    this.firstAudioAt = null;
  }

  /**
   * Searches the connection's opening audio for its first title's start, from
   * its first audio and lag on; the audio's end follows the lag until that is
   * settled.
   */
  private searchOpening(): void {
    const opening = this.opening;
    const lag = this.lag();
    if (!opening || this.firstAudioAt == null || lag == null || !(lag.ms > 0))
      return;
    const to = this.firstAudioAt + lag.ms;
    if (lag.settled) this.opening = null;
    if (opening.searching) {
      this.report(this.finder.openingEnds(to, !lag.settled));
      return;
    }
    opening.searching = true;
    this.report(
      this.finder.opening(
        opening.title,
        opening.at,
        this.firstAudioAt,
        to,
        !lag.settled
      )
    );
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
