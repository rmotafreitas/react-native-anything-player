// The engine's driver over one <audio> element per player. Twin of the
// ExoPlayer and AVPlayer drivers: it executes engine commands and reports what
// the element does, tagged with the generation of the item that produced it.
//
// One element per player, reused for every item: iOS Safari unlocks playback
// per element (after a play() from a tap), so a fresh element per item would
// be refused again. Listeners are attached per item and detached on the next
// open, so a late event from a replaced item never reaches the engine.
//
// Live HTTP streams go through `MseStream` (fetch + Media Source Extensions)
// for ICY metadata and connection control; everything else, and any stream
// MSE cannot take, plays as the element's own `src`.

import type { PlayerError } from '../../errors';
import type { EngineDriver } from '../engine/PlaybackEngine';
import type {
  StreamMetadata,
  StreamTitleFormat,
} from '../engine/StreamMetadata';
import {
  engineError,
  isNetworkSource,
  type InterruptionReason,
  type OpenRequest,
  type PlaybackSample,
  type ReadyInfo,
  type SourceDescriptor,
} from '../engine/types';
import {
  browser,
  type AbortControllerLike,
  type AudioElementLike,
} from './dom';
import { MseStream, mediaSourceConstructor } from './MseStream';

export interface DriverObserver {
  onReady(generation: number, info: ReadyInfo): void;
  onPlaying(generation: number): void;
  onBuffering(generation: number): void;
  onEnded(generation: number): void;
  onFailed(generation: number, error: PlayerError): void;
  onPausedExternally(generation: number, reason: InterruptionReason): void;
  onStreamMetadata(generation: number, metadata: StreamMetadata): void;
  onDiscontinuity(generation: number, position: number): void;
  onNote(
    generation: number,
    event: string,
    details: Record<string, string>
  ): void;
  /** The element changed (a new one replaced a tapped one); the sampler re-attaches. */
  onElementReplaced(element: AudioElementLike): void;
}

/** What a play() attempt came to: the module rejects `play` on `blocked`. */
export type PlayAttempt = 'started' | 'blocked' | 'failed';

/** Live progress for the module's synchronous `getProgress`. */
export interface ProgressReading {
  position: number;
  duration: number | null;
  buffered: number;
  liveOffset: number | null;
  isPlaying: boolean;
  rate: number;
}

// MediaError codes.
const MEDIA_ERR_ABORTED = 1;
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;

type Timed = { time: number; fire: () => void };

function isHls(uri: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(uri);
}

export class MediaElementDriver implements EngineDriver {
  private _element: AudioElementLike;
  private generation = 0;
  private listeners: AbortControllerLike | null = null;
  private stream: MseStream | null = null;
  private source: SourceDescriptor | null = null;
  /** The current source has played before (in any generation): a later "unsupported" is the server failing. */
  private sourcePlayed = false;
  /** The current source has streamed through fetch: its server allows CORS. */
  private corsProven = false;
  private flowed = false;
  private playRequested = false;
  private expectingPause = false;
  private pendingStart: number | null = null;
  private timed: Timed[] = [];
  private timedTimer: number | null = null;
  /** The element is routed through Web Audio (visualizer): only same-origin audio may play on it. */
  tapped = false;
  /** Set by every play(); the module awaits it to report autoplay refusals. */
  lastPlayAttempt: Promise<PlayAttempt> | null = null;
  private volume = 1;
  private rate = 1;

  constructor(
    private readonly observer: DriverObserver,
    private readonly titleFormat: StreamTitleFormat
  ) {
    this._element = this.createElement();
  }

  get element(): AudioElementLike {
    return this._element;
  }

  /** Whether the current item is read through MSE (its bytes are same-origin to Web Audio). */
  get isStreamed(): boolean {
    return this.stream != null;
  }

  private createElement(): AudioElementLike {
    const element = browser().document!.createElement('audio');
    element.preload = 'auto';
    return element;
  }

  // ── EngineDriver ──

  open(request: OpenRequest): void {
    this.teardownItem();
    this.generation = request.generation;
    if (this.source?.uri !== request.source.uri) {
      this.sourcePlayed = false;
      this.corsProven = false;
    }
    this.source = request.source;
    this.flowed = false;
    this.pendingStart = request.startPosition;
    const media = mediaSourceConstructor();
    const streamable =
      media != null &&
      isNetworkSource(request.source) &&
      request.source.liveHint !== false &&
      !isHls(request.source.uri);
    if (streamable) {
      this.attach();
      this.startStream(request.source, media);
    } else {
      this.playPlain(request.source);
    }
    if (request.playWhenReady) this.play();
  }

  play(): void {
    this.playRequested = true;
    this.expectingPause = false;
    const generation = this.generation;
    let attempt: Promise<void>;
    try {
      attempt = this._element.play();
    } catch (error) {
      attempt = Promise.reject(error);
    }
    this.lastPlayAttempt = attempt.then(
      (): PlayAttempt => 'started',
      (error: { name?: string }): PlayAttempt => {
        // Replaced by a newer item or paused before it started: not a failure.
        if (generation !== this.generation || error?.name === 'AbortError')
          return 'started';
        if (error?.name === 'NotAllowedError') {
          this.observer.onPausedExternally(generation, 'autoplay-blocked');
          return 'blocked';
        }
        return 'failed';
      }
    );
  }

  pause(): void {
    this.playRequested = false;
    if (!this._element.paused) this.expectingPause = true;
    this._element.pause();
  }

  seek(seconds: number): void {
    if (this._element.readyState === 0) {
      this.pendingStart = seconds;
      return;
    }
    this._element.currentTime = seconds;
    this.pumpTimed();
  }

  releaseConnection(): void {
    this.teardownItem();
    this.emptyElement();
  }

  unload(): void {
    this.releaseConnection();
    this.source = null;
    this.sourcePlayed = false;
    this.corsProven = false;
  }

  setVolume(effective: number): void {
    this.volume = Math.min(1, Math.max(0, effective));
    this._element.volume = this.volume;
  }

  setRate(rate: number): void {
    this.rate = rate;
    this._element.playbackRate = rate;
  }

  sample(): PlaybackSample {
    const position = this.position();
    return {
      position,
      bufferedPosition: Math.max(position, this.bufferedEnd(position)),
    };
  }

  // ── Readings ──

  progress(): ProgressReading {
    const position = this.position();
    const duration = this._element.duration;
    return {
      position,
      duration:
        Number.isFinite(duration) && duration > 0 && !this.stream
          ? duration
          : null,
      buffered: Math.max(position, this.bufferedEnd(position)),
      liveOffset: this.stream ? this.stream.bufferedAhead : null,
      isPlaying: !this._element.paused && this.flowed,
      rate: this._element.playbackRate,
    };
  }

  destroy(): void {
    this.teardownItem();
    this.emptyElement();
  }

  // ── Items ──

  private attach(): void {
    const g = browser();
    const listeners = new g.AbortController();
    this.listeners = listeners;
    const generation = this.generation;
    const on = (type: string, handler: () => void) =>
      this._element.addEventListener(type, handler, {
        signal: listeners.signal,
      });
    on('loadedmetadata', () => this.onLoadedMetadata(generation));
    on('playing', () => {
      this.flowed = true;
      this.sourcePlayed = true;
      this.observer.onPlaying(generation);
      this.pumpTimed();
    });
    on('waiting', () => this.observer.onBuffering(generation));
    on('ended', () => this.observer.onEnded(generation));
    on('error', () => this.onError(generation));
    on('pause', () => {
      const expected = this.expectingPause;
      this.expectingPause = false;
      this.clearTimedTimer();
      // Only after audio flowed: loading a new src pauses the element too.
      if (
        !expected &&
        this.playRequested &&
        this.flowed &&
        !this._element.ended
      ) {
        this.playRequested = false;
        this.observer.onPausedExternally(generation, 'system');
      }
    });
    on('timeupdate', () => this.pumpTimed());
    on('seeked', () => this.pumpTimed());
  }

  private playPlain(source: SourceDescriptor): void {
    if (this.tapped && isNetworkSource(source)) {
      // A Web Audio-routed element plays a cross-origin source as silence:
      // continue on a fresh element (the old one stays with the sampler).
      this._element.pause();
      this._element = this.createElement();
      this._element.volume = this.volume;
      this._element.playbackRate = this.rate;
      this.tapped = false;
      this.observer.onElementReplaced(this._element);
    }
    this.attach();
    this._element.src = source.uri;
    this._element.load();
  }

  private startStream(
    source: SourceDescriptor,
    media: NonNullable<ReturnType<typeof mediaSourceConstructor>>
  ): void {
    const generation = this.generation;
    const live = () => generation === this.generation && this.stream === stream;
    const stream: MseStream = new MseStream(
      this._element,
      source,
      media,
      this.titleFormat,
      {
        onStation: (metadata) => {
          if (live()) this.observer.onStreamMetadata(generation, metadata);
        },
        onTimedMetadata: (metadata, time) => {
          if (live())
            this.schedule(time, () =>
              this.observer.onStreamMetadata(generation, metadata)
            );
        },
        onSplice: (time) => {
          if (!live()) return;
          this.observer.onNote(generation, 'connection spliced', {
            at: time.toFixed(2),
          });
          this.schedule(time, () =>
            this.observer.onDiscontinuity(generation, time)
          );
        },
        onFallback: (reason) => {
          if (!live()) return;
          this.observer.onNote(generation, 'plain playback', { reason });
          stream.close();
          this.stream = null;
          this.listeners?.abort();
          this.playPlain(source);
          if (this.playRequested) this.play();
        },
        onFailure: (error) => {
          if (live()) this.observer.onFailed(generation, error);
        },
        onNote: (event, details) => {
          if (live()) this.observer.onNote(generation, event, details);
        },
        onConnected: () => {
          if (live()) this.corsProven = true;
        },
      },
      this.corsProven
    );
    this.stream = stream;
    stream.start();
  }

  private onLoadedMetadata(generation: number): void {
    const element = this._element;
    const duration = element.duration;
    const finite = !this.stream && Number.isFinite(duration) && duration > 0;
    const info: ReadyInfo = finite
      ? { duration, isLive: false, seekable: element.seekable.length > 0 }
      : { duration: null, isLive: true, seekable: false };
    if (finite && this.pendingStart != null && this.pendingStart > 0) {
      element.currentTime = Math.min(this.pendingStart, duration);
    }
    this.pendingStart = null;
    this.observer.onReady(generation, info);
  }

  private onError(generation: number): void {
    const error = this._element.error;
    if (!error || error.code === MEDIA_ERR_ABORTED) return;
    this.observer.onFailed(
      generation,
      this.mapError(error.code, error.message)
    );
  }

  private mapError(code: number, message: string): PlayerError {
    const details = {
      platformDomain: 'MediaError',
      platformCode: code,
      cause: message || undefined,
    };
    const navigator = browser().navigator;
    if (navigator && !navigator.onLine) {
      return engineError(
        'NETWORK_UNAVAILABLE',
        'The device is offline.',
        true,
        details
      );
    }
    if (code === MEDIA_ERR_NETWORK) {
      return engineError(
        'NETWORK_ERROR',
        'A network error interrupted the download.',
        true,
        details
      );
    }
    if (code === MEDIA_ERR_DECODE) {
      return engineError(
        'DECODER_ERROR',
        'The audio could not be decoded.',
        this.flowed,
        details
      );
    }
    // MEDIA_ERR_SRC_NOT_SUPPORTED: browsers also report a refused or missing
    // resource this way. A source that played before is a server failing.
    if (this.sourcePlayed) {
      return engineError(
        'NETWORK_ERROR',
        'The server stopped serving the source.',
        true,
        details
      );
    }
    return engineError(
      'UNSUPPORTED_FORMAT',
      'The browser could not open the source (unsupported format, or the server refused it).',
      false,
      details
    );
  }

  private teardownItem(): void {
    this.listeners?.abort();
    this.listeners = null;
    this.stream?.close();
    this.stream = null;
    this.timed = [];
    this.clearTimedTimer();
    this.playRequested = false;
    this.expectingPause = false;
  }

  private emptyElement(): void {
    this._element.pause();
    this._element.removeAttribute('src');
    this._element.load();
  }

  private position(): number {
    const t = this._element.currentTime;
    return Number.isFinite(t) && t >= 0 ? t : 0;
  }

  private bufferedEnd(position: number): number {
    const ranges = this._element.buffered;
    for (let i = 0; i < ranges.length; i++) {
      if (ranges.start(i) <= position + 0.1 && ranges.end(i) >= position)
        return ranges.end(i);
    }
    return position;
  }

  // ── Timed delivery (metadata and splices, when heard) ──

  private schedule(time: number, fire: () => void): void {
    this.timed.push({ time, fire });
    this.timed.sort((a, b) => a.time - b.time);
    this.pumpTimed();
  }

  private pumpTimed(): void {
    this.clearTimedTimer();
    const now = this.position();
    while (this.timed.length > 0 && this.timed[0]!.time <= now)
      this.timed.shift()!.fire();
    const next = this.timed[0];
    if (!next || this._element.paused) return;
    const rate = this._element.playbackRate || 1;
    // Strictly when heard (never early). timeupdate fires every ~250 ms; a
    // timer lands it on time, re-armed if the audio clock is still short.
    this.timedTimer = browser().setTimeout(
      () => this.pumpTimed(),
      Math.max(10, ((next.time - now) / rate) * 1000)
    );
  }

  private clearTimedTimer(): void {
    if (this.timedTimer !== null) browser().clearTimeout(this.timedTimer);
    this.timedTimer = null;
  }
}
