/// <reference types="node" />
// Google Cast in the browser: loading the sender SDK, the state it reports,
// the driver that plays on a receiver, handing players to it and back, and the
// metadata-only connection that keeps titles flowing.

import { FakeCast } from './FakeCast';
import { icyChunk, install, uninstall, type FakeWorld } from './FakeBrowser';
import { WebModule } from '../platform/WebModule';

type Event = Record<string, unknown> & { type: string };
interface Snapshot {
  state: string;
  playWhenReady: boolean;
  loadId: number;
  isLive: boolean;
  seekable: boolean;
  duration: number | null;
  route: { kind: string; name: string | null };
  error: { code: string; recoverable: boolean } | null;
}

let world: FakeWorld;
let module: WebModule;
let events: Event[];
let cast: FakeCast;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}

function setup(options: Parameters<typeof install>[0] = {}) {
  world = install(options);
  module = new WebModule();
  events = [];
  module.onPlayerEvent((e) => events.push(e as Event));
}

const castOf = () =>
  module.getCastState() as { state: string; device: string | null };
const ofType = (type: string) => events.filter((e) => e.type === type);
const status = (id: string) => module.getStatus(id) as Snapshot;
const notes = (id: string) =>
  (module.getDiagnostics(id) as Array<{ event: string }>).map((d) => d.event);
const castStates = () =>
  ofType('castState').map((e) => `${e.state}:${e.device ?? ''}`);

const ICY = {
  'content-type': 'audio/mpeg',
  'icy-metaint': '16000',
  'icy-name': 'Radio X',
  'icy-genre': 'Jazz',
};
const LIVE = 'https://radio.example/live.mp3';

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  setup();
  cast = new FakeCast();
});

afterEach(() => {
  uninstall();
  jest.useRealTimers();
});

/** The page has the Cast SDK, devices are around, and Cast is configured. */
async function ready(devices = true): Promise<void> {
  cast.install();
  cast.setDevicesAvailable(devices);
  await module.configureCast({});
}

/** A live stream playing from this device. */
async function playLive(uri = LIVE, options: object = {}) {
  world.fetch.respond({ headers: ICY });
  const id = module.createPlayer({});
  const loading = module.load(
    id,
    {
      uri,
      live: true,
      metadata: { title: 'Radio X', artwork: 'https://radio.example/art.png' },
    },
    { autoplay: true, ...options }
  );
  loading.catch(() => undefined);
  await flush();
  const element = world.element();
  element.becomeReady(Number.POSITIVE_INFINITY);
  await flush();
  element.startPlaying();
  await flush();
  await loading;
  return { id, element };
}

/** A file, playing from this device. */
async function playFile(uri = 'https://cdn.example/song.mp3') {
  const id = module.createPlayer({});
  const loading = module.load(
    id,
    {
      uri,
      live: false,
      metadata: { title: 'Song', artist: 'Band', album: 'LP' },
    },
    { autoplay: true }
  );
  const element = world.element();
  element.becomeReady(120);
  await flush();
  element.startPlaying();
  await flush();
  await loading;
  return { id, element };
}

describe('the sender SDK', () => {
  it('is unavailable until configured', async () => {
    expect(castOf()).toEqual({
      state: 'unavailable',
      device: null,
    });
    await expect(module.showCastPicker()).rejects.toMatchObject({
      code: 'CAST_UNAVAILABLE',
    });
    await expect(module.stopCasting()).resolves.toBeUndefined();
  });

  it('uses an SDK the page already loaded, with the default receiver', async () => {
    cast.install();
    await module.configureCast({});
    expect(world.scripts).toHaveLength(0);
    expect(castOf()).toEqual({ state: 'noDevices', device: null });
    expect(cast.options).toMatchObject({
      receiverApplicationId: 'CC1AD845',
      autoJoinPolicy: 'origin_scoped',
    });
    expect(castStates()).toEqual(['initializing:', 'noDevices:']);
  });

  it('takes the app’s own receiver, also when configured again later', async () => {
    cast.install();
    const first = module.configureCast({ receiverApplicationId: 'ABCD1234' });
    await first;
    expect(cast.options.receiverApplicationId).toBe('ABCD1234');
    await module.configureCast({ receiverApplicationId: 'EFGH5678' });
    expect(cast.options.receiverApplicationId).toBe('EFGH5678');
    await module.configureCast({});
    expect(cast.options.receiverApplicationId).toBe('EFGH5678');
    expect(castStates()).toEqual(['initializing:', 'noDevices:']);
  });

  it('loads the SDK script and starts when it calls back', async () => {
    const configured = module.configureCast({});
    expect(castOf().state).toBe('initializing');
    expect(world.scripts).toHaveLength(1);
    expect(world.scripts[0]!.src).toBe(
      'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'
    );
    // Asking again shares the load.
    const again = module.configureCast({});
    expect(world.scripts).toHaveLength(1);
    cast.install();
    cast.setDevicesAvailable(true);
    (globalThis as { __onGCastApiAvailable?: (ok: boolean) => void })
      .__onGCastApiAvailable!(true);
    await Promise.all([configured, again]);
    expect(castOf().state).toBe('notConnected');
  });

  it.each([
    ['the SDK says it is not available', 'callback'],
    ['the script fails to load', 'error'],
    ['it never answers', 'timeout'],
  ])('settles as unavailable when %s', async (_name, how) => {
    const configured = module.configureCast({});
    if (how === 'callback')
      (globalThis as { __onGCastApiAvailable?: (ok: boolean) => void })
        .__onGCastApiAvailable!(false);
    else if (how === 'error') world.scripts[0]!.onerror!();
    else await jest.advanceTimersByTimeAsync(15_000);
    await configured;
    expect(castOf()).toEqual({
      state: 'unavailable',
      device: null,
    });
    expect(castStates()).toEqual(['initializing:', 'unavailable:']);
    await expect(module.showCastPicker()).rejects.toMatchObject({
      code: 'CAST_UNAVAILABLE',
    });
  });

  it.each([
    [
      'Firefox',
      {
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
      },
    ],
    [
      'Chrome on iOS',
      {
        userAgent:
          'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/140.0 Mobile/15E148 Safari/604.1',
      },
    ],
    ['an insecure page', { secureContext: false }],
  ])('does not even try on %s', async (_name, options) => {
    uninstall();
    setup(options);
    await module.configureCast({});
    expect(world.scripts).toHaveLength(0);
    expect(castOf().state).toBe('unavailable');
  });

  it('does not touch a page without a document', async () => {
    const g = globalThis as Record<string, unknown>;
    const document = g.document;
    g.document = undefined;
    try {
      await module.configureCast({});
    } finally {
      g.document = document;
    }
    expect(castOf().state).toBe('unavailable');
  });

  it('follows the SDK’s state and names the receiver', async () => {
    await ready(false);
    expect(castOf().state).toBe('noDevices');
    cast.setDevicesAvailable(true);
    cast.connect({ friendlyName: 'Kitchen', label: 'k1' });
    expect(castOf()).toEqual({
      state: 'connected',
      device: 'Kitchen',
    });
    cast.end();
    expect(castOf()).toEqual({
      state: 'notConnected',
      device: null,
    });
    await flush();
    expect(castStates()).toEqual([
      'initializing:',
      'noDevices:',
      'notConnected:',
      'connecting:',
      'connected:Kitchen',
      'notConnected:',
    ]);
  });

  it('opens the chooser inside the click, and tells what failed', async () => {
    await ready();
    const picked = module.showCastPicker();
    expect(cast.requests).toBe(1);
    await expect(picked).resolves.toBeUndefined();
    cast.requestResult = 'cancel';
    await expect(module.showCastPicker()).resolves.toBeUndefined();
    cast.requestResult = 'receiver_unavailable';
    await expect(module.showCastPicker()).rejects.toMatchObject({
      code: 'CAST_UNAVAILABLE',
      message: expect.stringContaining('receiver_unavailable'),
    });
  });

  it('settles a rejected request as the SDK’s code, or as an error', async () => {
    await ready();
    const context = (
      globalThis as any
    ).cast.framework.CastContext.getInstance();
    context.requestSession = () => Promise.reject('session_error');
    await expect(module.showCastPicker()).rejects.toMatchObject({
      code: 'CAST_UNAVAILABLE',
    });
    context.requestSession = () => Promise.reject(new Error('boom'));
    await expect(module.showCastPicker()).rejects.toMatchObject({
      message: 'boom',
    });
    context.requestSession = () => Promise.reject('cancel');
    await expect(module.showCastPicker()).resolves.toBeUndefined();
  });

  it('stops casting, waiting for the session to end', async () => {
    await ready();
    cast.connect();
    const stopped = module.stopCasting();
    await expect(stopped).resolves.toBeUndefined();
    expect(cast.ended).toBe(1);
    expect(castOf().state).toBe('notConnected');
  });

  it('does not wait forever for a session that will not end', async () => {
    await ready();
    cast.connect();
    const context = (
      globalThis as any
    ).cast.framework.CastContext.getInstance();
    context.endCurrentSession = () => undefined;
    const stopped = module.stopCasting();
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(stopped).resolves.toBeUndefined();
  });

  it('adopts a session that was already there', async () => {
    cast.install();
    cast.resume();
    await module.configureCast({});
    expect(castOf()).toEqual({
      state: 'connected',
      device: 'Living Room',
    });
    const id = module.createPlayer({});
    expect(status(id).route).toEqual({ kind: 'cast', name: 'Living Room' });
  });
});

describe('playing on a receiver', () => {
  beforeEach(ready);

  it('hands the playing stream to the receiver when a session starts', async () => {
    const { id, element } = await playLive();
    expect(status(id).route.kind).toBe('unknown');
    const listeners = world.fetch.requests.length;
    cast.connect();
    await flush();

    expect(cast.loads).toHaveLength(1);
    expect(cast.loads[0]).toMatchObject({
      contentId: LIVE,
      contentType: 'audio/mpeg',
      streamType: 'LIVE',
      autoplay: true,
      metadata: {
        title: 'Radio X',
        images: [{ url: 'https://radio.example/art.png' }],
      },
    });
    expect(cast.loads[0]!.currentTime).toBeUndefined();
    expect(status(id)).toMatchObject({
      state: 'playing',
      playWhenReady: true,
      isLive: true,
      route: { kind: 'cast', name: 'Living Room' },
    });
    // This device let go of the stream (a second connection only reads titles).
    expect(world.fetch.requests[0]!.signal.aborted).toBe(true);
    expect(world.fetch.requests).toHaveLength(listeners + 1);
    expect(element.src).toBe('');
    expect(notes(id)).toContain('handoff');
  });

  it('opens a file on the receiver at the same position', async () => {
    const { id, element } = await playFile();
    element.currentTime = 42;
    cast.duration = 120;
    cast.connect();
    await flush();
    expect(cast.loads[0]).toMatchObject({
      contentId: 'https://cdn.example/song.mp3',
      streamType: 'BUFFERED',
      currentTime: 42,
      metadata: { title: 'Song', artist: 'Band', albumName: 'LP' },
    });
    expect(status(id)).toMatchObject({
      state: 'playing',
      duration: 120,
      seekable: true,
      isLive: false,
    });
    cast.tick(43);
    expect(module.getProgress(id)).toMatchObject({
      position: 43,
      duration: 120,
      buffered: 43,
      liveOffset: null,
    });
  });

  it('describes what the receiver cannot be told as it is', async () => {
    const id = module.createPlayer({});
    cast.connect();
    await flush();
    const loading = module.load(
      id,
      { uri: 'https://cdn.example/clip.m4a?x=1', live: false },
      { autoplay: true }
    );
    await flush();
    await loading;
    expect(cast.loads[0]).toMatchObject({
      contentType: 'audio/mp4',
      metadata: {},
    });
    // An unflagged source with no length is a live one.
    const other = module.load(
      id,
      { uri: 'https://cdn.example/stream' },
      { autoplay: true }
    );
    await flush();
    await other;
    expect(status(id).isLive).toBe(true);
  });

  it('starts a new item on the receiver without a stop-over here', async () => {
    const { id } = await playLive();
    cast.connect();
    await flush();
    const before = world.fetch.requests.length;
    world.fetch.respond({ headers: ICY });
    const loading = module.load(
      id,
      { uri: 'https://radio.example/other.mp3', live: true },
      { autoplay: true }
    );
    await flush();
    await loading;
    expect(cast.loads).toHaveLength(2);
    expect(cast.loads[1]!.contentId).toBe('https://radio.example/other.mp3');
    // Only the titles connection for the new station was opened here.
    expect(world.fetch.requests).toHaveLength(before + 1);
    expect(world.fetch.last().headers['Icy-MetaData']).toBe('1');
    expect(status(id)).toMatchObject({
      state: 'playing',
      route: { kind: 'cast' },
    });
  });

  it('pauses, plays, seeks and sets the volume on the receiver', async () => {
    const { id, element } = await playFile();
    element.currentTime = 10;
    cast.duration = 120;
    cast.connect();
    await flush();
    // The handoff set the player's own volume (1), then the app's.
    await module.setVolume(id, 0.4);
    expect(cast.volumes).toEqual([1, 0.4]);
    await module.setMuted(id, true);
    expect(cast.volumes).toEqual([1, 0.4, 0]);

    await module.pause(id);
    expect(cast.playOrPauses).toBe(1);
    expect(status(id)).toMatchObject({ state: 'paused', playWhenReady: false });
    await module.play(id);
    expect(cast.playOrPauses).toBe(2);
    expect(status(id).state).toBe('playing');
    await module.seekTo(id, 60);
    expect(cast.seeks).toEqual([60]);
    await module.setRate(id, 1.5);
    expect(notes(id)).toContain('cast rate ignored');
    // Nothing to do when it is already as wanted.
    await module.play(id);
    expect(cast.playOrPauses).toBe(2);
  });

  it('leaves the receiver’s volume alone where it has no stream volume', async () => {
    cast.supportsStreamVolume = false;
    const { id } = await playFile();
    cast.connect();
    await flush();
    await module.setVolume(id, 0.4);
    expect(cast.volumes).toEqual([]);
    expect(notes(id)).toContain('cast volume ignored');
  });

  it('keeps a pause and a seek asked for before the receiver is ready', async () => {
    cast.loadBehavior = 'hang';
    const { id, element } = await playFile();
    element.currentTime = 5;
    cast.duration = 120;
    cast.connect();
    await flush();
    expect(status(id).state).toBe('loading');
    await module.seekTo(id, 30);
    await module.setVolume(id, 0.7);
    await module.pause(id);
    cast.release();
    await flush();
    expect(cast.seeks).toEqual([30]);
    expect(cast.volumes).toEqual([0.7]);
    expect(status(id)).toMatchObject({ state: 'paused', playWhenReady: false });
    // The receiver was playing (autoplay) and was paused to match.
    expect(cast.playOrPauses).toBe(1);
  });

  it('treats a pause on the TV as the user’s, not as a failure', async () => {
    const { id } = await playLive();
    cast.connect();
    await flush();
    cast.setPlayerState('PAUSED');
    await flush();
    expect(status(id)).toMatchObject({ state: 'paused', playWhenReady: false });
    expect(status(id).error).toBeNull();
  });

  it('reports buffering, the end of a file and a receiver error', async () => {
    const { id, element } = await playFile();
    element.currentTime = 100;
    cast.duration = 120;
    cast.connect();
    await flush();
    cast.setPlayerState('BUFFERING');
    await jest.advanceTimersByTimeAsync(600);
    expect(status(id).state).toBe('buffering');
    cast.setPlayerState('PLAYING');
    await flush();
    cast.setPlayerState('IDLE', 'FINISHED');
    await flush();
    expect(status(id).state).toBe('ended');
    expect(ofType('ended')).toHaveLength(1);

    const second = await (async () => {
      const live = await playLive();
      return live.id;
    })();
    expect(status(second).route.kind).toBe('cast');
    cast.setPlayerState('IDLE', 'ERROR');
    await flush();
    expect(status(second)).toMatchObject({ state: 'reconnecting' });
    expect(ofType('error').pop()).toMatchObject({
      error: {
        code: 'NETWORK_ERROR',
        recoverable: true,
        platform: 'web',
        platformDomain: 'cast',
      },
      fatal: false,
    });
  });

  it('pauses when another sender takes the receiver over', async () => {
    const { id } = await playLive();
    cast.connect();
    await flush();
    cast.setPlayerState('IDLE', 'INTERRUPTED');
    await flush();
    expect(status(id)).toMatchObject({ state: 'paused', playWhenReady: false });
  });

  it('retries a load the receiver refused, however it says so', async () => {
    cast.loadBehavior = 'resolveError';
    const { id } = await playLive();
    cast.connect();
    await flush();
    expect(status(id).state).toBe('reconnecting');
    expect(ofType('error').pop()).toMatchObject({
      error: { code: 'NETWORK_ERROR', recoverable: true },
    });
    cast.loadBehavior = 'accept';
    await jest.advanceTimersByTimeAsync(30_000);
    await flush();
    expect(status(id).state).toBe('playing');

    cast.loadBehavior = 'reject';
    const loading = module.load(
      id,
      { uri: 'https://radio.example/b.mp3', live: true },
      { autoplay: true }
    );
    loading.catch(() => undefined);
    await flush();
    expect(status(id).state).toBe('reconnecting');
  });

  it('does not report the receiver going idle as the session ends', async () => {
    const { id } = await playLive();
    cast.connect();
    await flush();
    // The SDK reports the idle player before it reports the session ended.
    cast.inSession = false;
    cast.setPlayerState('IDLE', 'FINISHED');
    await flush();
    expect(status(id).state).toBe('playing');
    expect(ofType('ended')).toHaveLength(0);
  });

  it('stops the receiver when the player is released', async () => {
    const { id } = await playLive();
    cast.connect();
    await flush();
    await module.releasePlayer(id);
    expect(cast.stops).toBe(1);
  });

  it('fails softly when there is no session to play on', async () => {
    const { id } = await playLive();
    cast.connect();
    await flush();
    // The session vanished without telling (a broken SDK): the engine recovers.
    cast.inSession = false;
    const loading = module.load(
      id,
      { uri: LIVE, live: true },
      { autoplay: true }
    );
    loading.catch(() => undefined);
    await flush();
    expect(status(id).state).toBe('reconnecting');
  });
});

describe('handing players back and forth', () => {
  beforeEach(ready);

  it('returns to this device, paused, when the session ends', async () => {
    const { id, element } = await playLive();
    world.fetch.respond({ headers: ICY });
    cast.connect();
    await flush();
    world.fetch.respond({ headers: ICY });
    cast.end();
    await flush();
    // It opens on this device again, but does not play.
    element.becomeReady(Number.POSITIVE_INFINITY);
    await flush();
    expect(status(id)).toMatchObject({
      state: 'paused',
      playWhenReady: false,
      route: { kind: 'unknown', name: null },
    });
    expect(cast.stops).toBe(0);
    expect(notes(id).filter((n) => n === 'handoff')).toHaveLength(2);
    expect(element.paused).toBe(true);
  });

  it('puts a stopped or ended player back on its own, with nothing opened', async () => {
    const { id } = await playFile();
    await module.stop(id);
    cast.connect();
    await flush();
    expect(status(id)).toMatchObject({
      state: 'stopped',
      route: { kind: 'cast' },
    });
    expect(cast.loads).toHaveLength(0);
    await module.play(id);
    await flush();
    expect(cast.loads).toHaveLength(1);
    expect(status(id).state).toBe('playing');
  });

  it('hands the player that exists when the session starts, even if nothing is loaded', async () => {
    const id = module.createPlayer({});
    cast.connect();
    expect(status(id).route).toEqual({ kind: 'cast', name: 'Living Room' });
    const before = world.fetch.requests.length;
    world.fetch.respond({ headers: ICY });
    const loading = module.load(
      id,
      { uri: LIVE, live: true },
      { autoplay: true }
    );
    await flush();
    await loading;
    expect(cast.loads).toHaveLength(1);
    // Straight to the receiver: this device opened the titles connection only.
    expect(world.fetch.requests).toHaveLength(before + 1);
    expect(world.elements.every((e) => e.srcHistory.length === 0)).toBe(true);
  });

  it('does not reload for a session resumed on the same device', async () => {
    const { id } = await playLive();
    cast.connect();
    await flush();
    cast.resume();
    await flush();
    expect(cast.loads).toHaveLength(1);
    expect(status(id).state).toBe('playing');
  });

  it('follows the active player: the previous one is handed back, paused', async () => {
    const first = await playLive();
    cast.connect();
    await flush();
    expect(status(first.id).route.kind).toBe('cast');

    // A second player plays: Cast follows it.
    const second = module.createPlayer({});
    const requests = world.fetch.requests.length;
    world.fetch.respond({ headers: ICY });
    world.fetch.respond({ headers: ICY });
    const loading = module.load(
      second,
      { uri: 'https://radio.example/two.mp3', live: true },
      { autoplay: true }
    );
    await flush();
    await loading;
    first.element.becomeReady(Number.POSITIVE_INFINITY);
    await flush();
    expect(status(first.id)).toMatchObject({
      state: 'paused',
      playWhenReady: false,
      route: { kind: 'unknown' },
    });
    expect(status(second).route.kind).toBe('cast');
    expect(cast.loads.map((l) => l.contentId)).toEqual([
      LIVE,
      'https://radio.example/two.mp3',
    ]);
    // The second player never opened its stream on this device.
    expect(
      world.fetch.requests
        .slice(requests)
        .every((r) => r.headers['Icy-MetaData'] === '1')
    ).toBe(true);
  });

  it('moves Cast to the player that has a source, when it starts playing later', async () => {
    const first = await playLive();
    cast.connect();
    await flush();
    const second = await playFile('https://cdn.example/b.mp3');
    // `playFile` ran after Cast: the second player took over, the first was handed back.
    expect(status(second.id).route.kind).toBe('cast');
    expect(status(first.id).route.kind).toBe('unknown');
    first.element.becomeReady(Number.POSITIVE_INFINITY);
    await flush();
    expect(status(first.id).state).toBe('paused');

    // The first resumes: Cast goes back to it.
    await module.play(first.id);
    await flush();
    expect(status(first.id).route.kind).toBe('cast');
    expect(status(second.id).route.kind).toBe('unknown');
  });

  it('hands the next player over when the casting one is released', async () => {
    const first = await playLive();
    const second = module.createPlayer({});
    cast.connect();
    await flush();
    await module.releasePlayer(first.id);
    await flush();
    // The second player is the lock screen's now, and it is idle: just routed.
    expect(status(second).route.kind).toBe('unknown');
    const loading = module.load(
      second,
      { uri: LIVE, live: true },
      { autoplay: true }
    );
    loading.catch(() => undefined);
    await flush();
    expect(status(second).route.kind).toBe('cast');
  });

  describe('a source the receiver cannot reach', () => {
    it.each([
      'blob:https://app.example/1234',
      'file:///music/a.mp3',
      'data:audio/mpeg;base64,AAAA',
    ])('keeps %s here and says why, once', async (uri) => {
      const id = module.createPlayer({});
      const loading = module.load(id, { uri, live: false }, { autoplay: true });
      const element = world.element();
      element.becomeReady(30);
      await flush();
      await loading;
      cast.connect();
      await flush();
      cast.end();
      cast.connect();
      await flush();
      expect(cast.loads).toHaveLength(0);
      expect(status(id).route.kind).toBe('unknown');
      const errors = ofType('error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        fatal: false,
        error: { code: 'CAST_UNSUPPORTED_SOURCE', recoverable: false },
      });
      expect(cast.requests).toBe(0);
      expect(castOf().state).toBe('connected');
    });

    it('returns a casting player to this device when it loads one', async () => {
      const { id } = await playLive();
      cast.connect();
      await flush();
      const loading = module.load(
        id,
        { uri: 'blob:https://app.example/x', live: false },
        { autoplay: true }
      );
      world.element().becomeReady(30);
      await flush();
      await loading;
      expect(status(id).route).toEqual({ kind: 'unknown', name: null });
      expect(ofType('error').pop()).toMatchObject({
        error: { code: 'CAST_UNSUPPORTED_SOURCE' },
        fatal: false,
      });
      expect(cast.stops).toBe(1);
      // A source it can reach goes back to the receiver.
      world.fetch.respond({ headers: ICY });
      const again = module.load(
        id,
        { uri: LIVE, live: true },
        { autoplay: true }
      );
      await flush();
      await again;
      expect(status(id).route.kind).toBe('cast');
      expect(cast.loads.at(-1)!.contentId).toBe(LIVE);
    });

    it('resolves a relative URL against the page', async () => {
      const id = module.createPlayer({});
      cast.connect();
      const loading = module.load(
        id,
        { uri: '/media/a.mp3', live: false },
        { autoplay: true }
      );
      await flush();
      await loading;
      expect(cast.loads[0]!.contentId).toBe('https://app.example/media/a.mp3');
    });
  });
});

describe('titles while casting', () => {
  beforeEach(ready);

  async function casting() {
    const { id } = await playLive();
    world.fetch.respond({ headers: ICY });
    cast.connect();
    await flush();
    return id;
  }

  it('reads the stream for titles only, and delivers each one at once', async () => {
    const id = await casting();
    const request = world.fetch.last();
    expect(request.url).toBe(LIVE);
    expect(request.headers['Icy-MetaData']).toBe('1');
    request.body.push(icyChunk(16_000, 'Miles - So What'));
    request.body.push(icyChunk(16_000, null));
    request.body.push(icyChunk(16_000, 'Coltrane - Naima'));
    await flush();
    const titles = ofType('metadata').map(
      (e) => (e.metadata as { title: string }).title
    );
    expect(titles.slice(-2)).toEqual(['So What', 'Naima']);
    expect((module.getMetadata(id) as any).metadata).toMatchObject({
      artist: 'Coltrane',
      title: 'Naima',
      station: 'Radio X',
    });
    expect((world.session.metadata as any).init).toMatchObject({
      title: 'Naima',
    });
    // The receiver is not involved.
    expect(status(id)).toMatchObject({
      state: 'playing',
      route: { kind: 'cast' },
    });
    expect(cast.loads).toHaveLength(1);
  });

  it('keeps delivering across a reopen of the receiver', async () => {
    const id = await casting();
    cast.loadBehavior = 'resolveError';
    cast.setPlayerState('IDLE', 'ERROR');
    await flush();
    expect(status(id).state).toBe('reconnecting');
    world.fetch.last().body.push(icyChunk(16_000, 'A - B'));
    await flush();
    expect((module.getMetadata(id) as any).metadata.title).toBe('B');
  });

  it('reconnects with a growing wait while the player is casting', async () => {
    await casting();
    const count = () => world.fetch.requests.length;
    const base = count();
    world.fetch.respond({ headers: ICY });
    world.fetch.last().body.end();
    await jest.advanceTimersByTimeAsync(999);
    expect(count()).toBe(base);
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(count()).toBe(base + 1);

    // The next wait is twice as long, and the attempt after it fails.
    world.fetch.respond(new Error('offline'));
    world.fetch.last().body.end();
    await jest.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(count()).toBe(base + 1);

    // Then four seconds.
    world.fetch.respond({ headers: ICY });
    await jest.advanceTimersByTimeAsync(3_999);
    expect(count()).toBe(base + 1);
    await jest.advanceTimersByTimeAsync(1);
    await flush();
    expect(count()).toBe(base + 2);

    // A read error is a dropped connection like any other.
    world.fetch.last().body.fail(new Error('reset'));
    await flush();
    world.fetch.respond({ headers: ICY });
    await jest.advanceTimersByTimeAsync(8_000);
    await flush();
    expect(count()).toBe(base + 3);
  });

  it('starts the backoff over after a connection that stayed up', async () => {
    await casting();
    const count = () => world.fetch.requests.length;
    world.fetch.respond({ headers: ICY });
    world.fetch.last().body.end();
    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
    const base = count();
    // This one stays up: its end earns a one-second wait, not four.
    await jest.advanceTimersByTimeAsync(11_000);
    world.fetch.respond({ headers: ICY });
    world.fetch.last().body.end();
    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(count()).toBe(base + 1);
  });

  it('retries a refusal, but not a stream with no titles to read', async () => {
    await casting();
    const base = world.fetch.requests.length;
    world.fetch.respond({ status: 503 });
    world.fetch.last().body.end();
    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(world.fetch.requests).toHaveLength(base + 1);
    world.fetch.respond({ headers: { 'content-type': 'audio/mpeg' } });
    await jest.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(world.fetch.requests).toHaveLength(base + 2);
    // No icy-metaint: nothing to read, so no further attempts.
    await jest.advanceTimersByTimeAsync(120_000);
    await flush();
    expect(world.fetch.requests).toHaveLength(base + 2);
  });

  it('stops when the session ends', async () => {
    await casting();
    const reader = world.fetch.last();
    world.fetch.respond({ headers: ICY });
    cast.end();
    await flush();
    expect(reader.signal.aborted).toBe(true);
    const count = world.fetch.requests.length;
    await jest.advanceTimersByTimeAsync(60_000);
    await flush();
    // Back on this device, paused: the stream is not opened for titles.
    expect(world.fetch.requests.length).toBeLessThanOrEqual(count + 1);
  });

  it('stops when the player pauses, and starts again when it plays', async () => {
    const id = await casting();
    const reader = world.fetch.last();
    await module.pause(id);
    await flush();
    expect(reader.signal.aborted).toBe(true);
    const count = world.fetch.requests.length;
    world.fetch.respond({ headers: ICY });
    await module.play(id);
    await flush();
    expect(world.fetch.requests.length).toBe(count + 1);
  });

  it('switches to the new source when the source changes', async () => {
    const id = await casting();
    const reader = world.fetch.last();
    world.fetch.respond({ headers: ICY });
    const loading = module.load(
      id,
      { uri: 'https://radio.example/other.mp3', live: true },
      { autoplay: true }
    );
    await flush();
    await loading;
    expect(reader.signal.aborted).toBe(true);
    expect(world.fetch.last().url).toBe('https://radio.example/other.mp3');
  });

  it('reads no titles for a file', async () => {
    const { id } = await playFile();
    const base = world.fetch.requests.length;
    cast.connect();
    await flush();
    expect(status(id).route.kind).toBe('cast');
    expect(world.fetch.requests).toHaveLength(base);
  });

  it('never lets a failure of its own reach the receiver', async () => {
    const id = await casting();
    world.fetch.last().body.fail(new Error('reset'));
    await flush();
    expect(status(id)).toMatchObject({ state: 'playing', error: null });
    expect(ofType('error')).toHaveLength(0);
    expect(cast.stops).toBe(0);
    expect(cast.loads).toHaveLength(1);
  });
});
