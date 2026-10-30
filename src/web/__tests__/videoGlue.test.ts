/// <reference types="node" />
// The parts of the web player that load on first use (hls.js's glue, the
// remuxer, Shaka's glue, DRM): when one does not load, the item fails with an
// error the engine can retry, and the next open tries to load it again.

import { configureHls } from '../../core/hls';
import { configureShaka } from '../../core/shaka';
import type { DrmDescriptor, OpenRequest } from '../engine/types';
import { MediaElementDriver } from '../platform/MediaElementDriver';
import { uninstall } from './FakeBrowser';
import { FakeHls } from './FakeHls';
import {
  FakeDashStream,
  FakeEme,
  FakeRemuxStream,
  RichHls,
  asHls,
  fakeShaka,
} from './FakeStreams';
import { installVideo, recorder, type FakeVideoWorld } from './FakeVideo';

const mockGlue = { offline: false };

jest.mock('../platform/HlsStream', () => {
  if (mockGlue.offline) throw new Error('chunk failed to load');
  return jest.requireActual('../platform/HlsStream');
});
jest.mock('../platform/RemuxStream', () => {
  if (mockGlue.offline) throw new Error('chunk failed to load');
  return { RemuxStream: require('./FakeStreams').FakeRemuxStream };
});
jest.mock('../platform/DashStream', () => {
  if (mockGlue.offline) throw new Error('chunk failed to load');
  return { DashStream: require('./FakeStreams').FakeDashStream };
});
jest.mock('../platform/WebDrm', () => {
  if (mockGlue.offline) throw new Error('chunk failed to load');
  return jest.requireActual('../platform/WebDrm');
});

let world: FakeVideoWorld;
let rec: ReturnType<typeof recorder>;
let driver: MediaElementDriver;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}

const open = (
  uri: string,
  generation: number,
  source: Partial<OpenRequest['source']> = {}
): OpenRequest => ({
  generation,
  source: { uri, headers: {}, liveHint: null, ...source },
  startPosition: null,
  playWhenReady: false,
  allowReconnect: true,
});

const failures = () =>
  rec
    .of('onFailed')
    .map(
      (a) => a[1] as { code: string; message: string; recoverable: boolean }
    );

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  mockGlue.offline = false;
  FakeHls.reset();
  FakeRemuxStream.instances = [];
  FakeDashStream.instances = [];
  world = installVideo({}, { mediaKeys: true });
  rec = recorder();
  driver = new MediaElementDriver(rec.observer, 'artist-title', 'video');
});

afterEach(() => {
  configureHls(null);
  configureShaka(null);
  uninstall();
  jest.useRealTimers();
});

describe('hls.js’s glue', () => {
  it('that does not load fails the item as recoverable, and is loaded on a later open', async () => {
    mockGlue.offline = true;
    configureHls(asHls(RichHls));
    await flush();

    driver.open(open('https://cdn.example/a.m3u8', 1));
    await flush();
    expect(failures()).toMatchObject([
      {
        code: 'UNSUPPORTED_FORMAT',
        recoverable: true,
        message: expect.stringContaining('glue code did not load'),
      },
    ]);
    expect(RichHls.instances).toEqual([]);

    // An item replaced while the glue loads is not failed for it.
    driver.open(open('https://cdn.example/b.m3u8', 2));
    driver.open(open('https://cdn.example/c.mp4', 3));
    await flush();
    expect(failures()).toHaveLength(1);

    // Back online: it loads, and the play asked for meanwhile happens.
    mockGlue.offline = false;
    driver.open({
      ...open('https://cdn.example/d.m3u8', 4),
      playWhenReady: true,
    });
    await flush();
    expect(RichHls.last().source).toBe('https://cdn.example/d.m3u8');
    expect(world.video().plays).toBe(1);
    expect(failures()).toHaveLength(1);
  });
});

describe('the remuxer', () => {
  it('that does not load fails the item as recoverable, and is loaded on a later open', async () => {
    mockGlue.offline = true;
    driver.open(open('https://cdn.example/a.mkv', 1));
    await flush();
    expect(failures()).toMatchObject([
      {
        code: 'UNSUPPORTED_FORMAT',
        recoverable: true,
        message: expect.stringContaining('remuxer did not load'),
      },
    ]);

    mockGlue.offline = false;
    driver.open(open('https://cdn.example/a.mkv', 2));
    await flush();
    expect(FakeRemuxStream.last().started).toBe(true);
    expect(failures()).toHaveLength(1);
  });
});

describe('Shaka’s glue', () => {
  it('that does not load fails the item as recoverable, and is loaded on a later open', async () => {
    configureShaka(fakeShaka());
    mockGlue.offline = true;
    driver.open(open('https://cdn.example/a.mpd', 1));
    await flush();
    expect(failures()).toMatchObject([
      {
        code: 'UNSUPPORTED_FORMAT',
        recoverable: true,
        message: expect.stringContaining('DASH glue code did not load'),
      },
    ]);

    mockGlue.offline = false;
    driver.open(open('https://cdn.example/a.mpd', 2));
    await flush();
    expect(FakeDashStream.last().starts).toEqual([null]);
    expect(failures()).toHaveLength(1);
  });
});

describe('the DRM glue', () => {
  const drm: DrmDescriptor = {
    clearkey: {
      keys: {
        a7e61c373e219033c21091fa607bf3b8: '76a6c65c5ea762046bd749a2e632ccbb',
      },
      licenseUrl: null,
      headers: {},
    },
    hook: false,
  };

  it('that does not load fails the item as recoverable, and is loaded on a later open', async () => {
    const eme = new FakeEme(['org.w3.clearkey']);
    Object.assign(world.navigator, {
      requestMediaKeySystemAccess: eme.requestMediaKeySystemAccess,
    });
    mockGlue.offline = true;
    driver.open(open('https://cdn.example/a.mp4', 1, { drm }));
    await flush();
    expect(failures()).toMatchObject([
      {
        code: 'DRM_LICENSE_FAILED',
        recoverable: true,
        message: expect.stringContaining('DRM code did not load'),
      },
    ]);
    expect(world.video().src).toBe('');

    mockGlue.offline = false;
    driver.open(open('https://cdn.example/a.mp4', 2, { drm }));
    await flush();
    expect(world.video().src).toBe('https://cdn.example/a.mp4');
    expect(world.video().keys).toBe(eme.keys);
    expect(failures()).toHaveLength(1);
  });
});
