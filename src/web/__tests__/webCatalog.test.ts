/// <reference types="node" />
// The catalog on the web: `setCatalog`, `searchCatalog` and `playFromSearch`
// through `WebModule`, on the scripted fake browser. Ranking itself is the
// shared matcher's (conformance/catalog); these cover the platform rules.

import { install, uninstall, type FakeWorld } from './FakeBrowser';
import { WebModule } from '../platform/WebModule';

type Event = Record<string, unknown> & { type: string };

let world: FakeWorld;
let module: WebModule;
let events: Event[];

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}

const item = (id: string, title: string, extra: object = {}) => ({
  id,
  title,
  keywords: [],
  kind: 'station',
  source: { uri: `https://cdn.example/${id}.mp3`, live: false },
  ...extra,
});

const CATALOG = [
  item('jazz', 'Jazz FM', { genre: 'Jazz' }),
  item('news', 'World News', { kind: 'podcast' }),
];

/** Runs `playFromSearch` while making whatever it loads ready. */
async function play(
  request: object,
  playerId: string | null = null
): Promise<{ item: { id: string } | null }> {
  const result = module.playFromSearch(request, playerId);
  await flush();
  world.element()?.becomeReady(120);
  await flush();
  return (await result) as { item: { id: string } | null };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  world = install();
  module = new WebModule();
  events = [];
  module.onPlayerEvent((e) => events.push(e as Event));
});

afterEach(() => {
  uninstall();
  jest.useRealTimers();
});

describe('web catalog', () => {
  it('searches with the shared matcher', async () => {
    await module.setCatalog(CATALOG, {});
    const found = (await module.searchCatalog({ query: 'jazz' })) as Array<{
      id: string;
    }>;
    expect(found.map((i) => i.id)).toEqual(['jazz']);
    expect(await module.searchCatalog({ query: 'opera' })).toEqual([]);
  });

  it("plays the best match on the catalog's player, creating it, and reports it", async () => {
    await module.setCatalog(CATALOG, {
      playerId: 'main',
      playerOptions: { metadata: { streamTitleFormat: 'title' } },
    });
    const result = await play({ query: 'play jazz fm' });
    expect(result.item?.id).toBe('jazz');
    expect(module.getStatus('main')).toMatchObject({ playWhenReady: true });
    const played = events.find((e) => e.type === 'searchPlay');
    expect(played).toMatchObject({
      playerId: 'main',
      request: { query: 'play jazz fm', origin: 'app' },
      item: { id: 'jazz' },
    });
    // The app's own `new Player({ id: 'main' })` attaches to it.
    expect(module.createPlayer({ id: 'main' })).toBe('main');
  });

  it('uses the given player, else the one on the lock screen', async () => {
    await module.setCatalog(CATALOG, {});
    const a = module.createPlayer({});
    const b = module.createPlayer({});
    await play({ query: 'world news' }, b);
    expect(events.find((e) => e.type === 'searchPlay')?.playerId).toBe(b);
    events = [];
    await play({ query: 'jazz' });
    // `b` plays, so it now holds the lock screen.
    expect(events.find((e) => e.type === 'searchPlay')?.playerId).toBe(b);
    expect(a).not.toBe(b);
    await expect(
      module.playFromSearch({ query: 'jazz' }, 'gone')
    ).rejects.toMatchObject({ code: 'PLAYER_RELEASED' });
  });

  it('plays the last item for an empty request, else the first', async () => {
    await module.setCatalog(CATALOG, {});
    expect((await play({ query: 'play' })).item?.id).toBe('jazz');
    await play({ query: 'world news' });
    expect((await play({ query: '' })).item?.id).toBe('news');
  });

  it('asks the app when nothing matches, and gives up after 5.5 s', async () => {
    await module.setCatalog(CATALOG, {});
    expect((await play({ query: 'opera' })).item).toBeNull();
    module.setSearchHandlerEnabled(true);
    const asked = module.playFromSearch({ query: 'opera' }, null);
    await flush();
    const request = events.find((e) => e.type === 'searchRequest')!;
    expect(request.request).toMatchObject({ query: 'opera', origin: 'app' });
    module.resolveSearchRequest(request.requestId as string, {
      item: item('opera', 'Opera Live'),
    });
    await flush();
    world.element()?.becomeReady(120);
    await flush();
    expect(((await asked) as { item: { id: string } }).item.id).toBe('opera');
    // An unknown or late answer is ignored.
    module.resolveSearchRequest('nope', { item: null });
    const timedOut = module.playFromSearch({ query: 'polka' }, null);
    await jest.advanceTimersByTimeAsync(5500);
    expect(await timedOut).toEqual({ item: null });
  });

  it('has no output picker or Cast until the browser layer provides them', async () => {
    expect(module.isRoutePickerAvailable()).toBe(false);
    await expect(module.showRoutePicker()).rejects.toMatchObject({
      code: 'ROUTE_PICKER_UNAVAILABLE',
    });
    expect(module.getCastState()).toEqual({
      state: 'unavailable',
      device: null,
    });
    await expect(module.configureCast()).resolves.toBeUndefined();
    await expect(module.showCastPicker()).rejects.toMatchObject({
      code: 'CAST_UNAVAILABLE',
    });
    await expect(module.stopCasting()).resolves.toBeUndefined();
  });
});
