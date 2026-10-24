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
// for ICY metadata and connection control. HLS goes to hls.js where the
// browser cannot play it itself (`HlsStream`). Everything else, and any stream
// MSE cannot take, plays as the element's own `src`.

import type { PlayerError } from '../../errors';
import {
  hlsConstructor,
  onHlsConfigured,
  type HlsConstructor,
} from '../../core/hls';
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
  type QualityConstraints,
  type ReadyInfo,
  type SourceDescriptor,
  type VideoInfo,
  type VideoVariant,
} from '../engine/types';
import {
  browser,
  type AbortControllerLike,
  type AudioElementLike,
  type VideoElementLike,
} from './dom';
import { HLS_HINT, HLS_MISSING, isHlsType, isHlsUri } from './hlsFormats';
import type { HlsStream } from './HlsStream';
import { MediaTracks } from './MediaTracks';
import { MseStream, mediaSourceConstructor } from './MseStream';
import type { MediaTrack } from '../../core/subtitles/tracks';
import type { SubtitleCue } from '../../core/subtitles/types';

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
  /** Video: the picture's size (and the variant playing). */
  onVideoInfo?(generation: number, info: VideoInfo): void;
  /** Video: the first frame was shown. */
  onFirstFrame?(generation: number): void;
  /** Video: an adaptive source's variants. */
  onVariants?(generation: number, variants: VideoVariant[]): void;
  /** Video: a bandwidth estimate, bits per second. */
  onBandwidth?(generation: number, bitsPerSecond: number): void;
  /** Video: the source's own audio and text tracks. */
  onTracks?(generation: number, tracks: MediaTrack[]): void;
  /** Video: the cues of the source's text track on screen now. */
  onSourceCues?(generation: number, cues: SubtitleCue[]): void;
}

/** What the driver plays: sound alone, or a picture too. */
export type MediaKind = 'audio' | 'video';

/** How often a bandwidth estimate is read from the Network Information API. */
const DOWNLINK_EVERY_MS = 2000;

type HlsParts = typeof import('./HlsStream');

/** The hls.js glue, once loaded (it is only needed with hls.js). */
let hlsParts: HlsParts | null = null;
let hlsLoading: Promise<HlsParts | null> | null = null;

/** Loads the hls.js glue once; a failed load is tried again next time. */
function loadHlsParts(): Promise<HlsParts | null> {
  hlsLoading ??= import('./HlsStream').then(
    (parts) => (hlsParts = parts),
    () => {
      hlsLoading = null;
      return null;
    }
  );
  return hlsLoading;
}

// Registering hls.js (configureHls) loads the glue ahead of playback, so an
// HLS source normally starts synchronously, inside the play() that asked for
// it: within the tap's user activation, and with AUTOPLAY_BLOCKED reported to
// that command.
onHlsConfigured(() => {
  loadHlsParts().catch(() => undefined);
});

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
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

type Timed = { time: number; fire: () => void };

/** A source whose bytes the page itself holds (a picked file). */
const LOCAL_URI = /^(blob|data):/i;

/** A network source that may be a live stream (not HLS, not marked a file): read through MSE. */
function mayStream(source: SourceDescriptor): boolean {
  if (!isNetworkSource(source) || source.liveHint === false) return false;
  return !isHlsUri(source.uri);
}

/** What `canPlayType` answers for HLS in browsers that play it natively (Safari, Android). */
const HLS_MIME = 'application/vnd.apple.mpegurl';

export class MediaElementDriver implements EngineDriver {
  private _element: AudioElementLike;
  private generation = 0;
  private listeners: AbortControllerLike | null = null;
  private stream: MseStream | null = null;
  private hls: HlsStream | null = null;
  /** The HLS part is loading (the module, then hls.js): `play()` waits for it. */
  private hlsPending = false;
  /** Items torn down so far: a loading HLS part knows whether its item is gone. */
  private itemSerial = 0;
  /** The element is playing an HLS playlist itself: hls.js is the way out if it cannot. */
  private nativeHls = false;
  /** The element's own HLS could not open the current source: hls.js plays it from now on. */
  private nativeHlsFailed = false;
  private source: SourceDescriptor | null = null;
  /** The current source has played before (in any generation): a later "unsupported" is the server failing. */
  private sourcePlayed = false;
  /** The current source has streamed through fetch: its server allows CORS. */
  private corsProven = false;
  /** The engine allows reconnecting (`OpenRequest.allowReconnect`): a dropped stream may be spliced. */
  private allowReconnect = true;
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
  /** Counts play() calls, so a refusal of a replaced one is told from the current one. */
  private playToken = 0;
  private volume = 1;
  private rate = 1;
  private loop = false;
  private quality: QualityConstraints | null = null;
  private variantId: string | null = null;
  private downlinkAt = 0;
  /** Video: the current item's own tracks, and the engine's picks among them. */
  private tracks: MediaTracks | null = null;
  private chosenTracks: { audio: string | null; text: string | null } | null =
    null;
  /** The source's tracks so far: a quality switch's new file reports them again. */
  sourceTracks: MediaTrack[] = [];

  constructor(
    private readonly observer: DriverObserver,
    private readonly titleFormat: StreamTitleFormat,
    readonly kind: MediaKind = 'audio'
  ) {
    this._element = this.createElement();
  }

  get element(): AudioElementLike {
    return this._element;
  }

  /** The `<video>` of a video driver (`null` for audio). */
  get videoElement(): VideoElementLike | null {
    return this.kind === 'video' ? (this._element as VideoElementLike) : null;
  }

  /**
   * Whether the current item plays from bytes the page holds (a MediaSource
   * fed by RNAP or hls.js, or a picked file's `blob:` URL): same-origin to Web
   * Audio, and out of a Remote Playback receiver's reach.
   */
  get isStreamed(): boolean {
    return (
      this.stream != null ||
      this.hls != null ||
      this.hlsPending ||
      LOCAL_URI.test(this.source?.uri ?? '')
    );
  }

  /** Whether the current item is live (read through MSE, or an HLS playlist without an end). */
  private get isLive(): boolean {
    return this.stream != null || this.hls?.live === true;
  }

  private createElement(): AudioElementLike {
    const document = browser().document!;
    if (this.kind === 'video') {
      const video = document.createElement('video');
      video.preload = 'auto';
      video.playsInline = true;
      // iPhone Safari before `playsInline` was a property.
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.loop = this.loop;
      Object.assign(video.style, {
        width: '100%',
        height: '100%',
        display: 'block',
        objectFit: 'contain',
        backgroundColor: 'black',
      });
      return video;
    }
    const element = document.createElement('audio');
    element.preload = 'auto';
    return element;
  }

  // ── EngineDriver ──

  open(request: OpenRequest): void {
    // hls.js from a <script> tag (globalThis.Hls) was never registered.
    if (hlsConstructor()) loadHlsParts().catch(() => undefined);
    this.teardownItem();
    // A previous stream that needed headers kept this element off AirPlay.
    if (this._element.disableRemotePlayback)
      this._element.disableRemotePlayback = false;
    this.generation = request.generation;
    if (this.source?.uri !== request.source.uri) {
      this.sourcePlayed = false;
      this.corsProven = false;
      this.nativeHlsFailed = false;
    }
    this.source = request.source;
    this.allowReconnect = request.allowReconnect;
    this.flowed = false;
    this.pendingStart = request.startPosition;
    this.variantId = null;
    const media = mediaSourceConstructor();
    // ICY over MSE is audio's: a video plays on the element (or hls.js).
    const streamable =
      this.kind === 'audio' && media != null && mayStream(request.source);
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
    // hls.js is still loading: the element has no source to play yet. The
    // request is kept and runs when the stream starts (see loadHls), so the
    // play() is not lost and the element is not asked twice.
    if (this.hlsPending) return;
    const generation = this.generation;
    this.playToken += 1;
    const token = this.playToken;
    // An async body runs synchronously up to its first await: play() is still
    // called here, and a synchronous throw becomes a rejection.
    const attempt = (async () => this._element.play())();
    this.lastPlayAttempt = attempt.then(
      (): PlayAttempt => 'started',
      (error: { name?: string }): PlayAttempt => {
        // Replaced by a newer item or paused before it started: not a failure.
        // A newer play() took over: its outcome is the one that counts.
        if (
          generation !== this.generation ||
          token !== this.playToken ||
          error?.name === 'AbortError'
        )
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

  seek(seconds: number, exact = false): void {
    if (this._element.readyState === 0) {
      this.pendingStart = seconds;
      return;
    }
    const video = this.videoElement;
    // A scrub lands on the nearest keyframe (fast); `exact` on the frame.
    if (!exact && video?.fastSeek) video.fastSeek(seconds);
    else this._element.currentTime = seconds;
    this.pumpTimed();
  }

  setLoop(loop: boolean): void {
    this.loop = loop;
    const video = this.videoElement;
    if (video) video.loop = loop;
  }

  setVideoEnabled(): void {
    // A browser decodes what the element plays: audio-only variants save the data.
  }

  setQuality(constraints: QualityConstraints): void {
    this.quality = constraints;
    this.hls?.setQuality(constraints);
  }

  selectTracks(audio: string | null, text: string | null): void {
    this.chosenTracks = { audio, text };
    this.tracks?.select(audio, text);
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
    this.nativeHlsFailed = false;
  }

  setVolume(effective: number): void {
    this.volume = Math.min(1, Math.max(0, effective));
    this._element.volume = this.volume;
  }

  setRate(rate: number): void {
    this.rate = rate;
    this._element.playbackRate = rate;
  }

  switchOutput(): void {
    // The element is the local output; the routing driver switches outputs.
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
        Number.isFinite(duration) && duration > 0 && !this.isLive
          ? duration
          : null,
      buffered: Math.max(position, this.bufferedEnd(position)),
      liveOffset: this.liveOffset(),
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
    if (this.kind === 'video') this.attachVideo(generation, on);
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

  /** The picture's size, the first frame, and a coarse bandwidth for files. */
  private attachVideo(
    generation: number,
    on: (type: string, handler: () => void) => void
  ): void {
    const video = this._element as VideoElementLike;
    const info = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0)
        this.observer.onVideoInfo?.(generation, {
          width: video.videoWidth,
          height: video.videoHeight,
          hdr: false,
          variantId: this.variantId,
        });
    };
    on('loadedmetadata', info);
    on('resize', info);
    on('loadeddata', () => {
      const frame = () => {
        if (generation === this.generation)
          this.observer.onFirstFrame?.(generation);
      };
      if (video.requestVideoFrameCallback)
        video.requestVideoFrameCallback(frame);
      else frame();
    });
    on('progress', () => this.readDownlink(generation));
    // The source's own tracks: the element's lists, or hls.js's once it runs.
    this.sourceTracks = [];
    const tracks = new MediaTracks(video, {
      onTracks: (list) => {
        if (generation !== this.generation) return;
        this.sourceTracks = list;
        this.observer.onTracks?.(generation, list);
      },
      onCues: (cues) => {
        if (generation === this.generation)
          this.observer.onSourceCues?.(generation, cues);
      },
    });
    this.tracks = tracks;
    if (this.chosenTracks)
      tracks.select(this.chosenTracks.audio, this.chosenTracks.text);
  }

  /** Chromium's Network Information estimate, for files (hls.js has its own). */
  private readDownlink(generation: number): void {
    if (this.hls != null) return;
    const now = Date.now();
    if (now - this.downlinkAt < DOWNLINK_EVERY_MS) return;
    this.downlinkAt = now;
    const mbps = browser().navigator?.connection?.downlink;
    if (mbps != null && Number.isFinite(mbps) && mbps > 0)
      this.observer.onBandwidth?.(generation, mbps * 1_000_000);
  }

  private liveOffset(): number | null {
    if (this.stream) return this.stream.bufferedAhead;
    return this.hls?.live ? this.hls.liveOffset : null;
  }

  /** Whether hls.js has to play this: an HLS source on an element that cannot. */
  private needsHls(source: SourceDescriptor, contentType: string | null) {
    const hls = isHlsUri(source.uri) || isHlsType(contentType);
    if (!hls) return false;
    if (this.nativeHlsFailed || this._element.canPlayType(HLS_MIME) === '')
      return true;
    // A video: a native HLS without track lists (Chromium's) has no
    // qualities, caps, audio groups or subtitles to pick from; hls.js has
    // them, where there is one. Safari's own HLS lists its tracks: it stays.
    const video = this.videoElement;
    return (
      video != null &&
      video.audioTracks === undefined &&
      hlsConstructor()?.isSupported() === true
    );
  }

  /**
   * Plays on the element itself. `contentType`: the response's, when a read
   * through MSE found it was an HLS playlist.
   */
  private playPlain(
    source: SourceDescriptor,
    contentType: string | null = null
  ): void {
    const hls = this.needsHls(source, contentType);
    this.nativeHls = !hls && (isHlsUri(source.uri) || isHlsType(contentType));
    // hls.js feeds the element from a MediaSource: the audio is same-origin.
    if (this.tapped && isNetworkSource(source) && !hls) {
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
    if (hls) {
      // The hls.js glue is fetched first: stop what the element had while it
      // loads (hls.js replaces the source once it is there).
      if (this._element.src !== '') {
        this._element.removeAttribute('src');
        this._element.load();
      }
      this.startHls(source);
      return;
    }
    this._element.src = source.uri;
    this._element.load();
  }

  /**
   * A browser may say it plays HLS and still fail on a playlist (Chrome's
   * native HLS takes fewer streams than hls.js does): before anything played,
   * the same item is tried with hls.js, if there is one.
   */
  private retryWithHls(generation: number): boolean {
    const source = this.source;
    if (!this.nativeHls || this.sourcePlayed || !source) return false;
    if (!hlsConstructor()?.isSupported()) return false;
    this.nativeHls = false;
    // Later opens of this source (reconnects) go to hls.js directly.
    this.nativeHlsFailed = true;
    this.listeners?.abort();
    this._element.removeAttribute('src');
    this._element.load();
    this.observer.onNote(generation, 'hls.js', {
      reason: 'native HLS could not open the source',
    });
    this.attach();
    this.startHls(source);
    // Loading the element anew dropped the play() that was pending.
    if (this.playRequested) this.play();
    return true;
  }

  private startHls(source: SourceDescriptor): void {
    const generation = this.generation;
    const ctor = hlsConstructor();
    if (!ctor?.isSupported()) {
      const message = ctor
        ? 'hls.js is not supported in this browser (it needs Media Source Extensions).'
        : HLS_MISSING;
      this.failHls(generation, message, false);
      return;
    }
    if (hlsParts) {
      this.startHlsSafely(source, generation, ctor, hlsParts);
      return;
    }
    // Opened right after hls.js was registered (or hls.js came from a
    // <script> tag): the glue is still loading.
    this.hlsPending = true;
    this.loadHls(source, generation, ctor, this.itemSerial);
  }

  /**
   * Loads the hls.js glue (its module first, then hls.js itself) and starts
   * it. A newer open, a stop or a release may have happened meanwhile: then
   * the item it was for is gone and no stream is made for it.
   */
  private async loadHls(
    source: SourceDescriptor,
    generation: number,
    ctor: HlsConstructor,
    item: number
  ): Promise<void> {
    const parts = await loadHlsParts();
    if (
      generation !== this.generation ||
      item !== this.itemSerial ||
      source !== this.source
    )
      return;
    this.hlsPending = false;
    if (!parts) {
      this.failHls(
        generation,
        'The hls.js glue code did not load. Check the connection and try again.',
        true
      );
      return;
    }
    this.startHlsSafely(source, generation, ctor, parts);
    // Asked to play while it loaded, before hls.js could attach the element.
    if (this.hls && this.playRequested) this.play();
  }

  private startHlsSafely(
    source: SourceDescriptor,
    generation: number,
    ctor: HlsConstructor,
    parts: HlsParts
  ): void {
    try {
      this.startHlsStream(source, generation, ctor, parts);
    } catch (error) {
      // A constructor or attach that throws (an extension of hls.js, say):
      // reported like a glue that did not load, so the engine's recovery runs.
      this.hls?.close();
      this.hls = null;
      this.failHls(
        generation,
        `hls.js could not start the stream (${String(error)}).`,
        true
      );
    }
  }

  private startHlsStream(
    source: SourceDescriptor,
    generation: number,
    ctor: HlsConstructor,
    parts: HlsParts
  ): void {
    const live = () => generation === this.generation && this.hls === hls;
    const hls: HlsStream = new parts.HlsStream(this._element, source, ctor, {
      onMetadata: (metadata, time) => {
        if (live())
          this.schedule(time, () =>
            this.observer.onStreamMetadata(generation, metadata)
          );
      },
      onFailure: (error) => {
        if (live()) this.observer.onFailed(generation, error);
      },
      onNote: (event, details) => {
        if (live()) this.observer.onNote(generation, event, details);
      },
      onVariants: (variants) => {
        if (live()) this.observer.onVariants?.(generation, variants);
      },
      onVariantSwitched: (id) => {
        if (!live()) return;
        this.variantId = id;
        const video = this.videoElement;
        if (video && video.videoWidth > 0)
          this.observer.onVideoInfo?.(generation, {
            width: video.videoWidth,
            height: video.videoHeight,
            hdr: false,
            variantId: id,
          });
      },
      onBandwidth: (bps) => {
        if (live()) this.observer.onBandwidth?.(generation, bps);
      },
      onTracks: () => {
        if (live()) this.tracks?.useHls(hls);
      },
    });
    this.hls = hls;
    this.observer.onNote(generation, 'hls.js', { reason: 'no native HLS' });
    hls.start();
    if (this.quality) hls.setQuality(this.quality);
  }

  /** Reports an HLS failure from a microtask: not from inside open(). */
  private failHls(
    generation: number,
    message: string,
    recoverable: boolean
  ): void {
    browser().queueMicrotask(() => {
      if (generation !== this.generation) return;
      this.observer.onFailed(
        generation,
        engineError('UNSUPPORTED_FORMAT', message, recoverable)
      );
    });
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
        onFallback: (reason, contentType) => {
          if (!live()) return;
          this.observer.onNote(generation, 'plain playback', { reason });
          stream.close();
          this.stream = null;
          this.listeners?.abort();
          this.playPlain(source, contentType ?? null);
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
      this.corsProven,
      this.allowReconnect
    );
    this.stream = stream;
    stream.start();
  }

  private onLoadedMetadata(generation: number): void {
    const element = this._element;
    // An HLS playlist says whether it is live (the element's duration alone
    // cannot, before the first segments); everything else is the element's.
    const info = this.hls?.readyInfo() ?? this.elementReadyInfo();
    if (
      info.duration != null &&
      this.pendingStart != null &&
      this.pendingStart > 0
    ) {
      element.currentTime = Math.min(this.pendingStart, info.duration);
    }
    this.pendingStart = null;
    this.observer.onReady(generation, info);
  }

  private elementReadyInfo(): ReadyInfo {
    const element = this._element;
    const duration = element.duration;
    const finite = !this.stream && Number.isFinite(duration) && duration > 0;
    return finite
      ? { duration, isLive: false, seekable: element.seekable.length > 0 }
      : { duration: null, isLive: true, seekable: false };
  }

  private onError(generation: number): void {
    const error = this._element.error;
    if (!error || error.code === MEDIA_ERR_ABORTED) return;
    // hls.js already reported the failure that stopped the element.
    if (this.hls?.failed) return;
    if (
      error.code === MEDIA_ERR_SRC_NOT_SUPPORTED &&
      this.retryWithHls(generation)
    )
      return;
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
      'The browser could not open the source (unsupported format, or the server refused it).' +
        (this.nativeHls ? HLS_HINT : ''),
      false,
      details
    );
  }

  private teardownItem(): void {
    this.listeners?.abort();
    this.listeners = null;
    this.tracks?.close();
    this.tracks = null;
    this.stream?.close();
    this.stream = null;
    this.hls?.close();
    this.hls = null;
    this.hlsPending = false;
    this.itemSerial += 1;
    this.nativeHls = false;
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
