/// <reference types="node" />
/* eslint-disable no-bitwise -- MP4 flags are bit fields. */
// Fakes for RemuxStream's tests: a file server that answers range requests
// and streams (or stalls, or drops) its body, a MediaSource whose source
// buffer reads the fragmented MP4 it is given, and a <video> that takes text
// tracks. They sit on FakeBrowser's element, URL and global installation.

import fs from 'node:fs';
import path from 'node:path';

import type { PlayerError } from '../../errors';
import type { SourceDescriptor } from '../engine/types';
import { boxes, find } from './audioFixtures';
import {
  FakeAudio,
  FakeEvents,
  FakeMediaSource,
  FakeSourceBuffer,
  install,
  ranges,
  uninstall,
} from './FakeBrowser';
import type { RemuxFormat } from '../remux/Remuxer';
import { RemuxStream, type RemuxListener } from '../platform/RemuxStream';

const DIR = path.resolve(__dirname, '../../../conformance/remux');

/** The bytes of a `conformance/remux/` file. */
export function fixture(name: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(path.join(DIR, name)));
}

/** A golden `tracks.json` entry. */
export interface GoldenTrack {
  id: number;
  kind: string;
  codec: string | null;
  language: string | null;
  name: string | null;
  default: boolean;
}

export function goldenTracks(name: string): GoldenTrack[] {
  return JSON.parse(
    fs.readFileSync(path.join(DIR, `${name}.out`, 'tracks.json'), 'utf8')
  );
}

/** The MSE types a browser takes for these codecs, as video and as audio. */
export function typesFor(codecs: string[]): string[] {
  return ['video', 'audio'].flatMap((kind) =>
    codecs.map((c) => `${kind}/mp4; codecs="${c}"`)
  );
}

// ── The file server ──

/** What happens to one request (the next in the queue). */
export interface Plan {
  /** The request fails before any response (CORS, offline). */
  error?: Error;
  /** Answers with this status (and the file's bytes only if it is 2xx). */
  status?: number;
  /** A 2xx response without a body. */
  noBody?: boolean;
  /** The body breaks (a connection reset) after this many bytes. */
  dropAfter?: number;
  /** The body waits (until aborted) after this many bytes. */
  stallAfter?: number;
  /** The `content-length` header says this (a wrong one). */
  length?: number;
  /** The answer (or the error) comes only once this settles. */
  gate?: Promise<void>;
}

export interface ServedRequest {
  url: string;
  headers: Record<string, string>;
  cache: string;
  mode: string;
  /** The `Range` header's start and end (`null`: open). */
  range: { from: number; to: number | null } | null;
  /** A streaming read (it has a signal), not a one-shot range fetch. */
  streaming: boolean;
  signal?: AbortSignal;
  cancelled: boolean;
}

export class FileServer {
  requests: ServedRequest[] = [];
  /** The server answers `Range` with 206. */
  ranges = true;
  /** The responses carry `content-length`. */
  lengthKnown = true;
  /** Bytes the body gives per read. */
  chunk = 4096;
  /** Applied to every request that has no plan of its own. */
  stallAfter = Number.POSITIVE_INFINITY;
  private readonly queue: Plan[] = [];

  constructor(readonly data: Uint8Array) {}

  /** Plans the next request (the ones after take the defaults). */
  next(plan: Plan): void {
    this.queue.push(plan);
  }

  get streams(): ServedRequest[] {
    return this.requests.filter((r) => r.streaming);
  }

  fetch = (
    url: string,
    init: {
      headers: Record<string, string>;
      signal?: AbortSignal;
      cache: string;
      mode: string;
    }
  ) => {
    const plan = this.queue.shift() ?? {};
    const match = /^bytes=(\d+)-(\d*)$/.exec(init.headers.Range ?? '');
    const record: ServedRequest = {
      url,
      headers: init.headers,
      cache: init.cache,
      mode: init.mode,
      range: match
        ? { from: Number(match[1]), to: match[2] ? Number(match[2]) : null }
        : null,
      streaming: init.signal != null,
      signal: init.signal,
      cancelled: false,
    };
    this.requests.push(record);
    if (plan.gate) return plan.gate.then(() => this.answer(record, plan));
    return this.answer(record, plan);
  };

  private answer(record: ServedRequest, plan: Plan) {
    if (plan.error) return Promise.reject(plan.error);
    const ranged = this.ranges && record.range != null;
    const from = ranged ? record.range!.from : 0;
    const to = ranged
      ? Math.min(record.range!.to ?? Infinity, this.data.length - 1)
      : this.data.length - 1;
    const status = plan.status ?? (ranged ? 206 : 200);
    const ok = status >= 200 && status < 300;
    const bytes = ok ? this.data.subarray(from, to + 1) : new Uint8Array(0);
    const headers = new Map<string, string>();
    if (this.lengthKnown)
      headers.set('content-length', `${plan.length ?? bytes.length}`);
    return Promise.resolve({
      ok,
      status,
      headers: {
        get: (name: string) => headers.get(name.toLowerCase()) ?? null,
      },
      body: plan.noBody ? null : this.body(record, bytes, plan),
      arrayBuffer: () =>
        Promise.resolve(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)
        ),
    });
  }

  private body(record: ServedRequest, bytes: Uint8Array, plan: Plan) {
    let at = 0;
    const stallAfter = plan.stallAfter ?? this.stallAfter;
    const aborted = () => record.signal?.aborted === true;
    const abortError = () =>
      Object.assign(new Error('aborted'), { name: 'AbortError' });
    return {
      getReader: () => ({
        read: (): Promise<{ done: boolean; value?: Uint8Array }> => {
          if (aborted()) return Promise.reject(abortError());
          if (plan.dropAfter != null && at >= plan.dropAfter)
            return Promise.reject(new Error('connection reset'));
          if (at >= stallAfter && at < bytes.length) {
            return new Promise((_, reject) => {
              record.signal?.addEventListener('abort', () =>
                reject(abortError())
              );
            });
          }
          if (at >= bytes.length) return Promise.resolve({ done: true });
          const limit = Math.min(
            this.chunk,
            plan.dropAfter == null ? Infinity : plan.dropAfter - at,
            Number.isFinite(stallAfter) ? stallAfter - at : Infinity
          );
          const value = bytes.subarray(at, at + limit);
          at += value.length;
          return Promise.resolve({ done: false, value });
        },
        cancel: () => {
          record.cancelled = true;
          return Promise.resolve();
        },
      }),
    };
  }
}

// ── The media source ──

interface Fragment {
  track: number;
  start: number;
  end: number;
}

const u32 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset, b.length).getUint32(at);

/** Track id → timescale, from an init segment. */
export function timescalesOf(init: Uint8Array): Map<number, number> {
  const moov = boxes(init).find((b) => b.type === 'moov')!;
  const out = new Map<number, number>();
  for (const trak of boxes(moov.body).filter((b) => b.type === 'trak')) {
    const tkhd = find(trak.body, 'tkhd')!;
    const mdhd = find(trak.body, 'mdia/mdhd')!;
    out.set(
      u32(tkhd.body, tkhd.body[0] === 1 ? 20 : 12),
      u32(mdhd.body, mdhd.body[0] === 1 ? 20 : 12)
    );
  }
  return out;
}

/** The track fragments of a media segment, in seconds. */
export function fragmentsOf(
  segment: Uint8Array,
  scales: ReadonlyMap<number, number>
): Fragment[] {
  const moof = boxes(segment).find((b) => b.type === 'moof')!;
  return boxes(moof.body)
    .filter((b) => b.type === 'traf')
    .map((traf) => {
      const tfhd = find(traf.body, 'tfhd')!;
      const tfdt = find(traf.body, 'tfdt')!;
      const trun = find(traf.body, 'trun')!;
      const track = u32(tfhd.body, 4);
      const scale = scales.get(track)!;
      const time =
        tfdt.body[0] === 1
          ? u32(tfdt.body, 4) * 2 ** 32 + u32(tfdt.body, 8)
          : u32(tfdt.body, 4);
      const flags = u32(trun.body, 0) & 0xffffff;
      const count = u32(trun.body, 4);
      let at = 8 + (flags & 0x1 ? 4 : 0) + (flags & 0x4 ? 4 : 0);
      const perSample =
        (flags & 0x100 ? 4 : 0) +
        (flags & 0x200 ? 4 : 0) +
        (flags & 0x400 ? 4 : 0) +
        (flags & 0x800 ? 4 : 0);
      let duration = 0;
      for (let i = 0; i < count; i++, at += perSample)
        duration += flags & 0x100 ? u32(trun.body, at) : 0;
      return { track, start: time / scale, end: (time + duration) / scale };
    });
}

/** A source buffer that reads the MP4 appended to it, video or audio. */
export class Mp4Buffer extends FakeSourceBuffer {
  /** Seconds added to the buffered range's end (a long read-ahead). */
  static stretch = 0;
  inits: Uint8Array[] = [];
  /** The first track's fragment of each media segment appended. */
  fragments: Fragment[] = [];
  /** The types given to `changeType`. */
  retyped: string[] = [];
  changeType?: (type: string) => void;
  private scales = new Map<number, number>();
  private spans: Array<[number, number]> = [];

  constructor(type: string, canChangeType: boolean) {
    super(type);
    if (canChangeType)
      this.changeType = (next) => {
        this.retyped.push(next);
      };
  }

  get buffered() {
    const stretch = this.spans.length > 0 ? Mp4Buffer.stretch : 0;
    return ranges(
      this.spans.map(([a, b], i) =>
        i === this.spans.length - 1 ? [a, b + stretch] : [a, b]
      )
    );
  }

  appendBuffer(data: Uint8Array): void {
    if (this.updating)
      throw Object.assign(new Error('still updating'), {
        name: 'InvalidStateError',
      });
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
      this.take(data);
      this.updating = false;
      this.dispatch('updateend');
    });
  }

  private take(data: Uint8Array): void {
    if (boxes(data).some((b) => b.type === 'moov')) {
      this.inits.push(data);
      this.scales = timescalesOf(data);
      return;
    }
    const [first] = fragmentsOf(data, this.scales);
    this.fragments.push(first!);
    this.spans.push([first!.start, first!.end]);
    this.spans.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const span of this.spans) {
      const last = merged[merged.length - 1];
      if (last && span[0] <= last[1] + 0.05)
        last[1] = Math.max(last[1], span[1]);
      else merged.push([...span]);
    }
    this.spans = merged;
  }

  remove(start: number, end: number): void {
    this.removed.push([start, end]);
    this.spans = this.spans.flatMap(([a, b]): Array<[number, number]> => {
      if (end <= a || start >= b) return [[a, b]];
      const kept: Array<[number, number]> = [];
      if (start > a) kept.push([a, start]);
      if (end < b) kept.push([end, b]);
      return kept;
    });
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.dispatch('updateend');
    });
  }
}

export class Mp4MediaSource extends FakeMediaSource {
  /** Called with each source buffer made (to arm its failures). */
  static created: ((buffer: Mp4Buffer) => void) | null = null;
  /** The buffers have `changeType`. */
  static changeType = true;
  /** Setting `duration` throws, as it does on a source that is not open. */
  static rejectDuration = false;
  types: string[] = [];
  /** The source buffers made, as `Mp4Buffer`s. */
  made: Mp4Buffer[] = [];

  constructor() {
    super();
    if (Mp4MediaSource.rejectDuration)
      Object.defineProperty(this, 'duration', {
        get: () => NaN,
        set: () => {
          throw Object.assign(new Error('not open'), {
            name: 'InvalidStateError',
          });
        },
      });
  }

  addSourceBuffer(type: string): FakeSourceBuffer {
    if (FakeMediaSource.failAdd) throw new Error('NotSupportedError');
    this.types.push(type);
    const buffer = new Mp4Buffer(type, Mp4MediaSource.changeType);
    this.buffers.push(buffer);
    this.made.push(buffer);
    Mp4MediaSource.created?.(buffer);
    return buffer;
  }
}

// ── The element ──

export class FakeCue {
  align = 'center';
  line: number | string = 'auto';
  snapToLines = true;
  lineAlign = 'start';
  position: number | string = 'auto';

  constructor(
    readonly startTime: number,
    readonly endTime: number,
    readonly text: string
  ) {}
}

export class FakeTextTrack extends FakeEvents {
  mode = 'hidden';
  cues: FakeCue[] = [];
  readonly activeCues = null;

  constructor(
    readonly kind: string,
    readonly label: string,
    readonly language: string
  ) {
    super();
  }

  addCue(cue: FakeCue): void {
    this.cues.push(cue);
  }
}

/** A <video> that takes the page's own text tracks. */
export class FakeVideo extends FakeAudio {
  textTracks: FakeTextTrack[] = [];

  addTextTrack(kind: string, label = '', language = ''): FakeTextTrack {
    const track = new FakeTextTrack(kind, label, language);
    this.textTracks.push(track);
    return track;
  }
}

/** An element without `addTextTrack`: an <audio>. */
export class FakeAudioOnly extends FakeAudio {}

// ── The rig ──

export interface RigOptions {
  file: string;
  /** `undefined`: the container is sniffed from the first bytes. */
  format?: RemuxFormat;
  /** The bytes served, when they are not the file's. */
  bytes?: Uint8Array;
  /** The codecs the browser takes (as video and as audio). */
  codecs: string[];
  /** A video player (default), or an audio one. */
  video?: boolean;
  managed?: boolean;
  liveHint?: boolean | null;
  headers?: Record<string, string>;
  /** The listener has `onWarning` (default) and `onTracks`. */
  full?: boolean;
  /** The element is an <audio>. */
  audioElement?: boolean;
  /** The browser has no `VTTCue`. */
  noVttCue?: boolean;
}

export class Rig {
  readonly element: FakeAudio;
  readonly server: FileServer;
  readonly stream: RemuxStream;
  readonly failures: PlayerError[] = [];
  readonly fallbacks: string[] = [];
  readonly warnings: PlayerError[] = [];
  readonly notes: Array<{ event: string; details: Record<string, string> }> =
    [];
  tracksAnnounced = 0;

  constructor(options: RigOptions) {
    install({ mediaTypes: typesFor(options.codecs) });
    const g = globalThis as Record<string, unknown>;
    this.server = new FileServer(options.bytes ?? fixture(options.file));
    Object.defineProperty(g, 'fetch', {
      value: this.server.fetch,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(g, 'VTTCue', {
      value: options.noVttCue ? undefined : FakeCue,
      configurable: true,
      writable: true,
    });
    Mp4Buffer.stretch = 0;
    Mp4MediaSource.created = null;
    Mp4MediaSource.changeType = true;
    Mp4MediaSource.rejectDuration = false;
    this.element = options.audioElement ? new FakeAudioOnly() : new FakeVideo();
    const source: SourceDescriptor = {
      uri: `https://media.example/${options.file}`,
      headers: options.headers ?? {},
      liveHint: options.liveHint ?? null,
    };
    const listener: RemuxListener = {
      onFailure: (error) => this.failures.push(error),
      onFallback: (reason) => this.fallbacks.push(reason),
      onNote: (event, details) => this.notes.push({ event, details }),
    };
    if (options.full !== false) {
      listener.onTracks = () => {
        this.tracksAnnounced += 1;
      };
      listener.onWarning = (error) => this.warnings.push(error);
    }
    this.stream = new RemuxStream(
      this.element,
      source,
      { ctor: Mp4MediaSource, managed: options.managed === true },
      options.format ?? null,
      options.video !== false,
      listener
    );
  }

  /** The media source the stream made. */
  get mediaSource(): Mp4MediaSource {
    return this.element.mediaSource as Mp4MediaSource;
  }

  get buffer(): Mp4Buffer {
    return this.mediaSource.made[0]!;
  }

  /** The text tracks of the element, by label. */
  get subtitles(): FakeTextTrack[] {
    return (this.element as FakeVideo).textTracks;
  }

  /** The note events, in order. */
  get events(): string[] {
    return this.notes.map((n) => n.event);
  }

  start(): void {
    this.stream.start();
  }

  dispose(): void {
    this.stream.close();
    uninstall();
    delete (globalThis as Record<string, unknown>).VTTCue;
  }
}

/** Lets every promise and microtask the stream is waiting on run. */
export async function settle(hops = 3000): Promise<void> {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}
