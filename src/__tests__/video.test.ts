// The JavaScript side of video: validating the video parts of a source,
// subtitle files (fetch with retry, parse, hand over), the thumbnail track,
// the signed-URL `refresh` hook, and a Player's video commands and events
// through the fake native module.

import { Platform } from 'react-native';
import { fake } from './FakeNative';
import { videoCommands, videoNative, videoStatus } from './FakeVideoNative';

jest.mock('../native/NativeAnythingPlayer', () => ({
  __esModule: true,
  default: require('./FakeNative').fake,
}));

import { Player } from '../Player';
import { PlayerError } from '../errors';
import {
  SubtitleLoader,
  ThumbnailTrack,
  callRefresh,
  normalizeRenditions,
  normalizeVideoSource,
  subtitleTracks,
  type SubtitleSink,
} from '../core/video';
import type { SubtitleCue } from '../core/subtitles/types';
import type { SourceInput, SubtitleSource } from '../types';

const flush = () => new Promise<void>((r) => setImmediate(() => r()));

const SRT = '1\n00:00:01,000 --> 00:00:02,500\nHello\n';
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello\n';

const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), {
    code: 'HTTP_ERROR',
    userInfo: { httpStatus: status },
  });

beforeEach(() => {
  fake.calls = [];
  fake.rejectNext = null;
  videoNative.reset();
});

describe('normalizeRenditions', () => {
  it('rejects anything but a non-empty array', () => {
    expect(() => normalizeRenditions([])).toThrow(
      '`renditions` must be a non-empty array.'
    );
    expect(() => normalizeRenditions('x' as never)).toThrow(
      '`renditions` must be a non-empty array.'
    );
  });

  it('names the rendition that has no uri', () => {
    expect(() =>
      normalizeRenditions([{ uri: 'https://x.example/a.mp4' }, { uri: ' ' }])
    ).toThrow('renditions[1] needs a non-empty `uri`.');
    expect(() => normalizeRenditions([null as never])).toThrow(
      'renditions[0] needs a non-empty `uri`.'
    );
  });

  it('keeps a rendition with no height or bitrate as just its uri', () => {
    expect(
      normalizeRenditions([{ uri: '  https://x.example/a.mp4 ' }])
    ).toEqual([{ uri: 'https://x.example/a.mp4' }]);
  });

  it('carries height, bitrate, label, audio-only and a copy of the headers', () => {
    const headers = { Authorization: 'Bearer t' };
    const [out] = normalizeRenditions([
      {
        uri: 'https://x.example/a.mp4',
        headers,
        height: 720,
        bitrate: 2_500_000,
        label: '720p',
        audioOnly: true,
      },
    ]);
    expect(out).toEqual({
      uri: 'https://x.example/a.mp4',
      headers,
      height: 720,
      bitrate: 2_500_000,
      label: '720p',
      audioOnly: true,
    });
    expect(out!.headers).not.toBe(headers);
  });

  it('rejects a height or bitrate that is not a positive number', () => {
    const uri = 'https://x.example/a.mp4';
    expect(() => normalizeRenditions([{ uri, height: 0 }])).toThrow(
      'renditions[0].height must be a positive number.'
    );
    expect(() => normalizeRenditions([{ uri, bitrate: -1 }])).toThrow(
      'renditions[0].bitrate must be a positive number.'
    );
    expect(() => normalizeRenditions([{ uri, height: Number.NaN }])).toThrow(
      'renditions[0].height must be a positive number.'
    );
    expect(() =>
      normalizeRenditions([{ uri, height: '720' as never }])
    ).toThrow('renditions[0].height must be a positive number.');
  });
});

describe('subtitleTracks', () => {
  it('rejects a list that is not an array and a file with neither uri nor text', () => {
    expect(() => subtitleTracks('x' as never)).toThrow(
      '`subtitles` must be an array.'
    );
    expect(() => subtitleTracks([{ language: 'en' }])).toThrow(
      'subtitles[0] needs a `uri` or a `text`.'
    );
  });

  it('gives the defaults: subtitles, no language, not forced, not default', () => {
    const [track] = subtitleTracks([{ uri: 'https://x.example/en.srt' }]);
    expect(track!.info).toEqual({
      id: 'sub:0',
      kind: 'subtitles',
      language: null,
      label: null,
      forced: false,
      default: false,
    });
  });

  it('numbers the ids it was not given from the first index', () => {
    const tracks = subtitleTracks(
      [{ text: SRT }, { text: SRT, id: 'mine' }, { text: SRT }],
      3
    );
    expect(tracks.map((t) => t.info.id)).toEqual(['sub:3', 'mine', 'sub:5']);
  });

  it('carries language, label, captions, forced and default', () => {
    const source: SubtitleSource = {
      uri: 'https://x.example/pt.vtt',
      language: 'pt-BR',
      label: 'Português',
      kind: 'captions',
      forced: true,
      default: true,
      encoding: 'windows-1252',
    };
    const [track] = subtitleTracks([source]);
    expect(track!.info).toEqual({
      id: 'sub:0',
      kind: 'captions',
      language: 'pt-BR',
      label: 'Português',
      forced: true,
      default: true,
    });
    expect(track!.source).toBe(source);
  });
});

describe('normalizeVideoSource', () => {
  const art = jest.fn((a: unknown) => (a === 'none' ? null : `art:${a}`));
  const uri = 'https://x.example/a.mp4';

  it('is empty for an audio source', () => {
    expect(normalizeVideoSource({ uri }, art)).toEqual({});
  });

  it('collects renditions, subtitle infos, thumbnails, poster and expiry', () => {
    const out = normalizeVideoSource(
      {
        uri,
        renditions: [{ uri, height: 480 }],
        subtitles: [{ text: SRT, language: 'en' }],
        thumbnails: 'https://x.example/t.vtt',
        poster: 'poster.png' as never,
        expiresAt: 1_700_000_000_000,
        refresh: async () => ({ uri }),
      },
      art
    );
    expect(out).toEqual({
      renditions: [{ uri, height: 480 }],
      subtitles: [expect.objectContaining({ id: 'sub:0', language: 'en' })],
      thumbnails: 'https://x.example/t.vtt',
      poster: 'art:poster.png',
      expiresAt: 1_700_000_000_000,
      refreshable: true,
    });
  });

  it('leaves out a poster that resolves to nothing', () => {
    expect(normalizeVideoSource({ uri, poster: 'none' as never }, art)).toEqual(
      {}
    );
  });

  it('validates the drm, the refresh hook and the expiry', () => {
    expect(() => normalizeVideoSource({ uri, drm: {} }, art)).toThrow(
      'drm needs a key system'
    );
    expect(() =>
      normalizeVideoSource({ uri, refresh: 'x' as never }, art)
    ).toThrow('`refresh` must be a function that returns a source.');
    expect(() =>
      normalizeVideoSource({ uri, expiresAt: Number.NaN }, art)
    ).toThrow('`expiresAt` must be epoch milliseconds.');
  });

  it('passes a valid drm through', () => {
    const out = normalizeVideoSource(
      { uri, drm: { widevine: { licenseUrl: 'https://lic.example/w' } } },
      art
    );
    expect(out.drm).toMatchObject({
      widevine: { licenseUrl: 'https://lic.example/w' },
      hook: false,
    });
  });
});

describe('SubtitleLoader', () => {
  let sent: Array<{ session: string; trackId: string; cues: SubtitleCue[] }>;
  let failures: PlayerError[];
  let loader: SubtitleLoader;

  beforeEach(() => {
    sent = [];
    failures = [];
    const sink: SubtitleSink = {
      sendCues: async (session, trackId, cues) => {
        sent.push({ session, trackId, cues });
      },
      failed: (error) => failures.push(error),
    };
    loader = new SubtitleLoader(sink);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const add = (source: SubtitleSource, headers = {}) =>
    loader.add(subtitleTracks([source]), headers);

  it('does nothing before a load began or after it was cancelled', async () => {
    add({ text: SRT });
    await flush();
    expect(sent).toEqual([]);
    expect(loader.size).toBe(0);
    loader.begin();
    loader.cancel();
    add({ text: SRT });
    await flush();
    expect(sent).toEqual([]);
  });

  it('parses a text file and hands its cues over under the session id', async () => {
    const session = loader.begin();
    add({ text: SRT, id: 'en' });
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ session, trackId: 'en' });
    expect(sent[0]!.cues).toHaveLength(1);
    expect(sent[0]!.cues[0]).toMatchObject({ start: 1, end: 2.5 });
    expect(videoNative.fetches).toEqual([]);
  });

  it('gives each load its own session and counts files across add calls', () => {
    const first = loader.begin();
    add({ text: SRT });
    add({ text: SRT });
    expect(loader.size).toBe(2);
    const second = loader.begin();
    expect(second).not.toBe(first);
    expect(loader.size).toBe(0);
  });

  it('fetches a uri with the source headers, the file headers and its encoding', async () => {
    videoNative.files.set('https://x.example/pt.vtt', VTT);
    loader.begin();
    add(
      {
        uri: 'https://x.example/pt.vtt',
        headers: { 'X-File': '1' },
        encoding: 'windows-1252',
      },
      { Authorization: 'Bearer t' }
    );
    await flush();
    expect(videoNative.fetches).toEqual([
      {
        uri: 'https://x.example/pt.vtt',
        headers: { 'Authorization': 'Bearer t', 'X-File': '1' },
        encoding: 'windows-1252',
      },
    ]);
    expect(sent[0]!.cues).toHaveLength(1);
  });

  it('takes the format from the declared one before the file name', async () => {
    videoNative.files.set('https://x.example/sub.txt', VTT);
    loader.begin();
    add({ uri: 'https://x.example/sub.txt', format: 'vtt' });
    await flush();
    expect(sent[0]!.cues).toHaveLength(1);
  });

  it('sends no cues for an empty file', async () => {
    loader.begin();
    add({ text: '   ' });
    await flush();
    expect(sent[0]!.cues).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('reports a file in no known format as a subtitle failure', async () => {
    loader.begin();
    add({ text: 'this is not a subtitle file', id: 'x' });
    await flush();
    expect(sent).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      code: 'SUBTITLE_LOAD_FAILED',
      recoverable: false,
      nativeCause: 'UNSUPPORTED_FORMAT',
    });
    expect(failures[0]!.message).toContain('Subtitles "x" could not be loaded');
  });

  it('reports a failure of the hand-over', async () => {
    const failing = new SubtitleLoader({
      sendCues: () => Promise.reject(new Error('module is gone')),
      failed: (error) => failures.push(error),
    });
    failing.begin();
    failing.add(subtitleTracks([{ text: SRT, id: 'en' }]), {});
    await flush();
    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).toBe(
      'Subtitles "en" could not be loaded: Error: module is gone'
    );
  });

  describe('fetching', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    it('does not retry a 404 and reports it with its status', async () => {
      videoNative.answers.push(httpError(404));
      loader.begin();
      add({ uri: 'https://x.example/missing.srt', id: 'gone' });
      await jest.advanceTimersByTimeAsync(60_000);
      expect(videoNative.fetches).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        code: 'SUBTITLE_LOAD_FAILED',
        httpStatus: 404,
        nativeCause: 'HTTP_ERROR',
      });
    });

    it('retries a 503 after a second and delivers the file', async () => {
      videoNative.answers.push(httpError(503), { text: SRT });
      loader.begin();
      add({ uri: 'https://x.example/en.srt' });
      await jest.advanceTimersByTimeAsync(999);
      expect(videoNative.fetches).toHaveLength(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(videoNative.fetches).toHaveLength(2);
      expect(sent).toHaveLength(1);
      expect(failures).toEqual([]);
    });

    it('retries 408, 429 and a network error without a status', async () => {
      videoNative.answers.push(
        httpError(408),
        httpError(429),
        new Error('offline'),
        { text: SRT }
      );
      loader.begin();
      add({ uri: 'https://x.example/en.srt' });
      // 1 s, then 2 s, then 4 s of backoff.
      await jest.advanceTimersByTimeAsync(7000);
      expect(videoNative.fetches).toHaveLength(4);
      expect(sent).toHaveLength(1);
    });

    it('gives up after five retries, waiting 1, 2, 4, 8 and 16 seconds', async () => {
      for (let i = 0; i < 6; i++) videoNative.answers.push(httpError(500));
      loader.begin();
      add({ uri: 'https://x.example/en.srt' });
      await jest.advanceTimersByTimeAsync(30_999);
      expect(videoNative.fetches).toHaveLength(5);
      expect(failures).toEqual([]);
      await jest.advanceTimersByTimeAsync(1);
      expect(videoNative.fetches).toHaveLength(6);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        code: 'SUBTITLE_LOAD_FAILED',
        httpStatus: 500,
      });
    });

    it('stops retrying when the load was cancelled meanwhile', async () => {
      videoNative.answers.push(httpError(500), { text: SRT });
      loader.begin();
      add({ uri: 'https://x.example/en.srt' });
      await jest.advanceTimersByTimeAsync(0);
      loader.cancel();
      await jest.advanceTimersByTimeAsync(5000);
      expect(videoNative.fetches).toHaveLength(1);
      expect(sent).toEqual([]);
      expect(failures).toEqual([]);
    });

    it('drops a file that arrives after a newer load began', async () => {
      videoNative.answers.push({ text: SRT });
      loader.begin();
      add({ uri: 'https://x.example/en.srt' });
      loader.begin();
      await jest.advanceTimersByTimeAsync(0);
      expect(sent).toEqual([]);
    });
  });
});

describe('ThumbnailTrack', () => {
  const track = 'https://cdn.example/v/thumbs.vtt';
  const vtt = [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:05.000',
    'sprite.jpg#xywh=0,0,160,90',
    '',
    '00:00:05.000 --> 00:00:10.000',
    'sprite.jpg#xywh=160,0,160,90',
    '',
    '00:00:10.000 --> 00:00:15.000',
    'frames/10.jpg',
    '',
  ].join('\n');

  beforeEach(() => {
    videoNative.files.set(track, vtt);
  });

  it('finds the sprite cell that covers a time, relative to the track', async () => {
    const thumbs = new ThumbnailTrack(track, {});
    expect(await thumbs.at(0)).toEqual({
      uri: 'https://cdn.example/v/sprite.jpg',
      x: 0,
      y: 0,
      width: 160,
      height: 90,
    });
    expect(await thumbs.at(7.5)).toMatchObject({ x: 160, y: 0 });
  });

  it('has no cell for the end of a cue, which belongs to the next one', async () => {
    const thumbs = new ThumbnailTrack(track, {});
    expect(await thumbs.at(5)).toMatchObject({ x: 160 });
    expect(await thumbs.at(15)).toBeNull();
    expect(await thumbs.at(99)).toBeNull();
  });

  it('gives a whole image, with no cell, for a cue without #xywh', async () => {
    const thumbs = new ThumbnailTrack(track, {});
    expect(await thumbs.at(12)).toEqual({
      uri: 'https://cdn.example/v/frames/10.jpg',
      x: null,
      y: null,
      width: null,
      height: null,
    });
  });

  it('fetches the track once, with its headers', async () => {
    const thumbs = new ThumbnailTrack(track, { Authorization: 'Bearer t' });
    await thumbs.at(1);
    await thumbs.at(6);
    expect(videoNative.fetches).toEqual([
      { uri: track, headers: { Authorization: 'Bearer t' }, encoding: null },
    ]);
  });

  it('fetches again after a failure', async () => {
    videoNative.files.clear();
    videoNative.answers.push(httpError(404));
    const thumbs = new ThumbnailTrack(track, {});
    await expect(thumbs.at(1)).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      httpStatus: 404,
    });
    videoNative.files.set(track, vtt);
    expect(await thumbs.at(1)).toMatchObject({ width: 160 });
    expect(videoNative.fetches).toHaveLength(2);
  });

  it('keeps a uri it cannot resolve as it is', async () => {
    videoNative.files.set(
      'thumbs.vtt',
      'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nsprite.jpg#xywh=0,0,10,10\n'
    );
    const thumbs = new ThumbnailTrack('thumbs.vtt', {});
    expect(await thumbs.at(1)).toMatchObject({ uri: 'sprite.jpg', width: 10 });
  });
});

describe('callRefresh', () => {
  it('asks the app for a source with the reason', async () => {
    const refresh = jest.fn(async () => ({ uri: 'https://x.example/new.mp4' }));
    expect(await callRefresh(refresh, 'unauthorized')).toEqual({
      uri: 'https://x.example/new.mp4',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ reason: 'unauthorized' });
  });

  it('answers null, and warns, when the app failed', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new Error('token service down');
    expect(
      await callRefresh(() => Promise.reject(failure), 'expiring')
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('`refresh` failed'),
      failure
    );
    warn.mockRestore();
  });
});

describe('Player video', () => {
  const uri = 'https://cdn.example/movie.mp4';
  let players: Player[];

  const videoPlayer = (options: object = {}) => {
    const p = new Player({ video: true, ...options });
    players.push(p);
    return p;
  };

  beforeEach(() => {
    players = [];
  });

  afterEach(async () => {
    await Promise.all(players.map((p) => p.release()));
  });

  describe('the video option', () => {
    it('is passed to native, and the status has a video part', () => {
      const p = videoPlayer({ video: { whenBackgrounded: 'pause' } });
      expect(fake.calls[0]).toEqual([
        'createPlayer',
        { video: { whenBackgrounded: 'pause' } },
      ]);
      expect(p.status.video).toMatchObject({ firstFrame: false });
    });

    it('is not asked for by an audio player, whose status has no video', () => {
      const p = new Player({ video: false });
      players.push(p);
      expect(p.status.video ?? null).toBeNull();
    });

    it('fails with VIDEO_UNAVAILABLE, and frees the player, when native has no video', async () => {
      videoNative.available = false;
      const create = () => new Player({ video: true });
      let error: unknown;
      try {
        create();
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({
        code: 'VIDEO_UNAVAILABLE',
        recoverable: false,
      });
      expect((error as PlayerError).message).toContain('npx rnap add video');
      await flush();
      expect(fake.calls.filter((c) => c[0] === 'releasePlayer')).toHaveLength(
        1
      );
    });
  });

  describe('load', () => {
    it('sends the video parts of the source and a subtitle session', async () => {
      const p = videoPlayer();
      await p.load({
        uri,
        renditions: [{ uri, height: 720 }],
        subtitles: [{ text: SRT, language: 'en' }],
        thumbnails: 'https://cdn.example/t.vtt',
      });
      const load = fake.calls.find((c) => c[0] === 'load')!;
      expect(load[2]).toMatchObject({
        uri,
        renditions: [{ uri, height: 720 }],
        subtitles: [expect.objectContaining({ id: 'sub:0' })],
        thumbnails: 'https://cdn.example/t.vtt',
        subtitleSession: expect.stringMatching(/^s\d+$/),
      });
    });

    it('plays a source with renditions and no uri through its first picture', async () => {
      const p = videoPlayer();
      await p.load({
        renditions: [
          { uri: 'https://cdn.example/audio.m4a', audioOnly: true },
          { uri, height: 480 },
        ],
      });
      expect(fake.calls.find((c) => c[0] === 'load')![2]).toMatchObject({
        uri,
      });
    });

    it('rejects a source with no uri and no renditions', async () => {
      const p = videoPlayer();
      await expect(p.load({ uri: ' ' })).rejects.toMatchObject({
        code: 'INVALID_SOURCE',
      });
      await expect(p.load({ renditions: [] })).rejects.toMatchObject({
        code: 'INVALID_SOURCE',
      });
    });

    it('rejects a malformed video part before native hears of it', async () => {
      const p = videoPlayer();
      await expect(
        p.load({ uri, renditions: [{ uri: '' }] })
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(fake.calls.some((c) => c[0] === 'load')).toBe(false);
    });

    it('gives no subtitle session to an audio player', async () => {
      const p = new Player();
      players.push(p);
      await p.load({ uri, subtitles: [{ text: SRT }] });
      expect(fake.calls.find((c) => c[0] === 'load')![2]).not.toHaveProperty(
        'subtitleSession'
      );
    });

    it('hands the cues of a subtitle file to native once parsed', async () => {
      videoNative.files.set('https://cdn.example/en.srt', SRT);
      const p = videoPlayer();
      await p.load({
        uri,
        headers: { Authorization: 'Bearer t' },
        subtitles: [
          { uri: 'https://cdn.example/en.srt', id: 'en' },
          { text: VTT, id: 'inline' },
        ],
      });
      await flush();
      const cues = videoCommands().filter((c) => c.op === 'cues');
      expect(cues.map((c) => c.trackId).sort()).toEqual(['en', 'inline']);
      expect(cues[0]).toMatchObject({
        session: expect.stringMatching(/^s\d+$/),
        cues: [expect.objectContaining({ start: 1, end: 2.5 })],
      });
      expect(videoNative.fetches[0]).toMatchObject({
        headers: { Authorization: 'Bearer t' },
      });
    });

    it('raises a non-fatal error event when a subtitle file cannot be loaded', async () => {
      videoNative.answers.push(httpError(404));
      const p = videoPlayer();
      const errors: Array<[PlayerError, { fatal: boolean }]> = [];
      p.on('error', (error, info) => errors.push([error, info]));
      await p.load({
        uri,
        subtitles: [{ uri: 'https://cdn.example/none.srt', id: 'gone' }],
      });
      await flush();
      expect(errors).toHaveLength(1);
      expect(errors[0]![0]).toMatchObject({
        code: 'SUBTITLE_LOAD_FAILED',
        httpStatus: 404,
      });
      expect(errors[0]![1]).toEqual({ fatal: false });
    });

    it('drops the files of a source a newer load replaced', async () => {
      videoNative.files.set('https://cdn.example/old.srt', SRT);
      const p = videoPlayer();
      const first = p.load({
        uri,
        subtitles: [{ uri: 'https://cdn.example/old.srt', id: 'old' }],
      });
      await p.load({ uri });
      await first;
      await flush();
      expect(videoCommands().filter((c) => c.op === 'cues')).toEqual([]);
    });
  });

  describe('commands', () => {
    it('setLoop sends the loop flag', async () => {
      const p = videoPlayer();
      await p.setLoop(true);
      await p.setLoop(false);
      expect(videoCommands()).toEqual([
        { op: 'loop', value: true },
        { op: 'loop', value: false },
      ]);
    });

    it('selectQuality sends the id, and null for auto', async () => {
      const p = videoPlayer();
      await p.selectQuality('720p');
      await p.selectQuality('auto');
      expect(videoCommands()).toEqual([
        { op: 'selectQuality', id: '720p' },
        { op: 'selectQuality', id: null },
      ]);
    });

    it('selectAudioTrack sends the id, and null for auto', async () => {
      const p = videoPlayer();
      await p.selectAudioTrack('audio:1');
      await p.selectAudioTrack('auto');
      expect(videoCommands()).toEqual([
        { op: 'selectAudioTrack', id: 'audio:1' },
        { op: 'selectAudioTrack', id: null },
      ]);
    });

    it('selectSubtitles sends the id, and null for off', async () => {
      const p = videoPlayer();
      await p.selectSubtitles('sub:0');
      await p.selectSubtitles(null);
      expect(videoCommands()).toEqual([
        { op: 'selectTextTrack', id: 'sub:0' },
        { op: 'selectTextTrack', id: null },
      ]);
    });

    it('setSubtitleDelay sends the seconds and rejects a non-finite one', async () => {
      const p = videoPlayer();
      await p.setSubtitleDelay(-1.5);
      expect(videoCommands()).toEqual([{ op: 'subtitleDelay', seconds: -1.5 }]);
      await expect(p.setSubtitleDelay(Number.NaN)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      expect(videoCommands()).toHaveLength(1);
    });

    it('setListenOnly sends the flag', async () => {
      const p = videoPlayer();
      await p.setListenOnly(true);
      expect(videoCommands()).toEqual([{ op: 'listenOnly', value: true }]);
    });

    it('presentFullscreen and dismissFullscreen send the fullscreen command', async () => {
      const p = videoPlayer();
      await p.presentFullscreen();
      await p.presentFullscreen({ lockOrientation: 'landscape' });
      await p.dismissFullscreen();
      expect(videoCommands()).toEqual([
        { op: 'fullscreen', active: true, lockOrientation: false },
        { op: 'fullscreen', active: true, lockOrientation: 'landscape' },
        { op: 'fullscreen', active: false },
      ]);
    });

    it('startPictureInPicture and stopPictureInPicture send the PiP command', async () => {
      const p = videoPlayer();
      await p.startPictureInPicture();
      await p.stopPictureInPicture();
      expect(videoCommands()).toEqual([
        { op: 'pictureInPicture', active: true },
        { op: 'pictureInPicture', active: false },
      ]);
    });

    it('an exact seek is a video command, an inexact one is not', async () => {
      const p = videoPlayer();
      await p.seekTo(10, { exact: true });
      expect(videoCommands()).toEqual([
        { op: 'seek', position: 10, exact: true },
      ]);
      await p.seekTo(20);
      expect(fake.calls).toContainEqual(['seekTo', p.id, 20]);
      expect(videoCommands()).toHaveLength(1);
    });

    it('addSubtitles announces the files, then numbers on from the load and loads them', async () => {
      const p = videoPlayer();
      await p.load({ uri, subtitles: [{ text: SRT, id: 'en' }] });
      await flush();
      await p.addSubtitles([{ text: VTT, language: 'pt' }]);
      await flush();
      const add = videoCommands().find((c) => c.op === 'addSubtitles');
      expect(add).toEqual({
        op: 'addSubtitles',
        tracks: [expect.objectContaining({ id: 'sub:1', language: 'pt' })],
      });
      expect(
        videoCommands()
          .filter((c) => c.op === 'cues')
          .map((c) => c.trackId)
      ).toEqual(['en', 'sub:1']);
    });

    it('addSubtitles rejects a file with neither uri nor text', async () => {
      const p = videoPlayer();
      await expect(p.addSubtitles([{ language: 'en' }])).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
      expect(videoCommands()).toEqual([]);
    });

    it('a command native rejects rejects as a PlayerError', async () => {
      const p = videoPlayer();
      videoNative.rejectVideoCommand = Object.assign(new Error('no PiP'), {
        code: 'INVALID_ARGUMENT',
      });
      await expect(p.startPictureInPicture()).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'no PiP',
      });
    });

    it('a command on a released player rejects with PLAYER_RELEASED', async () => {
      const p = videoPlayer();
      await p.release();
      await expect(p.selectQuality('720p')).rejects.toMatchObject({
        code: 'PLAYER_RELEASED',
      });
      expect(videoCommands()).toEqual([]);
    });

    it('applies the status a command resolves with', async () => {
      const p = videoPlayer();
      const statuses = jest.fn();
      p.on('status', statuses);
      await p.setLoop(true);
      expect(statuses).toHaveBeenCalledTimes(1);
    });
  });

  describe('stats, thumbnails and cues', () => {
    it('getStats reads the stats from native', () => {
      const p = videoPlayer();
      expect(p.getStats()).toEqual({ startupMs: 120, rebuffers: 1 });
      expect(fake.calls).toContainEqual(['getVideoStats', p.id]);
    });

    it('getThumbnail is null when the source has no thumbnails', async () => {
      const p = videoPlayer();
      await p.load({ uri });
      expect(await p.getThumbnail(3)).toBeNull();
    });

    it('getThumbnail looks the time up in the source track, with its headers', async () => {
      videoNative.files.set(
        'https://cdn.example/t.vtt',
        'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\ns.jpg#xywh=0,0,16,9\n'
      );
      const p = videoPlayer();
      await p.load({
        uri,
        headers: { Authorization: 'Bearer t' },
        thumbnails: 'https://cdn.example/t.vtt',
      });
      expect(await p.getThumbnail(4)).toEqual({
        uri: 'https://cdn.example/s.jpg',
        x: 0,
        y: 0,
        width: 16,
        height: 9,
      });
      expect(await p.getThumbnail(40)).toBeNull();
      expect(videoNative.fetches).toEqual([
        {
          uri: 'https://cdn.example/t.vtt',
          headers: { Authorization: 'Bearer t' },
          encoding: null,
        },
      ]);
    });

    it('getThumbnail rejects a time that is not finite', async () => {
      const p = videoPlayer();
      await expect(
        p.getThumbnail(Number.POSITIVE_INFINITY)
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    });

    it('a new load forgets the previous source thumbnails', async () => {
      videoNative.files.set(
        'https://cdn.example/t.vtt',
        'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\ns.jpg\n'
      );
      const p = videoPlayer();
      await p.load({ uri, thumbnails: 'https://cdn.example/t.vtt' });
      expect(await p.getThumbnail(1)).not.toBeNull();
      await p.load({ uri });
      expect(await p.getThumbnail(1)).toBeNull();
    });

    it('cues events update getCues and reach listeners', async () => {
      const p = videoPlayer();
      const seen: SubtitleCue[][] = [];
      p.on('cues', (cues) => seen.push(cues));
      expect(p.getCues()).toEqual([]);
      const cues = [{ start: 1, end: 2, text: 'Hello' }];
      fake.emit({ type: 'cues', playerId: p.id, cues });
      expect(p.getCues()).toBe(cues);
      expect(seen).toEqual([cues]);
    });
  });

  describe('status events', () => {
    it('raises firstFrame, fullscreenChange and pictureInPictureChange on change only', () => {
      const p = videoPlayer();
      const events: string[] = [];
      p.on('firstFrame', () => events.push('firstFrame'));
      p.on('fullscreenChange', (on) => events.push(`fullscreen:${on}`));
      p.on('pictureInPictureChange', (on) => events.push(`pip:${on}`));
      fake.emitStatus(p.id, {
        seq: 1,
        video: videoStatus({ firstFrame: true, fullscreen: true }),
      });
      fake.emitStatus(p.id, {
        seq: 2,
        video: videoStatus({
          firstFrame: true,
          fullscreen: true,
          pictureInPicture: true,
        }),
      });
      fake.emitStatus(p.id, { seq: 3, video: videoStatus() });
      expect(events).toEqual([
        'firstFrame',
        'fullscreen:true',
        'pip:true',
        'pip:false',
        'fullscreen:false',
      ]);
    });
  });

  describe('licenseRequest', () => {
    const request = (id: string, challenge = 'AQID') => ({
      type: 'licenseRequest',
      playerId: id,
      requestId: 7,
      keySystem: 'widevine',
      challenge,
      contentId: null,
      licenseUrl: 'https://lic.example/w',
      headers: { 'X-A': '1' },
    });

    it('is answered with the license the app returns, in base64', async () => {
      const getLicense = jest.fn(async () => new Uint8Array([4, 5, 6]));
      const p = videoPlayer();
      await p.load({
        uri,
        drm: {
          widevine: { licenseUrl: 'https://lic.example/w' },
          getLicense,
        },
      });
      fake.emit(request(p.id));
      await flush();
      expect(getLicense).toHaveBeenCalledWith({
        keySystem: 'widevine',
        challenge: new Uint8Array([1, 2, 3]),
        contentId: null,
        licenseUrl: 'https://lic.example/w',
        headers: { 'X-A': '1' },
      });
      expect(videoCommands().at(-1)).toEqual({
        op: 'license',
        requestId: 7,
        license: 'BAUG',
      });
    });

    it('is answered with the error when the app fails', async () => {
      const p = videoPlayer();
      await p.load({
        uri,
        drm: {
          widevine: { licenseUrl: 'https://lic.example/w' },
          getLicense: async () => {
            throw new Error('license server down');
          },
        },
      });
      fake.emit(request(p.id));
      await flush();
      expect(videoCommands().at(-1)).toEqual({
        op: 'license',
        requestId: 7,
        error: 'license server down',
      });
    });

    it('is answered with an error when the source has no getLicense', async () => {
      const p = videoPlayer();
      await p.load({ uri });
      fake.emit(request(p.id));
      await flush();
      expect(videoCommands().at(-1)).toEqual({
        op: 'license',
        requestId: 7,
        error: 'The source has no drm.getLicense.',
      });
    });

    it('is not answered once the player is released', async () => {
      let answer!: (bytes: Uint8Array) => void;
      const p = videoPlayer();
      await p.load({
        uri,
        drm: {
          widevine: { licenseUrl: 'https://lic.example/w' },
          getLicense: () =>
            new Promise<Uint8Array>((resolve) => {
              answer = resolve;
            }),
        },
      });
      fake.emit(request(p.id));
      await flush();
      await p.release();
      answer(new Uint8Array([1]));
      await flush();
      expect(videoCommands().some((c) => c.op === 'license')).toBe(false);
    });

    it('survives native rejecting the answer', async () => {
      const p = videoPlayer();
      await p.load({ uri });
      videoNative.rejectVideoCommand = new Error('gone');
      fake.emit(request(p.id));
      await flush();
      expect(videoCommands().at(-1)).toMatchObject({ op: 'license' });
    });
  });

  describe('refreshRequest', () => {
    const ask = (id: string, reason = 'unauthorized', loadId = 3) =>
      fake.emit({ type: 'refreshRequest', playerId: id, loadId, reason });

    it('calls the app refresh once and gives the engine the new source', async () => {
      const refresh = jest.fn(async () => ({
        uri: 'https://cdn.example/movie.mp4?sig=new',
        headers: { Authorization: 'Bearer new' },
      }));
      const p = videoPlayer();
      await p.load({ uri, refresh });
      ask(p.id, 'unauthorized', 5);
      await flush();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith({ reason: 'unauthorized' });
      expect(videoCommands().at(-1)).toEqual({
        op: 'refreshed',
        loadId: 5,
        source: {
          uri: 'https://cdn.example/movie.mp4?sig=new',
          headers: { Authorization: 'Bearer new' },
        },
      });
    });

    it("hands license requests to a refreshed source's getLicense, unless another load came first", async () => {
      const drm = (getLicense: () => Promise<Uint8Array>) => ({
        widevine: { licenseUrl: 'https://lic.example/w' },
        getLicense,
      });
      const license = (id: string) =>
        fake.emit({
          type: 'licenseRequest',
          playerId: id,
          requestId: 8,
          keySystem: 'widevine',
          challenge: 'AQID',
          contentId: null,
          licenseUrl: 'https://lic.example/w',
          headers: {},
        });
      const first = jest.fn(async () => new Uint8Array([1]));
      const refreshed = jest.fn(async () => new Uint8Array([2]));
      const p = videoPlayer();
      await p.load({
        uri,
        drm: drm(first),
        refresh: async () => ({ uri, drm: drm(refreshed) }),
      });
      ask(p.id);
      await flush();
      license(p.id);
      await flush();
      expect(refreshed).toHaveBeenCalledTimes(1);
      expect(first).not.toHaveBeenCalled();

      // The same refresh for a second load: the first load's late answer is not it.
      let answer!: (source: SourceInput) => void;
      const late = () =>
        new Promise<SourceInput>((resolve) => (answer = resolve));
      const second = jest.fn(async () => new Uint8Array([3]));
      await p.load({ uri, drm: drm(first), refresh: late });
      ask(p.id);
      await p.load({ uri, drm: drm(second), refresh: late });
      answer({ uri, drm: drm(refreshed) });
      await flush();
      license(p.id);
      await flush();
      expect(second).toHaveBeenCalledTimes(1);
      expect(refreshed).toHaveBeenCalledTimes(1);
    });

    it('tells the app when the source is about to expire', async () => {
      const refresh = jest.fn(async () => ({ uri }));
      const p = videoPlayer();
      await p.load({ uri, refresh, expiresAt: Date.now() + 60_000 });
      ask(p.id, 'expiring');
      await flush();
      expect(refresh).toHaveBeenCalledWith({ reason: 'expiring' });
    });

    it('marks the source as refreshable in what it sends native', async () => {
      const p = videoPlayer();
      await p.load({ uri, refresh: async () => ({ uri }) });
      expect(fake.calls.find((c) => c[0] === 'load')![2]).toMatchObject({
        refreshable: true,
      });
    });

    it('reports a failure when the source has no refresh', async () => {
      const p = videoPlayer();
      await p.load({ uri });
      ask(p.id, 'unauthorized', 9);
      await flush();
      expect(videoCommands().at(-1)).toEqual({
        op: 'refreshFailed',
        loadId: 9,
      });
    });

    it('reports a failure when the app refresh fails', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const p = videoPlayer();
      await p.load({
        uri,
        refresh: async () => {
          throw new Error('no token');
        },
      });
      ask(p.id);
      await flush();
      expect(videoCommands().at(-1)).toMatchObject({ op: 'refreshFailed' });
      warn.mockRestore();
    });

    it('reports a failure when the new source is not valid', async () => {
      const p = videoPlayer();
      await p.load({ uri, refresh: async () => ({ uri: '' }) });
      ask(p.id);
      await flush();
      expect(videoCommands().at(-1)).toMatchObject({ op: 'refreshFailed' });
    });

    it('forgets the refresh of a previous source', async () => {
      const refresh = jest.fn(async () => ({ uri }));
      const p = videoPlayer();
      await p.load({ uri, refresh });
      await p.load({ uri });
      ask(p.id);
      await flush();
      expect(refresh).not.toHaveBeenCalled();
      expect(videoCommands().at(-1)).toMatchObject({ op: 'refreshFailed' });
    });

    it('says nothing once the player is released', async () => {
      let answer!: (value: { uri: string }) => void;
      const p = videoPlayer();
      await p.load({
        uri,
        refresh: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      });
      ask(p.id);
      await flush();
      await p.release();
      answer({ uri });
      await flush();
      expect(videoCommands().some((c) => c.op === 'refreshed')).toBe(false);
    });
  });

  describe('attachTo', () => {
    afterEach(() => {
      Platform.OS = 'ios';
    });

    it('is for web pages: where there is no web engine it rejects', () => {
      const p = videoPlayer();
      expect(() => p.attachTo({})).toThrow(
        'attachTo() is for web pages. In React Native, use <VideoView player={player} />.'
      );
    });

    it('hands the element, fit and controls to the web engine', () => {
      const attached: unknown[][] = [];
      Object.assign(fake, {
        attachVideo: (...args: unknown[]) => attached.push(args),
      });
      Platform.OS = 'web';
      const p = videoPlayer();
      const element = {};
      p.attachTo(element, { contentFit: 'cover', nativeControls: true });
      p.attachTo(null);
      expect(attached).toEqual([
        [p.id, element, 'cover', true],
        [p.id, null, undefined, false],
      ]);
      delete (fake as { attachVideo?: unknown }).attachVideo;
    });

    it('rejects on a released player', async () => {
      const p = videoPlayer();
      await p.release();
      expect(() => p.attachTo({})).toThrow('The player was released.');
    });
  });
});
