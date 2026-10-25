// The web side of video: `parseOptions` / `parseSource` and the status
// shapes that cross the wire, what decides a source needs the remuxer or
// Shaka (and their lazy loaders), the `react-native-anything-player/web`
// host's video and foreground hooks, and the web module's video commands,
// stats, `attachVideo` and `fetchText`.

import { install, uninstall, type FakeWorld } from './FakeBrowser';
import { FakeBox, enableVideo } from './FakeVideoBrowser';
import {
  DEFAULT_FALLBACK_POLICY,
  DEFAULT_VIDEO_OPTIONS,
} from '../engine/RecoveryPolicy';
import type { AudioElementLike } from '../platform/dom';
import {
  maySniff,
  remuxFormatOf,
  loadDashParts,
  loadDrmParts,
  loadRemuxParts,
} from '../platform/sourceParts';
import {
  parseOptions,
  parseSource,
  parseSubtitleTracks,
  parseVideo,
  parseVideoParts,
  statusToMap,
} from '../platform/serialization';
import { WebModule } from '../platform/WebModule';
import type { EngineStatus } from '../engine/types';

let world: FakeWorld;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  world = install();
  enableVideo(world);
});

afterEach(() => {
  uninstall();
  jest.useRealTimers();
});

describe('parseVideo', () => {
  it('is no video for an audio player', () => {
    expect(parseVideo(undefined)).toBeNull();
    expect(parseVideo(false)).toBeNull();
    expect(parseVideo(null)).toBeNull();
  });

  it('takes every default for true, playing on in a hidden tab', () => {
    expect(parseVideo(true)).toEqual({
      ...DEFAULT_VIDEO_OPTIONS,
      whenBackgrounded: 'audio',
    });
  });

  it('plays on in a hidden tab unless asked to pause or to use Picture in Picture', () => {
    expect(parseVideo({})!.whenBackgrounded).toBe('audio');
    expect(parseVideo({ whenBackgrounded: 'pause' })!.whenBackgrounded).toBe(
      'pause'
    );
    expect(parseVideo({ whenBackgrounded: 'pip' })!.whenBackgrounded).toBe(
      'pip'
    );
    expect(parseVideo({ whenBackgrounded: 'nonsense' })!.whenBackgrounded).toBe(
      'audio'
    );
  });

  it('reads the flags and falls back to their defaults', () => {
    expect(parseVideo({})).toMatchObject({
      ambient: false,
      keepAwake: true,
      focusWhenMuted: false,
      fallback: null,
      tracks: { languages: [], followSystem: true },
    });
    expect(
      parseVideo({ ambient: true, keepAwake: false, focusWhenMuted: true })
    ).toMatchObject({ ambient: true, keepAwake: false, focusWhenMuted: true });
  });

  it('reads the track languages, dropping what is not a string', () => {
    expect(
      parseVideo({
        tracks: { languages: ['pt', 3, 'en'], followSystem: false },
      })!.tracks
    ).toEqual({ languages: ['pt', 'en'], followSystem: false });
    expect(
      parseVideo({ tracks: { languages: 'pt' } })!.tracks.languages
    ).toEqual([]);
  });

  it('turns fallbackToAudio on with its defaults, or with the numbers given', () => {
    expect(parseVideo({ fallbackToAudio: true })!.fallback).toEqual(
      DEFAULT_FALLBACK_POLICY
    );
    expect(parseVideo({ fallbackToAudio: false })!.fallback).toBeNull();
    expect(
      parseVideo({
        fallbackToAudio: { dropAfterMs: 5000, dropAfterStalls: 'x' },
      })!.fallback
    ).toEqual({ ...DEFAULT_FALLBACK_POLICY, dropAfterMs: 5000 });
  });

  it('reads the quality policy', () => {
    expect(parseVideo({})!.quality).toEqual(DEFAULT_VIDEO_OPTIONS.quality);
    expect(
      parseVideo({
        quality: {
          maxResolution: 1080,
          maxBitrate: 5_000_000,
          cellular: { maxResolution: 480, maxBitrate: 1_000_000 },
          startQuality: 'highest',
          followDataSaver: false,
          capToView: false,
        },
      })!.quality
    ).toEqual({
      maxHeight: 1080,
      maxBitrate: 5_000_000,
      cellularMaxHeight: 480,
      cellularMaxBitrate: 1_000_000,
      startQuality: 'highest',
      followDataSaver: false,
      capToView: false,
    });
  });

  it('starts at the lowest, a number of pixels, or automatically', () => {
    const start = (startQuality: unknown) =>
      parseVideo({ quality: { startQuality } })!.quality.startQuality;
    expect(start('lowest')).toBe('lowest');
    expect(start(720)).toBe(720);
    expect(start('whatever')).toBe('auto');
  });

  it('reaches the engine options through parseOptions', () => {
    expect(parseOptions({ video: true }).engine.video).toMatchObject({
      whenBackgrounded: 'audio',
    });
    expect(parseOptions({}).engine.video).toBeNull();
  });
});

describe('parseSource', () => {
  it('keeps an audio source to its uri, headers and live hint', () => {
    const [descriptor] = parseSource({ uri: 'https://x.example/a.mp3' });
    expect(descriptor).toEqual({
      uri: 'https://x.example/a.mp3',
      headers: {},
      liveHint: null,
    });
  });

  it('reads the renditions with their defaults', () => {
    const [descriptor] = parseSource({
      uri: 'https://x.example/hd.mp4',
      renditions: [
        {
          uri: 'https://x.example/hd.mp4',
          headers: { A: 'b', skipped: 1 },
          height: 1080,
          bitrate: 5_000_000,
          label: '1080p',
          audioOnly: true,
        },
        { uri: 'https://x.example/sd.mp4' },
        'junk',
      ],
    });
    expect(descriptor.renditions).toEqual([
      {
        uri: 'https://x.example/hd.mp4',
        headers: { A: 'b' },
        height: 1080,
        bitrate: 5_000_000,
        label: '1080p',
        audioOnly: true,
      },
      {
        uri: 'https://x.example/sd.mp4',
        headers: null,
        height: null,
        bitrate: null,
        label: null,
        audioOnly: false,
      },
      {
        uri: '',
        headers: null,
        height: null,
        bitrate: null,
        label: null,
        audioOnly: false,
      },
    ]);
  });

  it('has no renditions for an empty or missing list', () => {
    expect(parseSource({ uri: 'u', renditions: [] })[0]).not.toHaveProperty(
      'renditions'
    );
    expect(parseSource({ uri: 'u', renditions: 'x' })[0]).not.toHaveProperty(
      'renditions'
    );
  });

  it('reads refreshable, expiresAt and the drm only when the source has them', () => {
    const drm = {
      widevine: { licenseUrl: 'https://lic.example/w' },
      hook: false,
    };
    const [descriptor] = parseSource({
      uri: 'u',
      refreshable: true,
      expiresAt: 1_700_000_000_000,
      drm,
    });
    expect(descriptor).toMatchObject({
      refreshable: true,
      expiresAt: 1_700_000_000_000,
      drm,
    });
    const [plain] = parseSource({
      uri: 'u',
      refreshable: false,
      expiresAt: 'soon',
      drm: 'x',
    });
    expect(plain).not.toHaveProperty('refreshable');
    expect(plain).not.toHaveProperty('expiresAt');
    expect(plain).not.toHaveProperty('drm');
  });
});

describe('subtitle tracks and video load parts', () => {
  it('lists the files as tracks, captions being SDH', () => {
    expect(
      parseSubtitleTracks([
        { id: 'en', language: 'en', label: 'English', default: true },
        { id: 'sdh', kind: 'captions', forced: true },
        null,
      ])
    ).toEqual([
      {
        id: 'en',
        kind: 'subtitles',
        language: 'en',
        label: 'English',
        forced: false,
        default: true,
        sdh: false,
        describesVideo: false,
      },
      {
        id: 'sdh',
        kind: 'captions',
        language: null,
        label: null,
        forced: true,
        default: false,
        sdh: true,
        describesVideo: false,
      },
      {
        id: '',
        kind: 'subtitles',
        language: null,
        label: null,
        forced: false,
        default: false,
        sdh: false,
        describesVideo: false,
      },
    ]);
  });

  it('has no tracks when the list is not an array', () => {
    expect(parseSubtitleTracks(undefined)).toEqual([]);
    expect(parseSubtitleTracks('x')).toEqual([]);
  });

  it('reads the poster, the subtitle session and the tracks of a load', () => {
    expect(
      parseVideoParts({
        poster: 'https://x.example/p.jpg',
        subtitleSession: 's4',
        subtitles: [{ id: 'en' }],
      })
    ).toMatchObject({
      poster: 'https://x.example/p.jpg',
      session: 's4',
      subtitles: [{ id: 'en' }],
    });
    expect(parseVideoParts(undefined)).toEqual({
      poster: null,
      session: null,
      subtitles: [],
    });
  });
});

describe('statusToMap', () => {
  const status = (video: EngineStatus['video']): EngineStatus => ({
    state: 'paused',
    playWhenReady: false,
    loadId: 1,
    isLive: false,
    duration: 60,
    seekable: true,
    interruption: null,
    error: null,
    reconnect: null,
    network: 'online',
    volume: 1,
    muted: false,
    rate: 1,
    route: { kind: 'speaker', name: null },
    sleepAt: null,
    video,
  });

  it('has a null video for an audio player', () => {
    expect(statusToMap(status(null), 3)).toMatchObject({ seq: 3, video: null });
  });

  it('copies the qualities and tracks of a video player', () => {
    const qualities = [
      { id: '720p', height: 720, bitrate: null, label: null, audioOnly: false },
    ];
    const tracks = parseSubtitleTracks([{ id: 'en' }]);
    const video = {
      width: 1280,
      height: 720,
      hdr: false,
      firstFrame: true,
      audioOnly: null,
      pictureInPicture: false,
      qualities,
      quality: '720p',
      selectedQuality: null,
      tracks,
      audioTrack: null,
      textTrack: 'en',
      subtitleDelay: 0.5,
      fullscreen: false,
    };
    const map = statusToMap(status(video), 4) as {
      video: typeof video;
    };
    expect(map.video).toEqual(video);
    expect(map.video.qualities).not.toBe(qualities);
    expect(map.video.qualities[0]).not.toBe(qualities[0]);
    expect(map.video.tracks[0]).not.toBe(tracks[0]);
  });
});

describe('remuxFormatOf', () => {
  const element = (types: string[] = []) =>
    ({
      canPlayType: (type: string) => (types.includes(type) ? 'maybe' : ''),
    }) as unknown as AudioElementLike;

  it('always remuxes Matroska, whatever the element plays', () => {
    const plays = element(['video/webm', 'video/mp2t']);
    expect(remuxFormatOf('https://x.example/a.mkv', plays)).toBe('matroska');
    expect(remuxFormatOf('https://x.example/a.MK3D?x=1', plays)).toBe(
      'matroska'
    );
    expect(remuxFormatOf('https://x.example/a.mka#t=3', plays)).toBe(
      'matroska'
    );
  });

  it('remuxes WebM only where the element does not play it', () => {
    expect(remuxFormatOf('https://x.example/a.webm', element())).toBe(
      'matroska'
    );
    expect(
      remuxFormatOf('https://x.example/a.webm', element(['video/webm']))
    ).toBeNull();
  });

  it('remuxes MPEG-TS only where the element does not play it', () => {
    for (const ext of ['ts', 'm2ts', 'mts', 'm2t', 'tsv', 'mpegts']) {
      expect(remuxFormatOf(`https://x.example/a.${ext}`, element())).toBe(
        'mpegts'
      );
    }
    expect(
      remuxFormatOf('https://x.example/a.ts', element(['video/mp2t']))
    ).toBeNull();
  });

  it('leaves everything else to the element', () => {
    expect(remuxFormatOf('https://x.example/a.mp4', element())).toBeNull();
    expect(remuxFormatOf('https://x.example/stream', element())).toBeNull();
    expect(remuxFormatOf('', element())).toBeNull();
  });
});

describe('maySniff', () => {
  it('is false for what the element, hls.js or Shaka play by extension', () => {
    for (const name of [
      'a.mp3',
      'a.M4A',
      'a.mp4',
      'a.m3u8?token=1',
      'a.mpd#x',
      'a.mkv',
      'a.ts',
      'a.webm',
    ]) {
      expect(maySniff(`https://x.example/${name}`)).toBe(false);
    }
  });

  it('is true for a url that says nothing of its format', () => {
    expect(maySniff('https://iptv.example/channel/42')).toBe(true);
    expect(maySniff('blob:https://app.example/3f2a')).toBe(true);
    expect(maySniff('https://x.example/a.unknown?x=.mp4')).toBe(true);
  });
});

describe('the lazy loaders', () => {
  it('load each part once and give the same module again', async () => {
    const drm = await loadDrmParts();
    const remux = await loadRemuxParts();
    const dash = await loadDashParts();
    expect(drm).toHaveProperty('WebDrm');
    expect(remux).not.toBeNull();
    expect(dash).not.toBeNull();
    expect(await loadDrmParts()).toBe(drm);
    expect(await loadRemuxParts()).toBe(remux);
    expect(await loadDashParts()).toBe(dash);
  });

  describe('when a part fails to load', () => {
    const parts = [
      ['WebDrm', 'loadDrmParts'],
      ['RemuxStream', 'loadRemuxParts'],
      ['DashStream', 'loadDashParts'],
    ] as const;

    afterEach(() => {
      jest.resetModules();
      for (const [name] of parts) jest.dontMock(`../platform/${name}`);
    });

    it.each(parts)(
      'gives null for %s, then tries again next time',
      async (name, loader) => {
        jest.resetModules();
        jest.doMock(`../platform/${name}`, () => {
          throw new Error('chunk failed');
        });
        const load = (): Promise<unknown> =>
          (
            require('../platform/sourceParts') as Record<
              string,
              () => Promise<unknown>
            >
          )[loader]!();
        expect(await load()).toBeNull();
        jest.dontMock(`../platform/${name}`);
        jest.doMock(`../platform/${name}`, () => ({ marker: name }));
        expect(await load()).toHaveProperty('marker', name);
      }
    );
  });
});

describe('the web entry host', () => {
  let web: typeof import('../index');
  let host: typeof import('../../core/host').host;

  const load = () => {
    jest.isolateModules(() => {
      web = require('../index');
      host = require('../../core/host').host;
    });
  };

  it('accepts blob and data sources, and has no bundled assets', () => {
    load();
    expect(host().acceptsBlobs).toBe(true);
    expect(host().acceptsScheme!('blob')).toBe(true);
    expect(host().acceptsScheme!('data')).toBe(true);
    expect(host().acceptsScheme!('ftp')).toBe(false);
    expect(host().resolveAsset(1)).toBeNull();
  });

  it('tells the foreground from the page visibility', () => {
    load();
    expect(host().isForeground()).toBe(true);
    world.document.visibilityState = 'hidden';
    expect(host().isForeground()).toBe(false);
  });

  it('calls onForeground only when the page becomes visible', () => {
    load();
    const listener = jest.fn();
    host().onForeground(listener);
    world.document.visibilityState = 'hidden';
    world.document.dispatch('visibilitychange');
    expect(listener).not.toHaveBeenCalled();
    world.document.visibilityState = 'visible';
    world.document.dispatch('visibilitychange');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports every foreground change until unsubscribed', () => {
    load();
    const changes: boolean[] = [];
    const stop = host().onForegroundChange((foreground) =>
      changes.push(foreground)
    );
    world.document.visibilityState = 'hidden';
    world.document.dispatch('visibilitychange');
    world.document.visibilityState = 'visible';
    world.document.dispatch('visibilitychange');
    stop();
    world.document.visibilityState = 'hidden';
    world.document.dispatch('visibilitychange');
    expect(changes).toEqual([false, true]);
  });

  it('counts a page with no document as in the foreground', () => {
    load();
    Object.defineProperty(globalThis, 'document', {
      value: undefined,
      configurable: true,
    });
    expect(host().isForeground()).toBe(true);
    const listener = jest.fn();
    const stop = host().onForegroundChange(listener);
    expect(stop()).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    host().onForeground(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it('puts a video picture in a page element with attachTo, and takes it out', async () => {
    load();
    const player = new web.Player({ video: true });
    const box = new FakeBox();
    player.attachTo(box, { contentFit: 'cover', nativeControls: true });
    expect(box.children).toHaveLength(1);
    expect((box.children[0] as FakeBox).style).toMatchObject({
      position: 'relative',
    });
    player.attachTo(null);
    expect(box.children).toHaveLength(0);
    await player.release();
  });

  it('refuses a picture for an audio player', async () => {
    load();
    const player = new web.Player();
    expect(() => player.attachTo(new FakeBox())).toThrow(
      'This is not a video player (create it with `video`).'
    );
    await player.release();
  });
});

describe('WebModule video', () => {
  let module: WebModule;

  beforeEach(() => {
    module = new WebModule();
  });

  const video = (id: string) =>
    (module.getStatus(id) as { video: Record<string, unknown> }).video;

  describe('videoCommand', () => {
    it('rejects for a player that does not exist', async () => {
      await expect(
        module.videoCommand('nope', { op: 'loop', value: true })
      ).rejects.toMatchObject({ code: 'PLAYER_RELEASED' });
    });

    it('rejects the video-only commands of an audio player', async () => {
      const id = module.createPlayer({});
      await expect(
        module.videoCommand(id, { op: 'selectQuality', id: '720p' })
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'This is not a video player (create it with `video`).',
        recoverable: false,
      });
    });

    it('rejects a command it does not know', async () => {
      const id = module.createPlayer({ video: true });
      await expect(
        module.videoCommand(id, { op: 'teleport' })
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'Unknown video command "teleport".',
      });
    });

    it('resolves with the status after the command', async () => {
      const id = module.createPlayer({ video: true });
      const before = (module.getStatus(id) as { seq: number }).seq;
      const result = (await module.videoCommand(id, {
        op: 'subtitleDelay',
        seconds: 1.5,
      })) as { seq: number; video: Record<string, unknown> };
      expect(result.video.subtitleDelay).toBe(1.5);
      expect(result.seq).toBeGreaterThanOrEqual(before);
      expect(video(id).subtitleDelay).toBe(1.5);
    });

    it('turns subtitles off with a null track', async () => {
      const id = module.createPlayer({ video: true });
      await module.videoCommand(id, { op: 'selectTextTrack', id: null });
      expect(video(id).textTrack).toBeNull();
    });

    it('turns an error the command threw into a PlayerError rejection', async () => {
      const id = module.createPlayer({ video: true });
      await expect(
        module.videoCommand(id, { op: 'pictureInPicture', active: true })
      ).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        platform: 'web',
        message: expect.stringContaining('not available in this browser'),
      });
    });
  });

  describe('getVideoStats', () => {
    it('throws for a player that does not exist', () => {
      expect(() => module.getVideoStats('nope')).toThrow(
        'The player was released.'
      );
    });

    it('has the engine counters and no dropped frames where the browser counts none', () => {
      const id = module.createPlayer({ video: true });
      expect(module.getVideoStats(id)).toMatchObject({
        rebufferCount: 0,
        qualitySwitches: 0,
        droppedFrames: null,
        bandwidth: null,
      });
    });

    it('reads the dropped frames from the element', () => {
      const id = module.createPlayer({ video: true });
      Object.assign(world.element(), {
        getVideoPlaybackQuality: () => ({ droppedVideoFrames: 7 }),
      });
      expect(module.getVideoStats(id)).toMatchObject({ droppedFrames: 7 });
    });
  });

  describe('attachVideo', () => {
    it('throws for a player that does not exist', () => {
      expect(() => module.attachVideo('nope', new FakeBox())).toThrow(
        'The player was released.'
      );
    });

    it('throws for an audio player', () => {
      const id = module.createPlayer({});
      expect(() => module.attachVideo(id, new FakeBox())).toThrow(
        'This is not a video player'
      );
    });

    it('puts the stage in the element and applies the fit and the controls', () => {
      const id = module.createPlayer({ video: true });
      const box = new FakeBox();
      module.attachVideo(id, box, 'cover', true);
      expect(box.children).toHaveLength(1);
      const element = world.element() as unknown as {
        style: Record<string, string>;
        controls: boolean;
      };
      expect(element.style.objectFit).toBe('cover');
      expect(element.controls).toBe(true);
      module.attachVideo(id, null);
      expect(box.children).toHaveLength(0);
    });
  });

  describe('fetchText', () => {
    const bytes = (...values: number[]) => new Uint8Array(values);
    let requests: Array<{ uri: string; init: Record<string, unknown> }>;

    const respond = (
      status: number,
      body: Uint8Array = new Uint8Array()
    ): void => {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: (uri: string, init: Record<string, unknown>) => {
          requests.push({ uri, init });
          return Promise.resolve({
            ok: status >= 200 && status < 300,
            status,
            arrayBuffer: () =>
              Promise.resolve(
                body.buffer.slice(
                  body.byteOffset,
                  body.byteOffset + body.byteLength
                )
              ),
          });
        },
      });
    };

    beforeEach(() => {
      requests = [];
    });

    it('asks with the headers, through CORS, and decodes UTF-8', async () => {
      respond(200, new TextEncoder().encode('Olá, mundo'));
      const result = await module.fetchText(
        'https://x.example/pt.srt',
        { Authorization: 'Bearer t' },
        null
      );
      expect(result).toEqual({ text: 'Olá, mundo', charset: 'utf-8' });
      expect(requests).toEqual([
        {
          uri: 'https://x.example/pt.srt',
          init: {
            headers: { Authorization: 'Bearer t' },
            cache: 'default',
            mode: 'cors',
          },
        },
      ]);
    });

    it('decodes in the encoding it was told', async () => {
      respond(200, bytes(0x4f, 0x6c, 0xe1));
      expect(
        await module.fetchText('https://x.example/pt.srt', {}, 'windows-1252')
      ).toEqual({ text: 'Olá', charset: 'windows-1252' });
    });

    it('detects a legacy single-byte encoding', async () => {
      respond(200, bytes(0x4f, 0x6c, 0xe1, 0x20, 0x61, 0x6d, 0x69, 0x67, 0x6f));
      const result = (await module.fetchText(
        'https://x.example/pt.srt',
        {},
        null
      )) as { text: string; charset: string };
      expect(result.charset).not.toBe('utf-8');
      expect(result.text).toBe('Olá amigo');
    });

    it('reads UTF-8 when the browser does not know the encoding', async () => {
      respond(200, new TextEncoder().encode('Olá'));
      expect(
        await module.fetchText(
          'https://x.example/pt.srt',
          {},
          'no-such-charset'
        )
      ).toEqual({ text: 'Olá', charset: 'no-such-charset' });
    });

    it('reads the bytes as characters where the browser has no TextDecoder', async () => {
      const decoder = Object.getOwnPropertyDescriptor(
        globalThis,
        'TextDecoder'
      );
      Object.defineProperty(globalThis, 'TextDecoder', {
        value: undefined,
        configurable: true,
      });
      try {
        respond(200, bytes(0x68, 0x69));
        expect(
          await module.fetchText('https://x.example/a.srt', {}, null)
        ).toEqual({ text: 'hi', charset: 'utf-8' });
      } finally {
        Object.defineProperty(globalThis, 'TextDecoder', decoder!);
      }
    });

    it('fails with a recoverable NETWORK_ERROR when the request cannot be made', async () => {
      Object.defineProperty(globalThis, 'fetch', {
        configurable: true,
        writable: true,
        value: () => Promise.reject(new TypeError('Failed to fetch')),
      });
      await expect(
        module.fetchText('https://x.example/a.srt', {}, null)
      ).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        recoverable: true,
        platform: 'web',
        message: expect.stringContaining('https://x.example/a.srt'),
      });
    });

    it('fails with HTTP_ERROR and the status, recoverable for a server error', async () => {
      respond(404);
      await expect(
        module.fetchText('https://x.example/a.srt', {}, null)
      ).rejects.toMatchObject({
        code: 'HTTP_ERROR',
        httpStatus: 404,
        recoverable: false,
        platform: 'web',
      });
      respond(503);
      await expect(
        module.fetchText('https://x.example/a.srt', {}, null)
      ).rejects.toMatchObject({
        code: 'HTTP_ERROR',
        httpStatus: 503,
        recoverable: true,
      });
    });
  });
});
