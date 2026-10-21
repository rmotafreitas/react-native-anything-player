/**
 * The elapsed time of the song a live stream is playing, for the lock screen.
 * Twins: `ios/Core/TrackClock.swift`, `android/.../core/TrackClock.kt`.
 *
 * A radio stream has no duration, but the app usually knows the song's (from
 * its own API). The app sets elapsed + duration once, when the song becomes
 * audible; from then on the clock advances only while audio plays — pausing
 * or buffering freezes the audio, so it freezes the song too.
 */
export class TrackClock {
  readonly duration: number;
  private base: number;
  private runningSince: number | null;

  constructor(
    elapsed: number,
    duration: number,
    now: number,
    running: boolean
  ) {
    this.duration = Math.max(0, duration);
    this.base = Math.min(Math.max(elapsed, 0), this.duration);
    this.runningSince = running ? now : null;
  }

  get isRunning(): boolean {
    return this.runningSince != null;
  }

  setRunning(running: boolean, now: number): void {
    if (running === this.isRunning) return;
    if (running) {
      this.runningSince = now;
    } else {
      this.base = this.elapsed(now);
      this.runningSince = null;
    }
  }

  /** Seconds into the song at `now`, never past its end. */
  elapsed(now: number): number {
    if (this.runningSince == null) return this.base;
    return Math.min(
      this.base + Math.max(0, now - this.runningSince) / 1000,
      this.duration
    );
  }
}
