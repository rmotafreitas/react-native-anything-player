// The web's media cache (`Cache`): whole files kept in Cache Storage, with
// an index (what is held, its size, when it last played, which downloads
// keep it) stored next to them. A complete item plays from a `blob:` URL
// made from its stored body, so it starts at once and plays offline.
// What it cannot do, and says so: a cross-origin file without CORS (its
// bytes cannot be read), HLS and DASH (their segments are not files the
// element plays), and a partial file (only the browser's own HTTP cache
// keeps part of a file: `preload` warms it).

import { engineError, type SourceDescriptor } from '../engine/types';
import { browser } from './dom';

type DownloadState = 'queued' | 'downloading' | 'completed' | 'failed';

interface Entry {
  key: string;
  uri: string;
  headers: Record<string, string>;
  /** Bytes stored (complete), or fetched ahead into the HTTP cache (partial). */
  bytes: number;
  totalBytes: number | null;
  complete: boolean;
  lastUsed: number;
  /** A download keeps it: never evicted. */
  downloadId: string | null;
  state: DownloadState | null;
  error: { code: string; message: string; recoverable: boolean } | null;
}

/** A response body as the cache reads it (no DOM types in the library build). */
interface BodyStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: { byteLength: number } }>;
  };
  tee(): [BodyStream, BodyStream];
}

interface StoredResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: BodyStream | null;
  blob(): Promise<unknown>;
  json(): Promise<unknown>;
}

interface CacheLike {
  match(key: string): Promise<StoredResponse | undefined>;
  put(key: string, response: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface Globals {
  caches?: { open(name: string): Promise<CacheLike> };
  Response?: new (
    body: unknown,
    init?: { headers?: Record<string, string> }
  ) => unknown;
  navigator?: { storage?: { persist?(): Promise<boolean> } };
  fetch(url: string, init: object): Promise<StoredResponse>;
}

const STORE = 'rnap-media-v1';
const ORIGIN = 'https://rnap.invalid';
const INDEX_KEY = `${ORIGIN}/index`;
const MB = 1024 * 1024;
const DEFAULT_MAX = 256 * MB;
const DEFAULT_PRELOAD = MB;
/** Live blob URLs kept (the most recently played files). */
const LIVE_BLOBS = 3;
/** Download progress events, at most this often. */
const PROGRESS_MS = 1_000;
/** A file played for this long is written to the cache (when it is on). */
const CACHE_AFTER_MS = 5_000;

const g = () => globalThis as unknown as Globals;

function unavailable(): Error {
  return engineError(
    'CACHE_UNAVAILABLE',
    'This browser has no Cache Storage here (it needs a secure context: https or localhost).',
    false
  );
}

/** The cache identity of a source: its `cacheKey`, else its URL without the fragment. */
export function cacheKeyOf(source: {
  uri: string;
  cacheKey?: string | null;
}): string {
  return source.cacheKey ?? source.uri.split('#')[0]!;
}

/** Sources the web cache can hold: files over HTTP(S), not live, not adaptive. */
export function cacheable(source: SourceDescriptor): boolean {
  if (source.liveHint === true || source.drm != null) return false;
  if (!/^https?:/i.test(source.uri)) return false;
  return !/\.(m3u8|mpd)$/i.test(source.uri.split(/[?#]/)[0]!);
}

export class WebCache {
  private readonly index = new Map<string, Entry>();
  private store: Promise<CacheLike> | null = null;
  private loaded: Promise<void>;
  private enabled = false;
  private maxSize = DEFAULT_MAX;
  /** Blob URLs of complete files, most recently used last. */
  private readonly blobs = new Map<string, Promise<string>>();
  /** Fills in flight, by key. */
  private readonly filling = new Map<string, Promise<void>>();
  private readonly timers = new Map<string, number>();
  private listener: ((event: Record<string, unknown>) => void) | null = null;

  constructor() {
    this.loaded = this.load();
  }

  /** Where `download` events go (the module's event stream). */
  onEvent(listener: (event: Record<string, unknown>) => void): void {
    this.listener = listener;
  }

  // ── Commands (`cacheCommand`) ──

  async command(command: Record<string, unknown>): Promise<object> {
    await this.loaded;
    switch (command.op) {
      case 'configure':
        if (typeof command.enabled === 'boolean')
          this.enabled = command.enabled;
        if (typeof command.maxSizeBytes === 'number')
          this.maxSize = command.maxSizeBytes;
        await this.evict();
        return {};
      case 'preload':
        return this.preload(this.source(command), command);
      case 'download':
        return this.download(this.source(command), command.id as string | null);
      case 'downloads':
        return {
          downloads: [...this.index.values()]
            .filter((e) => e.downloadId != null)
            .map(downloadMap),
        };
      case 'removeDownload':
        await this.removeDownload(String(command.id));
        return {};
      case 'info':
        return this.info(this.source(command));
      case 'usage':
        return this.usage();
      case 'clear':
        await this.clear();
        return {};
      default:
        throw engineError(
          'INVALID_ARGUMENT',
          `Unknown cache command "${String(command.op)}".`,
          false
        );
    }
  }

  // ── The player's side ──

  /**
   * A complete file's `blob:` URL (the element plays it at once, offline
   * too), or `null` when the source is not held whole. Synchronous: the
   * index is in memory.
   */
  blobFor(source: SourceDescriptor): Promise<string> | null {
    if (!cacheable(source)) return null;
    const entry = this.index.get(cacheKeyOf(source));
    if (entry == null || !entry.complete) return null;
    entry.lastUsed = Date.now();
    this.saveSoon();
    const key = entry.key;
    let url = this.blobs.get(key);
    if (url == null) {
      url = this.body(key).then((blob) => {
        if (blob == null) throw unavailable();
        return browser().URL.createObjectURL(blob);
      });
      // A failed read (the store was cleared under us): the next play fetches.
      url.catch(() => this.blobs.delete(key));
    } else {
      this.blobs.delete(key);
    }
    this.blobs.set(key, url);
    this.trimBlobs();
    return url;
  }

  /** An item began playing: with the cache on, it is written once it played for a while. */
  played(source: SourceDescriptor): void {
    const wanted = source.cache ?? this.enabled;
    const key = cacheKeyOf(source);
    if (!wanted || !cacheable(source) || this.index.get(key)?.complete) return;
    if (this.timers.has(key)) return;
    const timer = browser().setTimeout(() => {
      this.timers.delete(key);
      this.fill(source, null).catch(() => undefined);
    }, CACHE_AFTER_MS);
    this.timers.set(key, timer);
  }

  // ── Internals ──

  private source(command: Record<string, unknown>): SourceDescriptor {
    const map = (command.source ?? {}) as Record<string, unknown>;
    return {
      uri: String(map.uri ?? ''),
      headers: (map.headers as Record<string, string> | undefined) ?? {},
      liveHint: typeof map.live === 'boolean' ? map.live : null,
      cacheKey: typeof map.cacheKey === 'string' ? map.cacheKey : undefined,
      drm: (map.drm as SourceDescriptor['drm']) ?? null,
    };
  }

  private open(): Promise<CacheLike> {
    const caches = g().caches;
    if (caches == null) return Promise.reject(unavailable());
    this.store ??= caches.open(STORE);
    return this.store;
  }

  private async load(): Promise<void> {
    try {
      const store = await this.open();
      const stored = await store.match(INDEX_KEY);
      const list = stored ? ((await stored.json()) as Entry[]) : [];
      for (const entry of list) this.index.set(entry.key, entry);
      // A download the page left half-way goes on.
      for (const entry of list) {
        if (
          entry.downloadId != null &&
          entry.state !== 'completed' &&
          entry.state !== 'failed'
        ) {
          entry.state = 'queued';
          this.fill(entryAsSource(entry), entry.downloadId).catch(
            () => undefined
          );
        }
      }
    } catch {
      // No Cache Storage: commands report CACHE_UNAVAILABLE.
    }
  }

  private saving: number | null = null;

  private saveSoon(): void {
    if (this.saving != null) return;
    this.saving = browser().setTimeout(() => {
      this.saving = null;
      this.save().catch(() => undefined);
    }, 500);
  }

  private async save(): Promise<void> {
    const Response = g().Response;
    if (Response == null) return;
    const store = await this.open();
    await store.put(
      INDEX_KEY,
      new Response(JSON.stringify([...this.index.values()]), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }

  private async body(key: string): Promise<unknown> {
    const store = await this.open();
    const stored = await store.match(mediaKey(key));
    return stored ? stored.blob() : null;
  }

  private async preload(
    source: SourceDescriptor,
    command: Record<string, unknown>
  ): Promise<object> {
    if (!cacheable(source)) return this.info(source);
    if (command.all === true) {
      await this.fill(source, null);
      return this.info(source);
    }
    const key = cacheKeyOf(source);
    const existing = this.index.get(key);
    if (existing?.complete) return this.info(source);
    // Part of a file: into the browser's HTTP cache, which the element reads from.
    const bytes =
      typeof command.bytes === 'number' ? command.bytes : DEFAULT_PRELOAD;
    const response = await g().fetch(source.uri, {
      headers: { ...source.headers, Range: `bytes=0-${bytes - 1}` },
      mode: 'cors',
    });
    if (!response.ok) throw httpError(response.status);
    const got = await drain(response);
    this.index.set(key, {
      ...(existing ?? blankEntry(key, source)),
      bytes: Math.max(existing?.bytes ?? 0, got),
      totalBytes: totalOf(response) ?? existing?.totalBytes ?? null,
      lastUsed: Date.now(),
    });
    this.saveSoon();
    return this.info(source);
  }

  private async download(
    source: SourceDescriptor,
    id: string | null
  ): Promise<object> {
    if (!cacheable(source)) {
      throw engineError(
        'UNSUPPORTED_FORMAT',
        'On the web, downloads are files over HTTP(S): not live streams, HLS or DASH.',
        false
      );
    }
    await this.open();
    const key = cacheKeyOf(source);
    const entry: Entry = {
      ...(this.index.get(key) ?? blankEntry(key, source)),
      downloadId: id ?? source.uri,
    };
    entry.state = entry.complete ? 'completed' : 'queued';
    entry.error = null;
    this.index.set(key, entry);
    this.saveSoon();
    // Ask the browser not to evict what the user downloaded.
    g()
      .navigator?.storage?.persist?.()
      .catch(() => undefined);
    if (!entry.complete)
      this.fill(source, entry.downloadId).catch(() => undefined);
    this.emitDownload(entry);
    return downloadMap(entry);
  }

  /** Stores a whole file (a download when `downloadId`). */
  private fill(
    source: SourceDescriptor,
    downloadId: string | null
  ): Promise<void> {
    const key = cacheKeyOf(source);
    const running = this.filling.get(key);
    if (running) return running;
    const work = this.fetchWhole(source, key, downloadId).finally(() =>
      this.filling.delete(key)
    );
    this.filling.set(key, work);
    return work;
  }

  private async fetchWhole(
    source: SourceDescriptor,
    key: string,
    downloadId: string | null
  ): Promise<void> {
    const entry = this.index.get(key) ?? blankEntry(key, source);
    if (downloadId != null) entry.downloadId = downloadId;
    this.index.set(key, entry);
    try {
      const store = await this.open();
      const Response = g().Response;
      const response = await g().fetch(source.uri, {
        headers: source.headers,
        mode: 'cors',
      });
      if (!response.ok || response.body == null || Response == null)
        throw httpError(response.status);
      entry.totalBytes = totalOf(response);
      entry.state = entry.downloadId != null ? 'downloading' : entry.state;
      const [stored, counted] = response.body.tee();
      const type = response.headers.get('Content-Type');
      const put = store.put(
        mediaKey(key),
        new Response(stored, { headers: type ? { 'Content-Type': type } : {} })
      );
      await this.count(counted, entry);
      await put;
      entry.complete = true;
      entry.lastUsed = Date.now();
      if (entry.downloadId != null) entry.state = 'completed';
      this.emitDownload(entry);
      await this.evict();
    } catch (error) {
      entry.bytes = entry.complete ? entry.bytes : 0;
      if (entry.downloadId != null) {
        entry.state = 'failed';
        const e = error as {
          code?: string;
          message?: string;
          recoverable?: boolean;
        };
        entry.error = {
          code: e.code ?? 'NETWORK_ERROR',
          message: String(e.message ?? error),
          recoverable: e.recoverable ?? true,
        };
        this.emitDownload(entry);
      }
      // A fill for the cache that failed leaves nothing behind.
      if (entry.downloadId == null && !entry.complete) this.index.delete(key);
      throw error;
    } finally {
      this.saveSoon();
    }
  }

  private async count(
    body: BodyStream,
    entry: Entry
  ): Promise<void> {
    const reader = body.getReader();
    let told = 0;
    entry.bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      entry.bytes += value?.byteLength ?? 0;
      const now = Date.now();
      if (entry.downloadId != null && now - told >= PROGRESS_MS) {
        told = now;
        this.emitDownload(entry);
      }
    }
  }

  private async removeDownload(id: string): Promise<void> {
    const entry = [...this.index.values()].find((e) => e.downloadId === id);
    if (entry == null) return;
    await this.drop(entry.key);
    this.saveSoon();
  }

  private info(source: SourceDescriptor): object {
    const entry = this.index.get(cacheKeyOf(source));
    const partial = entry != null && entry.bytes > 0 ? 'partial' : 'none';
    const state = entry?.complete ? 'complete' : partial;
    return {
      state,
      bytes: entry?.bytes ?? 0,
      totalBytes: entry?.totalBytes ?? null,
      downloaded: entry?.downloadId != null && entry.state === 'completed',
    };
  }

  private usage(): object {
    let cacheBytes = 0;
    let downloadBytes = 0;
    for (const e of this.index.values()) {
      if (!e.complete) continue;
      if (e.downloadId != null) downloadBytes += e.bytes;
      else cacheBytes += e.bytes;
    }
    return { cacheBytes, downloadBytes, maxSizeBytes: this.maxSize };
  }

  private async clear(): Promise<void> {
    for (const entry of [...this.index.values()]) {
      if (entry.downloadId == null) await this.drop(entry.key);
    }
    this.saveSoon();
  }

  /** The least recently played go until the cache fits (downloads stay). */
  private async evict(): Promise<void> {
    const cached = [...this.index.values()]
      .filter((e) => e.downloadId == null && e.complete)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let total = cached.reduce((sum, e) => sum + e.bytes, 0);
    for (const entry of cached) {
      if (total <= this.maxSize) break;
      total -= entry.bytes;
      await this.drop(entry.key);
    }
    this.saveSoon();
  }

  private async drop(key: string): Promise<void> {
    this.index.delete(key);
    const url = this.blobs.get(key);
    this.blobs.delete(key);
    url?.then((u) => browser().URL.revokeObjectURL(u)).catch(() => undefined);
    const store = await this.open();
    await store.delete(mediaKey(key));
  }

  private trimBlobs(): void {
    while (this.blobs.size > LIVE_BLOBS) {
      const [key, url] = this.blobs.entries().next().value as [
        string,
        Promise<string>,
      ];
      this.blobs.delete(key);
      url.then((u) => browser().URL.revokeObjectURL(u)).catch(() => undefined);
    }
  }

  private emitDownload(entry: Entry): void {
    if (entry.downloadId == null) return;
    this.listener?.({ type: 'download', ...downloadMap(entry) });
  }
}

function mediaKey(key: string): string {
  return `${ORIGIN}/media/${encodeURIComponent(key)}`;
}

function blankEntry(key: string, source: SourceDescriptor): Entry {
  return {
    key,
    uri: source.uri,
    headers: source.headers,
    bytes: 0,
    totalBytes: null,
    complete: false,
    lastUsed: Date.now(),
    downloadId: null,
    state: null,
    error: null,
  };
}

function entryAsSource(entry: Entry): SourceDescriptor {
  return {
    uri: entry.uri,
    headers: entry.headers,
    liveHint: false,
    cacheKey: entry.key,
  };
}

function downloadMap(entry: Entry): Record<string, unknown> {
  return {
    id: entry.downloadId,
    uri: entry.uri,
    state: entry.state ?? 'queued',
    bytes: entry.bytes,
    totalBytes: entry.totalBytes,
    error: entry.error,
  };
}

function totalOf(response: StoredResponse): number | null {
  const range = response.headers.get('Content-Range');
  const total =
    range != null
      ? Number(range.split('/')[1])
      : Number(response.headers.get('Content-Length'));
  return Number.isFinite(total) && total > 0 ? total : null;
}

function httpError(status: number): Error {
  return engineError(
    status === 404 || status === 410 ? 'SOURCE_NOT_FOUND' : 'HTTP_ERROR',
    `The server answered ${status} (a cross-origin file needs CORS to be cached).`,
    status >= 500 || status === 0,
    { httpStatus: status }
  );
}

async function drain(response: StoredResponse): Promise<number> {
  const reader = response.body?.getReader();
  if (reader == null) return 0;
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value?.byteLength ?? 0;
  }
}

let shared: WebCache | null = null;

/** The page's one media cache. */
export function webCache(): WebCache {
  shared ??= new WebCache();
  return shared;
}

/** @internal Tests: a fresh cache. */
export function resetWebCache(): void {
  shared = null;
}
