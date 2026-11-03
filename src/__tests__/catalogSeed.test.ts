import { fake } from './FakeNative';

jest.mock('../native/NativeAnythingPlayer', () => ({
  __esModule: true,
  default: require('./FakeNative').fake,
}));

import '../Player';
import { catalogSeed } from '../core/catalogSeed';
import { setCatalog } from '../core/system';

describe('catalogSeed', () => {
  it('bundles exactly what setCatalog stores, in the format native keeps', async () => {
    fake.calls = [];
    const input = {
      playerId: 'radio',
      playerOptions: { progressInterval: 1000 },
      browse: { recent: 5, favorites: ['a'] },
      items: [
        {
          id: 'a',
          title: 'A FM',
          artist: 'Various',
          keywords: ['A Radio'],
          group: 'Music',
          source: {
            renditions: [
              { id: 'hi', uri: 'https://example.com/a-320' },
              { id: 'lo', uri: 'https://example.com/a-64' },
            ],
            live: true,
          },
          quality: 'lo',
        },
      ],
    };
    await setCatalog(input.items, input);
    const [, items, options] = fake.calls.find((c) => c[0] === 'setCatalog')!;
    const seed = catalogSeed(input);
    expect(seed.items).toEqual(items);
    expect(seed).toMatchObject({
      version: 1,
      playerId: (options as { playerId: string }).playerId,
      playerOptions: input.playerOptions,
      browse: (options as { browse: unknown }).browse,
      lastPlayedId: null,
      recentIds: [],
    });
  });

  it('refuses what setCatalog refuses, and a file that is not a catalog', () => {
    expect(() =>
      catalogSeed({ items: [{ id: 'a', title: '', source: 'https://x/a' }] })
    ).toThrow('title');
    expect(() => catalogSeed(null as never)).toThrow('object');
    expect(() => catalogSeed({} as never)).toThrow('array');
  });
});
