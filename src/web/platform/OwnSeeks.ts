// The last seek RNAP made on an element: a `seeking` near its target, soon
// after, is not the user's. (A flag cleared on `seeked` is not enough: WebKit
// reports the previous seek's `seeked` before the next one's `seeking`, and
// the two would chase each other.)

import { monotonicNow } from './dom';

/** An element seek this soon after RNAP's, near its target, is RNAP's. */
const OWN_SEEK_MS = 3000;
const OWN_SEEK_SLACK_S = 2;

export class OwnSeeks {
  private last: { position: number; at: number } | null = null;

  /** RNAP is seeking the element to `position`. */
  mark(position: number): void {
    this.last = { position, at: monotonicNow() };
  }

  /** Whether a seek landing at `position` is RNAP's (within seconds; a keyframe seek lands nearby). */
  isOwn(position: number): boolean {
    const own = this.last;
    if (!own || monotonicNow() - own.at > OWN_SEEK_MS) return false;
    return Math.abs(position - own.position) < OWN_SEEK_SLACK_S;
  }
}
