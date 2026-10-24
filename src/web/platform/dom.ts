// The browser APIs the web engine uses, typed locally. The library is compiled
// without the DOM lib (React Native's global types conflict with it), and
// local types keep the published declarations neutral for every consumer.
// Read through `browser()` lazily: importing must not touch `window` (SSR).

export interface AbortSignalLike {
  readonly aborted: boolean;
}

export interface AbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(): void;
}

export interface EventTargetLike {
  addEventListener(
    type: string,
    listener: (event: any) => void,
    options?: { signal?: AbortSignalLike }
  ): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

export interface TimeRangesLike {
  readonly length: number;
  start(index: number): number;
  end(index: number): number;
}

export interface MediaErrorLike {
  readonly code: number;
  readonly message: string;
}

/** A `<source>` child of a media element. */
export interface SourceElementLike {
  src: string;
  type: string;
  remove(): void;
}

/** The Remote Playback API (Chrome): send an element's media to a receiver. */
export interface RemotePlaybackLike extends EventTargetLike {
  readonly state: string;
  prompt(): Promise<void>;
  watchAvailability(callback: (available: boolean) => void): Promise<number>;
  cancelWatchAvailability(id?: number): Promise<void>;
}

export interface AudioElementLike extends EventTargetLike {
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  preload: string;
  crossOrigin: string | null;
  disableRemotePlayback?: boolean;
  /** Safari: whether the element plays to an AirPlay receiver. */
  readonly webkitCurrentPlaybackTargetIsWireless?: boolean;
  /** Safari: opens the AirPlay picker (inside a user gesture). */
  webkitShowPlaybackTargetPicker?(): void;
  readonly remote?: RemotePlaybackLike;
  readonly buffered: TimeRangesLike;
  readonly seekable: TimeRangesLike;
  readonly error: MediaErrorLike | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  /** `''` when the browser cannot play the MIME type (`'maybe'` / `'probably'` otherwise). */
  canPlayType(type: string): string;
  removeAttribute(name: string): void;
  appendChild(child: SourceElementLike): void;
}

/** What every element RNAP styles has. */
export interface BoxLike {
  readonly style: Record<string, string>;
  className: string;
  readonly parentNode: { removeChild(child: unknown): unknown } | null;
  setAttribute(name: string, value: string): void;
  requestFullscreen?(): Promise<void>;
  webkitRequestFullscreen?(): void;
}

/** A styled box: the video stage, the subtitle overlay and its lines. */
export interface ElementLike extends EventTargetLike, BoxLike {
  textContent: string | null;
  appendChild(child: unknown): unknown;
  removeChild(child: unknown): unknown;
  replaceChildren?(...children: unknown[]): void;
}

/** A `<video>`: an audio element with a picture. */
export interface VideoElementLike extends AudioElementLike, BoxLike {
  readonly videoWidth: number;
  readonly videoHeight: number;
  poster: string;
  loop: boolean;
  playsInline: boolean;
  /** The browser's own controls. */
  controls: boolean;
  requestPictureInPicture?(): Promise<unknown>;
  /** Safari's Picture in Picture and fullscreen. */
  webkitSupportsPresentationMode?(mode: string): boolean;
  webkitSetPresentationMode?(mode: string): void;
  readonly webkitPresentationMode?: string;
  /** iPhone Safari's only fullscreen: the native player. */
  webkitEnterFullscreen?(): void;
  webkitExitFullscreen?(): void;
  requestVideoFrameCallback?(callback: () => void): number;
  getVideoPlaybackQuality?(): { droppedVideoFrames: number };
  fastSeek?(time: number): void;
  /** The source's own text tracks (in-band, Safari's HLS, hls.js's). */
  readonly textTracks?: TrackListLike<TextTrackLike>;
  /** The source's own audio tracks (Safari). */
  readonly audioTracks?: TrackListLike<AudioTrackLike>;
}

/** `TextTrackList` / `AudioTrackList`: `addtrack`, `removetrack`, `change`. */
export interface TrackListLike<T> extends EventTargetLike {
  readonly length: number;
  readonly [index: number]: T;
}

/** A `TextTrack`: subtitles or captions (also `metadata`, which RNAP skips). */
export interface TextTrackLike extends EventTargetLike {
  readonly kind: string;
  readonly label: string;
  readonly language: string;
  /** `disabled`, `hidden` (cues, no rendering: RNAP's overlay draws them) or `showing`. */
  mode: string;
  readonly activeCues: {
    readonly length: number;
    readonly [index: number]: VttCueLike;
  } | null;
}

/** A `VTTCue` (or a plain `TextTrackCue`, which has only times). */
export interface VttCueLike {
  readonly startTime: number;
  readonly endTime: number;
  readonly text?: string;
  readonly line?: number | string;
  readonly snapToLines?: boolean;
  readonly lineAlign?: string;
  readonly position?: number | string;
  readonly align?: string;
}

/** An `AudioTrack` (Safari). */
export interface AudioTrackLike {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly language: string;
  enabled: boolean;
}

/** `IntersectionObserver` / `ResizeObserver`: the view's visibility and size. */
export interface ObserverLike {
  observe(target: unknown): void;
  disconnect(): void;
}

export interface IntersectionEntryLike {
  readonly isIntersecting: boolean;
  readonly intersectionRatio: number;
}

export interface ResizeEntryLike {
  readonly contentRect: { readonly width: number; readonly height: number };
}

export interface WakeLockSentinelLike {
  release(): Promise<void>;
}

export interface SourceBufferLike extends EventTargetLike {
  mode: string;
  readonly updating: boolean;
  readonly buffered: TimeRangesLike;
  appendBuffer(data: Uint8Array): void;
  remove(start: number, end: number): void;
  abort(): void;
}

export interface MediaSourceLike extends EventTargetLike {
  readonly readyState: string;
  duration: number;
  addSourceBuffer(type: string): SourceBufferLike;
  endOfStream(): void;
}

export interface MediaSourceConstructor {
  new (): MediaSourceLike;
  isTypeSupported(type: string): boolean;
}

export interface HeadersLike {
  get(name: string): string | null;
}

export interface ReaderLike {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
}

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: HeadersLike;
  readonly body: { getReader(): ReaderLike } | null;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export type MediaSessionAction =
  | 'play'
  | 'pause'
  | 'stop'
  | 'seekto'
  | 'seekforward'
  | 'seekbackward'
  | 'previoustrack'
  | 'nexttrack';

export interface MediaSessionActionDetails {
  seekTime?: number;
  seekOffset?: number;
}

export interface MediaSessionLike {
  metadata: unknown;
  playbackState: 'none' | 'paused' | 'playing';
  setActionHandler(
    action: MediaSessionAction,
    handler: ((details: MediaSessionActionDetails) => void) | null
  ): void;
  setPositionState?(state?: {
    duration: number;
    position: number;
    playbackRate: number;
  }): void;
}

export interface AnalyserLike {
  fftSize: number;
  getFloatTimeDomainData(target: Float32Array): void;
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface AudioContextLike {
  readonly state: string;
  readonly sampleRate: number;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaElementSource(element: AudioElementLike): {
    connect(node: unknown): void;
    disconnect(): void;
  };
  createAnalyser(): AnalyserLike;
}

/** A Cast receiver, as the sender SDK describes it. */
export interface CastReceiverLike {
  readonly friendlyName: string;
  readonly label?: string;
  readonly deviceId?: string;
}

export interface CastMediaLike {
  readonly idleReason?: string | null;
  supportsCommand(command: string): boolean;
  /** Turns the receiver's text tracks on and off (`EditTracksInfoRequest`). */
  editTracksInfo?(
    request: unknown,
    onSuccess: () => void,
    onError: (error: unknown) => void
  ): void;
  setVolume(
    request: unknown,
    onSuccess: () => void,
    onError: (error: unknown) => void
  ): void;
}

export interface CastSessionLike {
  getCastDevice(): CastReceiverLike | null;
  getMediaSession(): CastMediaLike | null;
  /** Resolves `undefined` on success; an error code (resolved or rejected) on failure. */
  loadMedia(request: unknown): Promise<string | undefined>;
}

export interface CastContextLike {
  setOptions(options: Record<string, unknown>): void;
  getCastState(): string;
  getCurrentSession(): CastSessionLike | null;
  addEventListener(type: string, listener: (event: any) => void): void;
  /** Resolves `undefined` once a session starts, else an error code (`'cancel'` when dismissed). */
  requestSession(): Promise<string | undefined>;
  endCurrentSession(stopCasting: boolean): void;
}

export interface RemotePlayerLike {
  readonly isConnected: boolean;
  readonly isMediaLoaded: boolean;
  readonly isPaused: boolean;
  readonly canSeek: boolean;
  readonly playerState: string | null;
  duration: number;
  currentTime: number;
}

export interface RemotePlayerControllerLike {
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  playOrPause(): void;
  stop(): void;
  seek(): void;
}

/** `cast.framework`, once the Cast sender SDK is loaded. */
export interface CastFrameworkLike {
  CastContext: { getInstance(): CastContextLike };
  CastContextEventType: {
    CAST_STATE_CHANGED: string;
    SESSION_STATE_CHANGED: string;
  };
  SessionState: Record<
    'SESSION_STARTED' | 'SESSION_RESUMED' | 'SESSION_ENDED',
    string
  >;
  RemotePlayerEventType: { ANY_CHANGE: string };
  RemotePlayer: new () => RemotePlayerLike;
  RemotePlayerController: new (
    player: RemotePlayerLike
  ) => RemotePlayerControllerLike;
}

export interface CastMediaInfoLike {
  streamType: string;
  metadata: unknown;
  /** Video: the text tracks the receiver may show. */
  tracks?: unknown[];
}

/** A `chrome.cast.media.Track`: a text track for the receiver (WebVTT). */
export interface CastTrackLike {
  trackContentId: string;
  trackContentType: string;
  subtype: string;
  name: string | null;
  language: string | null;
}

/** `chrome.cast`, once the Cast sender SDK is loaded. */
export interface ChromeCastLike {
  AutoJoinPolicy: { ORIGIN_SCOPED: string };
  Image: new (url: string) => unknown;
  Volume: new (level: number | null, muted?: boolean | null) => unknown;
  media: {
    DEFAULT_MEDIA_RECEIVER_APP_ID: string;
    StreamType: { LIVE: string; BUFFERED: string };
    MediaCommand: { STREAM_VOLUME: string };
    MediaInfo: new (
      contentId: string,
      contentType: string
    ) => CastMediaInfoLike;
    MusicTrackMediaMetadata: new () => {
      title?: string;
      artist?: string;
      albumName?: string;
      images?: unknown[];
    };
    /** Video: a movie's metadata (the receiver's video layout). */
    MovieMetadata?: new () => {
      title?: string;
      subtitle?: string;
      images?: unknown[];
    };
    Track?: new (trackId: number, trackType: string) => CastTrackLike;
    TrackType?: { TEXT: string };
    TextTrackType?: { SUBTITLES: string; CAPTIONS: string };
    EditTracksInfoRequest?: new (activeTrackIds: number[]) => unknown;
    LoadRequest: new (mediaInfo: CastMediaInfoLike) => {
      autoplay: boolean;
      currentTime?: number;
      activeTrackIds?: number[];
    };
    VolumeRequest: new (volume: unknown) => unknown;
  };
}

export interface ScriptElementLike {
  src: string;
  async: boolean;
  onerror: (() => void) | null;
}

export interface NetworkInformationLike extends EventTargetLike {
  readonly type?: string;
  /** Mbps (Chromium). */
  readonly downlink?: number;
  readonly saveData?: boolean;
}

export interface BrowserGlobals {
  document?: EventTargetLike & {
    readonly visibilityState: string;
    readonly head?: { appendChild(node: ScriptElementLike): void };
    createElement(tag: 'audio'): AudioElementLike;
    createElement(tag: 'video'): VideoElementLike;
    createElement(tag: 'div' | 'span'): ElementLike;
    createElement(tag: 'source'): SourceElementLike;
    createElement(tag: 'script'): ScriptElementLike;
    readonly fullscreenElement?: unknown;
    readonly webkitFullscreenElement?: unknown;
    exitFullscreen?(): Promise<void>;
    webkitExitFullscreen?(): void;
    readonly pictureInPictureElement?: unknown;
    exitPictureInPicture?(): Promise<void>;
  };
  navigator?: {
    readonly onLine: boolean;
    readonly userAgent?: string;
    readonly mediaSession?: MediaSessionLike;
    readonly connection?: NetworkInformationLike;
    readonly languages?: readonly string[];
    readonly wakeLock?: {
      request(type: 'screen'): Promise<WakeLockSentinelLike>;
    };
  };
  screen?: {
    orientation?: { lock?(o: string): Promise<void>; unlock?(): void };
  };
  devicePixelRatio?: number;
  matchMedia?(query: string): { readonly matches: boolean };
  IntersectionObserver?: new (
    callback: (entries: IntersectionEntryLike[]) => void,
    options?: { threshold?: number[] }
  ) => ObserverLike;
  ResizeObserver?: new (
    callback: (entries: ResizeEntryLike[]) => void
  ) => ObserverLike;
  TextDecoder?: new (label: string) => { decode(bytes: Uint8Array): string };
  location?: { readonly href: string; readonly origin: string };
  addEventListener?: EventTargetLike['addEventListener'];
  readonly isSecureContext?: boolean;
  /** The Cast sender SDK's namespaces and its load callback. */
  cast?: { framework?: CastFrameworkLike };
  chrome?: { cast?: ChromeCastLike };
  __onGCastApiAvailable?: (available: boolean) => void;
  MediaSource?: MediaSourceConstructor;
  ManagedMediaSource?: MediaSourceConstructor;
  MediaMetadata?: new (init: {
    title?: string;
    artist?: string;
    album?: string;
    artwork?: Array<{ src: string }>;
  }) => unknown;
  AudioContext?: new () => AudioContextLike;
  webkitAudioContext?: new () => AudioContextLike;
  URL: {
    new (
      url: string,
      base?: string
    ): {
      readonly origin: string;
      readonly pathname: string;
      readonly href: string;
      readonly protocol: string;
    };
    createObjectURL(object: unknown): string;
    revokeObjectURL(url: string): void;
  };
  fetch(
    url: string,
    init: {
      headers: Record<string, string>;
      signal?: AbortSignalLike;
      cache: string;
      mode: string;
    }
  ): Promise<ResponseLike>;
  /** The Fetch API's `Request` (hls.js's `fetchSetup` returns one). */
  Request?: new (url: string, init: unknown) => unknown;
  AbortController: new () => AbortControllerLike;
  performance?: { now(): number };
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number | null): void;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(id: number | null): void;
  queueMicrotask(task: () => void): void;
}

/** The browser's globals. Only call at run time, never at import. */
export function browser(): BrowserGlobals {
  return globalThis as unknown as BrowserGlobals;
}

/** Monotonic milliseconds (falls back to the wall clock outside browsers). */
export function monotonicNow(): number {
  const performance = browser().performance;
  return performance ? performance.now() : Date.now();
}
