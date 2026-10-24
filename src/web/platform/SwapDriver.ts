// A video player's local output: the `<video>` on screen, and a second one
// that prepares a quality switch behind it (`open({ swap: true })`, separate
// files of one video). The second one opens a little ahead of the picture,
// muted, waits until the picture reaches that point, plays, and takes over on
// its first frame: no spinner, no jump. The engine then makes its generation
// the current one (twin behaviour: the second AVPlayer / ExoPlayer natively).

import type { EngineDriver } from '../engine/PlaybackEngine';
import type {
  OpenRequest,
  PlaybackSample,
  QualityConstraints,
  ReadyInfo,
} from '../engine/types';
import { browser, type AudioElementLike } from './dom';
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
  progress(): ProgressReading;
  destroy(): void;
}

/** Shows one element of the stage and hides the other. */
export interface SwapStage {
  show(element: AudioElementLike, hidden: AudioElementLike | null): void;
}

/** How far ahead of the picture the new file opens, seconds. */
const LOOKAHEAD_S = 1.5;
/** How often the rendezvous checks the picture's position. */
const RENDEZVOUS_TICK_MS = 40;

interface Pending {
  generation: number;
  /** The media time the new file waits at (`null`: live, start at once). */
  target: number | null;
  ready: boolean;
  timer: number | null;
}

export class SwapDriver implements LocalDriver {
  private current: MediaElementDriver;
  private spare: MediaElementDriver | null = null;
  private pending: Pending | null = null;
  private volume = 1;
  private rate = 1;
  private loop = false;
  private quality: QualityConstraints | null = null;
  /** The engine's track picks: a switch's file plays the same ones. */
  private tracks: { audio: string | null; text: string | null } | null = null;
  /** What both elements report to: the switch's events are intercepted here. */
  private readonly proxy: DriverObserver;

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
    this.current.open(request);
  }

  play(): void {
    this.current.play();
  }

  pause(): void {
    this.current.pause();
  }

  seek(seconds: number, exact = false): void {
    this.current.seek(seconds, exact);
  }

  releaseConnection(): void {
    this.drop();
    this.current.releaseConnection();
  }

  unload(): void {
    this.drop();
    this.current.unload();
  }

  setVolume(effective: number): void {
    this.volume = effective;
    this.current.setVolume(effective);
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.current.setRate(rate);
    this.spare?.setRate(rate);
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
    return this.current.sample();
  }

  progress(): ProgressReading {
    return this.current.progress();
  }

  destroy(): void {
    this.drop();
    this.current.destroy();
    this.spare?.destroy();
    this.spare = null;
  }

  // ── The switch ──

  private prepare(request: OpenRequest): void {
    this.drop();
    const spare = (this.spare ??= this.make(this.proxy));
    const position = this.current.sample().position;
    const target =
      request.startPosition != null ? position + LOOKAHEAD_S : null;
    this.pending = {
      generation: request.generation,
      target,
      ready: false,
      timer: null,
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
    const f = this.observer;
    const switching = (generation: number) =>
      this.pending?.generation === generation;
    return {
      onReady: (generation: number, info: ReadyInfo) => {
        f.onReady(generation, info);
        if (switching(generation)) {
          this.pending!.ready = true;
          this.rendezvous();
        }
      },
      onPlaying: (generation: number) => {
        const switched = switching(generation);
        if (switched) this.takeOver();
        f.onPlaying(generation);
        // The engine took the switch's generation: the new file's tracks are the ones now.
        if (switched) f.onTracks?.(generation, this.current.sourceTracks);
      },
      onBuffering: (g) => f.onBuffering(g),
      onEnded: (g) => f.onEnded(g),
      onFailed: (g, error) => f.onFailed(g, error),
      onPausedExternally: (g, reason) => f.onPausedExternally(g, reason),
      onStreamMetadata: (g, metadata) => f.onStreamMetadata(g, metadata),
      onDiscontinuity: (g, position) => f.onDiscontinuity(g, position),
      onNote: (g, event, details) => f.onNote(g, event, details),
      onElementReplaced: (element) => f.onElementReplaced(element),
      onVideoInfo: (g, info) => f.onVideoInfo?.(g, info),
      onFirstFrame: (g) => f.onFirstFrame?.(g),
      onVariants: (g, variants) => f.onVariants?.(g, variants),
      onBandwidth: (g, bps) => f.onBandwidth?.(g, bps),
      onTracks: (g, tracks) => f.onTracks?.(g, tracks),
      onSourceCues: (g, cues) => f.onSourceCues?.(g, cues),
    };
  }

  /** Plays the new file once the picture reaches where it waits. */
  private rendezvous(): void {
    const { pending, spare } = this;
    if (pending == null || spare == null || !pending.ready) return;
    const reading = this.current.progress();
    const target = pending.target;
    // Live, a stalled picture, or one already past it: no reason to wait.
    if (
      target == null ||
      !reading.isPlaying ||
      reading.position >= target - 0.04
    ) {
      if (
        target != null &&
        reading.position > target + 0.3 &&
        reading.isPlaying
      ) {
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

  /** The new file shows its first frame: it is the picture and the sound now. */
  private takeOver(): void {
    const spare = this.spare!;
    const old = this.current;
    this.clearTimer();
    this.pending = null;
    spare.element.muted = false;
    spare.setVolume(this.volume);
    this.stage.show(spare.element, old.element);
    old.releaseConnection();
    old.element.muted = false;
    this.current = spare;
    // The old one waits, emptied, for the next switch.
    this.spare = old;
    this.spare.tapped = false;
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
  }
}
