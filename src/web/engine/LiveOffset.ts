// How far what is heard trails a live source's live point (`liveOffset`).
//
// A progressive stream (ICY/Icecast, plain HTTP, a remuxed MPEG-TS channel)
// has no clock of its own: what it has received is the live point, as it
// arrives. Its buffered edge moves in steps, one per chunk, and never past
// live, so the freshest reading of `edge − time` over a window (60 s) is the
// live point against the device's clock; the offset is then that point now
// minus the playhead. It does not saw-tooth between chunks, it grows while
// paused or stalled (the live point moves on, the playhead does not), and it
// keeps going across a lined-up quality switch (positions are continuous).
// It starts again on a new connection: a `discontinuity`, or a playhead that
// went back.
//
// A source with a clock (HLS program dates, a DASH or ExoPlayer live window)
// is the player's own reading, passed through. `settled`: the reading has not
// risen for `SETTLE_MS` (the connect burst has arrived) and has been read
// that long. Twins: `ios/Core/LiveOffset.swift`,
// `android/.../core/LiveOffset.kt`, against `conformance/align/offset.json`.

/** One reading of the player, on its reported timeline (seconds). */
export interface OffsetReading {
  /** The playhead. */
  position: number;
  /** Where the audio received so far ends (a progressive live stream); `null` otherwise. */
  edge: number | null;
  /** The platform's own offset behind live (program dates, a live window); `null` when it has none. */
  native: number | null;
  /** The source is live. */
  live: boolean;
}

export interface LiveOffsetValue {
  /** Seconds behind live; `null` for a file, or before anything to measure. */
  offset: number | null;
  settled: boolean;
}

export const Offset = {
  /** The live point is the freshest `edge − time` this long back. */
  WINDOW_MS: 60_000,
  /** Settled once the reading has not risen for this long (and was read this long). */
  SETTLE_MS: 3_000,
  /** A rise smaller than this is a chunk's jitter, not the burst still arriving. */
  RISE_S: 0.1,
  /** A playhead this far back is a new connection: start again. */
  BACK_S: 1,
  /** A platform reading that moves more than this has not settled. */
  NATIVE_STEP_S: 0.25,
} as const;

interface Lead {
  t: number;
  lead: number;
}

export class LiveOffset {
  /** The window's leads, decreasing (a monotonic queue: the front is the freshest). */
  private leads: Lead[] = [];
  private since: number | null = null;
  private risenAt = 0;
  private anchor: number | null = null;
  private native: number | null = null;
  private lastPosition: number | null = null;

  /** A new connection (a `discontinuity`, a new load): measure again. */
  reset(): void {
    this.leads = [];
    this.since = null;
    this.anchor = null;
    this.native = null;
    this.lastPosition = null;
  }

  /** The offset at monotonic time `t` (ms). */
  read(t: number, r: OffsetReading): LiveOffsetValue {
    if (!r.live) {
      this.reset();
      return { offset: null, settled: false };
    }
    if (
      this.lastPosition != null &&
      r.position < this.lastPosition - Offset.BACK_S
    )
      this.reset();
    this.lastPosition = r.position;
    if (r.native != null) return this.fromNative(t, r.native);
    if (r.edge == null) return { offset: null, settled: false };
    this.since ??= t;
    const lead = r.edge - t / 1000;
    while (this.leads.length > 0 && this.leads.at(-1)!.lead <= lead)
      this.leads.pop();
    this.leads.push({ t, lead });
    while (this.leads[0]!.t < t - Offset.WINDOW_MS) this.leads.shift();
    const anchor = this.leads[0]!.lead;
    if (this.anchor == null || anchor > this.anchor + Offset.RISE_S)
      this.risenAt = t;
    this.anchor = anchor;
    const offset = Math.max(0, t / 1000 + anchor - r.position);
    return { offset, settled: this.settled(t) };
  }

  private fromNative(t: number, native: number): LiveOffsetValue {
    this.since ??= t;
    if (
      this.native == null ||
      Math.abs(native - this.native) > Offset.NATIVE_STEP_S
    )
      this.risenAt = t;
    this.native = native;
    return { offset: Math.max(0, native), settled: this.settled(t) };
  }

  private settled(t: number): boolean {
    return (
      t - this.since! >= Offset.SETTLE_MS &&
      t - this.risenAt >= Offset.SETTLE_MS
    );
  }
}
