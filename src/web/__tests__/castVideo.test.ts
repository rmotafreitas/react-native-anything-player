/// <reference types="node" />
// A video on a Google Cast receiver from the web: the content type a video
// container needs, a movie's metadata, and the app's subtitle files (any
// format, already parsed) as the receiver's WebVTT text tracks, switched
// while casting.

import { install, uninstall } from './FakeBrowser';
import {
  CastDriver,
  contentTypeOf,
  vttDataUrl,
  type CastMedia,
} from '../platform/CastDriver';
import type { CastService } from '../platform/CastService';

interface Loaded {
  media: {
    contentId: string;
    contentType: string;
    metadata: Record<string, unknown> & { kind: string };
    tracks?: Array<Record<string, unknown>>;
  };
  activeTrackIds?: number[];
}

function sdk(loads: Loaded[], edits: number[][]) {
  const chromeMedia = {
    StreamType: { LIVE: 'LIVE', BUFFERED: 'BUFFERED' },
    MediaInfo: class {
      streamType = 'BUFFERED';
      metadata: unknown = null;
      tracks?: unknown[];
      constructor(
        readonly contentId: string,
        readonly contentType: string
      ) {}
    },
    MusicTrackMediaMetadata: class {
      kind = 'music';
    },
    MovieMetadata: class {
      kind = 'movie';
    },
    Track: class {
      trackContentId = '';
      trackContentType = '';
      subtype = '';
      name: string | null = null;
      language: string | null = null;
      constructor(
        readonly trackId: number,
        readonly type: string
      ) {}
    },
    TrackType: { TEXT: 'TEXT' },
    TextTrackType: { SUBTITLES: 'SUBTITLES', CAPTIONS: 'CAPTIONS' },
    EditTracksInfoRequest: class {
      constructor(readonly activeTrackIds: number[]) {}
    },
    LoadRequest: class {
      autoplay = true;
      currentTime?: number;
      activeTrackIds?: number[];
      constructor(readonly media: object) {}
    },
  };
  const controller = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const session = {
    getCastDevice: () => ({ friendlyName: 'TV' }),
    getMediaSession: () => ({
      supportsCommand: () => false,
      setVolume: () => undefined,
      editTracksInfo: (
        request: { activeTrackIds: number[] },
        ok: () => void
      ) => {
        edits.push(request.activeTrackIds);
        ok();
      },
    }),
    loadMedia: (request: Loaded) => {
      loads.push(request);
      return Promise.resolve(undefined);
    },
  };
  const service = {
    sdk: () => ({
      framework: {
        RemotePlayer: class {
          isMediaLoaded = true;
          playerState = 'PLAYING';
          duration = 60;
          currentTime = 0;
        },
        RemotePlayerController: class {
          addEventListener = controller.addEventListener;
          removeEventListener = controller.removeEventListener;
        },
        RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
      },
      chrome: { media: chromeMedia, Image: class {} },
    }),
    session: () => session,
  };
  return service as unknown as CastService;
}

const observer = {
  onReady: () => undefined,
  onPlaying: () => undefined,
  onBuffering: () => undefined,
  onEnded: () => undefined,
  onFailed: () => undefined,
  onPausedExternally: () => undefined,
  onNote: () => undefined,
};

const nowPlaying = () => ({
  title: 'Episode 1',
  artist: 'The show',
  album: null,
  artwork: null,
  live: null,
  track: null,
});

const SOURCE = {
  uri: 'https://cdn.example/ep1.mp4',
  headers: {},
  liveHint: false as boolean | null,
};

beforeEach(() => install());
afterEach(() => uninstall());

it('names video containers and manifests for the receiver', () => {
  expect(contentTypeOf('https://x/a.mp4', true)).toBe('video/mp4');
  expect(contentTypeOf('https://x/a.webm?t=1', true)).toBe('video/webm');
  expect(contentTypeOf('https://x/a.m3u8', true)).toBe('application/x-mpegURL');
  expect(contentTypeOf('https://x/a.mpd', true)).toBe('application/dash+xml');
  expect(contentTypeOf('https://x/watch', true)).toBe('video/mp4');
  // An audio player's are unchanged.
  expect(contentTypeOf('https://x/a.mp4')).toBe('audio/mp4');
});

it("loads a video as a movie with the app's subtitle files as WebVTT tracks, and switches them", async () => {
  const loads: Loaded[] = [];
  const edits: number[][] = [];
  const media: CastMedia = {
    video: true,
    subtitles: [
      {
        id: 'sub:0',
        kind: 'subtitles',
        language: 'en',
        label: 'English',
        vtt: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n',
      },
      {
        id: 'sub:1',
        kind: 'captions',
        language: 'pt',
        label: null,
        vtt: 'WEBVTT\n',
      },
    ],
    textTrack: 'sub:1',
  };
  const driver = new CastDriver(
    observer,
    nowPlaying,
    sdk(loads, edits),
    () => media
  );
  driver.open({
    generation: 1,
    source: SOURCE,
    startPosition: 30,
    playWhenReady: true,
    allowReconnect: true,
    swap: false,
    rendition: null,
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(loads).toHaveLength(1);
  const load = loads[0]!;
  expect(load.media.contentType).toBe('video/mp4');
  expect(load.media.metadata).toMatchObject({
    kind: 'movie',
    title: 'Episode 1',
    subtitle: 'The show',
  });
  expect(load.media.tracks).toEqual([
    expect.objectContaining({
      trackId: 1,
      type: 'TEXT',
      trackContentType: 'text/vtt',
      subtype: 'SUBTITLES',
      name: 'English',
      language: 'en',
      trackContentId: vttDataUrl(media.subtitles[0]!.vtt),
    }),
    expect.objectContaining({ trackId: 2, subtype: 'CAPTIONS', name: 'pt' }),
  ]);
  // The track the engine shows is on from the start.
  expect(load.activeTrackIds).toEqual([2]);
  expect(decodeURIComponent(vttDataUrl('WEBVTT\n'))).toBe(
    'data:text/vtt;charset=utf-8,WEBVTT\n'
  );

  driver.selectTracks('track:a:0', 'sub:0');
  driver.selectTracks(null, null);
  // A source track the receiver was not given: none of the app's.
  driver.selectTracks(null, 'track:t:0');
  expect(edits).toEqual([[1], [], []]);
});

it('loads an audio player as music, without tracks', async () => {
  const loads: Loaded[] = [];
  const driver = new CastDriver(observer, nowPlaying, sdk(loads, []));
  driver.open({
    generation: 1,
    source: { ...SOURCE, uri: 'https://cdn.example/song.mp3' },
    startPosition: null,
    playWhenReady: true,
    allowReconnect: true,
    swap: false,
    rendition: null,
  });
  await Promise.resolve();
  expect(loads[0]!.media).toMatchObject({
    contentType: 'audio/mpeg',
    metadata: { kind: 'music', title: 'Episode 1', artist: 'The show' },
  });
  expect(loads[0]!.media.tracks).toBeUndefined();
  expect(loads[0]!.activeTrackIds).toBeUndefined();
});
