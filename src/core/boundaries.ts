// Where a live stream's item really starts, found in the audio around its
// ICY title.
//
// A station's title is no clock: its automation sends it when an item is
// queued, and Icecast places it at the next metadata block, so the title
// lands anywhere from ~0.5 s before to ~2.5 s after the audio it names
// (measured on Rádio Animu, every mount). The audio is exact: between items
// the automation leaves a gap of digital silence (MP3 decodes it to zeros,
// HE-AAC to under −105 dB; a file's own quiet start sits at −90…−100 dB), and
// the new item starts where that gap ends. Without a gap (a jingle over a
// fade-out) the item starts at its onset: sound after a quiet stretch.
//
// Fed with the player's audio sample windows (the times they are heard), it
// keeps the last few seconds as ~11 ms spans of loudness. A title opens a
// search from `LOOK_BACK_MS` before it to `LOOK_AHEAD_MS` after: the earliest
// gap end or onset in it is the boundary, reported as soon as it is seen
// (often before it is heard: windows arrive ahead of the speaker). The
// earliest, not the best: a short jingle's onset comes before the gap that
// starts the song after it. A title the audio does not show (music running
// straight on) is its own boundary once the search is over.
//
// A connection opens with the audio from before live, and its titles are where
// they were in that audio (recorded on Icecast: a connection made 2.5 s after a
// change got the item *before* as its first title on the 64 kbps mount, and the
// new one 12 s of audio later). So its first title names the item playing where
// the audio begins. That item was under way before the connection unless a
// start shows in the audio: without one nothing is reported for it, and a
// start found around it is left for the title that follows as well (a title
// lands up to seconds after its audio: the start may be the next item's).
// That title takes it unless another start shows in its own window: silence
// falls only between items, so two starts are taken for the first item's and
// its own. That is one of two readings: when the start was the next item's
// and that item lasts only seconds, the later one is the item's after it,
// which is then placed late and its follower by its title. A short item right
// as a connection opens cannot be told either way from the audio alone.

import type { StreamBoundary as Boundary } from '../types';

/** One window of decoded audio, timed to when it is heard. */
export interface BoundaryWindow {
  /** Epoch ms when the window's first frame is heard. */
  at: number;
  /** Ms of audio the window spans. */
  duration: number;
  /** Samples of the window, evenly spaced over it. */
  points: ArrayLike<number>;
}

/** A span this quiet is silence between items (dB of its mean power). */
const GAP_DB = -105;
/** A span this loud has sound again after a gap... */
const GAP_END_DB = -102;
/** ...if the sound holds for this long (not a blip in a fade-out): nothing as quiet as a gap, and as loud on average. */
const GAP_END_HOLD_MS = 50;
/** Silence this long is a gap between items, not a quiet moment. */
const MIN_GAP_MS = 80;
/**
 * A short gap HE-AAC smeared (to about −100 dB): this quiet for
 * `CUT_QUIET_MS`, then loud (`ONSET_DB`) within `CUT_RISE_MS`. Music does not
 * jump from near silence to full level that fast; an item does.
 */
const CUT_DB = -96;
const CUT_QUIET_MS = 30;
const CUT_RISE_MS = 60;
/** A gap may end this long before its title is heard (the title came a block late). */
const LOOK_BACK_MS = 2_500;
/** ...or this long after (the title came early). */
const LOOK_AHEAD_MS = 4_000;
/** Quieter than this for `ONSET_QUIET_MS`, then louder than `ONSET_DB`: an onset. */
const QUIET_DB = -70;
const ONSET_QUIET_MS = 300;
const ONSET_DB = -50;
const ONSET_RISE_MS = 150;
/** An onset this long before the title belongs to the item before it. */
const ONSET_LOOK_BACK_MS = 300;
/** Loudness spans (ms): ~32 points of a 4096-frame window at 44.1 kHz. */
const SPAN_MS = 11;
/** An item starts this long after the one before it at least (its boundary found earlier). */
const AFTER_PREVIOUS_MS = 500;
/** A search that cannot tell yet: more audio is needed. */
const WAIT = 'wait';
/** A time found, `WAIT`, or nothing. */
type Search = number | typeof WAIT | null;
/** Where a quiet run's span stands for a gap. */
type GapVerdict = 'end' | typeof WAIT | 'blip' | 'none';
/** History kept for the look-back (ms). */
const KEEP_MS = LOOK_BACK_MS + 1_000;

interface Span {
  at: number;
  end: number;
  db: number;
}

const powerDb = (
  points: ArrayLike<number>,
  from: number,
  to: number
): number => {
  let sum = 0;
  for (let i = from; i < to; i++) sum += points[i]! * points[i]!;
  return 10 * Math.log10(sum / Math.max(1, to - from) + 1e-30);
};

export class BoundaryFinder {
  private spans: Span[] = [];
  private pending: {
    title: string;
    titleAt: number;
    /** A connection's first title: its item may have been under way (see {@link first}). */
    first?: boolean;
    /** The start a connection's first title was given, found for this title too: its own unless a later one shows. */
    held?: Pick<Boundary, 'at' | 'kind'>;
  } | null = null;
  /** The last boundary reported: the next item cannot start before it. */
  private previous = -Infinity;
  /** The start given to a connection's first title, which the title after it may claim. */
  private candidate: number | null = null;
  /**
   * Sound was heard since the last reset. A connection's audio begins with
   * silence of its own (a decoder starting mid-stream: 14 ms of zeros on
   * Android, its next window timed up to 30 ms on), which is no gap between
   * items: nothing is kept until the first sound.
   */
  private sounded = false;

  /** A title was heard at `titleAt`: returns its boundary if the audio already shows it. */
  title(title: string, titleAt: number): Boundary | null {
    const previous = this.pending ? this.settle(true) : null;
    this.pending = { title, titleAt };
    return previous ?? this.settle(false);
  }

  /**
   * A connection's first title, heard at `titleAt`: its item may have been
   * under way before the connection opened. A start in the audio is reported
   * for it like any title's, as a candidate (it may be the next item's, and
   * is found again for that one's title); without one nothing is reported
   * (the title's time says nothing of an item under way).
   */
  first(title: string, titleAt: number): Boundary | null {
    const previous = this.pending ? this.settle(true) : null;
    this.pending = { title, titleAt, first: true };
    return previous ?? this.settle(false);
  }

  /**
   * A window of audio: returns a boundary once it is known — a title's gap
   * ending, or its search running out (a title superseded by the next one is
   * settled by {@link title}).
   */
  push(window: BoundaryWindow): Boundary | null {
    const n = window.points.length;
    if (n === 0 || !(window.duration > 0)) return null;
    const count = Math.max(1, Math.round(window.duration / SPAN_MS));
    for (let k = 0; k < count; k++) {
      this.addSpan(
        window,
        Math.floor((k * n) / count),
        Math.floor(((k + 1) * n) / count)
      );
    }
    const keepFrom = (this.spans.at(-1)?.end ?? 0) - KEEP_MS;
    const drop = this.spans.findIndex((span) => span.end >= keepFrom);
    if (drop > 0) this.spans.splice(0, drop);
    return this.pending ? this.settle(false) : null;
  }

  /** Drops the history and any pending title (a new source, a seek). */
  reset(): void {
    this.spans = [];
    this.pending = null;
    this.previous = -Infinity;
    this.candidate = null;
    this.sounded = false;
  }

  /** Points [from, to) of a window as a span; overlapping windows (a browser analyser) add only what is new. */
  private addSpan(window: BoundaryWindow, from: number, to: number): void {
    const n = window.points.length;
    const at = window.at + (from / n) * window.duration;
    const last = this.spans.at(-1);
    if (to <= from || (last && at < last.end - 0.5)) return;
    const db = powerDb(window.points, from, to);
    if (!this.sounded && db < CUT_DB) return;
    this.sounded = true;
    this.spans.push({ at, end: window.at + (to / n) * window.duration, db });
  }

  /** The pending title's boundary if known (or `final`: the best the audio shows). */
  private settle(final: boolean): Boundary | null {
    const pending = this.pending;
    if (!pending) return null;
    const to = pending.titleAt + LOOK_AHEAD_MS;
    const after = this.previous + AFTER_PREVIOUS_MS;
    const over = final || (this.spans.at(-1)?.end ?? -Infinity) >= to;
    let found =
      pending.held ??
      this.earliest(
        Math.max(after, pending.titleAt - LOOK_BACK_MS),
        Math.max(after, pending.titleAt - ONSET_LOOK_BACK_MS),
        to
      );
    if (found === WAIT) return null;
    // The start a connection's first title was given is this item's or that
    // one's own. Silence falls only between items, so another start after it
    // in this window settles it: that one is this item's, the earlier one the
    // first's. Without another, this item's, once the window was heard.
    const shared = pending.first ? null : this.candidate;
    if (found && shared != null && Math.abs(found.at - shared) < 1) {
      // Held while the window is heard on: the audio it is in is not kept that long.
      pending.held = found;
      const from = shared + AFTER_PREVIOUS_MS;
      const later = this.earliest(
        from,
        Math.max(from, pending.titleAt - ONSET_LOOK_BACK_MS),
        to
      );
      if (later === WAIT || (!later && !over)) return null;
      // Superseded before its window was heard: nothing showed the shared
      // start to be its own, so it keeps its title's time.
      found = later ?? (final ? null : found);
    }
    if (!found && over) {
      // A connection's first item with no start in its audio was under way.
      if (pending.first) {
        this.pending = null;
        return null;
      }
      found = { at: pending.titleAt, kind: 'title' };
    }
    if (!found) return null;
    this.pending = null;
    const boundary = {
      title: pending.title,
      titleAt: pending.titleAt,
      ...found,
    };
    // A start around a connection's first title may be the next item's (the
    // first being under way, the next one's title not heard yet): it is not
    // kept from the title that follows.
    if (pending.first) {
      this.candidate = found.at;
      return { ...boundary, first: true };
    }
    this.candidate = null;
    this.previous = found.at;
    return boundary;
  }

  /** The earliest start the audio shows in [from, to] (an onset, from `onsetFrom`), `WAIT` while one cannot be told yet. */
  private earliest(
    from: number,
    onsetFrom: number,
    to: number
  ): Pick<Boundary, 'at' | 'kind'> | typeof WAIT | null {
    const gap = this.gapEnd(from, to);
    const cut = this.cut(from, to);
    if (gap === WAIT || cut === WAIT) return WAIT;
    const onset = this.onset(onsetFrom, to);
    const candidates: Array<Pick<Boundary, 'at' | 'kind'>> = [];
    if (gap != null) candidates.push({ at: gap, kind: 'gap' });
    if (cut != null) candidates.push({ at: cut, kind: 'gap' });
    if (onset != null) candidates.push({ at: onset, kind: 'onset' });
    return candidates.sort((x, y) => x.at - y.at)[0] ?? null;
  }

  /**
   * The end of the first gap that ends within [from, to] (sound that holds,
   * not a blip), or `WAIT` while one has not been heard far enough past.
   */
  private gapEnd(from: number, to: number): Search {
    let since: number | null = null;
    for (let i = 0; i < this.spans.length; i++) {
      const span = this.spans[i]!;
      const verdict =
        since != null && span.db > GAP_END_DB
          ? this.gapVerdict(i, since, from, to)
          : 'none';
      if (verdict === 'end') return span.at;
      if (verdict === WAIT) return WAIT;
      since = nextGapStart(span, since, verdict);
    }
    return null;
  }

  /** Whether sound at span `i`, after silence since `since`, ends a gap in [from, to]. */
  private gapVerdict(
    i: number,
    since: number,
    from: number,
    to: number
  ): GapVerdict {
    const at = this.spans[i]!.at;
    if (at - since < MIN_GAP_MS) return 'none';
    const holds = this.soundHolds(i);
    const inRange = at >= from && at <= to;
    if (holds === WAIT) return inRange ? WAIT : 'none';
    if (!holds) return 'blip';
    return inRange ? 'end' : 'none';
  }

  /** Sound from span `i` holds for `GAP_END_HOLD_MS`: nothing as quiet as a gap, and as loud as a gap's end on average. */
  private soundHolds(i: number): boolean | typeof WAIT {
    const spans = this.spans;
    const until = spans[i]!.at + GAP_END_HOLD_MS;
    let power = 0;
    let j = i;
    for (; j < spans.length && spans[j]!.at < until; j++) {
      if (spans[j]!.db < GAP_DB) return false;
      power += 10 ** (spans[j]!.db / 10);
    }
    if (j === spans.length) return WAIT;
    return 10 * Math.log10(power / (j - i)) >= GAP_END_DB;
  }

  /** The first cut in [from, to]: `CUT_QUIET_MS` under `CUT_DB`, then loud within `CUT_RISE_MS`. */
  private cut(from: number, to: number): Search {
    // Quiet audio heard in a row (ms): a hole between two windows is not quiet.
    let quiet = 0;
    for (let i = 0; i < this.spans.length; i++) {
      const span = this.spans[i]!;
      const rises =
        quiet >= CUT_QUIET_MS &&
        span.db >= CUT_DB &&
        span.at >= from &&
        span.at <= to;
      const rise = rises ? this.loudWithin(i, CUT_RISE_MS) : null;
      if (rise != null) return rise;
      quiet = span.db < CUT_DB ? quiet + (span.end - span.at) : 0;
    }
    return null;
  }

  /** Span `i`'s start if a span within `ms` of it is loud (`ONSET_DB`); `WAIT` if not heard that far yet. */
  private loudWithin(i: number, ms: number): Search {
    const at = this.spans[i]!.at;
    const loud = this.spans.find(
      (span, j) => j >= i && span.at <= at + ms && span.db > ONSET_DB
    );
    if (loud) return at;
    return (this.spans.at(-1)?.at ?? -Infinity) <= at + ms ? WAIT : null;
  }

  /**
   * The first onset within [from, to]: where sound starts rising after
   * `ONSET_QUIET_MS` of quiet, once it gets loud within `ONSET_RISE_MS` (a
   * fade-in on HE-AAC passes through the middle levels first).
   */
  private onset(from: number, to: number): number | null {
    const run: OnsetRun = { quietSince: null, rise: null };
    for (const span of this.spans) {
      const rise = onsetStep(run, span);
      if (rise != null && rise >= from && rise <= to) return rise;
    }
    return null;
  }
}

/** Where a gap's quiet run starts after `span`: it goes on through levels between a gap's and a gap end's, and through a blip. */
function nextGapStart(
  span: Span,
  since: number | null,
  verdict: GapVerdict
): number | null {
  if (span.db < GAP_DB) return since ?? span.at;
  if (span.db > GAP_END_DB && verdict !== 'blip') return null;
  return since;
}

interface OnsetRun {
  quietSince: number | null;
  rise: number | null;
}

/** Moves an onset search past `span`: the onset's time once sound rose loud after a quiet stretch, else `null`. */
function onsetStep(run: OnsetRun, span: Span): number | null {
  if (span.db < QUIET_DB) {
    run.quietSince = run.rise == null ? (run.quietSince ?? span.at) : span.at;
    run.rise = null;
    return null;
  }
  if (
    run.rise == null &&
    run.quietSince != null &&
    span.at - run.quietSince >= ONSET_QUIET_MS
  )
    run.rise = span.at;
  const rise = run.rise;
  const rising = rise != null && span.at - rise <= ONSET_RISE_MS;
  const loud = rising && span.db > ONSET_DB;
  if (!rising || loud) {
    run.quietSince = null;
    run.rise = null;
  }
  return loud ? rise : null;
}
