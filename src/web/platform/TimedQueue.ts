// What a stream says ahead of the audio (ID3 titles, splices), delivered when
// the playhead reaches it: strictly when heard, never early.

import { browser } from './dom';

/** The playhead the queue follows. */
export interface Playhead {
  readonly position: number;
  readonly paused: boolean;
  readonly rate: number;
}

type Timed = { time: number; fire: () => void };

export class TimedQueue {
  private timed: Timed[] = [];
  private timer: number | null = null;

  constructor(private readonly playhead: () => Playhead) {}

  /** Fires `fire` when the playhead reaches `time` (seconds). */
  schedule(time: number, fire: () => void): void {
    this.timed.push({ time, fire });
    this.timed.sort((a, b) => a.time - b.time);
    this.pump();
  }

  /** Fires what is due and plans the next. */
  pump(): void {
    this.stop();
    const { position, paused, rate } = this.playhead();
    while (this.timed.length > 0 && this.timed[0]!.time <= position)
      this.timed.shift()!.fire();
    const next = this.timed[0];
    if (!next || paused) return;
    // timeupdate fires every ~250 ms; a timer lands it on time, re-armed if
    // the audio clock is still short.
    this.timer = browser().setTimeout(
      () => this.pump(),
      Math.max(10, ((next.time - position) / (rate || 1)) * 1000)
    );
  }

  /** Stops the timer (paused); what is queued stays. */
  stop(): void {
    if (this.timer !== null) browser().clearTimeout(this.timer);
    this.timer = null;
  }

  /** Drops everything (a new item). */
  clear(): void {
    this.timed = [];
    this.stop();
  }
}
