/// <reference types="node" />
// The catalog on the web: `setCatalog`, `searchCatalog` and `playFromSearch`
// through `WebModule`, on the scripted fake browser. Ranking itself is the
// shared matcher's (conformance/catalog); these cover the platform rules.

import { install, uninstall, type FakeWorld } from './FakeBrowser';
import { WebModule } from '../platform/WebModule';
import fs from 'node:fs';
import path from 'node:path';
import { sameMedia, type SourceDescriptor } from '../engine/types';

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
  it('filters a search by group and keeps the favorites', async () => {
    await module.setCatalog(
      [
        { ...CATALOG[0], group: 'Music/Jazz' },
        ...(CATALOG.slice(1) as object[]),
      ],
      { browse: { favorites: ['x', 'y'] } }
    );
    const inGroup = (await module.searchCatalog({
      query: 'jazz',
      group: 'Music',
    })) as unknown[];
    const elsewhere = await module.searchCatalog({
      query: 'jazz',
      group: 'Podcasts',
    });
    expect(inGroup).toHaveLength(1);
    expect(elsewhere).toEqual([]);
    await module.setFavorites(['nope']);
  });

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

  it('a pick of what is loaded plays on, without opening it again', async () => {
    await module.setCatalog(CATALOG, { playerId: 'main' });
    await play({ query: 'jazz' });
    const opened = module.getStatus('main') as { loadId: number };
    await module.pause('main');
    events = [];
    await play({ query: 'jazz' });
    const again = module.getStatus('main') as {
      loadId: number;
      playWhenReady: boolean;
    };
    expect(again.loadId).toBe(opened.loadId);
    expect(again.playWhenReady).toBe(true);
    expect(events.find((e) => e.type === 'searchPlay')).toMatchObject({
      item: { id: 'jazz' },
    });
    // Another item opens.
    await play({ query: 'world news' });
    expect(
      (module.getStatus('main') as { loadId: number }).loadId
    ).toBeGreaterThan(opened.loadId);
  });

  it("an item's quality is the one it starts at", async () => {
    await module.setCatalog(
      [
        item('radio', 'Radio', {
          source: {
            renditions: [
              {
                id: '320',
                uri: 'https://cdn.example/320.mp3',
                bitrate: 320_000,
              },
              { id: '64', uri: 'https://cdn.example/64.mp3', bitrate: 64_000 },
            ],
            live: true,
          },
          quality: '64',
        }),
      ],
      { playerId: 'main' }
    );
    await play({ query: 'radio' });
    expect(module.getStatus('main')).toMatchObject({
      quality: '64',
      selectedQuality: '64',
    });
  });

  it('the same media (conformance/catalog/same-media.json)', () => {
    const cases = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../../conformance/catalog/same-media.json'),
        'utf8'
      )
    ) as Array<{
      name: string;
      a: { uri: string; renditions?: string[] };
      b: { uri: string; renditions?: string[] };
      same: boolean;
    }>;
    const source = (s: { uri: string; renditions?: string[] }) =>
      ({
        uri: s.uri,
        headers: {},
        liveHint: null,
        renditions: s.renditions?.map((uri) => ({ uri })) ?? null,
      }) as SourceDescriptor;
    expect(cases.length).toBeGreaterThan(3);
    for (const c of cases)
      expect([c.name, sameMedia(source(c.a), source(c.b))]).toEqual([
        c.name,
        c.same,
      ]);
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

  it('has no output picker or Cast without a player or the Cast SDK', async () => {
    expect(module.isRoutePickerAvailable()).toBe(false);
    await expect(module.showRoutePicker(null)).rejects.toMatchObject({
      code: 'ROUTE_PICKER_UNAVAILABLE',
    });
    expect(module.getCastState()).toEqual({
      state: 'unavailable',
      device: null,
    });
    await expect(module.showCastPicker()).rejects.toMatchObject({
      code: 'CAST_UNAVAILABLE',
    });
    await expect(module.stopCasting()).resolves.toBeUndefined();
  });
});
