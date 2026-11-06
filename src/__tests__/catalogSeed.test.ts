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

  it('keeps the seed ids already written (cyrb53 over UTF-16 units)', () => {
    const seedOf = (title: string) =>
      catalogSeed({ items: [{ id: 'a', title, source: 'https://x/a' }] }).seed;
    expect(seedOf('Rádio Animu')).toBe('1aff67c58820c7');
    expect(seedOf('😀 live')).toBe('0f8e33b1b36323');
    expect(seedOf('a\uD83Db')).toBe('1f6f23e86e630c');
    expect(seedOf('\uDE00x')).toBe('10c23f73d23a3f');
    expect(seedOf('新時代')).toBe('03efd7e48323c5');
  });

  it('refuses what setCatalog refuses, and a file that is not a catalog', () => {
    expect(() =>
      catalogSeed({ items: [{ id: 'a', title: '', source: 'https://x/a' }] })
    ).toThrow('title');
    expect(() => catalogSeed(null as never)).toThrow('object');
    expect(() => catalogSeed({} as never)).toThrow('array');
  });
});
