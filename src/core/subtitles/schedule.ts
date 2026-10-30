// Which cues are on screen at a position, with the app's subtitle delay, and
// when that next changes. The overlays use it on every platform (twins:
// `ios/Core/CueSchedule.swift`, `android/.../core/CueSchedule.kt`, held to
// `conformance/subtitles/schedule.json`).

import type { SubtitleCue } from './types';

/**
 * The indices of the cues showing at `position` seconds, in order. A
 * positive `delay` shows every cue later (the subtitles were early).
 */
export function activeCues(
  cues: readonly Pick<SubtitleCue, 'start' | 'end'>[],
  position: number,
  delay = 0
): number[] {
  const t = position - delay;
  const active: number[] = [];
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    if (cue.start > t) break;
    if (t < cue.end) active.push(i);
  }
  return active;
}

/**
 * The next position (seconds) at which the active set changes, after
 * `position`; `null` when it never does again. Lets an overlay sleep until
 * then instead of polling.
 */
export function nextCueChange(
  cues: readonly Pick<SubtitleCue, 'start' | 'end'>[],
  position: number,
  delay = 0
): number | null {
  const t = position - delay;
  let next = Infinity;
  for (const cue of cues) {
    if (cue.start > t) {
      next = Math.min(next, cue.start);
      break;
    }
    if (cue.end > t) next = Math.min(next, cue.end);
  }
  return next === Infinity ? null : next + delay;
}
