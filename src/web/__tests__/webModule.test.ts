/// <reference types="node" />
// The browser layer, driven through `WebModule` (the contract `Player` uses)
// on a scripted fake browser. The engine's decisions are covered by the
// shared conformance suite; these tests cover what the platform adds.

import {
  BYTES_PER_SECOND,
  icyChunk,
  install,
  ranges,
  uninstall,
  type FakeWorld,
} from './FakeBrowser';
import { WebModule } from '../platform/WebModule';

interface Snapshot {
  seq: number;
  state: string;
  playWhenReady: boolean;
  isLive: boolean;
  seekable: boolean;
  network: string;
  interruption: { reason: string; resumable: boolean } | null;
  error: { code: string; platform: string } | null;
  reconnect: { attempt: number } | null;
}

type Event = Record<string, unknown> & { type: string; seq?: number };

let world: FakeWorld;
let module: WebModule;
let events: Event[];

/** Runs due timers and the promise chains they start (fetch → read → append takes a few turns). */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}
const status = (id: string) => module.getStatus(id) as Snapshot;
const ofType = (type: string) => events.filter((e) => e.type === type);
const diagnostics = (id: string) =>
  (
    module.getDiagnostics(id) as Array<{
      event: string;
      details: Record<string, string>;
    }>
  ).map((d) => d.event);

function setup(options: Parameters<typeof install>[0] = {}) {
  world = install(options);
  module = new WebModule();
  events = [];
  module.onPlayerEvent((e) => events.push(e as Event));
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  setup();
});

afterEach(() => {
  uninstall();
  jest.useRealTimers();
});

/** Loads a file on the plain element and makes it ready. */
async function loadFile(id: string, duration = 120, options: object = {}) {
  const loading = module.load(
    id,
    { uri: 'https://cdn.example/song.mp3', live: false },
    options
  );
  const element = world.element();
  element.becomeReady(duration);
  await flush();
  await loading;
  return element;
}

describe('plain element', () => {
  it('loads a file, plays, pauses, seeks and reports progress', async () => {
    const id = module.createPlayer({});
    const element = await loadFile(id);
    expect(element.src).toBe('https://cdn.example/song.mp3');
    expect(status(id)).toMatchObject({
      state: 'paused',
      seekable: true,
      isLive: false,
    });

    const playing = module.play(id);
    element.startPlaying();
    await flush();
    await playing;
    expect(status(id).state).toBe('playing');

    await module.seekTo(id, 30);
    expect(element.currentTime).toBe(30);
    element.plainBuffered = ranges([[0, 60]]);
    expect(module.getProgress(id)).toMatchObject({
      position: 30,
      duration: 120,
      buffered: 60,
      bufferedAhead: 30,
      liveOffset: null,
    });

    await module.setVolume(id, 0.5);
    expect(element.volume).toBe(0.5);
    await module.setMuted(id, true);
    expect(element.volume).toBe(0);
    await module.setRate(id, 1.5);
    expect(element.playbackRate).toBe(1.5);

    await module.pause(id);
    expect(element.paused).toBe(true);
    expect(status(id)).toMatchObject({ state: 'paused', interruption: null });
  });

  it('delivers events asynchronously, in order, after the status they imply', async () => {
    const id = module.createPlayer({});
    const loading = module.load(
      id,
      { uri: 'https://cdn.example/a.mp3', live: false },
      {}
    );
    expect(events).toHaveLength(0);
    await flush();
    world.element().becomeReady(10);
    await flush();
    await loading;
    const seqs = events.filter((e) => e.seq != null).map((e) => e.seq!);
    expect(seqs.length).toBeGreaterThan(1);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(events.every((e) => e.playerId === id)).toBe(true);
  });

  it('applies the start position once the file is ready', async () => {
    const id = module.createPlayer({});
    const element = await loadFile(id, 120, { startPosition: 42 });
    expect(element.currentTime).toBe(42);
  });

  it('rejects play with AUTOPLAY_BLOCKED and reports the interruption', async () => {
    const id = module.createPlayer({});
    const element = await loadFile(id);
    element.playBehavior = 'block';
    await expect(module.play(id)).rejects.toMatchObject({
      code: 'AUTOPLAY_BLOCKED',
      recoverable: true,
    });
    expect(status(id)).toMatchObject({
      playWhenReady: false,
      interruption: { reason: 'autoplay-blocked', resumable: false },
    });
  });

  it('keeps an autoplay load ready but paused when autoplay is refused', async () => {
    const id = module.createPlayer({});
    world.element().playBehavior = 'block';
    const loading = module.load(
      id,
      { uri: 'https://cdn.example/a.mp3', live: false },
      { autoplay: true }
    );
    await flush();
    world.element().becomeReady(10);
    await flush();
    await expect(loading).resolves.toBeDefined();
    expect(status(id)).toMatchObject({
      playWhenReady: false,
      interruption: { reason: 'autoplay-blocked' },
    });
  });

  it('treats an aborted, failed or throwing play() as no refusal', async () => {
    const id = module.createPlayer({});
    const element = await loadFile(id);
    for (const behavior of ['abort', 'fail', 'throw'] as const) {
      element.playBehavior = behavior;
      await expect(module.play(id)).resolves.toBeDefined();
      await module.pause(id);
    }
  });

  it('fails a load the browser cannot open', async () => {
    const id = module.createPlayer({});
    const loading = module.load(
      id,
      { uri: 'https://cdn.example/x.flac', live: false },
      {}
    );
    const settled = loading.then(
      () => null,
      (error: unknown) => error
    );
    world.element().fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    expect(await settled).toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      platform: 'web',
      platformCode: 4,
    });
    expect(status(id)).toMatchObject({
      state: 'error',
      error: { code: 'UNSUPPORTED_FORMAT', platform: 'web' },
    });
  });

  it('maps element errors and reconnects after recoverable ones', async () => {
    const id = module.createPlayer({});
    const element = await loadFile(id, 120, { autoplay: true });
    element.startPlaying();
    await flush();
    element.fail(1); // aborted: ignored
    expect(status(id).state).toBe('playing');

    element.fail(2);
    await flush();
    expect(status(id).state).toBe('reconnecting');
    expect(ofType('error').pop()).toMatchObject({
      fatal: false,
      error: { code: 'NETWORK_ERROR' },
    });

    await jest.advanceTimersByTimeAsync(2_000);
    expect(element.srcHistory.length).toBeGreaterThan(1);
    element.becomeReady(120);
    element.startPlaying();
    element.fail(3);
    await flush();
    expect(ofType('error').pop()).toMatchObject({
      error: { code: 'DECODER_ERROR', recoverable: true },
    });

    element.becomeReady(120);
    element.startPlaying();
    element.fail(4);
    await flush();
    expect(ofType('error').pop()).toMatchObject({
      error: { code: 'NETWORK_ERROR' },
    });

    world.navigator.onLine = false;
    element.becomeReady(120);
    element.startPlaying();
    element.fail(2);
    await flush();
    expect(ofType('error').pop()).toMatchObject({
      error: { code: 'NETWORK_UNAVAILABLE' },
    });
  });

  it('reports the end of a file', async () => {
    const id = module.createPlayer({});
    const element = await loadFile(id, 10, { autoplay: true });
    element.startPlaying();
    element.dispatch('ended');
    await flush();
    expect(status(id).state).toBe('ended');
    expect(ofType('ended')).toHaveLength(1);
  });

  it('treats a pause it did not ask for as a system interruption', async () => {
    const id = module.createPlayer({});
    const element = await loadFile(id, 120, { autoplay: true });
    element.startPlaying();
    element.pause();
    await flush();
    expect(status(id)).toMatchObject({
      playWhenReady: false,
      interruption: { reason: 'system' },
    });
  });

  it('releases the element on stop and unloads on reset', async () => {
    const id = module.createPlayer({});
    const element = await loadFile(id);
    await module.stop(id);
    expect(element.src).toBe('');
    expect(status(id).state).toBe('stopped');
    await module.reset(id);
    expect(status(id).state).toBe('idle');
  });

  it('rejects with engine errors', async () => {
    const id = module.createPlayer({});
    await expect(module.play(id)).rejects.toMatchObject({ code: 'NO_SOURCE' });
    await expect(module.setRate(id, 0)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await loadFile(id);
    await expect(module.setVolume(id, Number.NaN)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('refuses everything once released', async () => {
    const id = module.createPlayer({});
    await module.releasePlayer(id);
    await module.releasePlayer(id);
    await expect(module.play(id)).rejects.toMatchObject({
      code: 'PLAYER_RELEASED',
    });
    await expect(
      module.load(id, { uri: 'https://a.example/x.mp3' }, {})
    ).rejects.toMatchObject({
      code: 'PLAYER_RELEASED',
    });
    await expect(module.updateNowPlaying(id, {})).rejects.toMatchObject({
      code: 'PLAYER_RELEASED',
    });
    expect(() => module.getStatus(id)).toThrow();
    expect(() => module.getProgress(id)).toThrow();
    expect(module.getMetadata(id)).toEqual({ metadata: null });
    expect(module.getDiagnostics(id)).toEqual([]);
    expect(module.setAudioSampling(id, true, 512)).toBe(false);
    module.setDiagnosticsEnabled(id, true);
  });

  it('keeps a bounded diagnostics trace and streams it when enabled', async () => {
    const debug = jest
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);
    const id = module.createPlayer({});
    module.setDiagnosticsEnabled(id, true);
    for (let i = 0; i < 400; i++) {
      module
        .load(id, { uri: `https://cdn.example/${i}.mp3`, live: false }, {})
        .catch(() => undefined);
    }
    await flush();
    expect(module.getDiagnostics(id)).toHaveLength(300);
    expect(ofType('diagnostic').length).toBeGreaterThan(0);
    expect(debug).toHaveBeenCalled();
    debug.mockRestore();
  });

  it('emits progress events while playing when asked to', async () => {
    const id = module.createPlayer({ progressInterval: 500 });
    const element = await loadFile(id, 120, { autoplay: true });
    element.startPlaying();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(ofType('progress')).toHaveLength(2);
    await module.pause(id);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(ofType('progress')).toHaveLength(2);
  });
});

describe('media session', () => {
  it('shows the active player and answers the system controls', async () => {
    const id = module.createPlayer({
      mediaSession: { commands: ['next', 'skipForward'] },
    });
    const loading = module.load(
      id,
      {
        uri: 'https://cdn.example/a.mp3',
        live: false,
        metadata: {
          title: 'Song',
          artist: 'Band',
          artwork: { uri: 'https://img.example/a.png' },
        },
      },
      { autoplay: true }
    );
    const element = world.element();
    element.becomeReady(100);
    await flush();
    await loading;
    element.startPlaying();
    await flush();
    const session = world.session;
    expect(session.playbackState).toBe('playing');
    expect(session.metadata).toMatchObject({
      init: {
        title: 'Song',
        artist: 'Band',
        artwork: [{ src: 'https://img.example/a.png' }],
      },
    });
    expect(session.positions.pop()).toMatchObject({ duration: 100 });

    session.trigger('pause');
    expect(status(id).playWhenReady).toBe(false);
    session.trigger('play');
    expect(status(id).playWhenReady).toBe(true);
    session.trigger('seekto', { seekTime: 10 });
    expect(element.currentTime).toBe(10);
    session.trigger('seekto', {});
    session.trigger('nexttrack');
    session.trigger('seekforward');
    await flush();
    expect(ofType('remoteCommand').map((e) => e.command)).toEqual([
      'next',
      'skipForward',
    ]);
    expect(session.handlers.get('previoustrack')).toBeNull();
  });

  it('shows the song progress the app gives for a live stream', async () => {
    const id = module.createPlayer({});
    await loadFile(id);
    await module.updateNowPlaying(id, {
      title: 'Live song',
      duration: 200,
      elapsed: 20,
    });
    expect(world.session.positions.pop()).toMatchObject({
      duration: 200,
      position: 20,
    });
    await module.updateNowPlaying(id, {});
    expect(world.session.metadata).toMatchObject({
      init: { title: undefined },
    });
  });

  it('forwards play when nothing is loaded: only the app knows what to load', async () => {
    const id = module.createPlayer({});
    world.session.trigger('play');
    await flush();
    expect(ofType('remoteCommand')).toEqual([
      expect.objectContaining({ playerId: id, command: 'play' }),
    ]);
    world.session.trigger('stop');
  });

  it('hands the session to another player when the active one is released', async () => {
    const a = module.createPlayer({});
    const b = module.createPlayer({});
    await loadFile(b);
    await module.releasePlayer(b);
    world.session.trigger('play');
    await flush();
    expect(ofType('remoteCommand').pop()).toMatchObject({ playerId: a });
    await module.releasePlayer(a);
    expect(world.session.playbackState).toBe('none');
  });

  it('leaves players without a session out', async () => {
    const id = module.createPlayer({ mediaSession: { enabled: false } });
    await loadFile(id);
    expect(world.session.metadata).toBeNull();
  });

  it('works without a Media Session', async () => {
    uninstall();
    setup({ mediaSession: false });
    const id = module.createPlayer({});
    await loadFile(id);
    expect(status(id).state).toBe('paused');
  });
});

describe('connectivity and visibility', () => {
  it('follows online/offline edges and network handoffs', async () => {
    const id = module.createPlayer({});
    expect(status(id).network).toBe('online');
    world.window.dispatch('offline');
    await flush();
    expect(status(id).network).toBe('offline');
    world.window.dispatch('online');
    world.navigator.connection.type = 'cellular';
    world.navigator.connection.dispatch('change');
    world.navigator.connection.dispatch('change');
    expect(diagnostics(id)).toEqual(
      expect.arrayContaining([
        'network lost',
        'network restored',
        'network handoff',
      ])
    );
  });

  it('recovers wanted-but-silent audio when the page becomes visible', async () => {
    const id = module.createPlayer({});
    const element = await loadFile(id, 120, { autoplay: true });
    element.startPlaying();
    element.fail(2);
    await flush();
    world.document.visibilityState = 'hidden';
    world.document.dispatch('visibilitychange');
    world.document.visibilityState = 'visible';
    world.document.dispatch('visibilitychange');
    expect(diagnostics(id)).toContain('reopen');
  });
});

describe('live streams through MSE', () => {
  const ICY = {
    'content-type': 'audio/mpeg',
    'icy-metaint': '16000',
    'icy-name': 'Radio X',
    'icy-genre': 'Jazz',
  };

  async function openStream(
    response: Parameters<FakeWorld['fetch']['respond']>[0] = { headers: ICY },
    uri = 'https://radio.example/live'
  ) {
    world.fetch.respond(response);
    const id = module.createPlayer({});
    const loading = module.load(
      id,
      { uri, headers: { 'User-Agent': 'RNAP' } },
      { autoplay: true }
    );
    loading.catch(() => undefined);
    await flush();
    return {
      id,
      loading,
      element: world.element(),
      body: () => world.fetch.last().body,
    };
  }

  it('reads ICY metadata, announces the station and delivers each title when heard', async () => {
    const { id, loading, element, body } = await openStream();
    expect(element.src.startsWith('blob:')).toBe(true);
    expect(world.fetch.last().headers).toMatchObject({
      'Icy-MetaData': '1',
      'User-Agent': 'RNAP',
    });
    expect(ofType('metadata').pop()).toMatchObject({
      metadata: { station: 'Radio X', genre: 'Jazz' },
    });

    body().push(icyChunk(16_000, 'Artist - Title'));
    body().push(icyChunk(16_000, null));
    await flush();
    element.becomeReady(Number.POSITIVE_INFINITY);
    await flush();
    await loading;
    element.startPlaying();
    await flush();
    expect(status(id)).toMatchObject({ isLive: true, seekable: false });
    expect(ofType('metadata')).toHaveLength(1);

    element.currentTime = 16_000 / BYTES_PER_SECOND;
    element.dispatch('timeupdate');
    await flush();
    expect(ofType('metadata').pop()).toMatchObject({
      metadata: {
        artist: 'Artist',
        title: 'Title',
        station: 'Radio X',
        raw: { StreamTitle: 'Artist - Title' },
      },
    });
    expect(module.getMetadata(id)).toMatchObject({
      metadata: { title: 'Title' },
    });
    expect(
      (module.getProgress(id) as { liveOffset: number }).liveOffset
    ).toBeCloseTo(1);
  });

  it('times a title with a timer between timeupdates', async () => {
    const { element, body } = await openStream();
    for (let i = 0; i < 3; i++)
      body().push(icyChunk(16_000, i === 2 ? 'Late - Song' : null));
    await flush();
    element.becomeReady(Number.POSITIVE_INFINITY);
    element.startPlaying();
    await flush();
    // Between timeupdates: the timer armed on `playing` lands it at 3 s.
    element.currentTime = 3;
    await jest.advanceTimersByTimeAsync(3_100);
    expect(ofType('metadata').pop()).toMatchObject({
      metadata: { title: 'Song' },
    });
  });

  it('asks again without ICY when a cross-origin server hides icy-metaint', async () => {
    world.fetch.respond({ headers: { 'content-type': 'audio/mpeg' } });
    const { id } = await openStream({
      headers: { 'content-type': 'audio/mpeg' },
    });
    expect(world.fetch.requests).toHaveLength(2);
    expect(world.fetch.requests[0]!.headers['Icy-MetaData']).toBe('1');
    expect(world.fetch.requests[1]!.headers['Icy-MetaData']).toBeUndefined();
    expect(world.fetch.requests[0]!.body.cancelled).toBe(true);
    expect(diagnostics(id)).toContain('icy unavailable');
  });

  it('trusts a same-origin response without icy-metaint', async () => {
    await openStream(
      { headers: { 'content-type': 'audio/aacp' } },
      'https://app.example/live'
    );
    expect(world.fetch.requests).toHaveLength(1);
  });

  it.each([
    ['an unsupported codec', { 'content-type': 'audio/ogg' }],
    [
      'a finite file',
      { 'content-type': 'audio/mpeg', 'content-length': '1000' },
    ],
  ])('falls back to the plain element for %s', async (_name, headers) => {
    const { element, id } = await openStream(
      { headers },
      'https://app.example/live'
    );
    expect(element.src).toBe('https://app.example/live');
    expect(diagnostics(id)).toContain('plain playback');
    expect(element.plays).toBeGreaterThan(1);
  });

  it('falls back at once for a cross-origin file', async () => {
    const { element } = await openStream({
      headers: { 'content-type': 'audio/mpeg', 'content-length': '1000' },
    });
    expect(world.fetch.requests).toHaveLength(1);
    expect(element.src).toBe('https://radio.example/live');
  });

  it('falls back when the source buffer cannot be created or there is no body', async () => {
    const { FakeMediaSource } = jest.requireActual(
      './FakeBrowser'
    ) as typeof import('./FakeBrowser');
    FakeMediaSource.failAdd = true;
    const first = await openStream();
    expect(first.element.src).toBe('https://radio.example/live');
    FakeMediaSource.failAdd = false;
    world.fetch.respond({ headers: ICY, noBody: true });
    const id = module.createPlayer({});
    module
      .load(id, { uri: 'https://radio.example/b' }, {})
      .catch(() => undefined);
    await flush();
    expect(world.element().src).toBe('https://radio.example/b');
  });

  it('falls back when fetch fails while online (CORS), fails offline', async () => {
    const { element } = await openStream(new TypeError('Failed to fetch'));
    expect(element.src).toBe('https://radio.example/live');

    world.navigator.onLine = false;
    world.fetch.respond(new TypeError('Failed to fetch'));
    const id = module.createPlayer({});
    const loading = module.load(id, { uri: 'https://radio.example/c' }, {});
    const settled = loading.then(
      () => null,
      (error: unknown) => error
    );
    await flush();
    expect(await settled).toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
  });

  it('treats a failed fetch as the network once the source streamed with CORS', async () => {
    const { id, element, body } = await openStream();
    body().push(icyChunk(16_000, null));
    element.becomeReady(Number.POSITIVE_INFINITY);
    element.startPlaying();
    await flush();
    world.fetch.respond(new TypeError('Failed to fetch'));
    element.dispatch('ended'); // the stream closed: reconnect at once
    await flush();
    expect(ofType('error').pop()).toMatchObject({
      error: { code: 'STREAM_ENDED' },
    });
    await jest.advanceTimersByTimeAsync(1_500); // one backoff step (1 s ± 20 %)
    await flush();
    expect(ofType('error').pop()).toMatchObject({
      error: {
        code: 'NETWORK_ERROR',
        message: 'The stream could not be reached.',
      },
    });
    expect(diagnostics(id)).not.toContain('plain playback');
  });

  it('maps HTTP errors', async () => {
    const notFound = await openStream({ status: 404 });
    await expect(notFound.loading).rejects.toMatchObject({
      code: 'SOURCE_NOT_FOUND',
      httpStatus: 404,
    });

    const unavailable = await openStream({ status: 503 });
    await expect(unavailable.loading).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      recoverable: true,
    });
    expect(status(unavailable.id).state).toBe('reconnecting');
  });

  it('fails a first connection that closes before any audio', async () => {
    const { loading, body } = await openStream();
    body().end();
    await flush();
    await expect(loading).rejects.toMatchObject({ code: 'STREAM_ENDED' });
  });

  it('splices a fresh connection when a productive one drops, and reports the jump when heard', async () => {
    const headers = { 'content-type': 'audio/mpeg', 'icy-metaint': '1024' };
    const { id, element, body } = await openStream({ headers });
    element.becomeReady(Number.POSITIVE_INFINITY);
    element.startPlaying();
    for (let i = 0; i < 33; i++) body().push(icyChunk(1024, null));
    await flush();
    await jest.advanceTimersByTimeAsync(3_000); // up long enough to earn a splice
    world.fetch.respond({ headers });
    body().fail(new Error('connection reset'));
    await flush();
    expect(world.fetch.requests).toHaveLength(2);
    const buffer = element.mediaSource!.buffers[0]!;
    expect(buffer.aborts).toBe(1);
    expect(diagnostics(id)).toEqual(
      expect.arrayContaining(['connection dropped', 'connection spliced'])
    );
    expect(ofType('discontinuity')).toHaveLength(0);

    element.currentTime = (33 * 1024) / BYTES_PER_SECOND;
    element.dispatch('timeupdate');
    await flush();
    expect(ofType('discontinuity').pop()).toMatchObject({
      position: (33 * 1024) / BYTES_PER_SECOND,
    });

    // The splice itself fails: the element plays out what it has.
    world.fetch.respond(new TypeError('offline'));
    world.fetch.last().body.end();
    await flush();
    expect(element.mediaSource!.readyState).toBe('ended');
  });

  it('does not splice a short-lived connection, however much it sent (a flapping server)', async () => {
    const headers = { 'content-type': 'audio/mpeg', 'icy-metaint': '1024' };
    const { element, body } = await openStream({ headers });
    for (let i = 0; i < 64; i++) body().push(icyChunk(1024, null)); // a connect burst
    await flush();
    body().end();
    await flush();
    expect(world.fetch.requests).toHaveLength(1);
    expect(element.mediaSource!.readyState).toBe('ended');
  });

  it('ends the stream when an unproductive connection drops', async () => {
    const { element, body } = await openStream();
    body().push(icyChunk(16_000, null));
    await flush();
    body().end();
    await flush();
    expect(element.mediaSource!.readyState).toBe('ended');
  });

  it('ends a splice that gets an HTTP error', async () => {
    const headers = { 'content-type': 'audio/mpeg', 'icy-metaint': '1024' };
    const { element, body } = await openStream({ headers });
    for (let i = 0; i < 33; i++) body().push(icyChunk(1024, null));
    await flush();
    await jest.advanceTimersByTimeAsync(3_000); // up long enough to earn a splice
    world.fetch.respond({ status: 502 });
    body().end();
    await flush();
    expect(element.mediaSource!.readyState).toBe('ended');
  });

  it('closes the connection when released', async () => {
    const { id, body } = await openStream();
    const request = world.fetch.last();
    body().push(icyChunk(16_000, null));
    await flush();
    await module.reset(id);
    expect(request.signal.aborted).toBe(true);
    await flush();
  });

  it('waits for room, retries a full buffer and evicts old audio', async () => {
    const headers = { 'content-type': 'audio/mpeg', 'icy-metaint': '0' };
    // Not ready yet: a "playing" element with a frozen playhead would be
    // (rightly) reopened by the engine's silent-stall watchdog.
    const { id, element, body } = await openStream({ headers });
    const buffer = () => element.mediaSource!.buffers[0]!;
    body().push(new Uint8Array(31 * BYTES_PER_SECOND)); // 31 s ahead
    await flush();
    body().push(new Uint8Array(BYTES_PER_SECOND));
    await jest.advanceTimersByTimeAsync(600);
    expect(buffer().bytes).toBe(31 * BYTES_PER_SECOND);
    element.currentTime = 45; // caught up; 15 s of audio behind the keep window
    buffer().quotaFailures = 1;
    await jest.advanceTimersByTimeAsync(2_000);
    expect(buffer().bytes).toBe(32 * BYTES_PER_SECOND);
    expect(buffer().removed).toEqual([[0, 15]]);

    buffer().quotaFailures = 3;
    body().push(new Uint8Array(10));
    await jest.advanceTimersByTimeAsync(5_000);
    expect(diagnostics(id)).toContain('append dropped');

    buffer().appendError = new Error('broken');
    body().push(new Uint8Array(10));
    await jest.advanceTimersByTimeAsync(100);
    expect(diagnostics(id)).toContain('stream ended');
  });

  it('uses the managed media source on iOS', async () => {
    uninstall();
    setup({ mediaSource: 'managed' });
    const { element } = await openStream();
    // Headers cannot reach an AirPlay receiver: no alternative source, no AirPlay.
    expect(element.disableRemotePlayback).toBe(true);
    expect(element.children).toHaveLength(1);
    expect(element.mediaSource).not.toBeNull();
  });

  it.each([
    ['without MSE', 'none' as const, 'https://radio.example/live'],
    [
      'for HLS, where the browser plays it',
      'standard' as const,
      'https://radio.example/live.m3u8',
    ],
  ])(
    'plays live streams on the element %s',
    async (_name, mediaSource, uri) => {
      uninstall();
      setup({ mediaSource, nativeHls: true });
      const id = module.createPlayer({});
      module.load(id, { uri }, {}).catch(() => undefined);
      expect(world.element().src).toBe(uri);
    }
  );
});

describe('visualizer', () => {
  it('samples a fetched stream once the audio context runs', async () => {
    world.fetch.respond({ headers: { 'content-type': 'audio/mpeg' } });
    const id = module.createPlayer({});
    expect(module.setAudioSampling(id, true, 64)).toBe(true);
    module
      .load(id, { uri: 'https://app.example/live' }, {})
      .catch(() => undefined);
    await flush();
    const element = world.element();
    world.fetch.last().body.push(new Uint8Array(100));
    element.becomeReady(Number.POSITIVE_INFINITY);
    await flush();
    await module.play(id); // a user gesture starts the context
    element.startPlaying();
    await flush();
    await jest.advanceTimersByTimeAsync(100);
    const sample = ofType('audioSample').pop()!;
    expect(sample).toMatchObject({ level: 0.5, outputLatency: 0.03 });
    expect(sample.waveform).toHaveLength(64);
    expect(sample.duration).toBeCloseTo(2048 / 48000);

    // A cross-origin file on the tapped element would play as silence: a fresh element takes it.
    await module.setVolume(id, 0.4);
    const loading = module.load(
      id,
      { uri: 'https://cdn.example/song.mp3', live: false },
      {}
    );
    expect(world.elements).toHaveLength(2);
    expect(world.element().volume).toBe(0.4);
    world.element().becomeReady(10);
    await flush();
    await loading;

    expect(module.setAudioSampling(id, false, 64)).toBe(true);
    const count = ofType('audioSample').length;
    await jest.advanceTimersByTimeAsync(200);
    expect(ofType('audioSample')).toHaveLength(count);
  });

  it('reports no support without Web Audio', () => {
    uninstall();
    setup({ audioContext: false });
    const id = module.createPlayer({});
    expect(module.setAudioSampling(id, true, 64)).toBe(false);
  });
});
