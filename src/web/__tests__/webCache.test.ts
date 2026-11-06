/// <reference types="node" />
// The web's media cache: Cache Storage bodies, an index next to them, LRU
// eviction, downloads that are never evicted, and blob: URLs for complete files.

import { WebCache, cacheKeyOf } from '../platform/WebCache';

class FakeCacheStore {
  entries = new Map<string, Response>();
  async match(key: string) {
    return this.entries.get(key)?.clone();
  }
  async put(key: string, response: Response) {
    // Like the browser: the body is read to the end before put settles.
    const body = await response.arrayBuffer();
    this.entries.set(key, new Response(body, { headers: response.headers }));
  }
  async delete(key: string) {
    return this.entries.delete(key);
  }
}

const MB = 1024 * 1024;
let store: FakeCacheStore;
let served: Record<string, { status?: number; bytes: number }>;
let requests: Array<{ url: string; headers: Record<string, string> }>;
const globals = globalThis as unknown as Record<string, unknown>;
const saved = { caches: globals.caches, fetch: globals.fetch };

beforeEach(() => {
  store = new FakeCacheStore();
  served = {};
  requests = [];
  globals.caches = { open: async () => store };
  globals.fetch = async (
    url: string,
    init: { headers: Record<string, string> }
  ) => {
    requests.push({ url, headers: init.headers });
    const file = served[url];
    if (file == null) return new Response('', { status: 404 });
    const range = /bytes=0-(\d+)/.exec(init.headers.Range ?? '');
    const length = range
      ? Math.min(file.bytes, Number(range[1]) + 1)
      : file.bytes;
    return new Response(new Uint8Array(length), {
      status: file.status ?? (range ? 206 : 200),
      headers: range
        ? {
            'Content-Range': `bytes 0-${length - 1}/${file.bytes}`,
            'Content-Type': 'audio/mpeg',
          }
        : {
            'Content-Length': String(file.bytes),
            'Content-Type': 'audio/mpeg',
          },
    });
  };
});

afterEach(() => {
  globals.caches = saved.caches;
  globals.fetch = saved.fetch;
});

const src = (uri: string, extra: Record<string, unknown> = {}) => ({
  source: { uri, ...extra },
});
const descriptor = (uri: string) => ({ uri, headers: {}, liveHint: null });

describe('WebCache', () => {
  it('preloads the start of a file into the HTTP cache, or all of it into the store', async () => {
    served['https://cdn.example/a.mp3'] = { bytes: 3 * MB };
    const cache = new WebCache();
    const partial = await cache.command({
      op: 'preload',
      ...src('https://cdn.example/a.mp3'),
      bytes: 1000,
    });
    expect(partial).toEqual({
      state: 'partial',
      bytes: 1000,
      totalBytes: 3 * MB,
      downloaded: false,
    });
    expect(requests[0]!.headers.Range).toBe('bytes=0-999');
    expect(cache.blobFor(descriptor('https://cdn.example/a.mp3'))).toBeNull();

    const whole = await cache.command({
      op: 'preload',
      ...src('https://cdn.example/a.mp3'),
      all: true,
    });
    expect(whole).toEqual({
      state: 'complete',
      bytes: 3 * MB,
      totalBytes: 3 * MB,
      downloaded: false,
    });
    const url = await cache.blobFor(descriptor('https://cdn.example/a.mp3'));
    expect(url).toMatch(/^blob:/);
    expect(await cache.command({ op: 'usage' })).toEqual({
      cacheBytes: 3 * MB,
      downloadBytes: 0,
      maxSizeBytes: 256 * MB,
    });
  });

  it('evicts the least recently played files past its size, never a download', async () => {
    for (const name of ['a', 'b', 'c', 'd'])
      served[`https://cdn.example/${name}.mp3`] = { bytes: 4 * MB };
    const cache = new WebCache();
    await cache.command({ op: 'configure', maxSizeBytes: 9 * MB });
    await cache.command({
      op: 'download',
      ...src('https://cdn.example/d.mp3'),
      id: 'keep',
    });
    await new Promise((r) => setTimeout(r, 10));
    for (const name of ['a', 'b', 'c']) {
      await cache.command({
        op: 'preload',
        ...src(`https://cdn.example/${name}.mp3`),
        all: true,
      });
      await new Promise((r) => setTimeout(r, 2));
    }
    const state = async (name: string) =>
      (
        (await cache.command({
          op: 'info',
          ...src(`https://cdn.example/${name}.mp3`),
        })) as { state: string }
      ).state;
    expect([
      await state('a'),
      await state('b'),
      await state('c'),
      await state('d'),
    ]).toEqual(['none', 'complete', 'complete', 'complete']);
    expect(await cache.command({ op: 'downloads' })).toEqual({
      downloads: [
        {
          id: 'keep',
          uri: 'https://cdn.example/d.mp3',
          state: 'completed',
          bytes: 4 * MB,
          totalBytes: 4 * MB,
          error: null,
        },
      ],
    });
    await cache.command({ op: 'clear' });
    expect([await state('b'), await state('d')]).toEqual(['none', 'complete']);
    await cache.command({ op: 'removeDownload', id: 'keep' });
    expect(await state('d')).toBe('none');
  });

  it('keys by cacheKey: a re-signed URL finds the same bytes', async () => {
    served['https://cdn.example/a.mp3?sig=1'] = { bytes: MB };
    const cache = new WebCache();
    await cache.command({
      op: 'preload',
      ...src('https://cdn.example/a.mp3?sig=1', { cacheKey: 'ep-1' }),
      all: true,
    });
    const info = await cache.command({
      op: 'info',
      ...src('https://cdn.example/a.mp3?sig=2', { cacheKey: 'ep-1' }),
    });
    expect(info).toMatchObject({ state: 'complete' });
    expect(cacheKeyOf({ uri: 'https://x.example/a.mp3#t=3' })).toBe(
      'https://x.example/a.mp3'
    );
  });

  it('reports a failed download, refuses streams and adaptive sources, and holds nothing of them', async () => {
    const cache = new WebCache();
    const events: Array<Record<string, unknown>> = [];
    cache.onEvent((e) => events.push(e));
    await cache.command({
      op: 'download',
      ...src('https://cdn.example/missing.mp3'),
      id: 'x',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(events.at(-1)).toMatchObject({
      type: 'download',
      id: 'x',
      state: 'failed',
      error: { code: 'SOURCE_NOT_FOUND' },
    });
    await expect(
      cache.command({ op: 'download', ...src('https://cdn.example/v.m3u8') })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    await expect(
      cache.command({
        op: 'download',
        ...src('https://radio.example/live', { live: true }),
      })
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    expect(
      cache.blobFor({
        ...descriptor('https://radio.example/live'),
        liveHint: true,
      })
    ).toBeNull();
  });

  it('keeps its index across pages, and writes what plays once it has played a while, when on', async () => {
    jest.useFakeTimers({
      doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'],
    });
    served['https://cdn.example/a.mp3'] = { bytes: MB };
    const cache = new WebCache();
    await cache.command({ op: 'configure', enabled: true });
    cache.played(descriptor('https://cdn.example/a.mp3'), 'p1');
    cache.played(
      { ...descriptor('https://cdn.example/b.mp3'), cache: false },
      'p2'
    );
    await jest.advanceTimersByTimeAsync(5_000);
    await jest.advanceTimersByTimeAsync(600);
    expect(requests.map((r) => r.url)).toEqual(['https://cdn.example/a.mp3']);
    jest.useRealTimers();
    await new Promise((r) => setTimeout(r, 10));
    const next = new WebCache();
    expect(
      await next.command({ op: 'info', ...src('https://cdn.example/a.mp3') })
    ).toMatchObject({ state: 'complete' });
  });

  it('says so where there is no Cache Storage', async () => {
    globals.caches = undefined;
    const cache = new WebCache();
    await expect(
      cache.command({ op: 'download', ...src('https://cdn.example/a.mp3') })
    ).rejects.toMatchObject({ code: 'CACHE_UNAVAILABLE' });
  });

  it('a download asked for while the file is being cached finishes as that download', async () => {
    served['https://cdn.example/a.mp3'] = { bytes: 2 * MB };
    const cache = new WebCache();
    const events: Array<Record<string, unknown>> = [];
    cache.onEvent((e) => events.push(e));
    const filling = cache.command({
      op: 'preload',
      ...src('https://cdn.example/a.mp3'),
      all: true,
    });
    await cache.command({
      op: 'download',
      ...src('https://cdn.example/a.mp3'),
      id: 'd',
    });
    await filling;
    expect(events.at(-1)).toMatchObject({ id: 'd', state: 'completed' });
    expect(
      await cache.command({ op: 'info', ...src('https://cdn.example/a.mp3') })
    ).toMatchObject({ state: 'complete', downloaded: true });
  });

  it('drops an entry whose stored bytes are gone, and plays from the network then', async () => {
    served['https://cdn.example/a.mp3'] = { bytes: MB };
    const cache = new WebCache();
    await cache.command({
      op: 'preload',
      ...src('https://cdn.example/a.mp3'),
      all: true,
    });
    store.entries.delete(
      [...store.entries.keys()].find((k) => k.includes('/media/'))!
    );
    await expect(
      cache.blobFor(descriptor('https://cdn.example/a.mp3'))
    ).rejects.toBeTruthy();
    await new Promise((r) => setTimeout(r, 10));
    expect(
      await cache.command({ op: 'info', ...src('https://cdn.example/a.mp3') })
    ).toMatchObject({ state: 'none' });
  });

  it('answers a page that just opened once its index is read', async () => {
    served['https://cdn.example/a.mp3'] = { bytes: MB };
    const first = new WebCache();
    await first.command({
      op: 'download',
      ...src('https://cdn.example/a.mp3'),
      id: 'a',
    });
    await new Promise((r) => setTimeout(r, 600));
    const page = new WebCache();
    const url = page.blobFor(descriptor('https://cdn.example/a.mp3'));
    const other = page.blobFor(descriptor('https://cdn.example/other.mp3'));
    expect(url).not.toBeNull();
    await expect(url).resolves.toMatch(/^blob:/);
    // Not held: the element plays the network URL.
    await expect(other).rejects.toBeTruthy();
    expect(
      page.blobFor(descriptor('https://cdn.example/other.mp3'))
    ).toBeNull();
  });

  it('a removed download stops, and leaves no bytes behind', async () => {
    served['https://cdn.example/big.mp3'] = { bytes: 8 * MB };
    const cache = new WebCache();
    await cache.command({
      op: 'download',
      ...src('https://cdn.example/big.mp3'),
      id: 'big',
    });
    await cache.command({ op: 'removeDownload', id: 'big' });
    await new Promise((r) => setTimeout(r, 20));
    expect(
      [...store.entries.keys()].filter((k) => k.includes('/media/'))
    ).toEqual([]);
    expect(await cache.command({ op: 'downloads' })).toEqual({ downloads: [] });
  });

  it('does not fetch a file larger than the whole cache, nor a skipped item', async () => {
    jest.useFakeTimers({
      doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'],
    });
    served['https://cdn.example/huge.mp4'] = { bytes: 20 * MB };
    served['https://cdn.example/a.mp3'] = { bytes: MB };
    served['https://cdn.example/b.mp3'] = { bytes: MB };
    const cache = new WebCache();
    await cache.command({
      op: 'configure',
      enabled: true,
      maxSizeBytes: 10 * MB,
    });
    cache.played(descriptor('https://cdn.example/a.mp3'), 'p');
    await jest.advanceTimersByTimeAsync(1_000);
    cache.played(descriptor('https://cdn.example/b.mp3'), 'p');
    await jest.advanceTimersByTimeAsync(6_000);
    expect(requests.map((r) => r.url)).toEqual(['https://cdn.example/b.mp3']);
    jest.useRealTimers();
    await cache.command({
      op: 'preload',
      ...src('https://cdn.example/huge.mp4'),
      all: true,
    });
    expect(
      await cache.command({
        op: 'info',
        ...src('https://cdn.example/huge.mp4'),
      })
    ).toMatchObject({ state: 'none' });
  });

  it("keeps another page's downloads in the index it writes", async () => {
    served['https://cdn.example/a.mp3'] = { bytes: MB };
    served['https://cdn.example/b.mp3'] = { bytes: MB };
    const a = new WebCache();
    const b = new WebCache();
    await a.command({ op: 'usage' });
    await b.command({
      op: 'download',
      ...src('https://cdn.example/b.mp3'),
      id: 'b',
    });
    await new Promise((r) => setTimeout(r, 600));
    await a.command({
      op: 'download',
      ...src('https://cdn.example/a.mp3'),
      id: 'a',
    });
    await new Promise((r) => setTimeout(r, 600));
    const third = new WebCache();
    const ids = (
      (await third.command({ op: 'downloads' })) as {
        downloads: Array<{ id: string }>;
      }
    ).downloads.map((d) => d.id);
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});
