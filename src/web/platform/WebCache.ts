// The web's media cache (`Cache`): whole files kept in Cache Storage, with
// an index (what is held, its size, when it last played, which downloads
// keep it) stored next to them. A complete item plays from a `blob:` URL
// made from its stored body, so it starts at once and plays offline.
// What it cannot do, and says so: a cross-origin file without CORS (its
// bytes cannot be read), HLS and DASH (their segments are not files the
// element plays), and a partial file (only the browser's own HTTP cache
// keeps part of a file: `preload` warms it).

import { engineError, type SourceDescriptor } from '../engine/types';
import { browser, type AbortControllerLike } from './dom';

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
  pipeThrough?(transform: unknown): unknown;
}

type TransformConstructor = new (transformer: {
  transform(
    chunk: { byteLength: number },
    controller: { enqueue(chunk: unknown): void }
  ): void;
}) => unknown;

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
  navigator?: {
    storage?: { persist?(): Promise<boolean> };
    locks?: {
      request(name: string, task: () => Promise<void>): Promise<void>;
      request(
        name: string,
        options: { ifAvailable: boolean },
        task: (lock: unknown) => Promise<void>
      ): Promise<void>;
    };
  };
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
  private readonly loaded: Promise<void>;
  private isLoaded = false;
  private enabled = false;
  private maxSize = DEFAULT_MAX;
  /** Blob URLs of complete files, most recently used last (kept from eviction). */
  private readonly blobs = new Map<string, Promise<string>>();
  /** Fills in flight, by key, and how to stop them. */
  private readonly filling = new Map<
    string,
    { work: Promise<void>; stop: AbortControllerLike }
  >();
  /** A player's pending write of what it plays (`played`), by player. */
  private readonly timers = new Map<string, { key: string; timer: number }>();
  /** Keys this page changed or removed since it last wrote the index. */
  private readonly dirty = new Set<string>();
  private readonly deleted = new Set<string>();
  /** Keys this page holds the fetch lock of (`oneFetch`). */
  private readonly holding = new Map<string, number>();
  /** Blob URLs past the protected set, revoked when their file goes. */
  private readonly loose = new Map<string, Promise<string>>();
  /** The keys the stored index had when this page last read it. */
  private known = new Set<string>();
  private listener: ((event: Record<string, unknown>) => void) | null = null;
  private saving: number | null = null;

  constructor() {
    // No Cache Storage (an insecure page, an old browser): nothing to wait for.
    this.isLoaded = g().caches == null;
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
   * too), or `null` when the source is not held whole. Before the index is
   * read (a page just opened), a promise that settles once it is: rejected
   * when the file is not held, and the element plays the network URL.
   */
  blobFor(source: SourceDescriptor): Promise<string> | null {
    if (!cacheable(source)) return null;
    if (!this.isLoaded) {
      return this.loaded.then(
        () => this.blobForLoaded(source) ?? Promise.reject(notHeld())
      );
    }
    return this.blobForLoaded(source);
  }

  /**
   * A player began an item: with the cache on, the file is written once it
   * has had a few seconds (a skipped item is not fetched). The player's
   * previous item, if not written yet, no longer is.
   */
  played(source: SourceDescriptor, player: string): void {
    const pending = this.timers.get(player);
    if (pending != null) {
      browser().clearTimeout(pending.timer);
      this.timers.delete(player);
    }
    const key = cacheKeyOf(source);
    const wanted = source.cache ?? this.enabled;
    if (!wanted || !cacheable(source) || this.index.get(key)?.complete) return;
    const timer = browser().setTimeout(() => {
      this.timers.delete(player);
      // A page that just opened may not have read that it holds the file.
      this.loaded
        .then(() =>
          this.index.get(key)?.complete ? undefined : this.fill(source, null)
        )
        .catch(() => undefined);
    }, CACHE_AFTER_MS);
    this.timers.set(player, { key, timer });
  }

  // ── Internals ──

  private blobForLoaded(source: SourceDescriptor): Promise<string> | null {
    const entry = this.index.get(cacheKeyOf(source));
    if (entry == null || !entry.complete) return null;
    entry.lastUsed = Date.now();
    this.changed(entry.key);
    const key = entry.key;
    // A URL made before (still protected, or loose) is the one: never a second.
    let url = this.blobs.get(key) ?? this.loose.get(key);
    this.loose.delete(key);
    if (url == null) {
      url = this.body(key).then((blob) => {
        if (blob != null) return browser().URL.createObjectURL(blob);
        // The index outlived the body (cleared storage, another page): it goes.
        this.drop(key).catch(() => undefined);
        throw notHeld();
      });
      url.catch(() => this.blobs.delete(key));
    } else {
      this.blobs.delete(key);
    }
    this.blobs.set(key, url);
    this.trimBlobs();
    return url;
  }

  private source(command: Record<string, unknown>): SourceDescriptor {
    const map = (command.source ?? {}) as Record<string, unknown>;
    return {
      uri: String(map.uri ?? ''),
      headers: (map.headers as Record<string, string> | undefined) ?? {},
      liveHint: typeof map.live === 'boolean' ? map.live : null,
      cacheKey: typeof map.cacheKey === 'string' ? map.cacheKey : null,
      drm: (map.drm as SourceDescriptor['drm']) ?? null,
    };
  }

  private open(): Promise<CacheLike> {
    const caches = g().caches;
    if (caches == null) return Promise.reject(unavailable());
    this.store ??= caches.open(STORE);
    return this.store;
  }

  private async readStored(): Promise<Entry[]> {
    const store = await this.open();
    const stored = await store.match(INDEX_KEY);
    return stored ? ((await stored.json()) as Entry[]) : [];
  }

  private async load(): Promise<void> {
    try {
      for (const entry of await this.readStored())
        this.index.set(entry.key, entry);
      this.known = new Set(this.index.keys());
      // A download a page left half-way starts again (the web cannot resume a file).
      for (const entry of this.index.values()) {
        const unfinished =
          entry.state === 'queued' || entry.state === 'downloading';
        if (entry.downloadId == null || !unfinished) continue;
        entry.state = 'queued';
        this.fill(entryAsSource(entry), entry.downloadId).catch(
          () => undefined
        );
      }
    } catch {
      // No Cache Storage: commands report CACHE_UNAVAILABLE.
    } finally {
      this.isLoaded = true;
    }
  }

  private saveSoon(): void {
    if (this.saving != null) return;
    this.saving = browser().setTimeout(() => {
      this.saving = null;
      this.save().catch(() => undefined);
    }, 500);
  }

  /** One changed key onto the stored index; one another page removed is let go. */
  private writeKey(
    stored: Map<string, Entry>,
    key: string,
    removedHere: boolean
  ): void {
    const entry = this.index.get(key);
    if (entry == null) return;
    if (!removedHere && !stored.has(key) && this.known.has(key))
      this.index.delete(key);
    else {
      adoptComplete(entry, stored.get(key));
      stored.set(key, entry);
    }
  }

  /** A key leaves the index (and the stored one, at the next write). */
  private forget(key: string): void {
    this.index.delete(key);
    this.dirty.delete(key);
    this.deleted.add(key);
    this.saveSoon();
  }

  /** A key changed: written with the index soon. */
  private changed(key: string): void {
    this.dirty.add(key);
    this.saveSoon();
  }

  /**
   * Writes this page's changes onto the stored index (another page of this
   * site may have written since): its changed keys and its removals, one
   * page at a time where the browser has Web Locks. A key another page
   * removed is not written back; this page lets go of it too.
   */
  private async save(): Promise<void> {
    const write = async () => {
      const Response = g().Response;
      if (Response == null) return;
      const stored = new Map(
        (await this.readStored()).map((e) => [e.key, e] as const)
      );
      for (const key of this.deleted) stored.delete(key);
      for (const key of this.dirty)
        this.writeKey(stored, key, this.deleted.has(key));
      this.dirty.clear();
      this.deleted.clear();
      // What other pages wrote and this page has not: it sees it too.
      for (const [key, entry] of stored) {
        const local = this.index.get(key);
        if (local == null) this.index.set(key, entry);
        else adoptComplete(local, entry);
      }
      // What another page removed (and this one did not touch) goes here too.
      for (const key of [...this.index.keys()]) {
        if (!stored.has(key) && this.known.has(key)) this.index.delete(key);
      }
      this.known = new Set(stored.keys());
      const store = await this.open();
      await store.put(
        INDEX_KEY,
        new Response(JSON.stringify([...stored.values()]), {
          headers: { 'Content-Type': 'application/json' },
        })
      );
    };
    const locks = g().navigator?.locks;
    if (locks != null) await locks.request(INDEX_KEY, write);
    else await write();
  }

  private async body(key: string): Promise<unknown> {
    const store = await this.open();
    const stored = await store.match(mediaKey(key));
    return stored ? stored.blob() : null;
  }

  /** The one record of a key: a download and a fill of the same file share it. */
  private entryFor(key: string, source: SourceDescriptor): Entry {
    let entry = this.index.get(key);
    if (entry == null) {
      entry = blankEntry(key, source);
      this.index.set(key, entry);
      // A removal before it stays in `deleted`: the stored entry goes, then this one is written.
      this.changed(key);
    }
    return entry;
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
    if (this.index.get(key)?.complete) return this.info(source);
    // Part of a file: into the browser's HTTP cache, which the element reads from.
    const bytes =
      typeof command.bytes === 'number' ? command.bytes : DEFAULT_PRELOAD;
    const stop = new (browser().AbortController)();
    const response = await fetchFile(
      source,
      { Range: `bytes=0-${bytes - 1}` },
      stop.signal
    );
    // A server that ignores the range sends the whole file: enough at the budget.
    let got = 0;
    try {
      await drain(response, (n) => {
        got += n;
        if (got >= bytes) stop.abort();
      });
    } catch {
      // Stopped at the budget.
    }
    const entry = this.entryFor(key, source);
    entry.bytes = Math.max(entry.bytes, got);
    entry.totalBytes = totalOf(response) ?? entry.totalBytes;
    entry.lastUsed = Date.now();
    this.changed(key);
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
    const name = id ?? source.uri;
    // An id names one download: given again for another file, it moves there.
    const other = [...this.index.values()].find(
      (e) => e.downloadId === name && e.key !== key
    );
    if (other != null) await this.drop(other.key);
    const entry = this.entryFor(key, source);
    entry.downloadId = name;
    // Kept to start it again at the next visit (a download's only).
    entry.headers = source.headers;
    // Asked again while it runs: it is still downloading.
    const running = this.filling.has(key) ? 'downloading' : 'queued';
    entry.state = entry.complete ? 'completed' : running;
    entry.error = null;
    this.changed(key);
    // Ask the browser not to evict what the user downloaded.
    g()
      .navigator?.storage?.persist?.()
      .catch(() => undefined);
    // A fill already running for this file finishes as this download.
    if (!entry.complete) this.fill(source, name).catch(() => undefined);
    this.emitDownload(entry);
    return downloadMap(entry);
  }

  /** Stores a whole file (a download when `downloadId`). */
  private fill(
    source: SourceDescriptor,
    downloadId: string | null
  ): Promise<void> {
    const key = cacheKeyOf(source);
    const held = this.index.get(key);
    // Held whole already: a download of it is done at once.
    if (held?.complete) {
      if (downloadId != null && held.state !== 'completed') {
        held.state = 'completed';
        this.emitDownload(held);
        this.changed(key);
      }
      return Promise.resolve();
    }
    const running = this.filling.get(key);
    if (running) return running.work;
    const stop = new (browser().AbortController)();
    const work: Promise<void> = this.oneFetch(key, () =>
      this.fetchWhole(source, key, downloadId, stop)
    ).finally(() => {
      // Only its own entry: a removal may have let a newer fill take the key.
      if (this.filling.get(key)?.work === work) this.filling.delete(key);
    });
    this.filling.set(key, { work, stop });
    return work;
  }

  /**
   * One page of this site fetches a file at a time (Web Locks): another
   * page already fetching it lets this one go. The file it stores whole
   * reaches this page at its next index write (`adoptComplete`), and is
   * never written over.
   */
  private oneFetch(key: string, fetch: () => Promise<void>): Promise<void> {
    const locks = g().navigator?.locks;
    if (locks == null) return fetch();
    // This page's own earlier fetch (one being removed) is waited for, not skipped.
    const own = (this.holding.get(key) ?? 0) > 0;
    const run = (lock: unknown): Promise<void> => {
      if (lock == null) return Promise.resolve();
      this.holding.set(key, (this.holding.get(key) ?? 0) + 1);
      return fetch().finally(() => {
        const left = (this.holding.get(key) ?? 1) - 1;
        if (left > 0) this.holding.set(key, left);
        else this.holding.delete(key);
      });
    };
    const name = `${INDEX_KEY}/fetch/${key}`;
    return locks.request(name, { ifAvailable: !own }, run);
  }

  private async fetchWhole(
    source: SourceDescriptor,
    key: string,
    downloadId: string | null,
    stop: AbortControllerLike
  ): Promise<void> {
    const entry = this.entryFor(key, source);
    if (downloadId != null) entry.downloadId = downloadId;
    try {
      const store = await this.open();
      const Response = g().Response;
      const response = await fetchFile(source, {}, stop.signal);
      if (response.body == null || Response == null) throw httpError(0);
      const total = totalOf(response);
      const noStore = /no-store/i.test(
        response.headers.get('Cache-Control') ?? ''
      );
      // No length: a stream that never ends (a live source without `live: true`).
      if (total == null) {
        const error = engineError(
          'UNSUPPORTED_FORMAT',
          'The source has no length: a live stream cannot be kept.',
          false
        );
        this.fillFailed(entry, error);
        stop.abort();
        throw error;
      }
      // Larger than the whole cache, or a server that asks not to be stored: not for the cache.
      if (entry.downloadId == null && (total > this.maxSize || noStore)) {
        stop.abort();
        this.forget(key);
        return;
      }
      entry.totalBytes = total;
      if (entry.downloadId != null) entry.state = 'downloading';
      const type = response.headers.get('Content-Type');
      await store.put(
        mediaKey(key),
        new Response(this.counted(response.body, entry), {
          headers: type ? { 'Content-Type': type } : {},
        })
      );
      if (this.index.get(key) !== entry) {
        // Removed while it arrived: its bytes go too.
        await store.delete(mediaKey(key));
        return;
      }
      entry.complete = true;
      entry.lastUsed = Date.now();
      if (entry.downloadId != null) entry.state = 'completed';
      this.emitDownload(entry);
      await this.evict();
    } catch (error) {
      if (stop.signal.aborted || this.index.get(key) !== entry) return;
      this.fillFailed(entry, error);
      throw error;
    } finally {
      this.changed(key);
    }
  }

  /** A download that failed says why; a fill for the cache leaves nothing behind. */
  private fillFailed(entry: Entry, error: unknown): void {
    if (entry.downloadId == null) {
      if (!entry.complete) this.forget(entry.key);
      return;
    }
    const e = error as {
      code?: string;
      message?: string;
      recoverable?: boolean;
    };
    entry.state = 'failed';
    entry.error = {
      code: e.code ?? 'NETWORK_ERROR',
      message: String(e.message ?? error),
      recoverable: e.recoverable ?? true,
    };
    this.emitDownload(entry);
  }

  /**
   * The body as it is stored, counting its bytes on the way (a download's
   * progress). Through a transform where there is one: no second copy of
   * the file waits in memory.
   */
  private counted(body: BodyStream, entry: Entry): unknown {
    const Transform = (
      globalThis as unknown as { TransformStream?: TransformConstructor }
    ).TransformStream;
    let told = 0;
    entry.bytes = 0;
    const tick = (bytes: number) => {
      entry.bytes += bytes;
      const now = Date.now();
      if (entry.downloadId != null && now - told >= PROGRESS_MS) {
        told = now;
        this.emitDownload(entry);
      }
    };
    if (Transform != null && body.pipeThrough != null) {
      return body.pipeThrough(
        new Transform({
          transform(chunk, controller) {
            tick(chunk.byteLength);
            controller.enqueue(chunk);
          },
        })
      );
    }
    const [stored, counting] = body.tee();
    drain(counting, tick).catch(() => undefined);
    return stored;
  }

  private async removeDownload(id: string): Promise<void> {
    for (const entry of [...this.index.values()]) {
      if (entry.downloadId === id) await this.drop(entry.key);
    }
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
  }

  /**
   * The least recently played go until the cache fits. Downloads stay, and
   * so do the files players hold as `blob:` URLs (one may be playing).
   */
  private async evict(): Promise<void> {
    const cached = [...this.index.values()].filter(
      (e) => e.downloadId == null && e.complete
    );
    let total = cached.reduce((sum, e) => sum + e.bytes, 0);
    const candidates = cached
      .filter((e) => !this.blobs.has(e.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of candidates) {
      if (total <= this.maxSize) break;
      total -= entry.bytes;
      await this.drop(entry.key);
    }
  }

  private async drop(key: string): Promise<void> {
    this.filling.get(key)?.stop.abort();
    // A download asked for now starts afresh, not on the dying fill.
    this.filling.delete(key);
    this.index.delete(key);
    this.dirty.delete(key);
    this.deleted.add(key);
    const url = this.blobs.get(key) ?? this.loose.get(key);
    this.blobs.delete(key);
    this.loose.delete(key);
    url?.then((u) => browser().URL.revokeObjectURL(u)).catch(() => undefined);
    const store = await this.open();
    await store.delete(mediaKey(key));
    this.saveSoon();
  }

  private trimBlobs(): void {
    while (this.blobs.size > LIVE_BLOBS) {
      const [key, url] = this.blobs.entries().next().value as [
        string,
        Promise<string>,
      ];
      // Out of the protected set; the URL itself stays (a player may still
      // play from it): it goes with the file, or with the page.
      this.blobs.delete(key);
      this.loose.set(key, url);
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
    // Stored only for a download (it is started again from them).
    headers: {},
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
  // A part (206) whose range a cross-origin page cannot read: its length is the part's, not the file's.
  if (range == null && response.status === 206) return null;
  const total =
    range != null
      ? Number(range.split('/')[1])
      : Number(response.headers.get('Content-Length'));
  return Number.isFinite(total) && total > 0 ? total : null;
}

function notHeld(): Error {
  return engineError('NO_SOURCE', 'The cache does not hold this file.', true);
}

/** Fetches a file with CORS; a refused or failed request as RNAP's error. */
async function fetchFile(
  source: SourceDescriptor,
  extra: Record<string, string>,
  signal?: unknown
): Promise<StoredResponse> {
  let response: StoredResponse;
  try {
    response = await g().fetch(source.uri, {
      headers: { ...source.headers, ...extra },
      mode: 'cors',
      ...(signal != null ? { signal } : {}),
    });
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError') throw error;
    throw engineError(
      'NETWORK_ERROR',
      'The file could not be fetched (offline, or its server sends no CORS headers: the page cannot read its bytes).',
      true
    );
  }
  if (!response.ok) throw httpError(response.status);
  return response;
}

function httpError(status: number): Error {
  return engineError(
    status === 404 || status === 410 ? 'SOURCE_NOT_FOUND' : 'HTTP_ERROR',
    `The server answered ${status} (a cross-origin file needs CORS to be cached).`,
    status >= 500 || status === 0,
    { httpStatus: status }
  );
}

async function drain(
  source: StoredResponse | BodyStream,
  tick?: (bytes: number) => void
): Promise<number> {
  const body = 'getReader' in source ? source : source.body;
  const reader = body?.getReader();
  if (reader == null) return 0;
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    const n = value?.byteLength ?? 0;
    bytes += n;
    tick?.(n);
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

/**
 * A file another page stored whole stays whole: this page's stale view of it
 * (`queued`, part of it) is never written over it.
 */
function adoptComplete(local: Entry, stored: Entry | undefined): void {
  if (stored == null || local === stored || !stored.complete || local.complete)
    return;
  local.complete = true;
  local.bytes = stored.bytes;
  local.totalBytes = stored.totalBytes;
  if (local.downloadId != null) {
    local.state = 'completed';
    local.error = null;
  }
}
