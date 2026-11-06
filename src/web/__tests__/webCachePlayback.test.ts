/// <reference types="node" />
// A file the cache holds whole plays from its stored bytes (a blob: URL),
// through the same element and the same engine; one it does not hold plays
// from the network.

import { install, uninstall, type FakeWorld } from './FakeBrowser';
import { WebModule } from '../platform/WebModule';
import { webCache } from '../platform/WebCache';

let world: FakeWorld;
let module: WebModule;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  world = install({});
  module = new WebModule();
});

afterEach(() => {
  jest.restoreAllMocks();
  uninstall();
  jest.useRealTimers();
});

describe('playback from the web cache', () => {
  it('plays a cached file from its blob: URL, and keeps the play() it was asked for', async () => {
    jest
      .spyOn(webCache(), 'blobFor')
      .mockImplementation((source) =>
        source.uri === 'https://cdn.example/cached.mp3'
          ? Promise.resolve('blob:https://app.example/1')
          : null
      );
    const id = module.createPlayer({});
    void module.load(
      id,
      { uri: 'https://cdn.example/cached.mp3', live: false },
      { autoplay: true }
    );
    const element = world.element();
    expect(element.src).toBe('');
    await flush();
    expect(element.src).toBe('blob:https://app.example/1');
    expect(element.plays).toBeGreaterThan(0);

    void module.load(
      id,
      { uri: 'https://cdn.example/other.mp3', live: false },
      {}
    );
    await flush();
    expect(world.element().src).toBe('https://cdn.example/other.mp3');
  });

  it('plays from the network when the stored bytes cannot be read', async () => {
    jest
      .spyOn(webCache(), 'blobFor')
      .mockReturnValue(Promise.reject(new Error('gone')));
    const id = module.createPlayer({});
    void module.load(
      id,
      { uri: 'https://cdn.example/cached.mp3', live: false },
      {}
    );
    await flush();
    expect(world.element().src).toBe('https://cdn.example/cached.mp3');
  });

  it('a newer load wins over a cached file still being read', async () => {
    let release!: (url: string) => void;
    jest
      .spyOn(webCache(), 'blobFor')
      .mockImplementation((source) =>
        source.uri === 'https://cdn.example/cached.mp3'
          ? new Promise((r) => (release = r))
          : null
      );
    const id = module.createPlayer({});
    void module.load(
      id,
      { uri: 'https://cdn.example/cached.mp3', live: false },
      {}
    );
    void module.load(id, { uri: 'https://cdn.example/b.mp3', live: false }, {});
    release('blob:https://app.example/late');
    await flush();
    expect(world.element().src).toBe('https://cdn.example/b.mp3');
  });
});
