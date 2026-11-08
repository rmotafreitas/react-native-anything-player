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
    const [held, missing] = await Promise.allSettled([url!, other!]);
    expect(held).toMatchObject({
      status: 'fulfilled',
      value: expect.stringMatching(/^blob:/),
    });
    // Not held: the element plays the network URL.
    expect(missing.status).toBe('rejected');
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

  it("a page's stale 'queued' never goes over a file another page stored whole", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const before = globals.fetch as (...args: unknown[]) => Promise<Response>;
    served['https://cdn.example/slow.mp3'] = { bytes: MB };
    globals.fetch = async (...args: unknown[]) => {
      await gate;
      return before(...args);
    };
    const a = new WebCache();
    const b = new WebCache();
    await b.command({ op: 'usage' });
    await a.command({
      op: 'download',
      ...src('https://cdn.example/slow.mp3'),
      id: 's',
    });
    await new Promise((r) => setTimeout(r, 300));
    // a holds the file's fetch lock (its index write is due); b asks for the same download.
    await b.command({
      op: 'download',
      ...src('https://cdn.example/slow.mp3'),
      id: 's',
    });
    await new Promise((r) => setTimeout(r, 50));
    release();
    await new Promise((r) => setTimeout(r, 1300));
    globals.fetch = before;
    // Web Locks (Node 24, browsers): one page fetches the file.
    if ((globalThis as { navigator?: { locks?: unknown } }).navigator?.locks)
      expect(requests.filter((r) => r.url.endsWith('slow.mp3'))).toHaveLength(
        1
      );
    const third = new WebCache();
    expect(await third.command({ op: 'downloads' })).toMatchObject({
      downloads: [{ id: 's', state: 'completed' }],
    });
  });

  it('a page waiting on another page fetching the file sees it complete when that one ends', async () => {
    if (!(globalThis as { navigator?: { locks?: unknown } }).navigator?.locks)
      return;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const before = globals.fetch as (...args: unknown[]) => Promise<Response>;
    served['https://cdn.example/wait.mp3'] = { bytes: MB };
    globals.fetch = async (...args: unknown[]) => {
      await gate;
      return before(...args);
    };
    const a = new WebCache();
    const b = new WebCache();
    await b.command({ op: 'usage' });
    await a.command({
      op: 'download',
      ...src('https://cdn.example/wait.mp3'),
      id: 'w',
    });
    await new Promise((r) => setTimeout(r, 50));
    await b.command({
      op: 'download',
      ...src('https://cdn.example/wait.mp3'),
      id: 'w',
    });
    // b's own index write comes and goes while a still fetches.
    await new Promise((r) => setTimeout(r, 700));
    release();
    await new Promise((r) => setTimeout(r, 1300));
    globals.fetch = before;
    expect(requests.filter((r) => r.url.endsWith('wait.mp3'))).toHaveLength(1);
    expect(await b.command({ op: 'downloads' })).toMatchObject({
      downloads: [{ id: 'w', state: 'completed' }],
    });
    expect(
      await b.command({ op: 'info', ...src('https://cdn.example/wait.mp3') })
    ).toMatchObject({ state: 'complete', downloaded: true });
  });

  it('a download removed and asked for again at once starts afresh, not as the old complete file', async () => {
    served['https://cdn.example/r.mp3'] = { bytes: MB };
    const cache = new WebCache();
    await cache.command({
      op: 'download',
      ...src('https://cdn.example/r.mp3'),
      id: 'r',
    });
    await new Promise((r) => setTimeout(r, 600));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const before = globals.fetch as (...args: unknown[]) => Promise<Response>;
    globals.fetch = async (...args: unknown[]) => {
      await gate;
      return before(...args);
    };
    await cache.command({ op: 'removeDownload', id: 'r' });
    await cache.command({
      op: 'download',
      ...src('https://cdn.example/r.mp3'),
      id: 'r',
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(await cache.command({ op: 'downloads' })).toMatchObject({
      downloads: [{ id: 'r', state: 'queued' }],
    });
    expect(
      await cache.command({ op: 'info', ...src('https://cdn.example/r.mp3') })
    ).toMatchObject({ downloaded: false });
    release();
    await new Promise((r) => setTimeout(r, 50));
    globals.fetch = before;
    expect(await cache.command({ op: 'downloads' })).toMatchObject({
      downloads: [{ id: 'r', state: 'completed' }],
    });
  });

  it('a download of a source with no length fails, and says why', async () => {
    const cache = new WebCache();
    const events: Array<Record<string, unknown>> = [];
    cache.onEvent((e) => events.push(e));
    const globals2 = globalThis as unknown as Record<string, unknown>;
    const before = globals2.fetch;
    globals2.fetch = async () =>
      new Response(new Uint8Array(10), { status: 200 });
    await cache.command({
      op: 'download',
      ...src('https://radio.example/stream.mp3'),
      id: 'r',
    });
    await new Promise((r) => setTimeout(r, 20));
    globals2.fetch = before;
    expect(events.at(-1)).toMatchObject({
      id: 'r',
      state: 'failed',
      error: { code: 'UNSUPPORTED_FORMAT' },
    });
  });

  it('a preload of a file a download holds changes nothing of the download', async () => {
    served['https://cdn.example/a.mp3'] = { bytes: MB };
    const cache = new WebCache();
    await cache.command({
      op: 'download',
      ...src('https://cdn.example/a.mp3'),
      id: 'a',
    });
    await new Promise((r) => setTimeout(r, 20));
    requests = [];
    await cache.command({
      op: 'preload',
      ...src('https://cdn.example/a.mp3'),
      all: true,
    });
    expect(requests).toEqual([]);
    expect(await cache.command({ op: 'downloads' })).toMatchObject({
      downloads: [{ id: 'a', state: 'completed' }],
    });
  });

  it('does not bring back a download another page removed', async () => {
    served['https://cdn.example/x.mp3'] = { bytes: MB };
    const a = new WebCache();
    await a.command({
      op: 'download',
      ...src('https://cdn.example/x.mp3'),
      id: 'x',
    });
    await new Promise((r) => setTimeout(r, 600));
    const b = new WebCache();
    await b.command({ op: 'usage' });
    await a.command({ op: 'removeDownload', id: 'x' });
    await new Promise((r) => setTimeout(r, 600));
    // The stale page plays it (its index still says it is held) and writes.
    b.blobFor(descriptor('https://cdn.example/x.mp3'))?.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 600));
    const third = new WebCache();
    expect(await third.command({ op: 'downloads' })).toEqual({ downloads: [] });
  });

  it('does not cache a file its server asks not to store, but downloads it', async () => {
    const cache = new WebCache();
    const globals2 = globalThis as unknown as Record<string, unknown>;
    const before = globals2.fetch;
    globals2.fetch = async () =>
      new Response(new Uint8Array(100), {
        status: 200,
        headers: { 'Content-Length': '100', 'Cache-Control': 'no-store' },
      });
    await cache.command({
      op: 'preload',
      ...src('https://cdn.example/private.mp3'),
      all: true,
    });
    expect(
      await cache.command({
        op: 'info',
        ...src('https://cdn.example/private.mp3'),
      })
    ).toMatchObject({ state: 'none' });
    await cache.command({
      op: 'download',
      ...src('https://cdn.example/private.mp3'),
      id: 'p',
    });
    await new Promise((r) => setTimeout(r, 20));
    globals2.fetch = before;
    expect(
      await cache.command({
        op: 'info',
        ...src('https://cdn.example/private.mp3'),
      })
    ).toMatchObject({ state: 'complete', downloaded: true });
  });

  it('a download asked for again after its removal is one fetch, which a third ask joins', async () => {
    served['https://cdn.example/a.mp3'] = { bytes: 4 * MB };
    const cache = new WebCache();
    await cache.command({
      op: 'download',
      ...src('https://cdn.example/a.mp3'),
      id: 'a',
    });
    await cache.command({ op: 'removeDownload', id: 'a' });
    await cache.command({
      op: 'download',
      ...src('https://cdn.example/a.mp3'),
      id: 'a',
    });
    await cache.command({
      op: 'preload',
      ...src('https://cdn.example/a.mp3'),
      all: true,
    });
    // The removed one's fetch, and the new one's (the preload joined it).
    expect(requests.length).toBeLessThanOrEqual(2);
    expect(
      await cache.command({ op: 'info', ...src('https://cdn.example/a.mp3') })
    ).toMatchObject({ state: 'complete', downloaded: true });
  });
});
