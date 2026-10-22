/// <reference types="node" />
// HLS on the web: hls.js on the player's <audio> element where the browser
// cannot play HLS itself, driven through `WebModule` on the fake browser with
// a scripted hls.js (`FakeHls`).

import { configureHls, hlsConstructor } from '../../core/hls';
import type { HlsConstructor } from '../../core/hls';
import { FakeHls } from './FakeHls';
import { install, uninstall, type FakeWorld } from './FakeBrowser';
import { id3TextTag } from './audioFixtures';
import { WebModule } from '../platform/WebModule';

type Event = Record<string, unknown> & { type: string };

let world: FakeWorld;
let module: WebModule;
let events: Event[];

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}
const status = (id: string) =>
  module.getStatus(id) as {
    state: string;
    isLive: boolean;
    seekable: boolean;
    error: { code: string; recoverable: boolean } | null;
  };
const ofType = (type: string) => events.filter((e) => e.type === type);
const diagnostics = (id: string) =>
  (module.getDiagnostics(id) as Array<{ event: string }>).map((d) => d.event);

function setup(options: Parameters<typeof install>[0] = {}) {
  world = install(options);
  module = new WebModule();
  events = [];
  module.onPlayerEvent((e) => events.push(e as Event));
}

const URI = 'https://cdn.example/radio/index.m3u8';

/** Starts loading an HLS source; the promise settles with the load. */
async function open(uri = URI, headers: Record<string, string> = {}) {
  const id = module.createPlayer({ recovery: { giveUpAfterMs: 60_000 } });
  const loading = module.load(id, { uri, headers }, {});
  loading.catch(() => undefined);
  await flush();
  return { id, loading, element: world.element() };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  FakeHls.reset();
  configureHls(FakeHls as unknown as HlsConstructor);
  setup();
});

afterEach(() => {
  configureHls(null);
  delete (globalThis as { Hls?: unknown }).Hls;
  uninstall();
  jest.useRealTimers();
});

describe('configureHls', () => {
  it('prefers the registered constructor, then a global Hls, else none', () => {
    expect(hlsConstructor()).toBe(FakeHls);
    configureHls(null);
    expect(hlsConstructor()).toBeNull();
    const global = class {};
    (globalThis as { Hls?: unknown }).Hls = global;
    expect(hlsConstructor()).toBe(global);
    configureHls(FakeHls as unknown as HlsConstructor);
    expect(hlsConstructor()).toBe(FakeHls);
  });
});

describe('where the browser plays HLS itself', () => {
  it('gives the playlist to the element, without hls.js', async () => {
    uninstall();
    setup({ nativeHls: true });
    const { element } = await open();
    expect(element.src).toBe(URI);
    expect(FakeHls.instances).toHaveLength(0);
  });
});

describe('where the browser says it plays HLS but cannot open the playlist', () => {
  beforeEach(() => {
    uninstall();
    setup({ nativeHls: true });
  });

  it('tries hls.js on the same item, before anything played', async () => {
    const { id, loading, element } = await open();
    expect(element.src).toBe(URI);
    expect(FakeHls.instances).toHaveLength(0);
    element.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    expect(FakeHls.last().source).toBe(URI);
    expect(FakeHls.last().media).toBe(element);
    expect(element.src).toBe('');
    expect(diagnostics(id)).toContain('hls.js');
    expect(status(id).state).toBe('loading');
    FakeHls.last().level(false, 60);
    element.becomeReady(60);
    await flush();
    await loading;
    expect(status(id)).toMatchObject({ state: 'paused', seekable: true });
  });

  it('asks the element to play again: loading it anew dropped the first play()', async () => {
    const id = module.createPlayer({});
    const loading = module.load(id, { uri: URI }, { autoplay: true });
    loading.catch(() => undefined);
    await flush();
    const element = world.element();
    expect(element.plays).toBe(1);
    element.fail(4);
    await flush();
    expect(element.plays).toBe(2);
  });

  it('goes to hls.js at once when the engine re-opens the item', async () => {
    const id = module.createPlayer({});
    module.load(id, { uri: URI }, { autoplay: true }).catch(() => undefined);
    await flush();
    const element = world.element();
    element.fail(4);
    await flush();
    FakeHls.last().level(true);
    element.becomeReady(Number.POSITIVE_INFINITY);
    await flush();
    const first = FakeHls.last();
    first.fatal(FakeHls.ErrorTypes.NETWORK_ERROR);
    await flush();
    expect(status(id).state).toBe('reconnecting');

    await jest.advanceTimersByTimeAsync(30_000);
    expect(FakeHls.instances.length).toBeGreaterThan(1);
    expect(FakeHls.last()).not.toBe(first);
    // No second try on the element's own HLS.
    expect(element.src).toBe('');
    expect(element.srcHistory.filter((src) => src === URI)).toHaveLength(1);
  });

  it('does not, once it played: that is the server failing', async () => {
    const { id, loading, element } = await open();
    element.becomeReady(60);
    await flush();
    await loading;
    const play = module.play(id);
    element.startPlaying();
    await flush();
    await play;
    element.fail(4);
    await flush();
    expect(FakeHls.instances).toHaveLength(0);
    expect(status(id).state).toBe('reconnecting');
  });

  it.each([
    ['there is no hls.js', () => configureHls(null)],
    ['hls.js is not supported here', () => (FakeHls.supported = false)],
  ])('fails when %s, and says what to install', async (_name, arrange) => {
    arrange();
    const { loading, element } = await open();
    element.fail(4);
    await flush();
    await expect(loading).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      message: expect.stringContaining('configureHls'),
    });
    expect(FakeHls.instances).toHaveLength(0);
  });

  it('does not say it about a file the browser could not open', async () => {
    const id = module.createPlayer({});
    const loading = module.load(
      id,
      { uri: 'https://cdn.example/a.mp3', live: false },
      {}
    );
    loading.catch(() => undefined);
    world.element().fail(4);
    await flush();
    await expect(loading).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      message: expect.not.stringContaining('hls.js'),
    });
  });

  it('leaves other errors alone', async () => {
    const { element } = await open();
    element.fail(2); // a network error is not a format problem
    await flush();
    expect(FakeHls.instances).toHaveLength(0);
  });

  it('only tries once', async () => {
    const { element } = await open();
    element.fail(4);
    await flush();
    expect(FakeHls.instances).toHaveLength(1);
    // hls.js is attached now: the element failing again is hls.js's to report.
    element.fail(4);
    await flush();
    expect(FakeHls.instances).toHaveLength(1);
  });
});

describe('where it does not', () => {
  it('attaches hls.js to the element and takes ready from the playlist', async () => {
    const { id, loading, element } = await open();
    const hls = FakeHls.last();
    expect(hls.source).toBe(URI);
    expect(hls.media).toBe(element);
    // hls.js feeds the element itself: RNAP sets no src.
    expect(element.src).toBe('');
    expect(diagnostics(id)).toContain('hls.js');

    hls.level(false, 90);
    element.becomeReady(90);
    await flush();
    await loading;
    expect(status(id)).toMatchObject({
      state: 'paused',
      isLive: false,
      seekable: true,
    });
    expect(module.getProgress(id)).toMatchObject({
      duration: 90,
      liveOffset: null,
    });
  });

  it('takes live from the playlist even before the element knows a duration', async () => {
    const { id, loading, element } = await open();
    FakeHls.last().level(true);
    FakeHls.last().latency = 4.5;
    // A live element's duration may be Infinity or a growing window.
    element.becomeReady(37);
    await flush();
    await loading;
    expect(status(id)).toMatchObject({ isLive: true, seekable: false });
    expect(module.getProgress(id)).toMatchObject({
      duration: null,
      liveOffset: 4.5,
    });
    FakeHls.last().latency = undefined;
    expect(
      (module.getProgress(id) as { liveOffset: unknown }).liveOffset
    ).toBeNull();
  });

  it('falls back to the element when the playlist was not reported', async () => {
    const { id, loading, element } = await open();
    element.becomeReady(Number.POSITIVE_INFINITY);
    await flush();
    await loading;
    expect(status(id)).toMatchObject({ isLive: true });
  });

  it('applies the start position of an on-demand playlist', async () => {
    const id = module.createPlayer({});
    const loading = module.load(id, { uri: URI }, { startPosition: 30 });
    await flush();
    FakeHls.last().level(false, 90);
    world.element().becomeReady(90);
    await flush();
    await loading;
    expect(world.element().currentTime).toBe(30);
  });

  it('notes the manifest', async () => {
    const { id } = await open();
    FakeHls.last().emit(FakeHls.Events.MANIFEST_PARSED, {
      levels: [{}, {}],
    });
    FakeHls.last().emit(FakeHls.Events.MANIFEST_PARSED, undefined);
    expect(diagnostics(id)).toContain('hls manifest');
  });

  it('fails with UNSUPPORTED_FORMAT, and says what to install, without hls.js', async () => {
    configureHls(null);
    const { id, loading } = await open();
    await expect(loading).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      recoverable: false,
      message: expect.stringContaining('configureHls'),
    });
    expect(status(id).state).toBe('error');
    expect(FakeHls.instances).toHaveLength(0);
  });

  it('says so when hls.js itself is not supported here', async () => {
    FakeHls.supported = false;
    const { loading } = await open();
    await expect(loading).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      message: expect.stringContaining('Media Source Extensions'),
    });
  });

  it('uses a global Hls (hls.js loaded by a script tag)', async () => {
    configureHls(null);
    (globalThis as { Hls?: unknown }).Hls = FakeHls;
    await open();
    expect(FakeHls.instances).toHaveLength(1);
  });

  it('plays a playlist served without the .m3u8 extension, by its content type', async () => {
    world.fetch.respond({
      headers: { 'content-type': 'application/vnd.apple.mpegurl' },
    });
    const id = module.createPlayer({});
    module
      .load(id, { uri: 'https://cdn.example/stream?id=7' }, {})
      .catch(() => undefined);
    await flush();
    expect(world.fetch.requests).toHaveLength(1);
    expect(FakeHls.last().source).toBe('https://cdn.example/stream?id=7');
    expect(diagnostics(id)).toEqual(
      expect.arrayContaining(['plain playback', 'hls.js'])
    );
  });

  it('does not take other content types for HLS', async () => {
    world.fetch.respond({
      headers: { 'content-type': 'audio/ogg', 'icy-metaint': '16000' },
    });
    const id = module.createPlayer({});
    module
      .load(id, { uri: 'https://cdn.example/stream?id=8' }, {})
      .catch(() => undefined);
    await flush();
    expect(FakeHls.instances).toHaveLength(0);
    expect(world.element().src).toBe('https://cdn.example/stream?id=8');
  });

  it('shows the source headers to hls.js: XHR and fetch', async () => {
    const requests: unknown[] = [];
    (globalThis as { Request?: unknown }).Request = class {
      constructor(
        readonly url: string,
        readonly init: unknown
      ) {
        requests.push(this);
      }
    };
    try {
      await open(URI, { Authorization: 'Bearer t' });
      const { config } = FakeHls.last();
      const set: string[] = [];
      config.xhrSetup({
        setRequestHeader: (k: string, v: string) => set.push(`${k}=${v}`),
      });
      expect(set).toEqual(['Authorization=Bearer t']);
      const headers = new Map<string, string>();
      const request = config.fetchSetup(
        { url: 'https://cdn.example/seg.ts' },
        { headers: { set: (k: string, v: string) => headers.set(k, v) } }
      );
      expect(headers.get('Authorization')).toBe('Bearer t');
      expect(request).toBe(requests[0]);
    } finally {
      delete (globalThis as { Request?: unknown }).Request;
    }
  });

  it('configures no header hooks for a source without headers', async () => {
    await open();
    expect(FakeHls.last().config.xhrSetup).toBeUndefined();
    expect(FakeHls.last().config.liveDurationInfinity).toBe(true);
  });
});

describe('loading the hls.js glue', () => {
  it('starts within the play() that asked, once hls.js is registered', async () => {
    // configureHls (beforeEach) loaded the glue ahead of any playback.
    await flush();
    const id = module.createPlayer({});
    const loading = module.load(id, { uri: URI }, { autoplay: true });
    loading.catch(() => undefined);
    // Synchronously: inside the command, so within a tap's user activation.
    expect(FakeHls.instances).toHaveLength(1);
    expect(world.element().plays).toBe(1);
  });

  it('rejects play with AUTOPLAY_BLOCKED for an HLS source', async () => {
    await flush();
    const { id, element } = await open();
    element.playBehavior = 'block';
    await expect(module.play(id)).rejects.toMatchObject({
      code: 'AUTOPLAY_BLOCKED',
    });
  });

  // A source opened before the glue has loaded (hls.js registered in the same
  // tick, or found on window.Hls): a fresh module registry, so nothing is
  // loaded yet.
  async function freshModules<T>(
    run: (fresh: { module: WebModule }) => Promise<T>
  ): Promise<T> {
    let result: T | undefined;
    await jest.isolateModulesAsync(async () => {
      const { WebModule: Fresh } = require('../platform/WebModule');
      const hls = require('../../core/hls');
      hls.configureHls(FakeHls as unknown as HlsConstructor);
      try {
        result = await run({ module: new Fresh() });
      } finally {
        hls.configureHls(null);
      }
    });
    return result as T;
  }

  it('plays once the stream starts when asked while the glue loaded', async () => {
    await freshModules(async ({ module: fresh }) => {
      const id = fresh.createPlayer({});
      fresh.load(id, { uri: URI }, { autoplay: true }).catch(() => undefined);
      // hls.js has no source to attach yet: the element is not asked to play.
      expect(world.element().plays).toBe(0);
      await flush();
      expect(FakeHls.instances).toHaveLength(1);
      expect(FakeHls.last().media).toBe(world.element());
      // Asked once, when the stream was there.
      expect(world.element().plays).toBe(1);
    });
  });

  it('starts no stream for an item replaced while the glue loaded', async () => {
    await freshModules(async ({ module: fresh }) => {
      const id = fresh.createPlayer({});
      // Both loads happen before the import resolves: the second wins.
      fresh.load(id, { uri: URI }, {}).catch(() => undefined);
      fresh
        .load(id, { uri: 'https://cdn.example/other.mp3', live: false }, {})
        .catch(() => undefined);
      await flush();
      expect(FakeHls.instances).toHaveLength(0);
      expect(world.element().src).toBe('https://cdn.example/other.mp3');
    });
  });

  it('starts no stream for a player released while the glue loaded', async () => {
    await freshModules(async ({ module: fresh }) => {
      const id = fresh.createPlayer({});
      fresh.load(id, { uri: URI }, {}).catch(() => undefined);
      fresh.releasePlayer(id);
      await flush();
      expect(FakeHls.instances).toHaveLength(0);
    });
  });
});

describe('errors', () => {
  async function startPlaying() {
    const opened = await open();
    FakeHls.last().level(true);
    opened.element.becomeReady(Number.POSITIVE_INFINITY);
    await flush();
    await opened.loading;
    const play = module.play(opened.id);
    opened.element.startPlaying();
    await flush();
    await play;
    return opened;
  }

  it('leaves recovery to the engine: a fatal network error is reported once, recoverable, and the item is re-opened', async () => {
    const { id, element } = await startPlaying();
    const first = FakeHls.last();
    first.fatal(FakeHls.ErrorTypes.NETWORK_ERROR);
    first.fatal(FakeHls.ErrorTypes.NETWORK_ERROR); // hls.js may repeat itself
    element.fail(2); // and so may the element
    await flush();
    expect(status(id).state).toBe('reconnecting');
    expect(ofType('error')).toHaveLength(1);
    expect(ofType('error')[0]).toMatchObject({
      fatal: false,
      error: { code: 'NETWORK_ERROR', recoverable: true },
    });
    expect(first.destroyed).toBe(true);

    await jest.advanceTimersByTimeAsync(30_000);
    expect(FakeHls.instances.length).toBeGreaterThan(1);
    expect(FakeHls.last()).not.toBe(first);
    expect(FakeHls.last().source).toBe(URI);
  });

  it('maps a fatal media error to DECODER_ERROR, recoverable', async () => {
    const { id } = await startPlaying();
    FakeHls.last().fatal(FakeHls.ErrorTypes.MEDIA_ERROR, 'bufferAppendError');
    await flush();
    expect(status(id).state).toBe('reconnecting');
    expect(ofType('error')[0]).toMatchObject({
      error: { code: 'DECODER_ERROR', recoverable: true },
    });
  });

  it('ignores errors hls.js recovered from itself', async () => {
    const { id } = await startPlaying();
    FakeHls.last().emit(FakeHls.Events.ERROR, {
      type: FakeHls.ErrorTypes.NETWORK_ERROR,
      details: 'fragLoadError',
      fatal: false,
    });
    FakeHls.last().emit(FakeHls.Events.ERROR, undefined);
    await flush();
    expect(status(id).state).toBe('playing');
    expect(ofType('error')).toHaveLength(0);
  });

  it('gives a missing playlist up: it will not appear by retrying', async () => {
    const { loading } = await open();
    FakeHls.last().fatal(
      FakeHls.ErrorTypes.NETWORK_ERROR,
      'manifestLoadError',
      404
    );
    await flush();
    await expect(loading).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
      recoverable: false,
      httpStatus: 404,
    });
  });

  it('keeps a 5xx on the playlist recoverable, with its status', async () => {
    const { loading } = await open();
    FakeHls.last().fatal(
      FakeHls.ErrorTypes.NETWORK_ERROR,
      'manifestLoadError',
      503
    );
    await flush();
    expect(ofType('error')[0]).toMatchObject({
      error: { code: 'NETWORK_ERROR', recoverable: true, httpStatus: 503 },
    });
    loading.catch(() => undefined);
  });

  it('says the device is offline when it is', async () => {
    const { id } = await open();
    world.navigator.onLine = false;
    FakeHls.last().fatal(FakeHls.ErrorTypes.NETWORK_ERROR);
    await flush();
    expect(ofType('error')[0]).toMatchObject({
      error: { code: 'NETWORK_UNAVAILABLE' },
    });
    expect(status(id).state).not.toBe('playing');
  });

  it('gives up on an error that is not the network or the media', async () => {
    const { loading } = await open();
    FakeHls.last().fatal('keySystemError', 'keySystemNoKeys');
    await flush();
    await expect(loading).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      recoverable: false,
    });
  });

  it('still reports an element error that hls.js did not', async () => {
    const { loading, element } = await open();
    element.fail(3, 'decode');
    await flush();
    await expect(loading).rejects.toMatchObject({ code: 'DECODER_ERROR' });
  });

  it('survives hls.js failing to destroy', async () => {
    const { id } = await open();
    FakeHls.last().destroy = () => {
      throw new Error('boom');
    };
    await module.releasePlayer(id);
  });
});

describe('lifetime', () => {
  it('destroys the instance on stop, reset, a new load and release', async () => {
    const { id, element } = await open();
    FakeHls.last().level(true);
    element.becomeReady(Number.POSITIVE_INFINITY);
    const first = FakeHls.last();
    await module.stop(id);
    expect(first.destroyed).toBe(true);

    await module.reset(id);
    const loading = module.load(id, { uri: URI }, {});
    loading.catch(() => undefined);
    await flush();
    const second = FakeHls.last();
    expect(second).not.toBe(first);
    expect(second.destroyed).toBe(false);

    // A different source replaces it.
    module
      .load(id, { uri: 'https://cdn.example/other.m3u8' }, {})
      .catch(() => undefined);
    await flush();
    expect(second.destroyed).toBe(true);
    const third = FakeHls.last();
    expect(third.source).toBe('https://cdn.example/other.m3u8');

    await module.releasePlayer(id);
    expect(third.destroyed).toBe(true);
  });

  it('ignores what a replaced instance says', async () => {
    const { id } = await open();
    const old = FakeHls.last();
    module
      .load(id, { uri: 'https://cdn.example/other.mp3', live: false }, {})
      .catch(() => undefined);
    await flush();
    old.fatal(FakeHls.ErrorTypes.NETWORK_ERROR);
    old.emit(FakeHls.Events.FRAG_PARSING_METADATA, {
      samples: [
        {
          pts: 0,
          data: id3TextTag(4, [{ id: 'TIT2', encoding: 3, text: 'Late' }]),
        },
      ],
    });
    await flush();
    expect(ofType('error')).toHaveLength(0);
    expect(ofType('metadata')).toHaveLength(0);
  });

  it('feeds the visualizer: hls.js audio is same-origin, so the element may be tapped', async () => {
    const id = module.createPlayer({});
    expect(module.setAudioSampling(id, true, 64)).toBe(true);
    const loading = module.load(id, { uri: URI }, {});
    loading.catch(() => undefined);
    await flush();
    const element = world.element();
    FakeHls.last().level(true);
    element.becomeReady(Number.POSITIVE_INFINITY);
    await flush();
    await loading;
    await module.play(id); // a user gesture starts the context
    element.startPlaying();
    await flush();
    await jest.advanceTimersByTimeAsync(100);
    expect(ofType('audioSample').pop()).toMatchObject({ level: 0.5 });
    // No fresh element: the tapped one carries on with the next playlist.
    module
      .load(id, { uri: 'https://cdn.example/other.m3u8' }, {})
      .catch(() => undefined);
    await flush();
    expect(world.elements).toHaveLength(1);
  });
});

describe('timed metadata', () => {
  it('delivers an ID3 title when its time is heard', async () => {
    const { id, loading, element } = await open();
    FakeHls.last().level(true);
    element.becomeReady(Number.POSITIVE_INFINITY);
    await flush();
    await loading;
    const playing = module.play(id);
    element.startPlaying();
    await flush();
    await playing;

    FakeHls.last().emit(FakeHls.Events.FRAG_PARSING_METADATA, {
      samples: [
        {
          pts: 12,
          data: id3TextTag(4, [
            { id: 'TIT2', encoding: 3, text: 'Jóga' },
            { id: 'TPE1', encoding: 3, text: 'Björk' },
          ]),
        },
        { pts: 20, data: Uint8Array.of(1, 2, 3) }, // not an ID3 tag
        { pts: 21 }, // no data
      ],
    });
    FakeHls.last().emit(FakeHls.Events.FRAG_PARSING_METADATA, {});
    await flush();
    expect(ofType('metadata')).toHaveLength(0); // not heard yet

    element.currentTime = 12.2;
    element.dispatch('timeupdate');
    await flush();
    expect(ofType('metadata').pop()).toMatchObject({
      metadata: { title: 'Jóga', artist: 'Björk' },
    });
    expect(world.session.metadata).toMatchObject({
      init: { title: 'Jóga', artist: 'Björk' },
    });
  });

  it('replaces the title with the next one when it is heard', async () => {
    const { id, loading, element } = await open();
    FakeHls.last().level(true);
    element.becomeReady(Number.POSITIVE_INFINITY);
    await flush();
    await loading;
    const tag = (title: string) =>
      id3TextTag(4, [{ id: 'TIT2', encoding: 3, text: title }]);
    FakeHls.last().emit(FakeHls.Events.FRAG_PARSING_METADATA, {
      samples: [
        { pts: 1, data: tag('First') },
        { pts: 5, data: tag('Second') },
      ],
    });
    element.currentTime = 2;
    element.dispatch('timeupdate');
    await flush();
    expect(ofType('metadata').pop()).toMatchObject({
      metadata: { title: 'First' },
    });
    element.currentTime = 6;
    element.dispatch('timeupdate');
    await flush();
    expect(ofType('metadata').pop()).toMatchObject({
      metadata: { title: 'Second' },
    });
    expect(id).toBeDefined();
  });
});
