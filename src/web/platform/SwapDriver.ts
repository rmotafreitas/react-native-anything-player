// A player's local output: the element heard (and on screen), and a second
// one that prepares a quality switch behind it (`open({ swap: true })`,
// separate files of one video or one sound). The second one opens a little
// ahead, muted, waits until the first reaches that point, plays, and takes
// over on its first frame: no spinner, no jump. The engine then makes its
// generation the current one (twin behaviour: the second AVPlayer /
// ExoPlayer natively).
//
// A live stream has no shared timeline: each connection starts with its
// server's burst of recent audio. There the new element is lined up with
// what is heard first (`LiveAligner`): held, moved within what it holds, or
// run faster or slower, muted, until it plays what the old one plays; then
// it takes over by volume alone. When it cannot be lined up, it takes over
// as before and the app hears a `discontinuity`. Positions stay continuous
// across a live switch.

import { awaitsClock } from './liveClock';
import type { EngineDriver } from '../engine/PlaybackEngine';
import type { StreamMetadata } from '../engine/StreamMetadata';
import { engineError } from '../engine/types';
import {
  Align,
  LiveAligner,
  type AlignAction,
  type AlignCaps,
} from '../engine/LiveAligner';
import type {
  OpenRequest,
  PlaybackSample,
  QualityConstraints,
  ReadyInfo,
} from '../engine/types';
import { browser, monotonicNow, type AudioElementLike } from './dom';
import {
  MediaElementDriver,
  type DriverObserver,
  type PlayAttempt,
  type ProgressReading,
} from './MediaElementDriver';

/** The local output the controller drives: one element, or two with a swap. */
export interface LocalDriver extends EngineDriver {
  readonly element: AudioElementLike;
  readonly isStreamed: boolean;
  lastPlayAttempt: Promise<PlayAttempt> | null;
  tapped: boolean;
  /** Safari's AirPlay plays the element it was started on (`SwapDriver`). */
  readonly swapsInPlace?: boolean;
  progress(): ProgressReading;
  destroy(): void;
  /** A user gesture: elements WebKit holds back may play from now on. */
  unlock?(): void;
}

/** Shows one element of the stage and hides the other. */
export interface SwapStage {
  show(element: AudioElementLike, hidden: AudioElementLike | null): void;
}

/** How far ahead of the picture the new file opens, seconds. */
const LOOKAHEAD_S = 1.5;
/** How often the rendezvous checks the picture's position. */
const RENDEZVOUS_TICK_MS = 40;

/** A muted element runs at most this fast; Firefox mutes beyond 4×. */
const MAX_ALIGN_RATE = 4;
/**
 * A live switch's new element plays this quietly (−80 dB) in Firefox, not
 * muted: Firefox stops the output of a silent element, and its clock slips
 * by a second once it is heard again (measured). Elsewhere it is muted (an
 * audible one may need the user's activation, and WebKit unmutes one that
 * was refused); a refusal mutes it in Firefox too.
 */
const WHISPER = 0.0001;
/**
 * A lined-up live switch silences the old element as it raises the new one
 * (both reach the speakers after the output's latency) and releases it this
 * much later: stopping it at once would cut the audio still on its way out.
 */
const HANDOVER_MS = 300;

/**
 * `observer`, deaf to one generation: the old element of a live switch plays
 * out its last audio silently (`HANDOVER_MS`), and nothing it reports is the
 * player's any more.
 */
function deafTo(
  observer: DriverObserver,
  generation: () => number | null
): DriverObserver {
  return new Proxy(observer, {
    get(target, key, receiver) {
      const value: unknown = Reflect.get(target, key, receiver);
      if (typeof value !== 'function' || key === 'onElementReplaced')
        return value;
      return (g: unknown, ...rest: unknown[]) =>
        g === generation()
          ? undefined
          : (value as (...args: unknown[]) => unknown).call(target, g, ...rest);
    },
  });
}

/**
 * WebKit (Safari, and every browser on iPhone and iPad): a muted element moved
 * while paused, then played, is paused again at once (measured): the new
 * element runs faster to catch up instead of being moved.
 */
function isWebKit(): boolean {
  const agent = browser().navigator?.userAgent ?? '';
  return /Safari\//.test(agent) && !/Chrome|Chromium|Android/.test(agent);
}

/** Whether the new element whispers rather than being muted: Firefox, with a volume the page sets. */
function whispers(element: AudioElementLike): boolean {
  if (!/Firefox\//.test(browser().navigator?.userAgent ?? '')) return false;
  const before = element.volume;
  element.volume = before === 0.5 ? 0.25 : 0.5;
  const works = element.volume !== before;
  element.volume = before;
  return works;
}

/** How long a new HLS or DASH item may go without a program date before it is taken to have none. */
const CLOCK_WAIT_MS = 3_000;

/** Fallbacks after which the aligner's last gap belongs to a mapping that no longer holds. */
const STALE_GAP: ReadonlySet<string> = new Set([
  'reconnecting',
  'discontinuity',
]);

interface Pending {
  generation: number;
  /** The media time the new file waits at (`null`: live). */
  target: number | null;
  ready: boolean;
  timer: number | null;
  /** Live: lines the new audio up with what is heard (`null`: not, or not yet). */
  aligner: LiveAligner | null;
  /** Gave up lining up: takes over on its first audio, reported as a discontinuity. */
  fallback: boolean;
  /** The player needs it (the current item stalls): one that cannot be lined up switches anyway. */
  required: boolean;
  /** What a fallback skips (+) or repeats (−), seconds, when the aligner knew. */
  jump: number | null;
  /** The new element plays at `WHISPER`, not muted. */
  whisper: boolean;
  /** Lined up by program dates (HLS, DASH), not by edges. */
  clocked: boolean;
  /** Since when it waits for the new item's first program date. */
  clockWaitSince?: number;
  /** The rate the aligner asked of the new element (× the app's). */
  alignRate: number;
  /** A start the aligner timed between two ticks. */
  startTimer: number | null;
  /** Both elements' reconnections when it started: one since breaks the mapping. */
  reconnects: [number, number];
  /** The latest metadata the new element's audio reached: told again once it is heard. */
  metadata: StreamMetadata | null;
  /** When it came (`SwapDriver.told`): told again only if after the old element's latest. */
  metadataAt: number;
}

export class SwapDriver implements LocalDriver {
  private current: MediaElementDriver;
  private spare: MediaElementDriver | null = null;
  private pending: Pending | null = null;
  /**
   * The queue's next item (`prepareNext`): opened, paused, on the spare
   * element when it is free (`onSpare`), else opened when its turn comes.
   */
  private next: { request: OpenRequest; onSpare: boolean } | null = null;
  /** WebKit lets an element play only after a play() in a user gesture: the spare has had one. */
  private spareUnlocked = false;
  private volume = 1;
  private rate = 1;
  private loop = false;
  private quality: QualityConstraints | null = null;
  /** The engine's track picks: a switch's file plays the same ones. */
  private tracks: { audio: string | null; text: string | null } | null = null;
  /** What both elements report to: the switch's events are intercepted here. */
  private readonly proxy: DriverObserver;
  /** The current element's generation (its events' positions are shifted). */
  private generation = -1;
  /** Live: current element's time − the position reported (continuous across switches). */
  private shift = 0;
  /** Metadata told so far (either element), and the count at the current element's latest. */
  private told = 0;
  private toldCurrent = 0;
  /** The old element of a live switch, still releasing (`HANDOVER_MS`), and its generation. */
  private handover: number | null = null;
  private leaving: number | null = null;

  constructor(
    private readonly observer: DriverObserver,
    private readonly make: (observer: DriverObserver) => MediaElementDriver,
    private readonly stage: SwapStage
  ) {
    this.proxy = this.makeProxy();
    this.current = make(this.proxy);
  }

  get element(): AudioElementLike {
    return this.current.element;
  }

  get isStreamed(): boolean {
    return this.current.isStreamed;
  }

  get lastPlayAttempt(): Promise<PlayAttempt> | null {
    return this.current.lastPlayAttempt;
  }

  set lastPlayAttempt(value: Promise<PlayAttempt> | null) {
    this.current.lastPlayAttempt = value;
  }

  get tapped(): boolean {
    return this.current.tapped;
  }

  /** Safari's AirPlay plays the element it was started on: no second, local one. */
  get swapsInPlace(): boolean {
    return this.current.element.webkitCurrentPlaybackTargetIsWireless === true;
  }

  set tapped(value: boolean) {
    this.current.tapped = value;
  }

  // ── EngineDriver ──

  open(request: OpenRequest): void {
    if (request.swap === true) {
      this.prepare(request);
      return;
    }
    this.drop();
    this.dropNext();
    this.generation = request.generation;
    this.shift = 0;
    this.current.open(request);
  }

  // ── The queue's next item ──

  prepareNext(request: OpenRequest): void {
    this.dropNext();
    this.next = { request, onSpare: false };
    // A quality switch holds the spare; or WebKit would refuse to start it.
    if (this.pending != null || (isWebKit() && !this.spareUnlocked)) return;
    this.finishHandover();
    const spare = (this.spare ??= this.make(this.proxy));
    spare.element.muted = false;
    spare.setRate(this.rate);
    spare.setVolume(this.volume);
    spare.setLoop(false);
    spare.open({ ...request, swap: false, playWhenReady: false });
    this.next.onSpare = true;
  }

  cancelNext(generation: number): void {
    if (this.next?.request.generation === generation) this.dropNext();
  }

  /** The current item ended: the prepared one plays (from the spare, without a network wait, when it is there). */
  advance(generation: number): void {
    const next = this.next;
    if (next == null || next.request.generation !== generation) return;
    this.next = null;
    this.drop();
    const spare = this.spare;
    this.shift = 0;
    if (!next.onSpare || spare == null) {
      this.generation = generation;
      this.current.open({ ...next.request, playWhenReady: true });
      return;
    }
    const old = this.current;
    spare.setRate(this.rate);
    spare.setVolume(this.volume);
    spare.setLoop(this.loop);
    if (this.tracks) spare.selectTracks(this.tracks.audio, this.tracks.text);
    this.current = spare;
    this.generation = generation;
    this.stage.show(spare.element, old.element);
    spare.play();
    old.releaseConnection();
    this.spare = old;
  }

  /**
   * A user gesture: WebKit lets the spare element play from now on (a
   * play() inside the gesture lifts its restriction, whatever it plays).
   */
  unlock(): void {
    if (this.spareUnlocked || !isWebKit()) return;
    if (this.pending != null || this.next?.onSpare === true) return;
    const spare = (this.spare ??= this.make(this.proxy));
    this.spareUnlocked = true;
    try {
      const attempt = spare.element.play?.() as Promise<void> | undefined;
      attempt?.catch?.(() => undefined);
    } catch {
      // Nothing to play: the restriction is lifted all the same.
    }
  }

  play(): void {
    this.current.play();
  }

  pause(): void {
    this.current.pause();
  }

  seek(seconds: number, exact = false): void {
    this.current.seek(seconds + this.shift, exact);
  }

  releaseConnection(): void {
    this.drop();
    this.dropNext();
    this.current.releaseConnection();
  }

  unload(): void {
    this.drop();
    this.dropNext();
    this.current.unload();
  }

  setVolume(effective: number): void {
    this.volume = effective;
    this.current.setVolume(effective);
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.current.setRate(rate);
    // A live switch lining up keeps running at its multiple of the app's rate.
    this.spare?.setRate(rate * (this.pending?.alignRate ?? 1));
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    this.current.setLoop(loop);
    this.spare?.setLoop(loop);
  }

  setQuality(constraints: QualityConstraints): void {
    this.quality = constraints;
    this.current.setQuality(constraints);
  }

  setVideoEnabled(): void {
    // See MediaElementDriver.setVideoEnabled.
  }

  selectTracks(audio: string | null, text: string | null): void {
    this.tracks = { audio, text };
    this.current.selectTracks(audio, text);
  }

  cancelSwap(generation: number): void {
    if (this.pending?.generation === generation) this.drop();
  }

  switchOutput(): void {
    // The routing driver switches outputs.
  }

  sample(): PlaybackSample {
    const sample = this.current.sample();
    if (this.shift === 0) return sample;
    return {
      position: Math.max(0, sample.position - this.shift),
      bufferedPosition: Math.max(0, sample.bufferedPosition - this.shift),
    };
  }

  progress(): ProgressReading {
    const reading = this.current.progress();
    if (this.shift === 0) return reading;
    return {
      ...reading,
      position: Math.max(0, reading.position - this.shift),
      buffered: Math.max(0, reading.buffered - this.shift),
      edge: reading.edge == null ? null : reading.edge - this.shift,
    };
  }

  destroy(): void {
    this.drop();
    this.dropNext();
    this.finishHandover();
    this.current.destroy();
    this.spare?.destroy();
    this.spare = null;
  }

  // ── The switch ──

  private prepare(request: OpenRequest): void {
    this.drop();
    this.finishHandover();
    // The switch takes the spare: the queue's next item opens when its turn comes.
    if (this.next?.onSpare === true) this.next.onSpare = false;
    const spare = (this.spare ??= this.make(this.proxy));
    const position = this.current.sample().position;
    const target =
      request.startPosition != null ? position + LOOKAHEAD_S : null;
    this.pending = {
      generation: request.generation,
      target,
      ready: false,
      timer: null,
      aligner: null,
      fallback: false,
      required: request.required === true,
      jump: null,
      whisper: false,
      clocked: false,
      alignRate: 1,
      startTimer: null,
      reconnects: [0, 0],
      metadata: null,
      metadataAt: 0,
    };
    spare.element.muted = true;
    spare.setRate(this.rate);
    spare.setLoop(this.loop);
    if (this.quality) spare.setQuality(this.quality);
    if (this.tracks) spare.selectTracks(this.tracks.audio, this.tracks.text);
    spare.open({
      ...request,
      swap: false,
      startPosition: target,
      playWhenReady: false,
    });
  }

  /**
   * Forwards both elements' events; the switch's ready starts the
   * rendezvous, and its first frame takes over before the engine hears it.
   */
  private makeProxy(): DriverObserver {
    const f = deafTo(this.observer, () => this.leaving);
    const switching = (generation: number) =>
      this.pending?.generation === generation;
    return {
      onReady: (generation: number, info: ReadyInfo) => {
        f.onReady(generation, info);
        if (switching(generation) && !this.pending!.ready) {
          this.pending!.ready = true;
          this.rendezvous();
        }
      },
      onPlaying: (generation: number) => {
        if (!switching(generation)) f.onPlaying(generation);
        // Lining up: the new element plays muted, and takes over later.
        else if (!this.aligning) this.switched();
        else {
          // Its takeover comes from the aligner.
        }
      },
      onBuffering: (g) => f.onBuffering(g),
      onEnded: (g) => f.onEnded(g),
      onFailed: (g, error) => f.onFailed(g, error),
      onPausedExternally: (g, reason) => f.onPausedExternally(g, reason),
      onStreamMetadata: (g, metadata) => {
        // The new element's, while it lines up: told again once it is heard
        // (unless the old one told a later title since).
        this.told += 1;
        if (switching(g)) {
          this.pending!.metadata = metadata;
          this.pending!.metadataAt = this.told;
        } else if (g === this.generation) {
          this.toldCurrent = this.told;
        } else {
          // A generation already gone: the controller drops it.
        }
        f.onStreamMetadata(g, metadata);
      },
      onDiscontinuity: (g, position, reason, jump) => {
        const shifted =
          g === this.generation ? position - this.shift : position;
        f.onDiscontinuity(g, shifted, reason, jump);
        // Given up already, not taken over yet: its jump was read before this one.
        if (this.pending?.fallback) this.pending.jump = null;
        // Either connection jumped: the two no longer line up.
        if (this.aligning) this.apply(this.pending!.aligner!.interrupt());
      },
      onNote: (g, event, details) => f.onNote(g, event, details),
      // The hidden one's element is not the controller's (AirPlay, the
      // tap): it takes over through the stage.
      onElementReplaced: (element) => {
        if (element !== this.spare?.element) f.onElementReplaced(element);
      },
      // Both elements' streams: the hidden one's tap is ready when it takes over.
      onStreamAudio: (element, audio) => f.onStreamAudio?.(element, audio),
      onVideoInfo: (g, info) => f.onVideoInfo?.(g, info),
      onFirstFrame: (g) => f.onFirstFrame?.(g),
      onVariants: (g, variants) => f.onVariants?.(g, variants),
      onBandwidth: (g, bps) => f.onBandwidth?.(g, bps),
      onTracks: (g, tracks) => f.onTracks?.(g, tracks),
      onSourceCues: (g, cues) => f.onSourceCues?.(g, cues),
      onUserCommand: (g, command, position) =>
        f.onUserCommand?.(g, command, position),
      onLicenseRequest: (g, request) => f.onLicenseRequest?.(g, request),
      onWarning: (g, error) => f.onWarning?.(g, error),
    };
  }

  /** Plays the new file once the picture reaches where it waits. */
  private rendezvous(): void {
    const { pending, spare } = this;
    if (pending == null || spare == null || !pending.ready) return;
    const target = pending.target;
    if (target == null) return this.startAligning(pending, spare);
    const reading = this.current.progress();
    // A stalled picture, or one already past it: no reason to wait.
    if (!reading.isPlaying || reading.position >= target - 0.04) {
      if (reading.position > target + 0.3 && reading.isPlaying) {
        // Too slow to open: try again a little further ahead.
        pending.target = reading.position + LOOKAHEAD_S;
        spare.seek(pending.target, true);
      } else {
        spare.play();
        return;
      }
    }
    pending.timer = browser().setTimeout(() => {
      pending.timer = null;
      this.rendezvous();
    }, RENDEZVOUS_TICK_MS);
  }

  // ── A live switch, lined up ──

  private get aligning(): boolean {
    const pending = this.pending;
    return pending?.aligner != null && !pending.fallback;
  }

  /**
   * Live: a stream RNAP reads (a MediaSource it feeds) is lined up by its
   * edges, an HLS or DASH stream by its program dates. Sources that never
   * can be switch whatever the reason: one on a plain `<audio>` (a station
   * without CORS: a paused element stops loading, and its edge moves in steps
   * of seconds) as a `discontinuity`; HLS or DASH without program dates (or
   * renditions of different kinds) at once, as before.
   */
  private startAligning(pending: Pending, spare: MediaElementDriver): void {
    if (pending.aligner != null) return;
    const old = this.current.alignReading();
    const next = spare.alignReading();
    // hls.js or Shaka without a program date yet (no fragment at its
    // playhead): it comes with the first one, for a while.
    if (
      old?.clock != null &&
      next == null &&
      awaitsClock(spare.liveSources())
    ) {
      pending.clockWaitSince ??= monotonicNow();
      if (monotonicNow() - pending.clockWaitSince < CLOCK_WAIT_MS) {
        pending.timer = browser().setTimeout(() => {
          pending.timer = null;
          if (this.pending === pending) this.startAligning(pending, spare);
        }, Align.TICK_MS);
        return;
      }
    }
    if (
      old == null ||
      next == null ||
      (old.clock == null) !== (next.clock == null)
    ) {
      this.note(pending, 'not aligned', { reason: 'adaptive' });
      spare.play();
      return;
    }
    pending.clocked = next.clock != null;
    if (!pending.clocked && !spare.feedsItself)
      return this.unaligned(pending, spare, 'plain', true);
    const caps: AlignCaps = {
      maxRate: MAX_ALIGN_RATE,
      minRate: 0.5,
      // WebKit pauses a MediaSource element RNAP feeds after a seek; hls.js and Shaka seek it themselves.
      jump: isWebKit() && !pending.clocked ? 'never' : 'always',
      startLead: 0.1,
      jumpLead: 0.3,
    };
    pending.aligner = new LiveAligner(caps);
    pending.reconnects = [old.reconnects, next.reconnects];
    if (whispers(spare.element)) {
      pending.whisper = true;
      spare.setVolume(WHISPER);
      spare.element.muted = false;
    }
    // On a clock: once the library's own handlers have placed its playhead.
    if (!pending.clocked) return this.alignTick();
    pending.timer = browser().setTimeout(() => this.alignTick(), 0);
  }

  private alignTick(): void {
    const pending = this.pending;
    if (pending == null || !this.aligning) return;
    pending.timer = null;
    const old = this.current.alignReading();
    const next = this.spare!.alignReading();
    // An item that changed kind (a fallback to plain playback), or a
    // connection replaced since it started (between two ticks, too): as before.
    const [oldDrops, nextDrops] = pending.reconnects;
    // Fallen back to a plain element mid-way (a codec its MediaSource lacks): as before too.
    const replaced =
      old?.reconnects !== oldDrops ||
      next?.reconnects !== nextDrops ||
      (!pending.clocked && !this.spare!.feedsItself);
    const action: AlignAction =
      old == null || next == null || replaced
        ? pending.aligner!.interrupt()
        : pending.aligner!.step(monotonicNow(), old, next);
    this.apply(action);
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- apply() may end the alignment, which TypeScript does not follow
    if (this.pending === pending && this.aligning)
      pending.timer = browser().setTimeout(
        () => this.alignTick(),
        Align.TICK_MS
      );
  }

  private apply(action: AlignAction): void {
    const pending = this.pending!;
    const spare = this.spare!;
    switch (action.kind) {
      case 'wait':
        return;
      case 'rate':
        return this.run(pending, spare, action.rate, action.afterMs);
      case 'jump':
        return spare.seek(action.to, true);
      case 'takeOver':
        this.note(pending, 'aligned', {
          residual: action.residual.toFixed(3),
          offset: (pending.aligner!.offset ?? 0).toFixed(3),
        });
        return this.switched();
      case 'fallback':
        // The old one stalls: the player needs the switch now.
        if (action.reason === 'stalled') pending.required = true;
        // A connection replaced or jumped: the last gap read is the old mapping's.
        pending.jump = STALE_GAP.has(action.reason)
          ? null
          : pending.aligner!.gap;
        return this.unaligned(pending, spare, action.reason);
    }
  }

  /** Runs the new element at `rate` × the app's (0: holds it), from `afterMs` on. */
  private run(
    pending: Pending,
    spare: MediaElementDriver,
    rate: number,
    afterMs: number | undefined
  ): void {
    pending.alignRate = rate === 0 ? 1 : rate;
    if (rate === 0) return spare.pause();
    spare.setRate(rate * this.rate);
    // Playing already: a rate change only (WebKit refuses a play() it did
    // not need, without the user's activation, and stops).
    if (!spare.element.paused) return;
    if (afterMs == null) return this.playSpare(pending, spare);
    // Due between two ticks: started on time.
    pending.startTimer = browser().setTimeout(() => {
      pending.startTimer = null;
      if (this.pending === pending && this.aligning)
        this.playSpare(pending, spare);
    }, afterMs);
  }

  /** Plays the new element; whispering, a refusal (no user activation yet) mutes it and plays again. */
  private playSpare(pending: Pending, spare: MediaElementDriver): void {
    spare.play();
    if (!pending.whisper) return;
    void spare.lastPlayAttempt?.then((attempt) => {
      if (attempt !== 'blocked' || this.pending !== pending) return;
      if (!pending.whisper) return;
      pending.whisper = false;
      spare.element.muted = true;
      spare.play();
    });
  }

  /**
   * A live switch that cannot be lined up: switched anyway, as a
   * `discontinuity`, when the player needs it (or `always`: a source that
   * never can be); else dropped, the current one playing on
   * (`QUALITY_SWITCH_FAILED`).
   */
  private unaligned(
    pending: Pending,
    spare: MediaElementDriver,
    reason: string,
    always = false
  ): void {
    this.note(pending, 'not aligned', {
      reason,
      ...(pending.aligner?.gap != null
        ? { gap: pending.aligner.gap.toFixed(3) }
        : {}),
    });
    if (!pending.required && !always) {
      // The engine drops it (cancelSwap) and the app hears why.
      this.observer.onFailed(
        pending.generation,
        engineError(
          'QUALITY_SWITCH_FAILED',
          `The live switch could not be lined up with what is heard (${reason}).`,
          true
        )
      );
      return;
    }
    pending.fallback = true;
    pending.alignRate = 1;
    spare.setRate(this.rate);
    // Already playing (it was running to catch up): at once.
    if (spare.progress().isPlaying) return this.switched();
    if (spare.element.paused) this.playSpare(pending, spare);
  }

  private note(
    pending: Pending,
    event: string,
    details: Record<string, string>
  ): void {
    this.observer.onNote(
      pending.generation,
      `quality switch ${event}`,
      details
    );
  }

  /**
   * The new element takes over (its first audio, or lined up): the engine
   * hears its `playing` and its tracks, and a fallback's jump.
   */
  private switched(): void {
    const pending = this.pending!;
    const { generation, fallback } = pending;
    this.takeOver(generation, pending.target == null);
    const f = this.observer;
    f.onPlaying(generation);
    // The engine took the switch's generation: the new file's tracks are the ones now.
    f.onTracks?.(generation, this.current.sourceTracks);
    // A fallback's jump first: the title told next is heard after it.
    if (fallback)
      f.onDiscontinuity(
        generation,
        this.sample().position,
        'switch',
        pending.jump
      );
    // What it reached while it lined up was the pending generation's: told now.
    if (pending.metadata && pending.metadataAt > this.toldCurrent)
      f.onStreamMetadata(generation, pending.metadata);
  }

  /** The new file plays: it is the picture and the sound now. */
  private takeOver(generation: number, live: boolean): void {
    const spare = this.spare!;
    const old = this.current;
    this.clearTimer();
    this.pending = null;
    // Live: the position goes on from where the old one was.
    if (live)
      this.shift =
        spare.sample().position - (old.sample().position - this.shift);
    else this.shift = 0;
    spare.setRate(this.rate);
    spare.element.muted = false;
    spare.setVolume(this.volume);
    this.current = spare;
    const previous = this.generation;
    this.generation = generation;
    this.stage.show(spare.element, old.element);
    if (live) {
      // Muted, not volume 0: iPhone and iPad Safari ignore the volume.
      old.element.muted = true;
      this.leaving = previous;
      this.handover = browser().setTimeout(() => {
        this.handover = null;
        this.leaving = null;
        old.releaseConnection();
        old.element.muted = false;
      }, HANDOVER_MS);
    } else {
      old.releaseConnection();
      old.element.muted = false;
    }
    // The old one waits, emptied, for the next switch. It stays tapped if it
    // was: Web Audio keeps an element for good, and a tapped element must
    // not play a cross-origin file (MediaElementDriver swaps it out first).
    this.spare = old;
  }

  /** Releases a live switch's old element now (the spare is needed again). */
  private finishHandover(): void {
    if (this.handover == null) return;
    browser().clearTimeout(this.handover);
    this.handover = null;
    this.leaving = null;
    this.spare?.releaseConnection();
    if (this.spare) this.spare.element.muted = false;
  }

  private dropNext(): void {
    const next = this.next;
    if (next == null) return;
    this.next = null;
    if (next.onSpare) this.spare?.releaseConnection();
  }

  private drop(): void {
    if (this.pending == null) return;
    this.clearTimer();
    this.pending = null;
    this.spare?.releaseConnection();
  }

  private clearTimer(): void {
    const timer = this.pending?.timer;
    if (timer != null) browser().clearTimeout(timer);
    const start = this.pending?.startTimer;
    if (start != null) browser().clearTimeout(start);
  }
}
