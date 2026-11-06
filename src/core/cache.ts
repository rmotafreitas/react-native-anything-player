// `Cache`: media kept on the device. A cache written as items play (off by
// default), bytes fetched ahead (`preload`), and downloads kept for offline
// replay, never evicted. App-global: every player reads the same cache. The
// platform does the work (Media3's cache on Android, the stream proxy and
// AVAssetDownloadURLSession on iOS, Cache Storage on the web), so a cached
// item plays while JavaScript is frozen and with no network. See the Cache
// and offline guide.

import { PlayerError, toPlayerError } from '../errors';
import type { PlayerErrorInfo, SourceInput } from '../types';
import { host } from './host';
import { onModuleEvent } from './moduleEvents';
import { ensureSubscription, normalizeSource } from './Player';

/** `Cache.configure()`. */
export interface CacheOptions {
  /**
   * Write what plays to the cache, and play it from there next time
   * (finite sources over HTTP(S): files in any container, HLS and DASH on
   * demand). Off by default. A source's own `cache` wins.
   */
  enabled?: boolean;
  /** The cache's size; the least recently played go first. Default 256 MB. Downloads do not count. */
  maxSizeBytes?: number;
}

/** How much of a source the device holds. */
export type CacheState = 'none' | 'partial' | 'complete';

/** `Cache.info()`. */
export interface CacheInfo {
  state: CacheState;
  /** Bytes held (the cache and downloads). */
  bytes: number;
  /** The source's size when known. */
  totalBytes: number | null;
  /** A download holds it (kept until removed). */
  downloaded: boolean;
}

/** `Cache.usage()`. */
export interface CacheUsage {
  /** Bytes in the cache written as items play and by `preload`. */
  cacheBytes: number;
  /** Bytes kept by downloads. */
  downloadBytes: number;
  /** The cache's size limit. */
  maxSizeBytes: number;
}

/** A download's state. */
export type DownloadState = 'queued' | 'downloading' | 'completed' | 'failed';

/** `Cache.downloads()` and the `download` event. */
export interface DownloadInfo {
  /** Yours (`Cache.download(source, { id })`), else the source's URL. */
  id: string;
  /** The source's URL. */
  uri: string;
  state: DownloadState;
  bytes: number;
  totalBytes: number | null;
  /** Why it failed, while `failed`. */
  error: PlayerErrorInfo | null;
}

const MB = 1024 * 1024;
const native = () => host().module();

async function run<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toPlayerError(error);
  }
}

function invalid(message: string): PlayerError {
  return new PlayerError({
    code: 'INVALID_ARGUMENT',
    message,
    recoverable: false,
  });
}

/** A source as the module takes it (`load()`'s rules). */
function wire(source: SourceInput): Record<string, unknown> {
  return normalizeSource(source);
}

function command(
  op: string,
  fields: Record<string, unknown> = {}
): Promise<object> {
  return run(() => native().cacheCommand({ op, ...fields }));
}

function download(raw: unknown): DownloadInfo {
  const map = (raw ?? {}) as Record<string, unknown>;
  return {
    id: String(map.id ?? ''),
    uri: String(map.uri ?? ''),
    state: (map.state as DownloadState) ?? 'queued',
    bytes: typeof map.bytes === 'number' ? map.bytes : 0,
    totalBytes: typeof map.totalBytes === 'number' ? map.totalBytes : null,
    error: (map.error as PlayerErrorInfo | null | undefined) ?? null,
  };
}

function info(raw: unknown): CacheInfo {
  const map = (raw ?? {}) as Record<string, unknown>;
  const state =
    map.state === 'complete' || map.state === 'partial' ? map.state : 'none';
  return {
    state,
    bytes: typeof map.bytes === 'number' ? map.bytes : 0,
    totalBytes: typeof map.totalBytes === 'number' ? map.totalBytes : null,
    downloaded: map.downloaded === true,
  };
}

export const Cache = {
  /** Turns the cache written as items play on or off, and sets its size. */
  async configure(options: CacheOptions): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (options.enabled != null) fields.enabled = options.enabled === true;
    if (options.maxSizeBytes != null) {
      if (
        !Number.isFinite(options.maxSizeBytes) ||
        options.maxSizeBytes < 8 * MB
      )
        throw invalid('maxSizeBytes must be at least 8 MB.');
      fields.maxSizeBytes = Math.floor(options.maxSizeBytes);
    }
    await command('configure', fields);
  },

  /**
   * Fetches the start of a source into the cache (`bytes`, default 1 MB; for
   * HLS and DASH, the first segments), or all of it (`all`), so that a
   * later `load()` starts at once. A live source is only connected to ahead
   * where the platform can (nothing reaches the station: no listener is
   * counted). Resolves when it is done.
   */
  async preload(
    source: SourceInput,
    options: { bytes?: number; all?: boolean } = {}
  ): Promise<CacheInfo> {
    const fields: Record<string, unknown> = { source: wire(source) };
    if (options.all === true) fields.all = true;
    if (options.bytes != null) {
      if (!Number.isFinite(options.bytes) || options.bytes <= 0)
        throw invalid('bytes must be > 0.');
      fields.bytes = Math.floor(options.bytes);
    }
    return info(await command('preload', fields));
  },

  /**
   * Downloads a source for offline replay: kept until `removeDownload`,
   * never evicted. Files in any container, HLS and DASH on demand (one
   * quality: the source's `quality`, else the best that fits). Resolves once
   * it is queued; follow it with the `download` event.
   */
  async download(
    source: SourceInput,
    options: { id?: string } = {}
  ): Promise<DownloadInfo> {
    if (
      options.id != null &&
      (typeof options.id !== 'string' || options.id === '')
    )
      throw invalid('A download id must be a non-empty string.');
    return download(
      await command('download', {
        source: wire(source),
        id: options.id ?? null,
      })
    );
  },

  /** Every download, finished or not. */
  async downloads(): Promise<DownloadInfo[]> {
    const result = (await command('downloads')) as { downloads?: unknown[] };
    return (result.downloads ?? []).map(download);
  },

  /** Stops and deletes a download. */
  async removeDownload(id: string): Promise<void> {
    await command('removeDownload', { id });
  },

  /** How much of a source the device holds. */
  async info(source: SourceInput): Promise<CacheInfo> {
    return info(await command('info', { source: wire(source) }));
  },

  /** Bytes in the cache and in downloads. */
  async usage(): Promise<CacheUsage> {
    const map = (await command('usage')) as Record<string, unknown>;
    return {
      cacheBytes: Number(map.cacheBytes ?? 0),
      downloadBytes: Number(map.downloadBytes ?? 0),
      maxSizeBytes: Number(map.maxSizeBytes ?? 0),
    };
  },

  /** Empties the cache (downloads stay). For a sign-out, also remove the downloads. */
  async clear(): Promise<void> {
    await command('clear');
  },

  /** A download progressed (at most once a second), finished or failed. Returns the unsubscribe function. */
  addListener(
    event: 'download',
    listener: (download: DownloadInfo) => void
  ): () => void {
    if (event !== 'download')
      throw invalid(`Unknown cache event "${String(event)}".`);
    ensureSubscription();
    return onModuleEvent((e) => {
      if (e.type === 'download') listener(download(e));
    });
  },
};
