// `Cache` on React Native: what it sends native and how it reads the answers.
import { fake } from './FakeNative';

jest.mock('../native/NativeAnythingPlayer', () => ({
  __esModule: true,
  default: require('./FakeNative').fake,
}));

import { Cache } from '../index';

const sent = () =>
  fake.calls.filter((c) => c[0] === 'cacheCommand').map((c) => c[1]);

beforeEach(() => {
  fake.calls = [];
  fake.rejectNext = null;
  fake.cacheAnswer = {};
});

describe('Cache', () => {
  it('configures, preloads, downloads and asks, with sources normalized as load() does', async () => {
    await Cache.configure({ enabled: true, maxSizeBytes: 64 * 1024 * 1024 });
    fake.cacheAnswer = {
      state: 'partial',
      bytes: 1000,
      totalBytes: 5000,
      downloaded: false,
    };
    expect(
      await Cache.preload(
        {
          uri: 'https://cdn.example/a.mp3',
          cacheKey: 'a',
          headers: { A: '1' },
        },
        { bytes: 1000 }
      )
    ).toEqual({
      state: 'partial',
      bytes: 1000,
      totalBytes: 5000,
      downloaded: false,
    });
    fake.cacheAnswer = {
      id: 'ep',
      uri: 'https://cdn.example/a.mp3',
      state: 'queued',
      bytes: 0,
      totalBytes: null,
      error: null,
    };
    expect(
      await Cache.download('https://cdn.example/a.mp3', { id: 'ep' })
    ).toMatchObject({ id: 'ep', state: 'queued' });
    expect(sent()).toEqual([
      { op: 'configure', enabled: true, maxSizeBytes: 64 * 1024 * 1024 },
      {
        op: 'preload',
        source: {
          uri: 'https://cdn.example/a.mp3',
          headers: { A: '1' },
          cacheKey: 'a',
        },
        bytes: 1000,
      },
      {
        op: 'download',
        source: { uri: 'https://cdn.example/a.mp3' },
        id: 'ep',
      },
    ]);
  });

  it('refuses bad arguments before anything is sent', async () => {
    await expect(Cache.configure({ maxSizeBytes: 10 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(
      Cache.preload('https://a', { bytes: 0 })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(Cache.download('https://a', { id: '' })).rejects.toMatchObject(
      { code: 'INVALID_ARGUMENT' }
    );
    await expect(
      Cache.info({ uri: 'https://a', cacheKey: '' })
    ).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
    expect(sent()).toEqual([]);
  });

  it('reports download events, and stops on unsubscribe', async () => {
    const seen: string[] = [];
    const stop = Cache.addListener('download', (d) =>
      seen.push(`${d.id}:${d.state}:${d.bytes}`)
    );
    fake.emit({
      type: 'download',
      id: 'x',
      uri: 'https://a',
      state: 'downloading',
      bytes: 10,
      totalBytes: 100,
      error: null,
    });
    stop();
    fake.emit({
      type: 'download',
      id: 'x',
      uri: 'https://a',
      state: 'completed',
      bytes: 100,
      totalBytes: 100,
      error: null,
    });
    expect(seen).toEqual(['x:downloading:10']);
  });

  it('rejects with the native error', async () => {
    fake.rejectNext = { code: 'CACHE_UNAVAILABLE', message: 'no' };
    await expect(Cache.usage()).rejects.toMatchObject({
      code: 'CACHE_UNAVAILABLE',
    });
  });
});
