// What the engine is told about the item playing (duration, live, seekable),
// at its metadata and whenever the element learns more: a fragmented MP4
// can say 18 s at first, then 600 s once more of it is read.

import type { ReadyInfo } from '../engine/types';
import type { AudioElementLike } from './dom';

/** The element's own facts (`streamed`: a live stream read through MSE). */
export function elementReadyInfo(
  element: AudioElementLike,
  streamed: boolean
): ReadyInfo {
  const duration = element.duration;
  const finite = !streamed && Number.isFinite(duration) && duration > 0;
  return finite
    ? { duration, isLive: false, seekable: element.seekable.length > 0 }
    : { duration: null, isLive: true, seekable: false };
}

export class ItemFacts {
  /** A start past the first duration, applied once a later one reaches it. */
  private held: number | null = null;
  private reported: ReadyInfo | null = null;

  /**
   * The item's first facts. Returns where to start (`null`: where it is).
   * `guess`: the duration is the element's own, maybe an early one.
   */
  ready(info: ReadyInfo, start: number | null, guess: boolean): number | null {
    this.reported = info;
    if (info.duration == null || start == null || start <= 0) return null;
    if (guess && start > info.duration) this.held = start;
    return Math.min(start, info.duration);
  }

  /** Later facts: whether they are news, and where a start that waited goes now. */
  changed(info: ReadyInfo): { news: boolean; seek: number | null } {
    const last = this.reported;
    if (last == null) return { news: false, seek: null };
    const held = this.held;
    const due = held != null && info.duration != null && held <= info.duration;
    if (due) this.held = null;
    const news =
      info.duration !== last.duration ||
      info.isLive !== last.isLive ||
      info.seekable !== last.seekable;
    if (news) this.reported = info;
    return { news, seek: due ? held : null };
  }

  /** Something else moved the playhead: a start that waited is dropped. */
  dropStart(): void {
    this.held = null;
  }

  /** A new item. */
  reset(): void {
    this.held = null;
    this.reported = null;
  }
}
