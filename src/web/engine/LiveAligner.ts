// A live quality switch's audio, lined up with what is heard.
//
// Separate Icecast mounts of one station, loaded as renditions, are separate
// connections, and each starts with the server's burst of recent audio. The
// burst is a byte count, so how far behind live a connection starts depends
// on its bitrate (64 KiB is 1.6 s at 320 kbps, 8 s at 64 kbps): taking over on
// the new connection's first audio repeats or skips the difference.
//
// Once a connection's burst has arrived, its buffered edge is the live edge,
// so the two timelines map onto each other by `k = edge(new) − edge(old)`.
// An edge moves in steps, as chunks arrive (each connection on its own beat,
// ExoPlayer's a second apart at 64 kbps), and never past live: a
// connection's freshest reading over a window, the most of `edge − time`, is
// its live edge. While a burst arrives that rises fast; once two windows in a
// row agree on both connections, the burst is in and the newer gives `k`. The
// aligner then drives the new, muted player until it plays what the old one
// plays: held paused while it is ahead, run faster while it is behind (or
// moved forward, where the platform can), and gently slower or faster for
// the last tenths. It says when to take over (aligned within `TOLERANCE_S`,
// or within `ACCEPT_S` when it cannot do better) and when to give up and
// switch as before (`fallback`: the old player stalled, a connection is being
// replaced, the burst never settled, or the budget ran out); a fallback is a
// `discontinuity` for the app.
//
// Pure: the platform's `SwapDriver` feeds it readings every `TICK_MS` and
// applies what it answers. Twins: `ios/Core/LiveAligner.swift`,
// `android/.../core/LiveAligner.kt`, against `conformance/align/live.json`.

/** One player's reading, on its own timeline (seconds). */
export interface AlignReading {
  /** The playhead. */
  position: number;
  /** Where the audio received so far ends; `null` when unknown. */
  edge: number | null;
  /** When that audio arrived (ms, `t`'s clock), where the player knows: the reading's time otherwise. */
  edgeAt?: number;
  /** The playhead moves. */
  playing: boolean;
  /** A dropped connection is being replaced: the edge says nothing about live. */
  reconnecting?: boolean;
  /** It can start (default): one not ready yet is held, whatever the gap. */
  ready?: boolean;
  /**
   * The stream's own clock (program dates): epoch seconds it gives position 0 on this timeline, `programDate − position`. With one on both sides the mapping is known at once, and followed as a live window slides.
   */
  clock?: number | null;
  /** How far back it can be moved (its live window's start): a clocked player ahead is moved back. */
  start?: number | null;
}

/** What the new player can do while it is muted. */
export interface AlignCaps {
  /** The fastest it may run (1: it cannot catch up by speed). */
  maxRate: number;
  /** The slowest it may run (1: it cannot). */
  minRate: number;
  /**
   * It can be moved forward within what it received: `always` (a seek),
   * `first` (only at the first decision, before it plays anything: iOS drops
   * the burst's start before AVPlayer reads it), `never`.
   */
  jump: 'always' | 'first' | 'never';
  /**
   * How far ahead a held player starts, seconds: its start-up delay, learned
   * again after every start. Better too long than too short where it cannot
   * run faster: a player ahead is held again, one behind cannot catch up.
   */
  startLead: number;
  /** A moved player lands this much further ahead than its start lead, then is held (its time to be ready). */
  jumpLead: number;
}

export type AlignFallback =
  /** The edges never settled (the connect burst still arriving). */
  | 'unsettled'
  /** The old player stalls (a switch the player needs). */
  | 'stalled'
  /** The new player did not start playing within its budget. */
  | 'starting'
  /** A dropped connection is being replaced. */
  | 'reconnecting'
  /** A connection jumped (`interrupt`). */
  | 'discontinuity'
  /** Not lined up within `BUDGET_MS`. */
  | 'timeout'
  /** The new player is further ahead than a hold within the budget. */
  | 'ahead'
  /** The new player is behind and cannot catch up (no faster rate, no jump). */
  | 'behind';

export type AlignAction =
  | { kind: 'wait' }
  /**
   * Run the new player at this rate (× the app's); 0 holds it paused.
   * `afterMs`: start it this much later (a hold that ends between ticks).
   */
  | { kind: 'rate'; rate: number; afterMs?: number }
  /** Move the new player to this position (paused). */
  | { kind: 'jump'; to: number }
  /** Aligned: make the new player the one heard. `residual`: new − old, seconds. */
  | { kind: 'takeOver'; residual: number }
  /** Switch as before (on the new player's first audio) and report a discontinuity. */
  | { kind: 'fallback'; reason: AlignFallback };

export const Align = {
  /** How often the drivers read both players. */
  TICK_MS: 40,
  /** Each connection's freshest edge, against the clock, over two windows this long… */
  SETTLE_WINDOW_MS: 1_500,
  /** …moved less than this, and both edges grew by this × the window in the newer one: the burst is in. */
  DRIFT_S: 0.1,
  GROWTH: 0.5,
  /** No settled burst by then: switch as before. */
  SETTLE_BUDGET_MS: 8_000,
  /** Not aligned by then (from the first reading): switch as before. */
  BUDGET_MS: 30_000,
  /** Aligned: take over. */
  TOLERANCE_S: 0.05,
  /** Close enough when the player cannot do better, or did not within `FINE_BUDGET_MS` of first getting this close. */
  ACCEPT_S: 0.3,
  /** A clocked player this much further ahead than a jump would land it is moved back, not held. */
  BACK_S: 1,
  /** A jump back lands this far inside the live window (its start drops out as it slides). */
  WINDOW_MARGIN_S: 2,
  FINE_BUDGET_MS: 3_000,
  /** The rate closes the gap over about this long (1 + gap / horizon). */
  HORIZON_S: 1,
  RATE_STEP: 0.05,
  /** At rate 1 this long before its readings are trusted for a takeover. */
  STEADY_MS: 300,
  /** Told to run but not moving for this long: it stalled. */
  START_BUDGET_MS: 3_000,
} as const;

interface EdgeSample {
  t: number;
  next: number;
  old: number;
  /** When each edge's audio arrived. */
  nextAt: number;
  oldAt: number;
}

/** Rates move in `RATE_STEP`s: no stream of tiny changes. */
function quantize(rate: number): number {
  return Math.floor(rate / Align.RATE_STEP + 0.5) * Align.RATE_STEP;
}

/** A connection's live edge, against the clock: its freshest reading of `edge − time`. */
function freshest(samples: EdgeSample[], key: 'next' | 'old'): number {
  let best = -Infinity;
  for (const s of samples) {
    const at = key === 'next' ? s.nextAt : s.oldAt;
    best = Math.max(best, s[key] - at / 1000);
  }
  return best;
}

export class LiveAligner {
  private startedAt: number | null = null;
  private samples: EdgeSample[] = [];
  private k: number | null = null;
  private decided = false;
  private done = false;
  /** The rate the new player was told (0: held). */
  private commanded = 0;
  private runningSince: number | null = null;
  private steadySince: number | null = null;
  private fineSince: number | null = null;
  /** The gap when it last started from a hold, to learn its start-up delay. */
  private startGap: number | null = null;
  private lead: number;
  /** Where it was when it was told to start: it has started once it moved. */
  private startPosition = 0;
  private lastGap: number | null = null;

  constructor(private readonly caps: AlignCaps) {
    this.lead = caps.startLead;
  }

  /** `k`, once measured: new position = old position + k. */
  get offset(): number | null {
    return this.k;
  }

  /** The last gap read (new − old, seconds): what a switch now would skip (+) or repeat (−). */
  get gap(): number | null {
    return this.lastGap;
  }

  /** A connection jumped (either player): the mapping no longer holds. */
  interrupt(): AlignAction {
    return this.fallback('discontinuity');
  }

  /** One tick: both readings at monotonic time `t` (ms). */
  step(t: number, old: AlignReading, next: AlignReading): AlignAction {
    if (this.done) return { kind: 'wait' };
    this.startedAt ??= t;
    const elapsed = t - this.startedAt;
    if (old.reconnecting === true || next.reconnecting === true)
      return this.fallback('reconnecting');
    if (!old.playing) return this.fallback('stalled');
    if (old.clock != null && next.clock != null)
      this.k = old.clock - next.clock;
    if (this.k == null) {
      if (elapsed >= Align.SETTLE_BUDGET_MS) return this.fallback('unsettled');
      this.measure(t, old, next);
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- measure() sets it, which TypeScript does not follow
      if (this.k == null) return { kind: 'wait' };
    }
    if (elapsed >= Align.BUDGET_MS) return this.fallback('timeout');
    return this.align(t, elapsed, old, next);
  }

  // ── The mapping ──

  private measure(t: number, old: AlignReading, next: AlignReading): void {
    if (old.edge == null || next.edge == null) return;
    this.samples.push({
      t,
      next: next.edge,
      old: old.edge,
      nextAt: next.edgeAt ?? t,
      oldAt: old.edgeAt ?? t,
    });
    // Keep two windows, and one sample at or before their start.
    const span = 2 * Align.SETTLE_WINDOW_MS;
    while (this.samples.length > 1 && this.samples[1]!.t <= t - span)
      this.samples.shift();
    if (t - this.samples[0]!.t < span) return;
    const middle = t - Align.SETTLE_WINDOW_MS;
    const earlier = this.samples.filter((s) => s.t < middle);
    const later = this.samples.filter((s) => s.t >= middle);
    const drift = (key: 'next' | 'old') =>
      Math.abs(freshest(later, key) - freshest(earlier, key));
    const grew = (key: 'next' | 'old') =>
      later.at(-1)![key] - later[0]![key] >=
      (Align.GROWTH * Align.SETTLE_WINDOW_MS) / 1000;
    // Still arriving, or not growing: the windows slide on.
    if (drift('next') > Align.DRIFT_S || drift('old') > Align.DRIFT_S) return;
    if (!grew('next') || !grew('old')) return;
    this.k = freshest(later, 'next') - freshest(later, 'old');
    this.samples = [];
  }

  // ── Driving the new player ──

  private align(
    t: number,
    elapsed: number,
    old: AlignReading,
    next: AlignReading
  ): AlignAction {
    const target = old.position + this.k!;
    const gap = next.position - target;
    this.lastGap = gap;
    const first = !this.decided;
    this.decided = true;
    if (this.commanded === 0)
      return this.fromHold(t, elapsed, target, gap, first, next);
    return this.running(t, gap, next);
  }

  /** Running: started, faster or slower, until close enough. */
  private running(t: number, gap: number, next: AlignReading): AlignAction {
    if (!next.playing) {
      // Starting, or out of audio.
      this.steadySince = null;
      if (t - this.runningSince! >= Align.START_BUDGET_MS)
        return this.fallback('starting');
      return { kind: 'wait' };
    }
    if (this.startGap != null && next.position !== this.startPosition) {
      // It started from a hold at `startGap` and moves at `gap`: its start-up delay.
      this.lead = Math.min(Math.max(this.startGap - gap, 0), 1);
      this.startGap = null;
    }
    // Close for a while without settling (readings too coarse for the
    // tolerance): close enough.
    const close = Math.abs(gap) <= Align.ACCEPT_S;
    if (close) this.fineSince ??= t;
    const late =
      this.fineSince != null && t - this.fineSince >= Align.FINE_BUDGET_MS;
    if (close && late) return this.takeOver(gap);
    const desired = this.desiredRate(gap);
    if (desired !== this.commanded) return this.setRate(t, desired, gap, next);
    if (this.commanded !== 1) return { kind: 'wait' };
    return this.steady(t, gap, close);
  }

  /** At rate 1: trusted once steady, then aligned, or as close as it gets. */
  private steady(t: number, gap: number, close: boolean): AlignAction {
    this.steadySince ??= t;
    if (t - this.steadySince < Align.STEADY_MS) return { kind: 'wait' };
    if (Math.abs(gap) <= Align.TOLERANCE_S) return this.takeOver(gap);
    const { maxRate, minRate } = this.caps;
    const canFix = gap < 0 ? maxRate > 1 : minRate < 1;
    if (close && !canFix) return this.takeOver(gap);
    if (gap < -Align.ACCEPT_S && !canFix) return this.fallback('behind');
    return { kind: 'wait' };
  }

  /** Held: moved, held on, started, or run faster. */
  private fromHold(
    t: number,
    elapsed: number,
    target: number,
    gap: number,
    first: boolean,
    next: AlignReading
  ): AlignAction {
    const { jump, maxRate } = this.caps;
    // `first` is spent by the first decision, a wait too: iOS opens its gate then.
    const canJump = jump === 'always' || (jump === 'first' && first);
    // At first anything short of the lead is moved (the start is then always
    // from a hold); later only a player that fell behind.
    const short = first ? gap < this.lead : gap < -Align.TOLERANCE_S;
    if (short && canJump) return this.moveForward(target, next);
    const back = this.moveBack(elapsed, target, gap, next);
    if (back != null) return back;
    if (gap > this.lead || next.ready === false)
      return this.holding(t, elapsed, gap, first, next);
    if (gap < -Align.TOLERANCE_S && maxRate > 1)
      return this.setRate(t, this.speedUp(gap), gap, next);
    if (gap < -Align.ACCEPT_S) return this.fallback('behind');
    return this.setRate(t, 1, gap, next);
  }

  /**
   * Moved just ahead, then held: it never starts behind. One at the edge of
   * what it holds waits for more (a jump there would not move it).
   */
  private moveForward(target: number, next: AlignReading): AlignAction {
    const to = this.landing(target, next);
    if (to <= next.position + Align.TOLERANCE_S) return { kind: 'wait' };
    return { kind: 'jump', to };
  }

  /**
   * On a stream's clock it can go back too, within its live window: if the
   * hold left after it fits the budget, else not at all (decided once, when
   * it jumps; a held one is left to `holding`). `null`: not moved back.
   */
  private moveBack(
    elapsed: number,
    target: number,
    gap: number,
    next: AlignReading
  ): AlignAction | null {
    if (next.start == null || this.caps.jump !== 'always') return null;
    if (gap <= this.lead + this.caps.jumpLead + Align.BACK_S) return null;
    const to = this.landing(target, next);
    if (next.position - to <= Align.BACK_S) return null;
    if ((to - target - this.lead) * 1000 > Align.BUDGET_MS - elapsed)
      return this.fallback('ahead');
    return { kind: 'jump', to };
  }

  /** Where a jump lands it: just ahead of what is heard, within what it holds and its live window. */
  private landing(target: number, next: AlignReading): number {
    const edge = next.edge ?? Infinity;
    const to = Math.min(target + this.lead + this.caps.jumpLead, edge);
    if (next.start == null) return to;
    return Math.min(Math.max(to, next.start + Align.WINDOW_MARGIN_S), edge);
  }

  /** Ahead (or not ready): held until the old one gets there, if it gets there in time. */
  private holding(
    t: number,
    elapsed: number,
    gap: number,
    first: boolean,
    next: AlignReading
  ): AlignAction {
    const due = (gap - this.lead) * 1000;
    if (first && due > Align.BUDGET_MS - elapsed) return this.fallback('ahead');
    // Due before the next tick: started then, on a timer of its own.
    if (next.ready !== false && due < Align.TICK_MS)
      return this.setRate(t, 1, this.lead, next, Math.floor(due));
    return { kind: 'wait' };
  }

  /** While it runs: faster when behind, held again when well ahead, slower when a little. */
  private desiredRate(gap: number): number {
    const { maxRate, minRate } = this.caps;
    if (gap < -Align.TOLERANCE_S) return maxRate > 1 ? this.speedUp(gap) : 1;
    if (gap > Align.ACCEPT_S) return 0;
    if (gap > Align.TOLERANCE_S) return minRate < 1 ? this.slowDown(gap) : 1;
    return 1;
  }

  private speedUp(gap: number): number {
    const rate = quantize(1 - gap / Align.HORIZON_S);
    return Math.min(this.caps.maxRate, Math.max(1 + Align.RATE_STEP, rate));
  }

  private slowDown(gap: number): number {
    const rate = quantize(1 - gap / Align.HORIZON_S);
    return Math.max(this.caps.minRate, Math.min(1 - Align.RATE_STEP, rate));
  }

  private setRate(
    t: number,
    rate: number,
    gap: number,
    next: AlignReading,
    afterMs = 0
  ): AlignAction {
    const from = this.commanded;
    this.commanded = rate;
    this.steadySince = null;
    this.startGap = from === 0 && rate === 1 ? gap : null;
    this.startPosition = next.position;
    if (rate === 0) this.runningSince = null;
    else if (from === 0) this.runningSince = t + afterMs;
    else {
      // Running on at another rate: it has been running since then.
    }
    return afterMs > 0
      ? { kind: 'rate', rate, afterMs }
      : { kind: 'rate', rate };
  }

  private takeOver(residual: number): AlignAction {
    this.done = true;
    return { kind: 'takeOver', residual };
  }

  private fallback(reason: AlignFallback): AlignAction {
    this.done = true;
    return { kind: 'fallback', reason };
  }
}
