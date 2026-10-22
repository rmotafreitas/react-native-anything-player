/// <reference types="node" />
// Local files on the web, through the public `Player` of the web entry: a
// `File` or `Blob` is played from an object URL RNAP makes and revokes;
// `blob:` and `data:` URLs pass `normalizeSource` here and nowhere else; none
// of them is ever handed to a Cast receiver.

import { FakeCast } from './FakeCast';
import {
  install,
  liveBlobUrls,
  uninstall,
  type FakeWorld,
} from './FakeBrowser';

let world: FakeWorld;
let web: typeof import('../index');
let cast: FakeCast;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  world = install({ mediaSession: true });
  cast = new FakeCast();
  jest.isolateModules(() => {
    web = require('../index');
  });
});

afterEach(() => {
  uninstall();
  jest.useRealTimers();
});

const file = (name = 'My Song.mp3') =>
  new File([new Uint8Array(2048)], name, { type: 'audio/mpeg' });

/** Loads `source` and makes it ready, as the browser would once it parsed the file. */
async function loadReady(
  player: InstanceType<typeof web.Player>,
  source: Parameters<InstanceType<typeof web.Player>['load']>[0],
  options: Parameters<InstanceType<typeof web.Player>['load']>[1] = {}
) {
  const loading = player.load(source, options);
  world.element().becomeReady(120);
  await flush();
  await loading;
}

describe('a File or Blob', () => {
  it('plays from an object URL', async () => {
    const player = new web.Player();
    const picked = file();
    await loadReady(player, picked);
    const src = world.element().src;
    expect(src.startsWith('blob:')).toBe(true);
    expect(liveBlobUrls()).toEqual([src]);
    expect(player.status).toMatchObject({
      state: 'paused',
      isLive: false,
      seekable: true,
    });
    await player.release();
  });

  it('shows the file name, without its extension, on the lock screen', async () => {
    const player = new web.Player();
    await loadReady(player, file('My Song.mp3'), { autoplay: true });
    world.element().startPlaying();
    await flush();
    expect(world.session.metadata).toMatchObject({
      init: { title: 'My Song' },
    });
    // An unnamed Blob has no title to show; a name with no extension stays whole.
    await loadReady(player, new Blob(['abcd']));
    expect(world.session.metadata).toMatchObject({
      init: { title: undefined },
    });
    await loadReady(player, file('noext'));
    expect(world.session.metadata).toMatchObject({ init: { title: 'noext' } });
    await loadReady(player, file('.hidden'));
    expect(world.session.metadata).toMatchObject({
      init: { title: '.hidden' },
    });
    await player.release();
  });

  it('revokes the URL when the item is replaced, by a file or by a URL', async () => {
    const player = new web.Player();
    await loadReady(player, file('a.mp3'));
    const first = liveBlobUrls();
    expect(first).toHaveLength(1);

    await loadReady(player, file('b.mp3'));
    expect(liveBlobUrls()).toHaveLength(1);
    expect(liveBlobUrls()).not.toEqual(first);

    await loadReady(player, 'https://cdn.example/song.mp3');
    expect(liveBlobUrls()).toEqual([]);
    await player.release();
  });

  it('keeps it through stop and play (the file is re-opened), and revokes it on reset', async () => {
    const player = new web.Player();
    await loadReady(player, file(), { autoplay: true });
    const [url] = liveBlobUrls();
    await player.stop();
    expect(liveBlobUrls()).toEqual([url]);
    await player.reset();
    expect(liveBlobUrls()).toEqual([]);
    expect(player.state).toBe('idle');
    await player.release();
  });

  it('revokes it on release', async () => {
    const player = new web.Player();
    await loadReady(player, file());
    expect(liveBlobUrls()).toHaveLength(1);
    await player.release();
    expect(liveBlobUrls()).toEqual([]);
  });

  it('leaks nothing across many loads', async () => {
    const player = new web.Player();
    for (let i = 0; i < 20; i++) await loadReady(player, file(`${i}.mp3`));
    expect(liveBlobUrls()).toHaveLength(1);
    await player.release();
    expect(liveBlobUrls()).toEqual([]);
  });

  it('revokes the URL of a load the engine refused', async () => {
    const { WebModule } = await import('../platform/WebModule');
    const { WebPlayerController } =
      await import('../platform/WebPlayerController');
    const mod = new WebModule();
    const id = mod.createPlayer({});
    jest
      .spyOn(WebPlayerController.prototype, 'load')
      .mockImplementationOnce(() => {
        throw new Error('refused');
      });
    await expect(
      mod.load(id, { uri: '', blob: file() }, {})
    ).rejects.toBeDefined();
    expect(liveBlobUrls()).toEqual([]);
    await mod.releasePlayer(id);
  });

  it('is an element source the visualizer and Remote Playback treat as bytes the page holds', async () => {
    const player = new web.Player();
    expect(player.setAudioSampling({ enabled: true })).toBe(true);
    await loadReady(player, file(), { autoplay: true });
    world.element().startPlaying();
    await flush();
    await jest.advanceTimersByTimeAsync(100);
    // Same-origin: the element is tapped, not swapped for a fresh one.
    expect(world.elements).toHaveLength(1);
    await player.release();
  });
});

describe('blob: and data: URLs', () => {
  it.each(['blob:https://app.example/abc-123', 'data:audio/mpeg;base64,AAAA'])(
    'play as given, and RNAP does not revoke %s (the app made it)',
    async (uri) => {
      const player = new web.Player();
      await loadReady(player, uri);
      expect(world.element().src).toBe(uri);
      await player.reset();
      await player.release();
    }
  );

  it('are still refused in a catalog as Blobs, and accepted as URLs', async () => {
    await expect(
      web.setCatalog([
        {
          id: 'a',
          title: 'A',
          source: file() as unknown as string,
        },
      ])
    ).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
      message: expect.stringContaining('catalog'),
    });
    await web.setCatalog([
      { id: 'b', title: 'B', source: 'blob:https://app.example/b' },
    ]);
    expect(await web.searchCatalog('B')).toHaveLength(1);
  });
});

describe('Cast and AirPlay', () => {
  it('never get a picked file: it stays on this device, with a reason, once', async () => {
    cast.install();
    cast.setDevicesAvailable(true);
    await web.configureCast({});
    const player = new web.Player();
    const errors: string[] = [];
    player.on('error', (error) => errors.push(error.code));
    await loadReady(player, file(), { autoplay: true });
    cast.connect();
    await flush();
    cast.end();
    cast.connect();
    await flush();
    expect(cast.loads).toHaveLength(0);
    expect(cast.requests).toBe(0);
    expect(player.status.route.kind).toBe('unknown');
    expect(errors).toEqual(['CAST_UNSUPPORTED_SOURCE']);
    expect(web.getCastStatus().state).toBe('connected');
    await player.release();
  });

  it('returns a casting player to this device when it loads a file, then casts a URL again', async () => {
    cast.install();
    cast.setDevicesAvailable(true);
    await web.configureCast({});
    const player = new web.Player();
    const errors: Array<{ code: string }> = [];
    player.on('error', (error) => errors.push(error));
    cast.connect();
    const first = player.load('https://radio.example/song.mp3', {
      autoplay: true,
    });
    await flush();
    await first;
    expect(player.status.route.kind).toBe('cast');

    await loadReady(player, file(), { autoplay: true });
    expect(player.status.route.kind).toBe('unknown');
    expect(errors.map((e) => e.code)).toEqual(['CAST_UNSUPPORTED_SOURCE']);
    expect(cast.loads.map((l) => l.contentId)).toEqual([
      'https://radio.example/song.mp3',
    ]);

    const again = player.load('https://radio.example/other.mp3', {
      autoplay: true,
    });
    await flush();
    await again;
    expect(player.status.route.kind).toBe('cast');
    // Moving to a URL revoked the file's object URL.
    expect(liveBlobUrls()).toEqual([]);
    await player.release();
  });

  it('give a Safari media source no AirPlay alternative for a file', async () => {
    uninstall();
    world = install({ airplay: true });
    const player = new web.Player();
    await loadReady(player, file());
    // A plain element source: no <source> children, no alternative URL.
    expect(world.element().children).toHaveLength(0);
    await player.release();
  });
});
