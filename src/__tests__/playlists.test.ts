// Playlist files: one parser for every platform.
import { fake } from './FakeNative';

jest.mock('../native/NativeAnythingPlayer', () => ({
  __esModule: true,
  default: require('./FakeNative').fake,
}));

import { Player } from '../Player';
import { Playlists } from '../core/playlists';

describe('Playlists.parse', () => {
  it('reads extended M3U: lengths, Artist - Title, logos, album, user agent, relative entries', () => {
    const text = [
      '#EXTM3U',
      '#EXTALB:Live Album',
      '#EXTINF:215 tvg-logo="https://img.example/a.png" group-title="Rock, Pop",Band - Song',
      'song.mp3',
      '#EXTINF:-1,Radio One',
      '#EXTVLCOPT:http-user-agent=MyApp/1.0',
      'https://radio.example/live',
      '#EXTIMG:cover.jpg',
      '/abs/track.flac',
    ].join('\r\n');
    expect(
      Playlists.parse(text, { baseUrl: 'https://cdn.example/lists/mix.m3u' })
    ).toEqual([
      {
        uri: 'https://cdn.example/lists/song.mp3',
        metadata: {
          artist: 'Band',
          title: 'Song',
          artwork: 'https://img.example/a.png',
          album: 'Live Album',
          duration: 215,
        },
      },
      {
        uri: 'https://radio.example/live',
        live: true,
        metadata: { title: 'Radio One', album: 'Live Album' },
        headers: { 'User-Agent': 'MyApp/1.0' },
      },
      {
        uri: 'https://cdn.example/abs/track.flac',
        metadata: {
          album: 'Live Album',
          artwork: 'https://cdn.example/lists/cover.jpg',
        },
      },
    ]);
  });

  it('a plain M3U is a list of locations', () => {
    expect(Playlists.parse('a.mp3\nfile:///x/b.ogg\n')).toEqual([
      { uri: 'a.mp3' },
      { uri: 'file:///x/b.ogg' },
    ]);
  });

  it('an HLS playlist is one item: the stream', () => {
    const hls = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nseg1.ts\n';
    expect(
      Playlists.parse(hls, { baseUrl: 'https://cdn.example/x.m3u8' })
    ).toEqual([{ uri: 'https://cdn.example/x.m3u8' }]);
    expect(() => Playlists.parse(hls)).toThrow(/HLS/);
  });

  it('reads PLS in its numbers’ order, with endless entries live', () => {
    const pls =
      '[playlist]\nNumberOfEntries=2\nFile2=http://b.example/stream\nTitle2=Station B\nLength2=-1\nFile1=http://a.example/song.mp3\nTitle1=Artist - Tune\nLength1=180\nVersion=2\n';
    expect(Playlists.parse(pls)).toEqual([
      {
        uri: 'http://a.example/song.mp3',
        metadata: { artist: 'Artist', title: 'Tune', duration: 180 },
      },
      {
        uri: 'http://b.example/stream',
        live: true,
        metadata: { title: 'Station B' },
      },
    ]);
  });

  it('reads XSPF, entities and CDATA included', () => {
    const xspf = `<?xml version="1.0" encoding="UTF-8"?>
<playlist version="1" xmlns="http://xspf.org/ns/0/">
  <trackList>
    <track><location>https://cdn.example/a.mp3</location><title>A &amp; B</title><creator><![CDATA[Me]]></creator><album>X</album><image>art.png</image><duration>61000</duration></track>
    <track><title>no location</title></track>
  </trackList>
</playlist>`;
    expect(
      Playlists.parse(xspf, { baseUrl: 'https://cdn.example/p.xspf' })
    ).toEqual([
      {
        uri: 'https://cdn.example/a.mp3',
        metadata: {
          title: 'A & B',
          artist: 'Me',
          album: 'X',
          artwork: 'https://cdn.example/art.png',
          duration: 61,
        },
      },
    ]);
  });

  it('knows a playlist URL from an HLS one', () => {
    expect(Playlists.isPlaylistUri('https://s.example/listen.pls?x=1')).toBe(
      true
    );
    expect(Playlists.isPlaylistUri('https://s.example/a.M3U')).toBe(true);
    expect(Playlists.isPlaylistUri('https://s.example/a.m3u8')).toBe(false);
  });
});

describe('a playlist file given to load() or the queue', () => {
  beforeEach(() => {
    fake.calls = [];
  });

  it('plays its first entry, the source’s own options on top', async () => {
    const fetchText = jest.fn(async () => ({
      text: '[playlist]\nFile1=https://radio.example/320\nTitle1=Radio\nLength1=-1\nFile2=https://radio.example/64\n',
      charset: 'utf-8',
    }));
    (fake as unknown as { fetchText: typeof fetchText }).fetchText = fetchText;
    const p = new Player();
    await p.load({
      uri: 'https://radio.example/listen.pls',
      metadata: { artist: 'Me' },
    });
    const load = fake.calls.find((c) => c[0] === 'load')!;
    expect(load[2]).toEqual({
      uri: 'https://radio.example/320',
      live: true,
      metadata: { title: 'Radio', artist: 'Me' },
    });

    await p.queue.set([
      'https://radio.example/listen.pls',
      'https://cdn.example/a.mp3',
    ]);
    const set = fake.calls.find((c) => c[0] === 'queueCommand')![2] as {
      items: object[];
    };
    expect(set.items).toEqual([
      {
        uri: 'https://radio.example/320',
        live: true,
        metadata: { title: 'Radio' },
        id: 'q1',
      },
      { uri: 'https://cdn.example/a.mp3', id: 'q2' },
    ]);
    await p.release();
  });
});

describe('untrusted playlist text', () => {
  it('keeps bad character references as text, and knows no other entities', () => {
    const xspf = '<playlist><trackList><track><location>https://a.example/x.mp3</location><title>&#abc; &#x110000; &constructor; &#65;</title></track></trackList></playlist>';
    expect(Playlists.parse(xspf)[0]!.metadata!.title).toBe('&#abc; &#x110000; &constructor; A');
  });

  it('scans unclosed tracks in linear time', () => {
    const text = `<playlist><trackList>${'<track><location>x</location>'.repeat(50_000)}</trackList></playlist>`;
    const started = Date.now();
    expect(Playlists.parse(text, { format: 'xspf' })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('reads zero-padded PLS keys and skips empty entries; a length of 0 is not live', () => {
    const pls = '[playlist]\nFile01=http://a.example/1.mp3\nTitle01=One\nLength01=0\nFile2=\n';
    expect(Playlists.parse(pls)).toEqual([{ uri: 'http://a.example/1.mp3', metadata: { title: 'One' } }]);
  });
});

describe('a playlist fetched for a source', () => {
  const answer = (text: string) => {
    (fake as unknown as { fetchText: unknown }).fetchText = jest.fn(async () => ({ text, charset: 'utf-8' }));
  };

  it('sends the app’s headers to the playlist’s own host only, and drops device files a remote list names', async () => {
    answer('#EXTM3U\nfile:///data/secret.mp3\nhttps://other.example/a.mp3\nhttps://api.example/b.mp3\n');
    const items = await Playlists.fetch('https://api.example/list.m3u');
    expect(items.map((i) => i.uri)).toEqual(['https://other.example/a.mp3', 'https://api.example/b.mp3']);
    const p = new Player();
    fake.calls = [];
    await p.load({ uri: 'https://api.example/list.m3u', headers: { Authorization: 'Bearer t' } });
    expect(fake.calls.find((c) => c[0] === 'load')![2]).toEqual({ uri: 'https://other.example/a.mp3' });
    answer('https://api.example/b.mp3\n');
    await p.load({ uri: 'https://api.example/list.m3u', headers: { Authorization: 'Bearer t' } });
    expect(fake.calls.filter((c) => c[0] === 'load').pop()![2]).toEqual({
      uri: 'https://api.example/b.mp3',
      headers: { Authorization: 'Bearer t' },
    });
    await p.release();
  });

  it('a newer load or queue wins over one still fetching its playlist', async () => {
    let release!: (v: { text: string; charset: string }) => void;
    (fake as unknown as { fetchText: unknown }).fetchText = jest.fn(
      () => new Promise((r) => (release = r))
    );
    const p = new Player();
    fake.calls = [];
    const slow = p.load('https://radio.example/listen.pls');
    await p.load('https://cdn.example/b.mp3');
    release({ text: '[playlist]\nFile1=https://radio.example/320\n', charset: 'utf-8' });
    await slow;
    expect(fake.calls.filter((c) => c[0] === 'load').map((c) => (c[2] as { uri: string }).uri)).toEqual([
      'https://cdn.example/b.mp3',
    ]);
    const slowSet = p.queue.set(['https://radio.example/listen.pls']);
    await p.queue.set(['https://cdn.example/c.mp3']);
    release({ text: '[playlist]\nFile1=https://radio.example/320\n', charset: 'utf-8' });
    await slowSet;
    expect(fake.calls.filter((c) => c[0] === 'queueCommand')).toHaveLength(1);
    await p.release();
  });
});
