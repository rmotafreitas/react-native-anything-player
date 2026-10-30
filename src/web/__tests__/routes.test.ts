/// <reference types="node" />
// Output routes in the browser: Safari's AirPlay, Chrome's Remote Playback,
// the picker and its availability, and a MediaSource that stays AirPlay-able.

import {
  install,
  uninstall,
  type FakeAudio,
  type FakeWorld,
} from './FakeBrowser';
import { RoutingDriver } from '../platform/RoutingDriver';
import { WebModule } from '../platform/WebModule';

type Event = Record<string, unknown> & { type: string };

let world: FakeWorld;
let module: WebModule;
let events: Event[];

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}

function setup(options: Parameters<typeof install>[0] = {}) {
  world = install(options);
  module = new WebModule();
  events = [];
  module.onPlayerEvent((e) => events.push(e as Event));
}

const ofType = (type: string) => events.filter((e) => e.type === type);
const route = (id: string) =>
  (module.getStatus(id) as { route: { kind: string; name: string | null } })
    .route;
const availability = () =>
  ofType('routePickerAvailability').map((e) => e.available);

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
});

afterEach(() => {
  uninstall();
  jest.useRealTimers();
});

/** Loads a file on the plain element and makes it ready. */
async function loadFile(id: string, element: FakeAudio) {
  const loading = module.load(
    id,
    { uri: 'https://cdn.example/song.mp3', live: false },
    {}
  );
  element.becomeReady(120);
  await flush();
  await loading;
}

describe('Safari AirPlay', () => {
  beforeEach(() => setup({ airplay: true }));

  it('reports the route while the element plays to an AirPlay receiver', async () => {
    const id = module.createPlayer({});
    const element = world.element();
    expect(route(id)).toEqual({ kind: 'unknown', name: null });
    element.setWireless(true);
    await flush();
    expect(route(id)).toEqual({ kind: 'airplay', name: null });
    element.setWireless(false);
    await flush();
    expect(route(id)).toEqual({ kind: 'unknown', name: null });
    expect(
      ofType('status')
        .map((e) => (e.route as { kind: string }).kind)
        .slice(-2)
    ).toEqual(['airplay', 'unknown']);
  });

  it('tells when AirPlay receivers appear and go, once per change', async () => {
    expect(module.isRoutePickerAvailable()).toBe(false);
    const id = module.createPlayer({});
    const element = world.element();
    element.setAirplayTargets(true);
    element.setAirplayTargets(true);
    await flush();
    expect(module.isRoutePickerAvailable()).toBe(true);
    element.setAirplayTargets(false);
    await flush();
    expect(module.isRoutePickerAvailable()).toBe(false);
    expect(availability()).toEqual([true, false]);
    await module.releasePlayer(id);
    expect(module.isRoutePickerAvailable()).toBe(false);
  });

  it('opens the AirPlay picker of the active player, or the one asked for', async () => {
    const first = module.createPlayer({});
    const firstElement = world.element();
    const second = module.createPlayer({});
    const secondElement = world.element();
    await module.showRoutePicker(null);
    expect(firstElement.airplayPickers).toBe(1);
    await module.showRoutePicker(second);
    expect(secondElement.airplayPickers).toBe(1);
    await expect(module.showRoutePicker('nope')).rejects.toMatchObject({
      code: 'PLAYER_RELEASED',
    });
    expect(first).not.toBe(second);
  });

  it('opens the picker synchronously, inside the gesture', () => {
    module.createPlayer({});
    module.showRoutePicker(null).catch(() => undefined);
    expect(world.element().airplayPickers).toBe(1);
  });

  it('follows an element that was replaced', async () => {
    const id = module.createPlayer({});
    const old = world.element();
    // Routed through Web Audio, an element cannot take a cross-origin source.
    expect(module.setAudioSampling(id, true, 64)).toBe(true);
    world.fetch.respond({ headers: { 'content-type': 'audio/mpeg' } });
    module
      .load(id, { uri: 'https://app.example/live' }, {})
      .catch(() => undefined);
    await flush();
    world.fetch.last().body.push(new Uint8Array(100));
    old.becomeReady(Number.POSITIVE_INFINITY);
    await flush();
    await module.play(id);
    old.startPlaying();
    await flush();
    module
      .load(id, { uri: 'https://cdn.example/song.mp3', live: false }, {})
      .catch(() => undefined);
    const replaced = world.element();
    expect(replaced).not.toBe(old);
    replaced.setWireless(true);
    await flush();
    expect(route(id).kind).toBe('airplay');
    old.setWireless(false);
    await flush();
    expect(route(id).kind).toBe('airplay');
  });
});

describe('Chrome Remote Playback', () => {
  beforeEach(() => setup({ remotePlayback: true }));

  it('offers the picker while a receiver is available, not for a stream read through MSE', async () => {
    const id = module.createPlayer({});
    const remote = world.element().remote!;
    await flush();
    expect(remote.watching).toBe(1);
    remote.setAvailable(true);
    await flush();
    expect(module.isRoutePickerAvailable()).toBe(true);
    expect(availability()).toEqual([true]);

    // A blob: MediaSource is not something a receiver can fetch.
    world.fetch.respond({ headers: { 'content-type': 'audio/mpeg' } });
    module
      .load(id, { uri: 'https://radio.example/live', live: true }, {})
      .catch(() => undefined);
    await flush();
    expect(module.isRoutePickerAvailable()).toBe(false);
    await expect(module.showRoutePicker(null)).rejects.toMatchObject({
      code: 'ROUTE_PICKER_UNAVAILABLE',
    });
    expect(remote.prompts).toBe(0);
    expect(availability()).toEqual([true, false]);
  });

  it('prompts inside the gesture and treats a dismissed prompt as done', async () => {
    const id = module.createPlayer({});
    const remote = world.element().remote!;
    await loadFile(id, world.element());
    const shown = module.showRoutePicker(null);
    expect(remote.prompts).toBe(1);
    await expect(shown).resolves.toBeUndefined();
    remote.promptError = {
      name: 'NotAllowedError',
      message: 'The prompt was dismissed.',
    };
    await expect(module.showRoutePicker(id)).resolves.toBeUndefined();
    remote.promptError = { name: 'AbortError', message: 'closed' };
    await expect(module.showRoutePicker(id)).resolves.toBeUndefined();
    remote.promptError = { name: 'NotFoundError', message: 'no devices' };
    await expect(module.showRoutePicker(id)).rejects.toMatchObject({
      code: 'ROUTE_PICKER_UNAVAILABLE',
    });
    remote.promptError = {
      name: 'NotAllowedError',
      message: 'Must be handling a user gesture',
    };
    await expect(module.showRoutePicker(id)).rejects.toMatchObject({
      code: 'ROUTE_PICKER_UNAVAILABLE',
    });
  });

  it('reports the route while the browser casts the element itself', async () => {
    const id = module.createPlayer({});
    const remote = world.element().remote!;
    remote.setState('connecting');
    await flush();
    expect(route(id).kind).toBe('unknown');
    remote.setState('connected');
    await flush();
    expect(route(id)).toEqual({ kind: 'cast', name: null });
    remote.setState('disconnected');
    await flush();
    expect(route(id).kind).toBe('unknown');
  });

  it('stops watching when the player is released, and survives a browser that refuses', async () => {
    const id = module.createPlayer({});
    const remote = world.element().remote!;
    await flush();
    await module.releasePlayer(id);
    await flush();
    expect(remote.cancelled).toHaveLength(1);
    expect(remote.watching).toBe(0);

    uninstall();
    setup({ remotePlayback: true, refuseWatch: true });
    const refusing = module.createPlayer({});
    await flush();
    await module.releasePlayer(refusing);
    await flush();
    expect(world.element().remote!.cancelled).toHaveLength(0);
  });
});

describe('browsers without an output picker', () => {
  it('has none, and says so', async () => {
    setup();
    expect(module.isRoutePickerAvailable()).toBe(false);
    await expect(module.showRoutePicker(null)).rejects.toMatchObject({
      code: 'ROUTE_PICKER_UNAVAILABLE',
      message: 'There is no player to route.',
    });
    module.createPlayer({});
    await expect(module.showRoutePicker(null)).rejects.toMatchObject({
      code: 'ROUTE_PICKER_UNAVAILABLE',
      message: 'This browser has no output picker.',
    });
  });
});

describe('a ManagedMediaSource and AirPlay', () => {
  const ICY = { 'content-type': 'audio/mpeg' };

  async function open(uri: string, headers: Record<string, string> = {}) {
    world.fetch.respond({ headers: ICY });
    const id = module.createPlayer({});
    module
      .load(id, { uri, headers }, { autoplay: true })
      .catch(() => undefined);
    await flush();
    return { id, element: world.element() };
  }

  beforeEach(() => setup({ mediaSource: 'managed', airplay: true }));

  it('attaches the media source and an AirPlay alternative with the stream URL', async () => {
    const { element } = await open('https://radio.example/live.mp3');
    expect(element.src).toBe('');
    expect(element.children).toHaveLength(2);
    expect(element.children[0]!.src.startsWith('blob:')).toBe(true);
    expect(element.children[1]).toEqual({
      src: 'https://radio.example/live.mp3',
      type: 'audio/mpeg',
    });
    expect(element.disableRemotePlayback).toBe(false);
    expect(element.mediaSource).not.toBeNull();
  });

  it('leaves the type off an alternative it cannot tell', async () => {
    const { element } = await open('https://radio.example/live');
    expect(element.children[1]).toEqual({
      src: 'https://radio.example/live',
      type: '',
    });
    const aac = await open('https://radio.example/stream.aac');
    expect(aac.element.children[1]!.type).toBe('audio/aac');
  });

  it('keeps AirPlay off for a stream that needs headers', async () => {
    const { element } = await open('https://radio.example/live', {
      Authorization: 'secret',
    });
    expect(element.children).toHaveLength(1);
    expect(element.disableRemotePlayback).toBe(true);
  });

  it("clears a previous item's src before attaching the media source", async () => {
    const id = module.createPlayer({});
    module
      .load(id, { uri: 'https://cdn.example/song.mp3', live: false }, {})
      .catch(() => undefined);
    await flush();
    const element = world.element();
    expect(element.src).toBe('https://cdn.example/song.mp3');
    world.fetch.respond({ headers: ICY });
    module
      .load(id, { uri: 'https://radio.example/live.mp3' }, { autoplay: true })
      .catch(() => undefined);
    await flush();
    expect(element.src).toBe('');
    expect(element.children).toHaveLength(2);
    expect(element.mediaSource).not.toBeNull();
  });

  it('removes the sources with the stream, and lets the next item use AirPlay again', async () => {
    const { id, element } = await open('https://radio.example/live', {
      Authorization: 'secret',
    });
    module
      .load(id, { uri: 'https://cdn.example/song.mp3', live: false }, {})
      .catch(() => undefined);
    await flush();
    expect(element.children).toHaveLength(0);
    expect(element.disableRemotePlayback).toBe(false);
    expect(element.src).toBe('https://cdn.example/song.mp3');
  });
});

describe('RoutingDriver', () => {
  const stub = () => ({
    open: jest.fn(),
    play: jest.fn(),
    pause: jest.fn(),
    seek: jest.fn(),
    releaseConnection: jest.fn(),
    unload: jest.fn(),
    setVolume: jest.fn(),
    setRate: jest.fn(),
    switchOutput: jest.fn(),
    sample: jest.fn(() => ({ position: 1, bufferedPosition: 2 })),
    progress: jest.fn(() => ({ position: 1 })),
  });

  it('commands the current output only, and carries the settings across', () => {
    const local = stub();
    const cast = stub();
    const driver = new RoutingDriver(local as never, () => cast as never);
    expect(driver.casting).toBe(false);
    driver.setVolume(0.5);
    driver.setRate(1.5);
    driver.play();
    driver.pause();
    driver.seek(3);
    driver.releaseConnection();
    driver.open({} as never);
    expect(driver.sample()).toEqual({ position: 1, bufferedPosition: 2 });
    expect(local.play).toHaveBeenCalledTimes(1);
    expect(local.seek).toHaveBeenCalledWith(3, false);
    expect(cast.play).not.toHaveBeenCalled();

    driver.unload();
    driver.switchOutput('cast:tv1');
    expect(driver.casting).toBe(true);
    expect(cast.setVolume).toHaveBeenLastCalledWith(0.5);
    expect(cast.setRate).toHaveBeenLastCalledWith(1.5);
    driver.play();
    expect(driver.progress()).toEqual({ position: 1 });
    expect(cast.play).toHaveBeenCalledTimes(1);
    expect(local.play).toHaveBeenCalledTimes(1);

    driver.unload();
    driver.switchOutput('local');
    expect(driver.casting).toBe(false);
    expect(local.setVolume).toHaveBeenLastCalledWith(0.5);
    expect(local.setRate).toHaveBeenLastCalledWith(1.5);

    // At normal speed there is nothing to carry.
    driver.setRate(1);
    local.setRate.mockClear();
    driver.switchOutput('local');
    expect(local.setRate).not.toHaveBeenCalled();
  });
});
