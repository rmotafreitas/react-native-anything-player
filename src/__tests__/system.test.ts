import { fake, baseStatus } from './FakeNative';

jest.mock('../native/NativeAnythingPlayer', () => ({
  __esModule: true,
  default: require('./FakeNative').fake,
}));

import { Player } from '../Player';
import {
  addCastStateListener,
  addRoutePickerAvailabilityListener,
  configureCast,
  getCastStatus,
  isRoutePickerAvailable,
  playFromSearch,
  searchCatalog,
  setCatalog,
  setFavorites,
  setSearchHandler,
  showCastPicker,
  showRoutePicker,
  stopCasting,
} from '../core/system';
import type { AudioRoute, CatalogItem } from '../types';

const flush = () => new Promise<void>((r) => setImmediate(() => r()));

beforeEach(() => {
  fake.calls = [];
  fake.rejectNext = null;
});

const station: CatalogItem = {
  id: 'jazz',
  title: 'Jazz FM',
  artist: 'Jazz Network',
  album: 'Live',
  genre: 'Jazz',
  artwork: 'https://img.example/jazz.png',
  source: 'https://radio.example/jazz',
  keywords: ['Jazz Radio'],
};

describe('player ids', () => {
  it('attaches to a player native already has, and refuses a second live one', async () => {
    const first = new Player({ id: 'main' });
    expect(first.id).toBe('main');
    expect(() => new Player({ id: 'main' })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
    expect(() => new Player({ id: ' ' })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
    await first.release();
    // Released in JS; native still knows it (the fake keeps it): attach.
    const again = new Player({ id: 'main' });
    expect(again.id).toBe('main');
    await again.release();
  });
});

describe('route and search events', () => {
  it('emits routeChange when the route changes, and searchPlay', async () => {
    const p = new Player();
    const routes: Array<[AudioRoute, AudioRoute]> = [];
    const plays: unknown[] = [];
    p.on('routeChange', (route, previous) => routes.push([route, previous]));
    p.on('searchPlay', (e) => plays.push(e));
    fake.emitStatus(p.id, { seq: 5, volume: 0.5 });
    expect(routes).toHaveLength(0);
    fake.emitStatus(p.id, {
      seq: 6,
      route: { kind: 'airplay', name: 'Kitchen' },
    });
    expect(routes).toEqual([
      [
        { kind: 'airplay', name: 'Kitchen' },
        { kind: 'speaker', name: null },
      ],
    ]);
    fake.emit({
      playerId: p.id,
      type: 'searchPlay',
      request: { query: 'jazz', origin: 'siri' },
      item: { id: 'jazz' },
    });
    expect(plays).toEqual([
      { request: { query: 'jazz', origin: 'siri' }, item: { id: 'jazz' } },
    ]);
    await p.release();
  });
});

describe('output picker', () => {
  it('opens for the given player or the active one', async () => {
    const p = new Player();
    await showRoutePicker(p);
    await showRoutePicker();
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        ['showRoutePicker', p.id],
        ['showRoutePicker', null],
      ])
    );
    fake.rejectNext = {
      code: 'ROUTE_PICKER_UNAVAILABLE',
      message: 'none',
    };
    await expect(showRoutePicker()).rejects.toMatchObject({
      code: 'ROUTE_PICKER_UNAVAILABLE',
    });
    await p.release();
  });

  it('reports availability and its changes', () => {
    expect(isRoutePickerAvailable()).toBe(true);
    const seen: boolean[] = [];
    const off = addRoutePickerAvailabilityListener((a) => seen.push(a));
    fake.emit({ type: 'routePickerAvailability', available: false });
    fake.emit({ type: 'castState', state: 'connected' });
    off();
    fake.emit({ type: 'routePickerAvailability', available: true });
    expect(seen).toEqual([false]);
  });
});

describe('cast', () => {
  it('reads and follows the cast state', () => {
    fake.castStatus = { state: 'connected', device: 'TV' };
    expect(getCastStatus()).toEqual({ state: 'connected', device: 'TV' });
    fake.castStatus = {} as never;
    expect(getCastStatus()).toEqual({ state: 'unavailable', device: null });
    fake.castStatus = { state: 'notConnected', device: null };
    const seen: unknown[] = [];
    const off = addCastStateListener((s) => seen.push(s));
    fake.emit({ type: 'castState', state: 'connecting', device: 'TV' });
    fake.emit({ type: 'castState', state: 'noDevices' });
    fake.emit({ type: 'routePickerAvailability', available: true });
    off();
    expect(seen).toEqual([
      { state: 'connecting', device: 'TV' },
      { state: 'noDevices', device: null },
    ]);
  });

  it('configures, opens the chooser and stops', async () => {
    await configureCast();
    await configureCast({ receiverApplicationId: 'ABCD1234' });
    await showCastPicker();
    await stopCasting();
    expect(fake.calls).toEqual([
      ['configureCast', {}],
      ['configureCast', { receiverApplicationId: 'ABCD1234' }],
      ['showCastPicker'],
      ['stopCasting'],
    ]);
    fake.rejectNext = { code: 'CAST_UNAVAILABLE', message: 'no cast' };
    await expect(showCastPicker()).rejects.toMatchObject({
      code: 'CAST_UNAVAILABLE',
    });
  });
});

describe('catalog', () => {
  it('normalizes items for native, with the lock-screen metadata defaulted', async () => {
    await setCatalog(
      [
        station,
        {
          id: 'b',
          title: 'B',
          source: { uri: 'https://b.example/s', metadata: { title: 'Own' } },
        },
      ],
      {
        playerId: 'main',
        playerOptions: { audio: { contentType: 'music' } },
      }
    );
    expect(fake.calls[0]).toEqual([
      'setCatalog',
      [
        {
          id: 'jazz',
          title: 'Jazz FM',
          artist: 'Jazz Network',
          album: 'Live',
          genre: 'Jazz',
          artwork: 'https://img.example/jazz.png',
          keywords: ['Jazz Radio'],
          kind: 'station',
          source: {
            uri: 'https://radio.example/jazz',
            metadata: {
              title: 'Jazz FM',
              artist: 'Jazz Network',
              album: 'Live',
              artwork: 'https://img.example/jazz.png',
            },
          },
        },
        {
          id: 'b',
          title: 'B',
          keywords: [],
          kind: 'station',
          source: { uri: 'https://b.example/s', metadata: { title: 'Own' } },
        },
      ],
      { playerId: 'main', playerOptions: { audio: { contentType: 'music' } } },
    ]);
    await setCatalog([]);
    expect(fake.calls[1]).toEqual(['setCatalog', [], { playerId: 'default' }]);
  });

  it('sends groups and the browse options, trimmed to what is in the catalog', async () => {
    await setCatalog(
      [
        { ...station, group: ' Music / Jazz ' },
        { id: 'b', title: 'B', source: { uri: 'https://b.example/s' } },
      ],
      {
        browse: {
          recent: true,
          favorites: ['b', 'b', 'gone', ''],
          rootOrder: [' Podcasts ', 'Music'],
          titles: { recent: 'Last played', favorites: '  ' },
        },
      }
    );
    const [, items, options] = fake.calls[0] as [string, any[], any];
    expect(items[0].group).toBe('Music/Jazz');
    expect(items[1].group).toBeUndefined();
    expect(options.browse).toEqual({
      recent: 10,
      favorites: ['b'],
      rootOrder: ['Podcasts', 'Music'],
      titles: { recent: 'Last played' },
    });
  });

  it.each([
    [false, 0],
    [undefined, 0],
    [3.7, 3],
    [500, 50],
    [-4, 0],
    [Number.NaN, 0],
  ])('keeps %p recent items as %p', async (recent, kept) => {
    await setCatalog([station], { browse: { recent } });
    const [, , options] = fake.calls[0] as [string, any, any];
    expect(options.browse.recent).toBe(kept);
  });

  it('replaces the favorites without the catalog', async () => {
    await setFavorites(['a', 'b', 'a', '']);
    expect(fake.calls[0]).toEqual(['setFavorites', ['a', 'b']]);
    await expect(setFavorites('x' as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('rejects invalid catalogs', async () => {
    await expect(setCatalog('x' as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(setCatalog([{ ...station, id: '' }])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(setCatalog([{ ...station, title: '' }])).rejects.toMatchObject(
      { code: 'INVALID_ARGUMENT' }
    );
    await expect(setCatalog([station, station])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(
      setCatalog([{ ...station, source: '' }])
    ).rejects.toMatchObject({ code: 'INVALID_SOURCE' });
  });

  it('searches and plays, passing the request through', async () => {
    fake.catalogResults = [
      {
        id: 'jazz',
        title: 'Jazz FM',
        artist: 'Jazz Network',
        genre: 'Jazz',
        album: 'Live',
        artwork: 'https://img.example/jazz.png',
        source: { uri: 'https://radio.example/jazz' },
        keywords: ['Jazz Radio'],
        kind: 'station',
      },
      { id: 'x', title: 'X', source: { uri: 'https://x.example' } },
    ];
    const found = await searchCatalog({
      query: 'jazz',
      artist: 'Jazz Network',
      focus: 'station',
      title: '',
    });
    expect(found).toEqual([
      {
        id: 'jazz',
        title: 'Jazz FM',
        artist: 'Jazz Network',
        album: 'Live',
        genre: 'Jazz',
        artwork: 'https://img.example/jazz.png',
        source: { uri: 'https://radio.example/jazz' },
        keywords: ['Jazz Radio'],
        kind: 'station',
      },
      {
        id: 'x',
        title: 'X',
        source: { uri: 'https://x.example' },
        keywords: [],
        kind: 'station',
      },
    ]);
    expect(fake.calls[0]).toEqual([
      'searchCatalog',
      { query: 'jazz', artist: 'Jazz Network', focus: 'station' },
    ]);
    fake.playResult = { item: fake.catalogResults[1]! };
    const p = new Player();
    expect((await playFromSearch('x', p))?.id).toBe('x');
    fake.playResult = { item: null };
    expect(await playFromSearch('nothing')).toBeNull();
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        ['playFromSearch', { query: 'x' }, p.id],
        ['playFromSearch', { query: 'nothing' }, null],
      ])
    );
    await expect(searchCatalog({} as never)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await p.release();
  });

  it('answers search requests with the app handler, and nothing without one', async () => {
    setSearchHandler(async (request) =>
      request.query === 'opera'
        ? { id: 'opera', title: 'Opera', source: 'https://o.example/live' }
        : null
    );
    setSearchHandler(async (request) =>
      request.query === 'opera'
        ? { id: 'opera', title: 'Opera', source: 'https://o.example/live' }
        : null
    );
    fake.emit({
      type: 'searchRequest',
      requestId: 'r1',
      request: { query: 'opera', origin: 'siri' },
    });
    fake.emit({
      type: 'searchRequest',
      requestId: 'r2',
      request: { query: 'polka', origin: 'assistant' },
    });
    await flush();
    expect(fake.calls).toEqual(
      expect.arrayContaining([
        ['setSearchHandlerEnabled', true],
        [
          'resolveSearchRequest',
          'r1',
          {
            item: expect.objectContaining({
              id: 'opera',
              source: expect.objectContaining({
                uri: 'https://o.example/live',
              }),
            }),
          },
        ],
        ['resolveSearchRequest', 'r2', { item: null }],
      ])
    );
    setSearchHandler(null);
    setSearchHandler(null);
    fake.calls = [];
    fake.emit({
      type: 'searchRequest',
      requestId: 'r3',
      request: { query: 'opera', origin: 'siri' },
    });
    await flush();
    expect(fake.calls).toEqual([]);
  });

  it('answers nothing when the handler throws, and reports the error', async () => {
    jest.useFakeTimers();
    setSearchHandler(() => {
      throw new Error('boom');
    });
    fake.emit({
      type: 'searchRequest',
      requestId: 'r4',
      request: { query: 'x', origin: 'siri' },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.calls).toContainEqual([
      'resolveSearchRequest',
      'r4',
      { item: null },
    ]);
    expect(() => jest.runOnlyPendingTimers()).toThrow('boom');
    setSearchHandler(null);
    jest.useRealTimers();
  });

  it('gives a slow handler 5 s', async () => {
    jest.useFakeTimers();
    setSearchHandler(() => new Promise(() => undefined));
    fake.emit({
      type: 'searchRequest',
      requestId: 'r5',
      request: { query: 'x', origin: 'siri' },
    });
    await jest.advanceTimersByTimeAsync(5000);
    expect(fake.calls).toContainEqual([
      'resolveSearchRequest',
      'r5',
      { item: null },
    ]);
    setSearchHandler(null);
    jest.useRealTimers();
  });
});

it('keeps the status snapshot shape', () => {
  expect(baseStatus().route).toEqual({ kind: 'speaker', name: null });
});
