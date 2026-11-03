// A live item's place against the live point, for `MediaElementDriver`: the
// stream's own clock (program dates), the player's own offset behind live,
// and what a live quality switch lines an HLS or DASH item up on.

import type { AlignReading } from '../engine/LiveAligner';
import type { DashStream } from './DashStream';
import type { AudioElementLike } from './dom';
import type { HlsStream } from './HlsStream';
import type { MseStream } from './MseStream';

/** What plays the item: hls.js, Shaka, or the browser's own HLS. */
export interface LiveSources {
  hls: HlsStream | null;
  dash: DashStream | null;
  nativeHls: boolean;
  element: AudioElementLike;
  /** The playhead (s). */
  position: number;
}

/** Epoch ms the stream's own clock gives the playhead (hls.js, Shaka, Safari's own HLS); `null` without one. */
export function programDateOf(s: LiveSources): number | null {
  const own = s.hls?.programDate ?? s.dash?.programDate;
  if (own != null) return own;
  const start = s.nativeHls ? s.element.getStartDate?.() : undefined;
  const ms = start?.getTime();
  if (ms == null || !Number.isFinite(ms)) return null;
  return ms + s.position * 1000;
}

/** HLS or DASH whose program date is not known yet (none, or no fragment at the playhead). */
export function awaitsClock(s: LiveSources): boolean {
  return (
    (s.hls != null || s.dash != null || s.nativeHls) && programDateOf(s) == null
  );
}

/** The player's own reading behind live (HLS latency, a DASH presentation's clock). */
export function nativeLiveOffset(s: LiveSources): number | null {
  if (s.hls?.live) return s.hls.liveOffset;
  const date = s.dash?.programDate;
  return date == null ? null : Math.max(0, (Date.now() - date) / 1000);
}

/**
 * An HLS or DASH item lined up by its program dates (`LiveAligner`'s
 * `clock`), moved anywhere it can seek; `null` without program dates.
 */
export function clockReading(
  s: LiveSources,
  playing: boolean,
  bufferedEnd: number
): (AlignReading & { reconnects: number }) | null {
  const date = programDateOf(s);
  if (date == null) return null;
  const seekable = s.element.seekable;
  const any = seekable.length > 0;
  return {
    position: s.position,
    edge: Math.max(any ? seekable.end(seekable.length - 1) : 0, bufferedEnd),
    playing,
    clock: date / 1000 - s.position,
    start: any ? seekable.start(0) : null,
    reconnects: 0,
  };
}

/** A progressive stream RNAP feeds: lined up on its buffered edge, which is the live edge. */
export function edgeReading(
  s: LiveSources,
  playing: boolean,
  stream: MseStream | null
): AlignReading & { reconnects: number } {
  const ranges = s.element.buffered;
  return {
    position: s.position,
    edge: ranges.length > 0 ? ranges.end(ranges.length - 1) : null,
    playing,
    reconnecting: stream?.reconnecting === true,
    reconnects: stream?.reconnects ?? 0,
  };
}
