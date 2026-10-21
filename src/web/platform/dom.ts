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
  readonly buffered: TimeRangesLike;
  readonly seekable: TimeRangesLike;
  readonly error: MediaErrorLike | null;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
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
}

export interface AudioContextLike {
  readonly state: string;
  readonly sampleRate: number;
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createMediaElementSource(element: AudioElementLike): {
    connect(node: unknown): void;
    disconnect(): void;
  };
  createAnalyser(): AnalyserLike;
}

export interface NetworkInformationLike extends EventTargetLike {
  readonly type?: string;
}

export interface BrowserGlobals {
  document?: EventTargetLike & {
    readonly visibilityState: string;
    createElement(tag: 'audio'): AudioElementLike;
  };
  navigator?: {
    readonly onLine: boolean;
    readonly mediaSession?: MediaSessionLike;
    readonly connection?: NetworkInformationLike;
  };
  location?: { readonly href: string; readonly origin: string };
  addEventListener?: EventTargetLike['addEventListener'];
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
    ): { readonly origin: string; readonly pathname: string };
    createObjectURL(object: unknown): string;
    revokeObjectURL(url: string): void;
  };
  fetch(
    url: string,
    init: {
      headers: Record<string, string>;
      signal: AbortSignalLike;
      cache: string;
      mode: string;
    }
  ): Promise<ResponseLike>;
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
