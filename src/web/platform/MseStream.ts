// A live HTTP stream read with fetch() and fed to the element through Media
// Source Extensions. The web counterpart of the iOS stream proxy: RNAP owns
// the connection, so it can
//
// - read ICY metadata: the body is de-interleaved here and each block is
//   timed to the media position its audio starts at (heard, not received);
// - close the connection the moment it is released (no phantom listener);
// - splice a fresh connection into the same buffer when one that stayed up
//   (3 s) drops, so playback continues without a reload (reported as a splice).
//
// It needs CORS on the stream and an MSE-playable codec (MP3, AAC). Anything
// else falls back to the plain element (`onFallback`), which plays what the
// browser can without metadata.

import type { PlayerError } from '../../errors';
import {
  IcyDeinterleaver,
  IcyParser,
  type StreamMetadata,
  type StreamTitleFormat,
} from '../engine/StreamMetadata';
import { engineError, type SourceDescriptor } from '../engine/types';
import {
  browser,
  monotonicNow,
  type AudioElementLike,
  type MediaSourceConstructor,
  type MediaSourceLike,
  type ReaderLike,
  type HeadersLike,
  type ResponseLike,
  type SourceBufferLike,
  type SourceElementLike,
} from './dom';

export interface MseStreamListener {
  /** Station info from the response headers (`icy-name`, `icy-genre`). */
  onStation(metadata: StreamMetadata): void;
  /** A metadata block, with the media time its audio starts at. */
  onTimedMetadata(metadata: StreamMetadata, mediaTime: number): void;
  /** A fresh connection was spliced in; its audio starts at `mediaTime`. */
  onSplice(mediaTime: number): void;
  /** MSE cannot play this stream: play it with the plain element instead. */
  onFallback(reason: string): void;
  /** The first connection failed before any audio arrived. */
  onFailure(error: PlayerError): void;
  /** A diagnostics note. */
  onNote(event: string, details: Record<string, string>): void;
  /** The stream answered with CORS: a later fetch failure is the network. */
  onConnected(): void;
}

export interface MediaSourceSupport {
  ctor: MediaSourceConstructor;
  /** `ManagedMediaSource` (iOS Safari 17.1+). */
  managed: boolean;
}

/**
 * A connection that stayed up this long earns a splice when it drops. Time,
 * not bytes: a server's connect burst can send seconds of audio before it
 * closes, so a flapping server would look productive (iOS: `spliceMinUpstreamMs`).
 */
const SPLICE_MIN_UPSTREAM_MS = 3_000;
/** Reading pauses while this much audio is buffered ahead of the playhead. */
const MAX_AHEAD_S = 30;
/** Audio behind the playhead is evicted past this. */
const KEEP_BEHIND_S = 30;

/** Content-Type → the MSE type that plays it. */
const MSE_TYPES: Record<string, string> = {
  'audio/mpeg': 'audio/mpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/aac': 'audio/aac',
  'audio/aacp': 'audio/aac',
  'audio/x-aac': 'audio/aac',
};

const ignore = () => undefined;

/** The MSE type for a stream's Content-Type, or `null` when MSE cannot play it. */
export function mseType(
  contentType: string | null,
  ctor: MediaSourceConstructor
): string | null {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const type = MSE_TYPES[base];
  return type != null && ctor.isTypeSupported(type) ? type : null;
}

/** The MediaSource implementation, preferring the standard one (iOS only has the managed one). */
export function mediaSourceConstructor(): MediaSourceSupport | null {
  const g = browser();
  if (g.MediaSource) return { ctor: g.MediaSource, managed: false };
  if (g.ManagedMediaSource)
    return { ctor: g.ManagedMediaSource, managed: true };
  return null;
}

function httpError(status: number): PlayerError {
  if (status === 404 || status === 410) {
    return engineError(
      'SOURCE_NOT_FOUND',
      `The server returned HTTP ${status}.`,
      false,
      { httpStatus: status }
    );
  }
  const recoverable = status === 408 || status === 429 || status >= 500;
  return engineError(
    'HTTP_ERROR',
    `The server returned HTTP ${status}.`,
    recoverable,
    { httpStatus: status }
  );
}

/** Station info (`icy-name`, `icy-genre`) from response headers; `null` when there is none. */
export function stationFromHeaders(
  headers: HeadersLike,
  format: StreamTitleFormat
): StreamMetadata | null {
  const fields: Record<string, string> = {};
  const name = headers.get('icy-name');
  const genre = headers.get('icy-genre');
  if (name) fields['icy-name'] = name;
  if (genre) fields['icy-genre'] = genre;
  return Object.keys(fields).length === 0
    ? null
    : IcyParser.metadataFromFields(fields, format);
}

/** The MIME type a URL's extension implies, for an AirPlay alternative `<source>`. */
function typeOfUri(uri: string): string | null {
  const path = uri.split(/[?#]/)[0]!.toLowerCase();
  if (path.endsWith('.mp3')) return 'audio/mpeg';
  if (path.endsWith('.aac')) return 'audio/aac';
  return null;
}

/** Drops a response body we will not read. */
export function discard(response: ResponseLike): void {
  response.body?.getReader().cancel().catch(ignore);
}

export class MseStream {
  private mediaSource: MediaSourceLike | null = null;
  private buffer: SourceBufferLike | null = null;
  private objectUrl: string | null = null;
  private abort: (() => void) | null = null;
  private closed = false;
  /** Ask for ICY metadata (dropped when a cross-origin server hides `icy-metaint`). */
  private wantIcy = true;
  /** Audio bytes appended over all connections. */
  private totalBytes = 0;
  /** Byte → media time after the last two appends (metadata timing). */
  private anchor = { byte: 0, time: 0 };
  private previousAnchor = { byte: 0, time: 0 };
  private station: string | null = null;
  /** `<source>` children attached for a managed media source (removed on close). */
  private sources: SourceElementLike[] = [];

  constructor(
    private readonly element: AudioElementLike,
    private readonly source: SourceDescriptor,
    private readonly media: MediaSourceSupport,
    private readonly format: StreamTitleFormat,
    private readonly listener: MseStreamListener,
    /** This source already streamed through fetch (CORS is known to work). */
    private readonly corsProven = false
  ) {}

  /** Seconds of received audio not yet heard. */
  get bufferedAhead(): number {
    return Math.max(0, this.bufferedEnd() - this.element.currentTime);
  }

  start(): void {
    const g = browser();
    const mediaSource = new this.media.ctor();
    this.mediaSource = mediaSource;
    this.objectUrl = g.URL.createObjectURL(mediaSource);
    let opened = false;
    mediaSource.addEventListener('sourceopen', () => {
      if (opened || this.closed) return;
      opened = true;
      this.connect(true);
    });
    if (this.media.managed) this.attachManaged(this.objectUrl);
    else this.element.src = this.objectUrl;
  }

  /**
   * A ManagedMediaSource plays only with AirPlay off, or with an alternative:
   * the media source goes in a `<source>` child, followed by one with the
   * stream's own URL, which is what an AirPlay receiver fetches (WebKit:
   * "How to use Media Source Extensions with AirPlay"). Headers cannot reach
   * a receiver, so a stream that needs them stays off AirPlay.
   */
  private attachManaged(objectUrl: string): void {
    const document = browser().document!;
    // An element `src` (the previous item's) would win over child sources.
    this.element.removeAttribute('src');
    this.element.load();
    const primary = document.createElement('source');
    primary.src = objectUrl;
    this.sources = [primary];
    if (Object.keys(this.source.headers).length === 0) {
      const alternative = document.createElement('source');
      alternative.src = this.source.uri;
      const type = typeOfUri(this.source.uri);
      if (type) alternative.type = type;
      this.sources.push(alternative);
    } else {
      this.element.disableRemotePlayback = true;
    }
    for (const node of this.sources) this.element.appendChild(node);
  }

  /** Closes the connection at once and frees the media source. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort?.();
    this.abort = null;
    for (const node of this.sources) this.element.removeChild(node);
    this.sources = [];
    if (this.objectUrl) browser().URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  // ── Connections ──

  private connect(first: boolean): void {
    this.run(first).catch((error: unknown) => {
      if (this.closed) return;
      if (first && this.totalBytes === 0) {
        this.listener.onFallback(`stream setup failed: ${String(error)}`);
      } else {
        this.endStream(`stream failed: ${String(error)}`);
      }
    });
  }

  private async run(first: boolean): Promise<void> {
    const response = await this.request(first);
    if (!response || !(await this.accept(response, first))) return;
    this.listener.onConnected();
    this.announceStation(response);
    const metaint = parseInt(response.headers.get('icy-metaint') ?? '0', 10);
    const reader = response.body!.getReader();
    const base = this.totalBytes;
    const openedAt = monotonicNow();
    const failure = await this.pump(
      reader,
      new IcyDeinterleaver(Number.isFinite(metaint) ? metaint : 0),
      base
    );
    if (!this.closed) {
      this.connectionEnded(first, {
        bytes: this.totalBytes - base,
        ms: monotonicNow() - openedAt,
        failure,
      });
    }
  }

  /** Fetches the stream; `null` when it failed (already reported) or was closed. */
  private async request(first: boolean): Promise<ResponseLike | null> {
    const g = browser();
    const controller = new g.AbortController();
    this.abort = () => controller.abort();
    const headers: Record<string, string> = { ...this.source.headers };
    if (this.wantIcy) headers['Icy-MetaData'] = '1';
    let response: ResponseLike;
    try {
      response = await g.fetch(this.source.uri, {
        headers,
        signal: controller.signal,
        cache: 'no-store',
        mode: 'cors',
      });
    } catch (error) {
      if (!this.closed) this.fetchFailed(first, error);
      return null;
    }
    if (this.closed) {
      discard(response);
      return null;
    }
    if (!response.ok) {
      discard(response);
      if (first) this.listener.onFailure(httpError(response.status));
      else this.endStream(`splice got HTTP ${response.status}`);
      return null;
    }
    if (
      this.wantIcy &&
      response.headers.get('icy-metaint') == null &&
      // A Content-Length is a file (streams never send one): no second request.
      response.headers.get('content-length') == null &&
      this.crossOrigin()
    ) {
      // The server may be interleaving metadata behind a header CORS hides:
      // the body would be corrupt. Ask again without metadata.
      discard(response);
      this.wantIcy = false;
      this.listener.onNote('icy unavailable', {
        reason: 'icy-metaint not exposed (CORS)',
      });
      return this.request(first);
    }
    return response;
  }

  private fetchFailed(first: boolean, error: unknown): void {
    if (!first) {
      this.endStream(`splice failed: ${String(error)}`);
      return;
    }
    const navigator = browser().navigator;
    if (navigator && !navigator.onLine) {
      this.listener.onFailure(
        engineError('NETWORK_UNAVAILABLE', 'The device is offline.', true, {
          cause: String(error),
        })
      );
      return;
    }
    if (this.corsProven) {
      // This source answered with CORS before: the server is unreachable.
      this.listener.onFailure(
        engineError('NETWORK_ERROR', 'The stream could not be reached.', true, {
          cause: String(error),
        })
      );
      return;
    }
    // A CORS refusal and a network error look the same here; the plain
    // element reports the real network error if there is one.
    this.listener.onFallback(
      `fetch failed (CORS or network): ${String(error)}`
    );
  }

  /** Creates the source buffer (first connection) or splices; `false` when the stream cannot go on. */
  private async accept(
    response: ResponseLike,
    first: boolean
  ): Promise<boolean> {
    if (!first) return this.splice();
    const contentType = response.headers.get('content-type');
    const type = mseType(contentType, this.media.ctor);
    const finite =
      response.headers.get('content-length') != null &&
      response.headers.get('icy-metaint') == null;
    let reason: string | null = null;
    if (type == null) reason = `content type ${contentType}`;
    else if (finite) reason = 'a finite file';
    else if (!response.body) reason = 'no response body';
    else {
      try {
        this.buffer = this.mediaSource!.addSourceBuffer(type);
        this.buffer.mode = 'sequence';
      } catch (error) {
        reason = `addSourceBuffer: ${String(error)}`;
      }
    }
    if (reason == null) return true;
    discard(response);
    this.listener.onFallback(reason);
    return false;
  }

  private async splice(): Promise<boolean> {
    // Reset the demuxer: the new connection may start mid-frame.
    await this.idle();
    if (this.closed) return false;
    this.buffer!.abort();
    this.listener.onSplice(this.bufferedEnd());
    return true;
  }

  private announceStation(response: ResponseLike): void {
    const station = stationFromHeaders(response.headers, this.format);
    const key = `${station?.station ?? ''}|${station?.genre ?? ''}`;
    if (!station || key === this.station) return;
    this.station = key;
    this.listener.onStation(station);
  }

  /**
   * Reads the body until it ends; returns the read error, if any. Only a read
   * error is a dropped connection: an append error (a broken buffer) is
   * thrown on, since a new connection would not fix it.
   */
  private async pump(
    reader: ReaderLike,
    deinterleaver: IcyDeinterleaver,
    base: number
  ): Promise<string | null> {
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch (error) {
        return String(error);
      }
      if (this.closed || chunk.done || !chunk.value) return null;
      if (!(await this.deliver(chunk.value, deinterleaver, base))) return null;
    }
  }

  /** Appends a chunk's audio and times its metadata; `false` once closed. */
  private async deliver(
    chunk: Uint8Array,
    deinterleaver: IcyDeinterleaver,
    base: number
  ): Promise<boolean> {
    const { audio, blocks } = deinterleaver.consume(chunk);
    if (audio.length > 0 && !(await this.append(audio))) return false;
    for (const block of blocks) {
      const metadata = IcyParser.metadataFromBlock(block.bytes, this.format);
      if (Object.keys(metadata.raw).length > 0) {
        this.listener.onTimedMetadata(
          metadata,
          this.timeAt(base + block.audioOffset)
        );
      }
    }
    return true;
  }

  private connectionEnded(
    first: boolean,
    upstream: { bytes: number; ms: number; failure: string | null }
  ): void {
    const { bytes, ms, failure } = upstream;
    const cause: Record<string, string> = failure ? { cause: failure } : {};
    if (first && bytes === 0) {
      this.listener.onFailure(
        engineError(
          'STREAM_ENDED',
          'The stream closed the connection before any audio.',
          true,
          cause
        )
      );
    } else if (bytes > 0 && ms >= SPLICE_MIN_UPSTREAM_MS) {
      this.listener.onNote('connection dropped', {
        bytes: `${bytes}`,
        upstreamMs: `${Math.round(ms)}`,
        splice: 'true',
        ...cause,
      });
      this.connect(false);
    } else {
      // Short-lived: a flapping server. End the stream; the engine's backoff
      // paces the reconnects.
      const suffix = failure ? `: ${failure}` : '';
      this.endStream(`connection dropped after ${Math.round(ms)} ms${suffix}`);
    }
  }

  // ── Buffer ──

  private bufferedEnd(): number {
    const ranges = this.buffer?.buffered;
    return ranges && ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
  }

  private crossOrigin(): boolean {
    const g = browser();
    if (!g.location) return true;
    try {
      return (
        new g.URL(this.source.uri, g.location.href).origin !== g.location.origin
      );
    } catch {
      return true;
    }
  }

  /**
   * Media time of an absolute audio byte offset: interpolated across the last
   * append, which holds every block of the chunk it came with.
   */
  private timeAt(byte: number): number {
    const { previousAnchor: from, anchor: to } = this;
    if (byte >= to.byte || to.byte <= from.byte) return to.time;
    const fraction = Math.max(0, (byte - from.byte) / (to.byte - from.byte));
    return from.time + fraction * (to.time - from.time);
  }

  /** Appends audio once there is room; `false` when the stream was closed meanwhile. */
  private async append(audio: Uint8Array): Promise<boolean> {
    while (!this.closed && this.bufferedAhead > MAX_AHEAD_S)
      await this.sleep(500);
    for (let attempt = 0; attempt < 3 && !this.closed; attempt++) {
      if (await this.tryAppend(audio)) {
        this.previousAnchor = this.anchor;
        this.totalBytes += audio.length;
        this.anchor = { byte: this.totalBytes, time: this.bufferedEnd() };
        return !this.closed;
      }
      await this.sleep(1000);
    }
    if (!this.closed) {
      this.listener.onNote('append dropped', {
        bytes: `${audio.length}`,
        reason: 'buffer full',
      });
    }
    return !this.closed;
  }

  /** One append; `false` when the buffer is full (QuotaExceededError). */
  private async tryAppend(audio: Uint8Array): Promise<boolean> {
    await this.idle();
    if (this.closed) return false;
    this.evict();
    await this.idle();
    if (this.closed) return false;
    try {
      this.buffer!.appendBuffer(audio);
    } catch (error) {
      if ((error as { name?: string }).name !== 'QuotaExceededError')
        throw error;
      return false;
    }
    await this.idle();
    return true;
  }

  private evict(): void {
    const buffer = this.buffer!;
    const ranges = buffer.buffered;
    if (ranges.length === 0) return;
    const behind = this.element.currentTime - KEEP_BEHIND_S;
    if (behind - ranges.start(0) > 10) buffer.remove(ranges.start(0), behind);
  }

  private idle(): Promise<void> {
    const buffer = this.buffer;
    if (!buffer?.updating) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        buffer.removeEventListener('updateend', done);
        resolve();
      };
      buffer.addEventListener('updateend', done);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => browser().setTimeout(resolve, ms));
  }

  /** No more audio: the element plays what it has, then reports `ended`. */
  private endStream(reason: string): void {
    this.listener.onNote('stream ended', { reason });
    this.idle()
      .then(() => {
        if (!this.closed && this.mediaSource?.readyState === 'open') {
          this.mediaSource.endOfStream();
        }
      })
      .catch(ignore);
  }
}
