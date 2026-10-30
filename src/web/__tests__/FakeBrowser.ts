/// <reference types="node" />
// A scripted browser for the web engine's unit tests: an <audio> element,
// Media Source Extensions, a streaming fetch(), the Media Session and Web
// Audio — just enough behaviour to drive `WebModule` through every path.
// The real-browser counterpart is the Playwright suite (example web app).

import { boxes, parseInit, parseSegment } from './audioFixtures';

type Handler = (event: unknown) => void;

export class FakeEvents {
  private readonly handlers = new Map<
    string,
    Array<{ fn: Handler; signal?: { aborted: boolean } }>
  >();

  addEventListener(
    type: string,
    fn: Handler,
    options?: { signal?: { aborted: boolean } }
  ): void {
    const list = this.handlers.get(type) ?? [];
    list.push({ fn, signal: options?.signal });
    this.handlers.set(type, list);
  }

  removeEventListener(type: string, fn: Handler): void {
    const list = this.handlers.get(type) ?? [];
    this.handlers.set(
      type,
      list.filter((h) => h.fn !== fn)
    );
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const h of [...(this.handlers.get(type) ?? [])]) {
      if (!h.signal?.aborted) h.fn(event);
    }
  }

  listenerCount(type: string): number {
    return (this.handlers.get(type) ?? []).filter((h) => !h.signal?.aborted)
      .length;
  }
}

export function ranges(list: Array<[number, number]>) {
  return {
    length: list.length,
    start: (i: number) => list[i]![0],
    end: (i: number) => list[i]![1],
  };
}

/** Audio bytes per second of media in the fake source buffer. */
export const BYTES_PER_SECOND = 16_000; // 128 kbps

/** The MSE types a Chromium-like browser takes for MP3 and AAC. */
export const RAW_AUDIO_TYPES = ['audio/mpeg', 'audio/aac'];
/** The MSE types a Firefox-like browser takes: the codecs only inside MP4. */
export const MP4_AUDIO_TYPES = [
  'audio/mp4; codecs="mp3"',
  'audio/mp4; codecs="mp4a.40.2"',
];

export class FakeSourceBuffer extends FakeEvents {
  mode = 'segments';
  updating = false;
  bytes = 0;
  /** Everything appended, in order. */
  appended: Uint8Array[] = [];
  /** MP4 the fake's parser refused (a media segment before an init segment, a bad box). */
  mp4Errors: string[] = [];
  /** `baseMediaDecodeTime` of each media segment appended (MP4 types). */
  segmentStarts: number[] = [];
  private timescale = 0;
  private mp4Seconds = 0;
  /** Media time evicted from the front. */
  start = 0;
  removed: Array<[number, number]> = [];
  aborts = 0;
  /** Throw QuotaExceededError on the next N appends. */
  quotaFailures = 0;
  /** Throw this (non-quota) error on the next append. */
  appendError: Error | null = null;

  constructor(readonly type: string) {
    super();
  }

  private get mp4(): boolean {
    return this.type.startsWith('audio/mp4');
  }

  get buffered() {
    // MP4 time comes from the segments' own durations; raw audio from its bit rate.
    const end = this.mp4 ? this.mp4Seconds : this.bytes / BYTES_PER_SECOND;
    return end > 0 ? ranges([[this.start, end]]) : ranges([]);
  }

  /** Reads an appended MP4 chunk the way a demuxer would; sequence mode puts segments end to end. */
  private ingest(data: Uint8Array): void {
    try {
      const top = boxes(data);
      const moov = top.find((b) => b.type === 'moov');
      if (moov) {
        this.timescale = parseInit(
          data.subarray(0, moov.start + moov.size)
        ).timescale;
      }
      const moof = top.find((b) => b.type === 'moof');
      if (!moof) return;
      if (this.timescale === 0) {
        this.mp4Errors.push('media segment before an init segment');
        return;
      }
      const segment = parseSegment(data.subarray(moof.start));
      this.segmentStarts.push(segment.baseMediaDecodeTime);
      for (const sample of segment.samples)
        this.mp4Seconds += sample.duration / this.timescale;
    } catch (error) {
      this.mp4Errors.push(String(error));
    }
  }

  appendBuffer(data: Uint8Array): void {
    if (this.appendError) {
      const error = this.appendError;
      this.appendError = null;
      throw error;
    }
    if (this.quotaFailures > 0) {
      this.quotaFailures -= 1;
      throw Object.assign(new Error('full'), { name: 'QuotaExceededError' });
    }
    this.updating = true;
    this.appended.push(data.slice());
    queueMicrotask(() => {
      this.bytes += data.length;
      if (this.mp4) this.ingest(data);
      this.updating = false;
      this.dispatch('updateend');
    });
  }

  remove(start: number, end: number): void {
    this.removed.push([start, end]);
    if (start <= this.start) this.start = Math.max(this.start, end);
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.dispatch('updateend');
    });
  }

  abort(): void {
    this.aborts += 1;
  }
}

export class FakeMediaSource extends FakeEvents {
  static supported = new Set(RAW_AUDIO_TYPES);
  static instances: FakeMediaSource[] = [];
  readyState = 'closed';
  duration = NaN;
  buffers: FakeSourceBuffer[] = [];
  /** Throw on addSourceBuffer. */
  static failAdd = false;

  static isTypeSupported(type: string): boolean {
    return FakeMediaSource.supported.has(type);
  }

  constructor() {
    super();
    FakeMediaSource.instances.push(this);
  }

  open(): void {
    this.readyState = 'open';
    this.dispatch('sourceopen');
  }

  addSourceBuffer(type: string): FakeSourceBuffer {
    if (FakeMediaSource.failAdd) throw new Error('NotSupportedError');
    const buffer = new FakeSourceBuffer(type);
    this.buffers.push(buffer);
    return buffer;
  }

  endOfStream(): void {
    this.readyState = 'ended';
  }
}

/** The element each `<source>` child was appended to (`remove()` leaves it). */
const sourceOwners = new WeakMap<object, FakeAudio>();

/** A `<source>` element: `remove()` takes it out of its parent, as in the DOM. */
class FakeSourceElement {
  src = '';
  type = '';

  remove(): void {
    sourceOwners.get(this)?.removeChild(this);
  }
}

const objectUrls = new Map<string, unknown>();
let urlCounter = 0;

/** The object URLs made for a `Blob` or `File` and not revoked (MediaSources are not counted). */
export function liveBlobUrls(): string[] {
  return [...objectUrls]
    .filter(([, object]) => object instanceof Blob)
    .map(([url]) => url);
}

/** Features the next fake elements have (set by `install`). */
export const elementFeatures = {
  /** Safari / Android: the element plays HLS itself. */
  nativeHls: false,
  airplay: false,
  remote: false,
  refuseWatch: false,
};

/** A scripted Remote Playback API (Chrome). */
export class FakeRemotePlayback extends FakeEvents {
  state = 'disconnected';
  prompts = 0;
  /** What `prompt()` does: select a receiver, or reject with this error. */
  promptError: { name: string; message: string } | null = null;
  private readonly watchers = new Map<number, (available: boolean) => void>();
  private nextWatcher = 1;
  cancelled: number[] = [];
  /** Reject `watchAvailability` (the browser refuses to watch). */
  refuseWatch = elementFeatures.refuseWatch;

  watchAvailability(callback: (available: boolean) => void): Promise<number> {
    if (this.refuseWatch) return Promise.reject(new Error('NotSupportedError'));
    const id = this.nextWatcher++;
    this.watchers.set(id, callback);
    return Promise.resolve(id);
  }

  cancelWatchAvailability(id?: number): Promise<void> {
    this.cancelled.push(id ?? -1);
    this.watchers.delete(id ?? -1);
    return Promise.resolve();
  }

  prompt(): Promise<void> {
    this.prompts += 1;
    if (this.promptError)
      return Promise.reject(
        Object.assign(new Error(this.promptError.message), {
          name: this.promptError.name,
        })
      );
    return Promise.resolve();
  }

  // ── Test controls ──

  setAvailable(available: boolean): void {
    this.watchers.forEach((callback) => callback(available));
  }

  setState(state: 'connecting' | 'connected' | 'disconnected'): void {
    this.state = state;
    const events = {
      connecting: 'connecting',
      connected: 'connect',
      disconnected: 'disconnect',
    };
    this.dispatch(events[state]);
  }

  get watching(): number {
    return this.watchers.size;
  }
}

export class FakeAudio extends FakeEvents {
  private _src = '';
  /** `<source>` children, in order. */
  children: Array<{ src: string; type: string }> = [];
  /** Safari: set when this element has the AirPlay API. */
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless = false;
  airplayPickers = 0;
  remote?: FakeRemotePlayback;
  currentTime = 0;
  duration = NaN;
  paused = true;
  ended = false;
  readyState = 0;
  volume = 1;
  muted = false;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preload = '';
  crossOrigin: string | null = null;
  disableRemotePlayback = false;
  seekable = ranges([]);
  plainBuffered = ranges([]);
  error: { code: number; message: string } | null = null;
  /** What play() does: start, refuse (autoplay policy), fail, or abort. */
  playBehavior: 'start' | 'block' | 'fail' | 'abort' | 'throw' | 'defer' =
    'start';
  /** The play() promises left pending by `playBehavior = 'defer'`, to settle by hand. */
  pendingPlays: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  plays = 0;
  loads = 0;
  srcHistory: string[] = [];
  mediaSource: FakeMediaSource | null = null;

  constructor() {
    super();
    if (elementFeatures.airplay) {
      this.webkitShowPlaybackTargetPicker = () => {
        this.airplayPickers += 1;
      };
    }
    if (elementFeatures.remote) this.remote = new FakeRemotePlayback();
  }

  get src(): string {
    return this._src;
  }

  set src(value: string) {
    this._src = value;
    this.srcHistory.push(value);
    // The media load algorithm: the rate goes back to the default.
    this.playbackRate = this.defaultPlaybackRate;
    this.attachMediaSource(value);
  }

  private attachMediaSource(url: string): void {
    this.mediaSource = null;
    const attached = objectUrls.get(url);
    if (attached instanceof FakeMediaSource) {
      this.mediaSource = attached;
      queueMicrotask(() => attached.open());
    }
  }

  appendChild(child: { src: string; type: string }): void {
    sourceOwners.set(child, this);
    this.children.push(child);
    // Resource selection: the first usable `<source>` of an element without `src`.
    if (this._src === '' && this.mediaSource == null)
      this.attachMediaSource(child.src);
  }

  removeChild(child: { src: string; type: string }): void {
    this.children = this.children.filter((c) => c !== child);
    if (objectUrls.get(child.src) === this.mediaSource) this.mediaSource = null;
  }

  get buffered() {
    return this.mediaSource?.buffers[0]?.buffered ?? this.plainBuffered;
  }

  play(): Promise<void> {
    this.plays += 1;
    switch (this.playBehavior) {
      case 'block':
        return Promise.reject(
          Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
        );
      case 'fail':
        return Promise.reject(
          Object.assign(new Error('bad'), { name: 'NotSupportedError' })
        );
      case 'abort':
        return Promise.reject(
          Object.assign(new Error('aborted'), { name: 'AbortError' })
        );
      case 'throw':
        throw new Error('sync failure');
      case 'defer':
        return new Promise<void>((resolve, reject) => {
          this.pendingPlays.push({ resolve, reject });
        });
      default:
        this.paused = false;
        return Promise.resolve();
    }
  }

  pause(): void {
    const wasPlaying = !this.paused;
    this.paused = true;
    if (wasPlaying) this.dispatch('pause');
  }

  load(): void {
    this.loads += 1;
    this.playbackRate = this.defaultPlaybackRate;
  }

  canPlayType(type: string): string {
    return elementFeatures.nativeHls && type === 'application/vnd.apple.mpegurl'
      ? 'maybe'
      : '';
  }

  removeAttribute(name: string): void {
    if (name === 'src') this._src = '';
  }

  // ── Test controls ──

  becomeReady(duration: number, seekable = Number.isFinite(duration)): void {
    this.duration = duration;
    this.readyState = 1;
    this.seekable = seekable ? ranges([[0, duration]]) : ranges([]);
    this.dispatch('loadedmetadata');
  }

  startPlaying(): void {
    this.paused = false;
    this.dispatch('playing');
  }

  fail(code: number, message = 'failed'): void {
    this.error = { code, message };
    this.dispatch('error');
  }

  /** Safari: AirPlay receivers appeared (or all went away). */
  setAirplayTargets(available: boolean): void {
    this.dispatch('webkitplaybacktargetavailabilitychanged', {
      availability: available ? 'available' : 'not-available',
    });
  }

  /** Safari: the element started or stopped playing to an AirPlay receiver. */
  setWireless(wireless: boolean): void {
    this.webkitCurrentPlaybackTargetIsWireless = wireless;
    this.dispatch('webkitcurrentplaybacktargetiswirelesschanged');
  }
}

/** A streaming response body the test feeds chunk by chunk. */
export class FakeBody {
  private chunks: Array<Uint8Array | null | Error> = [];
  private waiting: ((r: { done: boolean; value?: Uint8Array }) => void) | null =
    null;
  private failWaiting: ((e: Error) => void) | null = null;
  cancelled = false;

  constructor(signal?: AbortSignal) {
    signal?.addEventListener('abort', () =>
      this.fail(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    );
  }

  push(chunk: Uint8Array): void {
    this.deliver(chunk);
  }

  end(): void {
    this.deliver(null);
  }

  fail(error: Error): void {
    this.deliver(error);
  }

  private deliver(item: Uint8Array | null | Error): void {
    if (this.waiting) {
      const resolve = this.waiting;
      const reject = this.failWaiting!;
      this.waiting = null;
      this.failWaiting = null;
      if (item instanceof Error) reject(item);
      else resolve(item ? { done: false, value: item } : { done: true });
    } else {
      this.chunks.push(item);
    }
  }

  getReader() {
    return {
      read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
        if (this.chunks.length > 0) {
          const item = this.chunks.shift()!;
          if (item instanceof Error) return Promise.reject(item);
          return Promise.resolve(
            item ? { done: false, value: item } : { done: true }
          );
        }
        return new Promise((resolve, reject) => {
          this.waiting = resolve;
          this.failWaiting = reject;
        });
      },
      cancel: () => {
        this.cancelled = true;
        return Promise.resolve();
      },
    };
  }
}

export interface FakeRequest {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  body: FakeBody;
}

type Responder =
  | { status?: number; headers?: Record<string, string>; noBody?: boolean }
  | Error;

export class FakeFetch {
  requests: FakeRequest[] = [];
  private responders: Responder[] = [];

  /** Queues the next response (or a network failure). */
  respond(responder: Responder): void {
    this.responders.push(responder);
  }

  fetch = (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal }
  ) => {
    const responder = this.responders.shift() ?? { status: 200 };
    if (responder instanceof Error) return Promise.reject(responder);
    const body = new FakeBody(init.signal);
    this.requests.push({
      url,
      headers: init.headers,
      signal: init.signal,
      body,
    });
    const headers = new Map(
      Object.entries(responder.headers ?? { 'content-type': 'audio/mpeg' }).map(
        ([k, v]) => [k.toLowerCase(), v]
      )
    );
    const status = responder.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: {
        get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      },
      body: responder.noBody ? null : body,
    });
  };

  last(): FakeRequest {
    return this.requests[this.requests.length - 1]!;
  }
}

export class FakeMediaSession {
  metadata: unknown = null;
  playbackState = 'none';
  handlers = new Map<string, ((details: object) => void) | null>();
  positions: unknown[] = [];
  /** Actions this browser rejects. */
  unsupported = new Set<string>(['stop']);

  setActionHandler(
    action: string,
    handler: ((details: object) => void) | null
  ) {
    if (this.unsupported.has(action)) throw new Error('unsupported');
    this.handlers.set(action, handler);
  }

  setPositionState(state?: unknown) {
    this.positions.push(state);
  }

  trigger(action: string, details: object = {}) {
    this.handlers.get(action)?.(details);
  }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** Construction throws (Chrome refuses a new context past its limit). */
  static failConstruct = false;
  /** `close()` rejects (the context was closed already). */
  static failClose = false;
  state = 'suspended';
  sampleRate = 48000;
  baseLatency = 0.01;
  outputLatency = 0.02;
  destination = {};
  sources: unknown[] = [];
  /** The nodes `createMediaElementSource` returned. */
  sourceNodes: Array<{ disconnected: boolean }> = [];
  analysers: Array<{
    fftSize: number;
    connected: unknown[];
    disconnected: boolean;
  }> = [];

  constructor() {
    if (FakeAudioContext.failConstruct)
      throw Object.assign(new Error('too many contexts'), {
        name: 'NotSupportedError',
      });
    FakeAudioContext.instances.push(this);
  }

  resume() {
    this.state = 'running';
    return Promise.resolve();
  }

  close() {
    if (FakeAudioContext.failClose)
      return Promise.reject(new Error('InvalidStateError'));
    this.state = 'closed';
    return Promise.resolve();
  }

  createMediaElementSource(element: unknown) {
    this.sources.push(element);
    const node = {
      disconnected: false,
      connect: () => undefined,
      disconnect() {
        node.disconnected = true;
      },
    };
    this.sourceNodes.push(node);
    return node;
  }

  createAnalyser() {
    const analyser = {
      fftSize: 2048,
      connected: [] as unknown[],
      disconnected: false,
      connect(node: unknown) {
        analyser.connected.push(node);
      },
      disconnect() {
        analyser.disconnected = true;
      },
      getFloatTimeDomainData(target: Float32Array) {
        for (let i = 0; i < target.length; i++) target[i] = i % 2 ? 0.5 : -0.5;
      },
    };
    this.analysers.push(analyser);
    return analyser;
  }
}

class FakeURL extends URL {
  static createObjectURL(object: unknown): string {
    urlCounter += 1;
    const url = `blob:https://app.example/${urlCounter}`;
    objectUrls.set(url, object);
    return url;
  }

  static revokeObjectURL(url: string): void {
    objectUrls.delete(url);
  }
}

class FakeMediaMetadata {
  constructor(readonly init: object) {}
}

export interface FakeWorld {
  elements: FakeAudio[];
  /** `<script>` elements the page added to <head> (the Cast SDK). */
  scripts: Array<{ src: string; onerror: (() => void) | null }>;
  fetch: FakeFetch;
  session: FakeMediaSession;
  navigator: { onLine: boolean; connection: FakeEvents & { type: string } };
  document: FakeEvents & { visibilityState: string };
  window: FakeEvents;
  element(): FakeAudio;
}

const KEYS = [
  'document',
  'navigator',
  'location',
  'MediaSource',
  'ManagedMediaSource',
  'MediaMetadata',
  'AudioContext',
  'webkitAudioContext',
  'URL',
  'fetch',
  'addEventListener',
  'isSecureContext',
  'cast',
  'chrome',
  '__onGCastApiAvailable',
] as const;

let saved: Record<string, PropertyDescriptor | undefined> = {};

/** Installs the fake browser on `globalThis`; `uninstall()` restores it. */
export function install(
  options: {
    mediaSource?: 'standard' | 'managed' | 'none';
    /** The MSE types `isTypeSupported` accepts (default: MP3 and AAC raw, as Chromium). */
    mediaTypes?: string[];
    /** Safari: the element plays HLS itself. */
    nativeHls?: boolean;
    audioContext?: boolean;
    mediaSession?: boolean;
    /** Safari: elements have the AirPlay API. */
    airplay?: boolean;
    /** Chrome: elements have the Remote Playback API. */
    remotePlayback?: boolean;
    /** Chrome: `watchAvailability` rejects. */
    refuseWatch?: boolean;
    userAgent?: string;
    secureContext?: boolean;
  } = {}
): FakeWorld {
  const g = globalThis as Record<string, unknown>;
  saved = Object.fromEntries(
    KEYS.map((k) => [k, Object.getOwnPropertyDescriptor(g, k)])
  );
  objectUrls.clear();
  urlCounter = 0;
  FakeMediaSource.instances = [];
  FakeMediaSource.failAdd = false;
  FakeMediaSource.supported = new Set(options.mediaTypes ?? RAW_AUDIO_TYPES);
  elementFeatures.nativeHls = options.nativeHls === true;
  FakeAudioContext.instances = [];
  FakeAudioContext.failConstruct = false;
  FakeAudioContext.failClose = false;
  elementFeatures.airplay = options.airplay === true;
  elementFeatures.remote = options.remotePlayback === true;
  elementFeatures.refuseWatch = options.refuseWatch === true;
  const elements: FakeAudio[] = [];
  const scripts: FakeWorld['scripts'] = [];
  const document = Object.assign(new FakeEvents(), {
    visibilityState: 'visible',
    head: {
      appendChild: (script: FakeWorld['scripts'][number]) =>
        scripts.push(script),
    },
    createElement: (tag: string) => {
      if (tag === 'source') return new FakeSourceElement();
      if (tag === 'script')
        return { src: '', async: false, onerror: null as (() => void) | null };
      const element = new FakeAudio();
      elements.push(element);
      return element;
    },
  });
  const connection = Object.assign(new FakeEvents(), { type: 'wifi' });
  const session = new FakeMediaSession();
  const navigator = {
    onLine: true,
    userAgent:
      options.userAgent ??
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    connection,
    ...(options.mediaSession === false ? {} : { mediaSession: session }),
  };
  const window = new FakeEvents();
  const fetch = new FakeFetch();
  const define = (key: string, value: unknown) =>
    Object.defineProperty(g, key, {
      value,
      configurable: true,
      writable: true,
    });
  define('document', document);
  define('isSecureContext', options.secureContext !== false);
  define('cast', undefined);
  define('chrome', undefined);
  define('__onGCastApiAvailable', undefined);
  define('navigator', navigator);
  define('location', {
    href: 'https://app.example/',
    origin: 'https://app.example',
  });
  const mode = options.mediaSource ?? 'standard';
  define('MediaSource', mode === 'standard' ? FakeMediaSource : undefined);
  define(
    'ManagedMediaSource',
    mode === 'managed' ? FakeMediaSource : undefined
  );
  define('MediaMetadata', FakeMediaMetadata);
  define(
    'AudioContext',
    options.audioContext === false ? undefined : FakeAudioContext
  );
  define('webkitAudioContext', undefined);
  define('URL', FakeURL);
  define('fetch', fetch.fetch);
  define('addEventListener', window.addEventListener.bind(window));
  return {
    elements,
    scripts,
    fetch,
    session,
    navigator,
    document,
    window,
    element: () => elements[elements.length - 1]!,
  };
}

export function uninstall(): void {
  const g = globalThis as Record<string, unknown>;
  for (const key of KEYS) {
    const descriptor = saved[key];
    if (descriptor) Object.defineProperty(g, key, descriptor);
    else delete g[key];
  }
}

/** Bytes of an ICY body: `metaint` audio bytes, then `title`'s block (or none). */
export function icyChunk(
  metaint: number,
  title: string | null,
  fill = 1
): Uint8Array {
  const audio = Array.from({ length: metaint }, () => fill);
  if (title == null) return Uint8Array.from([...audio, 0]);
  const payload = [...new TextEncoder().encode(`StreamTitle='${title}';`)];
  const blocks = Math.ceil(payload.length / 16);
  while (payload.length < blocks * 16) payload.push(0);
  return Uint8Array.from([...audio, blocks, ...payload]);
}
