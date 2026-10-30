/// <reference types="node" />
// MediaElementDriver on a <video>: how a source is played (the element, hls.js,
// Shaka, the remuxer, DRM), the picture's size and first frame, the browser's
// own controls, seeking, and the stream engines' reports reaching the player.
// The remuxer and Shaka are stand-ins here (see FakeStreams); hls.js is the
// real glue on a scripted hls.js, and DRM the real glue on scripted EME.

import { configureHls } from '../../core/hls';
import { configureShaka } from '../../core/shaka';
import { engineError, type DrmDescriptor } from '../engine/types';
import type { OpenRequest, SourceDescriptor } from '../engine/types';
import { MediaElementDriver } from '../platform/MediaElementDriver';
import { answerLicense } from '../platform/licenseRequests';
import { id3TextTag } from './audioFixtures';
import { FakeMediaSource, ranges, uninstall } from './FakeBrowser';
import { FakeHls } from './FakeHls';
import {
  BrokenHls,
  FakeDashStream,
  FakeEme,
  FakeRemuxStream,
  RichHls,
  asHls,
  fakeShaka,
} from './FakeStreams';
import { installVideo, recorder, type FakeVideoWorld } from './FakeVideo';

jest.mock('../platform/RemuxStream', () => ({
  RemuxStream: require('./FakeStreams').FakeRemuxStream,
}));
jest.mock('../platform/DashStream', () => ({
  DashStream: require('./FakeStreams').FakeDashStream,
}));

const MP4 = 'https://cdn.example/movie.mp4';
const HLS = 'https://cdn.example/movie/master.m3u8';
const MPD = 'https://cdn.example/movie/manifest.mpd';
const MKV = 'https://cdn.example/movie.mkv';

let world: FakeVideoWorld;
let rec: ReturnType<typeof recorder>;
let driver: MediaElementDriver;

type Features = Parameters<typeof installVideo>[1];
type Options = Parameters<typeof installVideo>[0];

function setup(
  features: Features = {},
  options: Options = {},
  optional = true
) {
  world = installVideo(options, features);
  rec = recorder(optional);
  driver = new MediaElementDriver(rec.observer, 'artist-title', 'video');
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}

const source = (
  uri: string,
  extra: Partial<SourceDescriptor> = {}
): SourceDescriptor => ({ uri, headers: {}, liveHint: null, ...extra });

const open = (
  uri: string,
  extra: Partial<OpenRequest> = {},
  generation = 1,
  src: Partial<SourceDescriptor> = {}
): OpenRequest => ({
  generation,
  source: source(uri, src),
  startPosition: null,
  playWhenReady: false,
  allowReconnect: true,
  ...extra,
});

const failures = () =>
  rec
    .of('onFailed')
    .map(
      (a) => a[1] as { code: string; message: string; recoverable: boolean }
    );

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  FakeHls.reset();
  FakeRemuxStream.instances = [];
  FakeDashStream.instances = [];
  configureHls(asHls(RichHls));
  configureShaka(fakeShaka());
  setup();
});

afterEach(() => {
  configureHls(null);
  configureShaka(null);
  uninstall();
  jest.useRealTimers();
});

describe('the element', () => {
  it('is a <video> made to play inline, filling its box', () => {
    const video = world.video();
    expect(driver.videoElement).toBe(video);
    expect(driver.element).toBe(video);
    expect(video.preload).toBe('auto');
    expect(video.playsInline).toBe(true);
    expect(video.attributes).toEqual({
      'playsinline': '',
      'webkit-playsinline': '',
    });
    expect(video.style).toMatchObject({
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      backgroundColor: 'black',
    });
  });

  it('loops as the engine says', () => {
    driver.setLoop(true);
    expect(world.video().loop).toBe(true);
    driver.setLoop(false);
    expect(world.video().loop).toBe(false);
  });

  it('is an <audio> for a sound player, with no picture to report', () => {
    const audio = new MediaElementDriver(rec.observer, 'artist-title');
    expect(audio.videoElement).toBeNull();
    expect(world.videos).toHaveLength(1);
    audio.setLoop(true);
    audio.open(open(MP4));
    const element = world.elements[world.elements.length - 1]!;
    element.dispatch('loadeddata');
    element.dispatch('resize');
    expect(rec.of('onFirstFrame')).toEqual([]);
    expect(rec.of('onVideoInfo')).toEqual([]);
  });
});

describe('a file', () => {
  it('plays on the element, not through MSE', () => {
    driver.open(open(MP4));
    expect(world.video().src).toBe(MP4);
    expect(world.video().loads).toBe(1);
    expect(FakeMediaSource.instances).toEqual([]);
    expect(driver.isStreamed).toBe(false);
  });

  it('tells the engine a longer duration found later, and seeks to a start that waited for it (#50)', () => {
    driver.open(open(MP4, { startPosition: 300 }));
    const video = world.video();
    video.becomeReady(18);
    // Not at the early end, where it would end.
    expect(video.currentTime).toBe(0);
    expect(rec.of('onReady')).toEqual([
      [1, { duration: 18, isLive: false, seekable: true }],
    ]);

    video.duration = 120;
    video.dispatch('durationchange');
    // Not yet: the start is past it.
    expect(video.currentTime).toBe(0);
    video.duration = 600;
    video.seekable = ranges([[0, 600]]);
    video.dispatch('durationchange');
    expect(video.currentTime).toBe(300);
    expect(rec.of('onReady').slice(1)).toEqual([
      [1, { duration: 120, isLive: false, seekable: true }],
      [1, { duration: 600, isLive: false, seekable: true }],
    ]);
    // The same facts again are not news.
    video.dispatch('durationchange');
    expect(rec.of('onReady')).toHaveLength(3);
  });

  it('keeps a start given before the duration is known, until there is one (sol S1)', () => {
    driver.open(open(MP4, { startPosition: 300 }));
    const video = world.video();
    video.becomeReady(Infinity);
    expect(video.currentTime).toBe(0);
    video.duration = 600;
    video.seekable = ranges([[0, 600]]);
    video.dispatch('durationchange');
    expect(video.currentTime).toBe(300);
  });

  it('tells the engine a seek range that appears without a new duration (sol S2)', () => {
    driver.open(open(MP4));
    const video = world.video();
    video.becomeReady(120, false);
    video.seekable = ranges([[0, 120]]);
    video.dispatch('progress');
    expect(rec.of('onReady')).toEqual([
      [1, { duration: 120, isLive: false, seekable: false }],
      [1, { duration: 120, isLive: false, seekable: true }],
    ]);
  });

  it('drops a start that waited once something else seeks', () => {
    driver.open(open(MP4, { startPosition: 300 }));
    const video = world.video();
    video.becomeReady(18);
    driver.seek(5);
    video.duration = 600;
    video.dispatch('durationchange');
    expect(video.currentTime).toBe(5);
  });

  it('keeps the rate on the next source: a load resets it to the default, which is the rate too (#49)', () => {
    driver.setRate(1.5);
    driver.open(open(MP4));
    const video = world.video();
    expect(video.playbackRate).toBe(1.5);
    expect(video.defaultPlaybackRate).toBe(1.5);
    driver.open(open('https://cdn.example/other.mp4', {}, 2));
    video.becomeReady(60);
    expect(video.playbackRate).toBe(1.5);
    expect(driver.progress().rate).toBe(1.5);
  });

  it('puts the rate back when something reset the default before it played (#49)', () => {
    driver.setRate(2);
    driver.open(open(MP4, { playWhenReady: true }));
    const video = world.video();
    video.becomeReady(60);
    video.defaultPlaybackRate = 1;
    video.playbackRate = 1;
    video.dispatch('playing');
    expect(video.playbackRate).toBe(2);
    expect(video.defaultPlaybackRate).toBe(2);
  });

  it.each(['blob:https://app.example/1', 'data:video/mp4;base64,AAAA'])(
    'held by the page (%s) counts as streamed',
    (uri) => {
      driver.open(open(uri));
      expect(driver.isStreamed).toBe(true);
    }
  );

  it('reports the picture once the size is known, and again when it changes', () => {
    driver.open(open(MP4));
    const video = world.video();
    video.becomeReady(120);
    expect(rec.of('onVideoInfo')).toEqual([]);

    video.size(1280, 720);
    video.dispatch('resize');
    video.size(1920, 1080);
    video.dispatch('resize');
    expect(rec.of('onVideoInfo')).toEqual([
      [1, { width: 1280, height: 720, hdr: false, variantId: null }],
      [1, { width: 1920, height: 1080, hdr: false, variantId: null }],
    ]);
  });

  it('reports the size together with the metadata', () => {
    driver.open(open(MP4));
    const video = world.video();
    video.size(640, 360);
    video.becomeReady(60);
    expect(rec.of('onVideoInfo')).toEqual([
      [1, { width: 640, height: 360, hdr: false, variantId: null }],
    ]);
    expect(rec.of('onReady')).toEqual([
      [1, { duration: 60, isLive: false, seekable: true }],
    ]);
  });

  it('reports a file with no end as live', () => {
    driver.open(open(MP4));
    world.video().becomeReady(Number.POSITIVE_INFINITY);
    expect(rec.of('onReady')).toEqual([
      [1, { duration: null, isLive: true, seekable: false }],
    ]);
  });

  it('reports the first frame as soon as the data is there', () => {
    driver.open(open(MP4));
    world.video().dispatch('loadeddata');
    expect(rec.of('onFirstFrame')).toEqual([[1]]);
  });

  it('reports the first frame when the browser has painted it', () => {
    setup({ frameCallback: true });
    driver.open(open(MP4));
    const video = world.video();
    video.dispatch('loadeddata');
    expect(rec.of('onFirstFrame')).toEqual([]);
    video.drawFrame();
    expect(rec.of('onFirstFrame')).toEqual([[1]]);
  });

  it('does not report a first frame for an item that was replaced meanwhile', () => {
    setup({ frameCallback: true });
    driver.open(open(MP4));
    const video = world.video();
    video.dispatch('loadeddata');
    driver.open(open('https://cdn.example/other.mp4', {}, 2));
    video.drawFrame();
    expect(rec.of('onFirstFrame')).toEqual([]);
  });

  it('estimates the bandwidth from the connection, at most every two seconds', () => {
    const video = world.video();
    driver.open(open(MP4));
    Object.assign(world.navigator.connection, { downlink: 5 });
    video.dispatch('progress');
    video.dispatch('progress');
    expect(rec.of('onBandwidth')).toEqual([[1, 5_000_000]]);
    jest.advanceTimersByTime(2001);
    Object.assign(world.navigator.connection, { downlink: 2.5 });
    video.dispatch('progress');
    expect(rec.of('onBandwidth')).toEqual([
      [1, 5_000_000],
      [1, 2_500_000],
    ]);
  });

  it('estimates a sound’s bandwidth too: an audio player steps renditions by it (council C1)', () => {
    const audio = new MediaElementDriver(rec.observer, 'artist-title', 'audio');
    audio.open(
      open('https://cdn.example/song.m4a', {}, 1, { liveHint: false })
    );
    Object.assign(world.navigator.connection, { downlink: 3 });
    (audio.element as unknown as { dispatch(type: string): void }).dispatch(
      'progress'
    );
    expect(rec.of('onBandwidth')).toEqual([[1, 3_000_000]]);
    audio.destroy();
  });

  it('has no bandwidth to report when the browser does not know one', () => {
    const video = world.video();
    driver.open(open(MP4));
    video.dispatch('progress');
    jest.advanceTimersByTime(2001);
    Object.assign(world.navigator.connection, { downlink: 0 });
    video.dispatch('progress');
    expect(rec.of('onBandwidth')).toEqual([]);
  });
});

describe('seeking', () => {
  it('waits for the metadata when the element is not ready', () => {
    driver.open(open(MP4));
    const video = world.video();
    driver.seek(30);
    expect(video.currentTime).toBe(0);
    video.becomeReady(120);
    expect(video.currentTime).toBe(30);
  });

  it('lands a scrub on the nearest keyframe where the browser can, an exact seek on the frame', () => {
    setup({ fastSeek: true });
    driver.open(open(MP4));
    const video = world.video();
    video.becomeReady(120);
    driver.seek(30);
    expect(video.fastSeeks).toEqual([30]);
    driver.seek(45, true);
    expect(video.fastSeeks).toEqual([30]);
    expect(video.currentTime).toBe(45);
  });

  it('sets the time where the browser has no fast seek', () => {
    driver.open(open(MP4));
    const video = world.video();
    video.becomeReady(120);
    driver.seek(30);
    expect(video.currentTime).toBe(30);
  });

  it('does nothing where the element already is', () => {
    setup({ fastSeek: true });
    driver.open(open(MP4));
    const video = world.video();
    video.becomeReady(120);
    video.currentTime = 30;
    driver.seek(30.005);
    expect(video.fastSeeks).toEqual([]);
    expect(video.currentTime).toBe(30);
  });

  it('starts at the position the engine asked for', () => {
    driver.open(open(MP4, { startPosition: 50 }));
    const video = world.video();
    video.becomeReady(120);
    expect(video.currentTime).toBe(50);
  });

  it('does not start a file at its end when the start is past the length it says: it waits for a longer one', () => {
    driver.open(open(MP4, { startPosition: 500 }));
    const video = world.video();
    video.becomeReady(120);
    expect(video.currentTime).toBe(0);
  });
});

describe('the browser’s own controls', () => {
  function playing() {
    driver.open(open(MP4, { playWhenReady: true }));
    const video = world.video();
    video.becomeReady(120);
    video.startPlaying();
    return video;
  }

  it('pausing is the user’s pause', () => {
    const video = playing();
    video.controls = true;
    video.currentTime = 42;
    video.pause();
    expect(rec.of('onUserCommand')).toEqual([[1, 'pause', 42]]);
    expect(rec.of('onPausedExternally')).toEqual([]);
  });

  it('pausing without them is the system’s', () => {
    const video = playing();
    video.pause();
    expect(rec.of('onPausedExternally')).toEqual([[1, 'system']]);
    expect(rec.of('onUserCommand')).toEqual([]);
  });

  it('playing is the user’s play, when RNAP did not ask', () => {
    driver.open(open(MP4));
    const video = world.video();
    video.controls = true;
    video.currentTime = 7;
    video.dispatch('play');
    expect(rec.of('onUserCommand')).toEqual([[1, 'play', 7]]);

    driver.play();
    video.dispatch('play');
    expect(rec.of('onUserCommand')).toHaveLength(1);
  });

  it('ignores their play without controls', () => {
    driver.open(open(MP4));
    world.video().dispatch('play');
    expect(rec.of('onUserCommand')).toEqual([]);
  });

  it('seeking is the user’s seek, but not the one RNAP made', () => {
    const video = playing();
    video.controls = true;
    driver.seek(60, true);
    video.dispatch('seeking');
    expect(rec.of('onUserCommand')).toEqual([]);

    video.currentTime = 100;
    video.dispatch('seeking');
    expect(rec.of('onUserCommand')).toEqual([[1, 'seek', 100]]);
  });

  it('treats a seek near the last one as RNAP’s only for a few seconds', () => {
    const video = playing();
    video.controls = true;
    driver.seek(60, true);
    video.currentTime = 61;
    video.dispatch('seeking');
    expect(rec.of('onUserCommand')).toEqual([]);

    jest.advanceTimersByTime(3001);
    video.dispatch('seeking');
    expect(rec.of('onUserCommand')).toEqual([[1, 'seek', 61]]);
  });

  it('ignores a seek of the element without them', () => {
    const video = playing();
    video.currentTime = 100;
    video.dispatch('seeking');
    expect(rec.of('onUserCommand')).toEqual([]);
  });

  it('is fine for a player that listens to no user commands', () => {
    setup({}, {}, false);
    const video = playing();
    video.controls = true;
    video.dispatch('seeking');
    video.pause();
    video.dispatch('play');
    expect(rec.of('onPausedExternally')).toEqual([]);
  });
});

describe('a Matroska, WebM or MPEG-TS file', () => {
  it('is remuxed in the page, the picture muxed too', async () => {
    driver.open(open(MKV));
    expect(driver.isStreamed).toBe(true);
    expect(world.video().src).toBe('');
    await flush();
    const remux = FakeRemuxStream.last();
    expect(remux).toMatchObject({
      format: 'matroska',
      withVideo: true,
      started: true,
    });
    expect(remux.source.uri).toBe(MKV);
    expect(remux.element).toBe(world.video());
  });

  it('is remuxed without the picture for a sound player', async () => {
    const audio = new MediaElementDriver(rec.observer, 'artist-title');
    audio.open(
      open('https://cdn.example/song.mka', {}, 1, { liveHint: false })
    );
    await flush();
    expect(FakeRemuxStream.last()).toMatchObject({
      format: 'matroska',
      withVideo: false,
    });
  });

  it.each([
    ['https://cdn.example/clip.mk3d?token=1', 'matroska'],
    ['https://cdn.example/clip.webm', 'matroska'],
    ['https://cdn.example/live/channel.ts', 'mpegts'],
    ['https://cdn.example/live/channel.m2ts#t=1', 'mpegts'],
  ])(
    '%s is remuxed as %s where the browser does not play it',
    async (uri, format) => {
      driver.open(open(uri));
      await flush();
      expect(FakeRemuxStream.last().format).toBe(format);
    }
  );

  it('is left to the element where the browser plays it', async () => {
    setup({ mimeTypes: ['video/webm', 'video/mp2t'] });
    driver.open(open('https://cdn.example/clip.webm'));
    driver.open(open('https://cdn.example/channel.ts', {}, 2));
    await flush();
    expect(FakeRemuxStream.instances).toEqual([]);
    expect(world.video().src).toBe('https://cdn.example/channel.ts');
  });

  it('is left to the element where there is no Media Source Extensions', async () => {
    setup({}, { mediaSource: 'none' });
    driver.open(open(MKV));
    await flush();
    expect(FakeRemuxStream.instances).toEqual([]);
    expect(world.video().src).toBe(MKV);
  });

  it('starts playing once the remuxer is loaded, when asked to play meanwhile', async () => {
    driver.open(open(MKV, { playWhenReady: true }));
    expect(world.video().plays).toBe(0);
    await flush();
    expect(world.video().plays).toBe(1);
  });

  it('is not started for an item that was replaced while the remuxer loaded', async () => {
    driver.open(open(MKV));
    driver.open(open(MP4, {}, 2));
    await flush();
    expect(FakeRemuxStream.instances).toEqual([]);
    expect(world.video().src).toBe(MP4);
  });

  it('takes its length and liveness from the remuxer', async () => {
    driver.open(open(MKV, { startPosition: 90 }));
    await flush();
    FakeRemuxStream.last().info = {
      duration: 7200,
      isLive: false,
      seekable: true,
    };
    world.video().becomeReady(7200);
    expect(rec.of('onReady')).toEqual([
      [1, { duration: 7200, isLive: false, seekable: true }],
    ]);
    expect(world.video().currentTime).toBe(90);
  });

  it('shows the file’s own audio and subtitles as tracks', async () => {
    driver.open(open(MKV));
    await flush();
    const remux = FakeRemuxStream.last();
    remux.audioTracks = [{ name: 'English', lang: 'en', default: true }];
    remux.subtitleTracks = [{ name: 'Forced', lang: 'en', forced: true }];
    remux.listener.onTracks?.();
    expect(rec.of('onTracks').pop()).toEqual([
      1,
      [
        expect.objectContaining({
          id: 'track:a:0',
          kind: 'audio',
          language: 'en',
        }),
        expect.objectContaining({
          id: 'track:t:0',
          kind: 'subtitles',
          forced: true,
        }),
      ],
    ]);
  });

  it('reports what the remuxer reports', async () => {
    driver.open(open(MKV));
    await flush();
    const { listener } = FakeRemuxStream.last();
    const error = engineError('UNSUPPORTED_FORMAT', 'no sound', false);
    listener.onNote('remux', { a: 'b' });
    listener.onWarning?.(error);
    listener.onFailure(error);
    expect(rec.of('onNote')).toContainEqual([1, 'remux', { a: 'b' }]);
    expect(rec.of('onWarning')).toEqual([[1, error]]);
    expect(rec.of('onFailed')).toEqual([[1, error]]);
  });

  it('is fine for a player that listens to no warnings', async () => {
    setup({}, {}, false);
    driver.open(open(MKV));
    await flush();
    const { listener } = FakeRemuxStream.last();
    expect(() =>
      listener.onWarning?.(engineError('UNSUPPORTED_FORMAT', 'no sound', false))
    ).not.toThrow();
  });

  it('is not heard once the item is gone', async () => {
    driver.open(open(MKV));
    await flush();
    const remux = FakeRemuxStream.last();
    driver.open(open(MP4, {}, 2));
    expect(remux.closed).toBe(true);
    rec.calls.length = 0;
    remux.listener.onNote('remux', {});
    remux.listener.onWarning?.(engineError('UNSUPPORTED_FORMAT', 'x', false));
    remux.listener.onFailure(engineError('UNSUPPORTED_FORMAT', 'x', false));
    remux.listener.onTracks?.();
    remux.listener.onFallback('CORS');
    expect(rec.calls).toEqual([]);
  });

  it('plays on the element as it is when the server does not allow reading it', async () => {
    driver.open(open(MKV, { playWhenReady: true }));
    await flush();
    const remux = FakeRemuxStream.last();
    remux.listener.onFallback('the server does not allow CORS');
    expect(remux.closed).toBe(true);
    expect(rec.of('onNote')).toContainEqual([
      1,
      'plain playback',
      { reason: 'the server does not allow CORS' },
    ]);
    expect(world.video().src).toBe(MKV);
    expect(world.video().plays).toBe(2);
    expect(FakeRemuxStream.instances).toHaveLength(1);

    // Opened again: not remuxed again, until the source is another.
    driver.open(open(MKV, {}, 2));
    await flush();
    expect(FakeRemuxStream.instances).toHaveLength(1);
    driver.open(open('https://cdn.example/other.mkv', {}, 3));
    await flush();
    expect(FakeRemuxStream.instances).toHaveLength(2);
  });

  it('is read for a failure the remuxer already reported, not twice', async () => {
    driver.open(open(MKV));
    await flush();
    const remux = FakeRemuxStream.last();
    remux.failed = true;
    world.video().fail(4);
    expect(rec.of('onFailed')).toEqual([]);
  });
});

describe('a source the element cannot open', () => {
  const CHANNEL = 'https://iptv.example/live/channel-42';

  async function fails(uri: string, code = 4) {
    driver.open(open(uri, { playWhenReady: true }));
    world.video().fail(code, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
  }

  it('is sniffed and remuxed when its address does not say what it is', async () => {
    await fails(CHANNEL);
    const remux = FakeRemuxStream.last();
    expect(remux.format).toBeNull();
    expect(remux.source.uri).toBe(CHANNEL);
    expect(world.video().src).toBe('');
    expect(rec.of('onNote')).toContainEqual([
      1,
      'remux',
      { reason: 'the element could not open the source' },
    ]);
    expect(failures()).toEqual([]);
    expect(world.video().plays).toBe(2);
  });

  it('is sniffed for a picked file too', async () => {
    await fails('blob:https://app.example/9');
    expect(FakeRemuxStream.last().format).toBeNull();
  });

  it('is only tried once: the next failure is the item\u2019s', async () => {
    await fails(CHANNEL);
    world.video().fail(4);
    expect(FakeRemuxStream.instances).toHaveLength(1);
    expect(failures()).toMatchObject([{ code: 'UNSUPPORTED_FORMAT' }]);
  });

  it('is a failure when the address names a format the element should play', async () => {
    await fails(MP4);
    expect(FakeRemuxStream.instances).toEqual([]);
    expect(failures()).toMatchObject([{ code: 'UNSUPPORTED_FORMAT' }]);
  });

  it('is a failure after its metadata too, on the element alone (#58)', async () => {
    driver.open(open(MP4, { playWhenReady: true }));
    world.video().becomeReady(120);
    world.video().fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    expect(failures()).toMatchObject([
      { code: 'UNSUPPORTED_FORMAT', recoverable: false },
    ]);
  });

  it('is a failure when something already played', async () => {
    driver.open(open(CHANNEL, { playWhenReady: true }));
    const video = world.video();
    video.startPlaying();
    video.fail(4);
    await flush();
    expect(FakeRemuxStream.instances).toEqual([]);
    expect(failures()).toHaveLength(1);
  });

  it('is a failure without Media Source Extensions', async () => {
    setup({}, { mediaSource: 'none' });
    await fails(CHANNEL);
    expect(FakeRemuxStream.instances).toEqual([]);
    expect(failures()).toHaveLength(1);
  });

  it('is a failure for an address the page cannot read', async () => {
    await fails('file:///movies/channel-42');
    expect(FakeRemuxStream.instances).toEqual([]);
    expect(failures()).toHaveLength(1);
  });

  it('is a failure for any other error of the element', async () => {
    await fails(CHANNEL, 3);
    expect(FakeRemuxStream.instances).toEqual([]);
    expect(failures()).toMatchObject([{ code: 'DECODER_ERROR' }]);
  });

  it('is nothing when the load was aborted', async () => {
    await fails(CHANNEL, 1);
    expect(failures()).toEqual([]);
    expect(FakeRemuxStream.instances).toEqual([]);
  });

  it('is nothing without an error to read', async () => {
    driver.open(open(CHANNEL));
    world.video().dispatch('error');
    expect(failures()).toEqual([]);
  });
});

describe('HLS', () => {
  async function openHls(extra: Partial<OpenRequest> = {}) {
    await flush();
    driver.open(open(HLS, extra));
    return { video: world.video(), hls: RichHls.last() };
  }

  it('reports a code 4 after the metadata as a pipeline failure to re-open (#58)', async () => {
    const { video, hls } = await openHls({ playWhenReady: true });
    hls.level(false, 90);
    video.becomeReady(90);
    video.fail(4, 'Failed to push buffer');
    await flush();
    expect(failures()).toMatchObject([
      { code: 'DECODER_ERROR', recoverable: true },
    ]);
  });

  it('reports a code 4 before the metadata as a format it cannot play (#58)', async () => {
    const { video } = await openHls({ playWhenReady: true });
    video.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');
    await flush();
    expect(failures()).toMatchObject([
      { code: 'UNSUPPORTED_FORMAT', recoverable: false },
    ]);
  });

  it('plays with hls.js where the element has no HLS', async () => {
    const { video, hls } = await openHls();
    expect(hls.source).toBe(HLS);
    expect(hls.media).toBe(video);
    expect(video.src).toBe('');
    expect(rec.of('onNote')).toContainEqual([
      1,
      'hls.js',
      { reason: 'no native HLS' },
    ]);
    expect(driver.isStreamed).toBe(true);
  });

  it('plays with hls.js on a native HLS that lists no tracks (Chromium)', async () => {
    setup({}, { nativeHls: true });
    await openHls();
    expect(RichHls.instances).toHaveLength(1);
    expect(world.video().src).toBe('');
  });

  it('plays natively where the element lists its tracks (Safari)', async () => {
    setup(
      {
        audioTracks: [
          { id: '1', kind: 'main', label: 'English', language: 'en' },
        ],
      },
      { nativeHls: true }
    );
    await flush();
    driver.open(open(HLS));
    expect(RichHls.instances).toEqual([]);
    expect(world.video().src).toBe(HLS);
    expect(driver.isStreamed).toBe(false);
  });

  it('plays natively on a native HLS when there is no hls.js to be better', async () => {
    setup({}, { nativeHls: true });
    FakeHls.supported = false;
    await flush();
    driver.open(open(HLS));
    expect(RichHls.instances).toEqual([]);
    expect(world.video().src).toBe(HLS);
  });

  it('fails when hls.js cannot run in this browser', async () => {
    FakeHls.supported = false;
    await openHls();
    await flush();
    expect(failures()).toMatchObject([
      {
        code: 'UNSUPPORTED_FORMAT',
        recoverable: false,
        message: expect.stringContaining('hls.js is not supported'),
      },
    ]);
    expect(RichHls.instances).toEqual([]);
  });

  it('fails, saying how to get it, when there is no hls.js', async () => {
    configureHls(null);
    await flush();
    driver.open(open(HLS));
    await flush();
    expect(failures()).toMatchObject([
      {
        code: 'UNSUPPORTED_FORMAT',
        recoverable: false,
        message: expect.stringContaining('configureHls'),
      },
    ]);
  });

  it('fails as a recoverable error when hls.js cannot start', async () => {
    configureHls(asHls(BrokenHls));
    await flush();
    driver.open(open(HLS));
    await flush();
    expect(failures()).toMatchObject([
      {
        code: 'UNSUPPORTED_FORMAT',
        recoverable: true,
        message: expect.stringContaining('worker blocked'),
      },
    ]);
  });

  it('reports the qualities, the level playing, and the bandwidth', async () => {
    const { video, hls } = await openHls();
    hls.parse([
      { height: 360, bitrate: 800_000 },
      { height: 1080, bitrate: 6_000_000 },
    ]);
    expect(rec.of('onVariants')).toEqual([
      [
        1,
        [
          {
            id: 'v0',
            height: 360,
            bitrate: 800_000,
            audioOnly: false,
            label: null,
          },
          {
            id: 'v1',
            height: 1080,
            bitrate: 6_000_000,
            audioOnly: false,
            label: null,
          },
        ],
      ],
    ]);
    hls.fragment(3_000_000);
    expect(rec.of('onBandwidth')).toEqual([[1, 3_000_000]]);

    hls.switched(1);
    expect(rec.of('onVideoInfo')).toEqual([]);
    video.size(1920, 1080);
    hls.switched(1);
    expect(rec.of('onVideoInfo')).toEqual([
      [1, { width: 1920, height: 1080, hdr: false, variantId: 'v1' }],
    ]);
    video.dispatch('resize');
    expect(rec.of('onVideoInfo').pop()).toEqual([
      1,
      { width: 1920, height: 1080, hdr: false, variantId: 'v1' },
    ]);
  });

  it('measures no bandwidth of its own: hls.js has one', async () => {
    const { video } = await openHls();
    Object.assign(world.navigator.connection, { downlink: 5 });
    video.dispatch('progress');
    expect(rec.of('onBandwidth')).toEqual([]);
  });

  it('holds the quality caps the engine set, before and after hls.js started', async () => {
    const caps = {
      maxHeight: 360,
      maxBitrate: null,
      pinned: null,
      audioOnly: false,
    };
    driver.setQuality(caps);
    const { hls } = await openHls();
    hls.parse([{ height: 360 }, { height: 1080 }]);
    expect(hls.autoLevelCapping).toBe(0);
    driver.setQuality({ ...caps, maxHeight: 1080 });
    expect(hls.autoLevelCapping).toBe(1);
  });

  it('shows its audio and subtitle renditions as tracks, and plays the engine’s picks', async () => {
    const { hls } = await openHls();
    driver.selectTracks('track:a:1', 'track:t:0');
    hls.renditions(
      [
        { name: 'English', lang: 'en', default: true },
        { name: 'Deutsch', lang: 'de' },
      ],
      [{ name: 'English', lang: 'en' }]
    );
    expect(rec.of('onTracks').pop()).toEqual([
      1,
      [
        expect.objectContaining({
          id: 'track:a:0',
          label: 'English',
          default: true,
        }),
        expect.objectContaining({ id: 'track:a:1', label: 'Deutsch' }),
        expect.objectContaining({ id: 'track:t:0', kind: 'subtitles' }),
      ],
    ]);
    expect(hls.audioTrack).toBe(1);
    expect(hls.subtitleTrack).toBe(0);
    driver.selectTracks('track:a:0', null);
    expect(hls.audioTrack).toBe(0);
    expect(hls.subtitleTrack).toBe(-1);
  });

  it('plays the picks made before the item opened', async () => {
    driver.selectTracks('track:a:1', null);
    const { hls } = await openHls();
    hls.renditions([{ name: 'English' }, { name: 'Deutsch' }], []);
    expect(hls.audioTrack).toBe(1);
  });

  it('hands timed metadata to the player when it is heard', async () => {
    const { video, hls } = await openHls({ playWhenReady: true });
    hls.emit(RichHls.Events.FRAG_PARSING_METADATA, {
      samples: [
        {
          pts: 5,
          data: id3TextTag(4, [{ id: 'TIT2', encoding: 3, text: 'Song' }]),
        },
      ],
    });
    expect(rec.of('onStreamMetadata')).toEqual([]);
    video.currentTime = 5;
    video.dispatch('timeupdate');
    expect(rec.of('onStreamMetadata')).toEqual([
      [1, expect.objectContaining({ title: 'Song' })],
    ]);
  });

  it('hands timed metadata to the player at the moment it is heard, while playing', async () => {
    const { video, hls } = await openHls({ playWhenReady: true });
    video.becomeReady(Number.POSITIVE_INFINITY);
    video.startPlaying();
    hls.emit(RichHls.Events.FRAG_PARSING_METADATA, {
      samples: [
        {
          pts: 5,
          data: id3TextTag(4, [{ id: 'TIT2', encoding: 3, text: 'Song' }]),
        },
      ],
    });
    jest.advanceTimersByTime(4999);
    expect(rec.of('onStreamMetadata')).toEqual([]);
    video.currentTime = 5;
    jest.advanceTimersByTime(1);
    expect(rec.of('onStreamMetadata')).toHaveLength(1);
  });

  it('reads whether it is live, and how far behind, from the playlist', async () => {
    const { video, hls } = await openHls();
    hls.level(true);
    hls.latency = 4;
    video.becomeReady(Number.POSITIVE_INFINITY);
    expect(rec.of('onReady')).toEqual([
      [1, { duration: null, isLive: true, seekable: false }],
    ]);
    expect(driver.progress()).toMatchObject({ duration: null, liveOffset: 4 });
  });

  it('reads the length of a recording from the playlist', async () => {
    const { video, hls } = await openHls();
    hls.level(false, 3600);
    video.becomeReady(3600);
    expect(rec.of('onReady')).toEqual([
      [1, { duration: 3600, isLive: false, seekable: true }],
    ]);
    expect(driver.progress()).toMatchObject({
      duration: 3600,
      liveOffset: null,
    });
  });

  it('reports a fatal error once, and ignores the element’s echo of it', async () => {
    const { video, hls } = await openHls();
    hls.fatal(RichHls.ErrorTypes.NETWORK_ERROR, 'levelLoadError', 503);
    video.fail(3);
    expect(failures()).toMatchObject([
      { code: 'NETWORK_ERROR', recoverable: true },
    ]);
    expect(hls.destroyed).toBe(true);
  });

  it('reports a fatal media error as recoverable, and a non-fatal one not at all', async () => {
    const { hls } = await openHls();
    hls.hiccup();
    expect(failures()).toEqual([]);
    hls.fatal(RichHls.ErrorTypes.MEDIA_ERROR);
    expect(failures()).toMatchObject([
      { code: 'DECODER_ERROR', recoverable: true },
    ]);
  });

  it('is not heard once the item is gone', async () => {
    const { hls } = await openHls();
    driver.open(open(MP4, {}, 2));
    expect(hls.destroyed).toBe(true);
    rec.calls.length = 0;
    hls.parse([{ height: 360 }]);
    hls.switched(0);
    hls.fragment(1_000_000);
    hls.renditions([{ name: 'English' }], []);
    hls.emit(RichHls.Events.FRAG_PARSING_METADATA, {
      samples: [
        {
          pts: 0,
          data: id3TextTag(4, [{ id: 'TIT2', encoding: 3, text: 'x' }]),
        },
      ],
    });
    expect(rec.calls).toEqual([]);
  });

  it('is fine for a player that listens to no video events', async () => {
    setup({}, {}, false);
    await flush();
    driver.open(open(HLS));
    const hls = RichHls.last();
    world.video().size(640, 360);
    expect(() => {
      hls.parse([{ height: 360 }]);
      hls.switched(0);
      hls.fragment(1_000_000);
      world.video().dispatch('loadeddata');
      world.video().dispatch('progress');
    }).not.toThrow();
  });

  it('starts playing once hls.js is loaded, when asked to play meanwhile', async () => {
    setup();
    configureHls(null);
    configureHls(asHls(RichHls));
    driver.open(open(HLS, { playWhenReady: true }));
    await flush();
    expect(RichHls.instances).toHaveLength(1);
    expect(world.video().plays).toBe(1);
  });
});

describe('DASH', () => {
  async function openDash(extra: Partial<OpenRequest> = {}) {
    driver.open(open(MPD, extra));
    await flush();
    return { video: world.video(), dash: FakeDashStream.last() };
  }

  it('plays with Shaka, from where the engine said', async () => {
    world.video().src = MP4;
    const { video, dash } = await openDash({ startPosition: 30 });
    expect(dash.starts).toEqual([30]);
    expect(dash.source.uri).toBe(MPD);
    expect(dash.element).toBe(video);
    expect(video.src).toBe('');
    expect(rec.of('onNote')).toContainEqual([1, 'shaka', { reason: 'DASH' }]);
    expect(driver.isStreamed).toBe(true);
  });

  it('fails, saying how to get Shaka, when there is none', async () => {
    configureShaka(null);
    driver.open(open(MPD));
    await flush();
    expect(failures()).toMatchObject([
      {
        code: 'UNSUPPORTED_FORMAT',
        recoverable: false,
        message: expect.stringContaining('configureShaka'),
      },
    ]);
  });

  it('fails when Shaka cannot run in this browser', async () => {
    configureShaka(fakeShaka(false));
    driver.open(open(MPD));
    await flush();
    expect(failures()).toMatchObject([
      {
        code: 'UNSUPPORTED_FORMAT',
        recoverable: false,
        message: expect.stringContaining('Shaka Player is not supported'),
      },
    ]);
    expect(FakeDashStream.instances).toEqual([]);
  });

  it('waits for the manifest before it plays', async () => {
    const { video, dash } = await openDash({ playWhenReady: true });
    expect(video.plays).toBe(0);
    dash.listener.onLoaded?.();
    expect(video.plays).toBe(1);
  });

  it('does not play after the manifest unless asked to', async () => {
    const { video, dash } = await openDash();
    dash.listener.onLoaded?.();
    expect(video.plays).toBe(0);
  });

  it('is not started for an item that was replaced while Shaka loaded', async () => {
    driver.open(open(MPD));
    driver.open(open(MP4, {}, 2));
    await flush();
    expect(FakeDashStream.instances).toEqual([]);
  });

  it('holds the quality caps the engine set, before and after Shaka started', async () => {
    const caps = {
      maxHeight: 720,
      maxBitrate: null,
      pinned: null,
      audioOnly: false,
    };
    driver.setQuality(caps);
    const { dash } = await openDash();
    expect(dash.qualities).toEqual([caps]);
    driver.setQuality({ ...caps, maxHeight: 360 });
    expect(dash.qualities).toHaveLength(2);
  });

  it('takes its length and liveness from Shaka', async () => {
    const { video, dash } = await openDash();
    dash.info = { duration: null, isLive: true, seekable: false };
    video.becomeReady(Number.POSITIVE_INFINITY);
    expect(rec.of('onReady')).toEqual([
      [1, { duration: null, isLive: true, seekable: false }],
    ]);
  });

  it('reports what Shaka reports', async () => {
    const { video, dash } = await openDash();
    const { listener } = dash;
    const error = engineError('NETWORK_ERROR', 'down', true);
    listener.onNote('shaka', { a: 'b' });
    listener.onVariants?.([
      { id: 'v0', height: 360, bitrate: 1, audioOnly: false, label: null },
    ]);
    listener.onBandwidth?.(2_000_000);
    listener.onVariantSwitched?.('v0');
    expect(rec.of('onVideoInfo')).toEqual([]);
    video.size(640, 360);
    listener.onVariantSwitched?.('v0');
    dash.audioTracks = [{ name: 'English', lang: 'en' }];
    listener.onTracks?.();
    listener.onFailure(error);
    expect(rec.of('onNote')).toContainEqual([1, 'shaka', { a: 'b' }]);
    expect(rec.of('onVariants')).toHaveLength(1);
    expect(rec.of('onBandwidth')).toEqual([[1, 2_000_000]]);
    expect(rec.of('onVideoInfo')).toEqual([
      [1, { width: 640, height: 360, hdr: false, variantId: 'v0' }],
    ]);
    expect(rec.of('onTracks').pop()).toEqual([
      1,
      [expect.objectContaining({ id: 'track:a:0' })],
    ]);
    expect(rec.of('onFailed')).toEqual([[1, error]]);
  });

  it('turns a license request into an event for the app, and takes its answer', async () => {
    const { dash } = await openDash();
    const license = dash.listener.requestLicense!({
      keySystem: 'widevine',
      challenge: new Uint8Array([1, 2]),
      contentId: null,
      licenseUrl: 'https://lic.example/wv',
      headers: {},
    });
    const [[generation, event]] = rec.of('onLicenseRequest') as [
      [number, { requestId: number; keySystem: string }],
    ];
    expect(generation).toBe(1);
    expect(event).toMatchObject({ keySystem: 'widevine', challenge: 'AQI=' });
    answerLicense({
      op: 'license',
      requestId: event.requestId,
      license: 'AwQ=',
    });
    await expect(license).resolves.toEqual(new Uint8Array([3, 4]));
  });

  it('is fine for a player that listens to no video events', async () => {
    setup({}, {}, false);
    driver.open(open(MPD));
    await flush();
    const { listener } = FakeDashStream.last();
    world.video().size(640, 360);
    expect(() => {
      listener.onVariants?.([]);
      listener.onBandwidth?.(1);
      listener.onVariantSwitched?.('v0');
      listener.onLoaded?.();
    }).not.toThrow();
  });

  it('is not heard once the item is gone', async () => {
    const { dash } = await openDash();
    driver.open(open(MP4, {}, 2));
    expect(dash.closed).toBe(true);
    rec.calls.length = 0;
    const { listener } = dash;
    listener.onNote('shaka', {});
    listener.onVariants?.([]);
    listener.onBandwidth?.(1);
    listener.onVariantSwitched?.('v0');
    listener.onTracks?.();
    listener.onLoaded?.();
    listener.onFailure(engineError('NETWORK_ERROR', 'down', true));
    expect(rec.calls).toEqual([]);
  });

  it('ignores the element’s echo of a failure Shaka reported', async () => {
    const { video, dash } = await openDash();
    dash.failed = true;
    video.fail(3);
    expect(failures()).toEqual([]);
  });

  it('leaves its keys to Shaka: protected or not, the element gets no license of RNAP’s', async () => {
    const eme = new FakeEme(['org.w3.clearkey']);
    Object.assign(world.navigator, {
      requestMediaKeySystemAccess: eme.requestMediaKeySystemAccess,
    });
    driver.open(
      open(MPD, {}, 1, {
        drm: {
          clearkey: { keys: null, licenseUrl: 'https://l', headers: {} },
          hook: false,
        },
      })
    );
    await flush();
    expect(FakeDashStream.instances).toHaveLength(1);
    expect(eme.requested).toEqual([]);
  });
});

describe('protected content', () => {
  const KID = 'a7e61c373e219033c21091fa607bf3b8';
  const KEY = '76a6c65c5ea762046bd749a2e632ccbb';
  const b64url = (hex: string) => Buffer.from(hex, 'hex').toString('base64url');
  const clearKey: DrmDescriptor = {
    clearkey: { keys: { [KID]: KEY }, licenseUrl: null, headers: {} },
    hook: false,
  };

  function withEme(granted = ['org.w3.clearkey']) {
    setup({ mediaKeys: true });
    const eme = new FakeEme(granted);
    Object.assign(world.navigator, {
      requestMediaKeySystemAccess: eme.requestMediaKeySystemAccess,
    });
    return eme;
  }

  it('gets its keys attached before the element is given the source', async () => {
    const eme = withEme();
    driver.open(open(MP4, { playWhenReady: true }, 1, { drm: clearKey }));
    const video = world.video();
    expect(video.src).toBe('');
    expect(video.plays).toBe(0);
    await flush();

    expect(video.keys).toBe(eme.keys);
    expect(video.src).toBe(MP4);
    expect(video.plays).toBe(1);
    expect(rec.of('onNote')).toContainEqual([
      1,
      'drm',
      { keySystem: 'org.w3.clearkey' },
    ]);
    expect(eme.sessions).toHaveLength(1);
    expect(eme.sessions[0]!.requests[0]!.type).toBe('keyids');
  });

  it('answers the key system’s challenge with a license made from the source’s keys', async () => {
    const eme = withEme();
    driver.open(open(MP4, {}, 1, { drm: clearKey }));
    await flush();
    const session = eme.sessions[0]!;
    session.challenge(
      new TextEncoder().encode(
        JSON.stringify({ kids: [b64url(KID)], type: 'temporary' })
      )
    );
    await flush();
    expect(JSON.parse(Buffer.from(session.licenses[0]!).toString())).toEqual({
      keys: [{ kty: 'oct', kid: b64url(KID), k: b64url(KEY) }],
      type: 'temporary',
    });
  });

  it('asks the app for the license when it answers license requests itself', async () => {
    const eme = withEme(['com.widevine.alpha']);
    driver.open(
      open(MP4, {}, 1, {
        drm: {
          widevine: {
            licenseUrl: 'https://lic.example/wv',
            headers: { A: 'b' },
          },
          hook: true,
        },
      })
    );
    await flush();
    expect(eme.sessions).toHaveLength(0);
    world.video().dispatch('encrypted', {
      initDataType: 'cenc',
      initData: new Uint8Array([9, 9]).buffer,
    });
    const session = eme.sessions[0]!;
    session.challenge(new Uint8Array([7, 7]));
    await flush();
    const [[, event]] = rec.of('onLicenseRequest') as [
      [
        number,
        {
          requestId: number;
          challenge: string;
          headers: Record<string, string>;
        },
      ],
    ];
    expect(event).toMatchObject({
      keySystem: 'widevine',
      licenseUrl: 'https://lic.example/wv',
      headers: { A: 'b' },
      challenge: 'Bwc=',
    });
    answerLicense({
      op: 'license',
      requestId: event.requestId,
      license: 'AQ==',
    });
    await flush();
    expect(Array.from(session.licenses[0]!)).toEqual([1]);
  });

  it('is refused where the browser has no Encrypted Media Extensions', async () => {
    driver.open(open(MP4, { playWhenReady: true }, 1, { drm: clearKey }));
    await flush();
    expect(failures()).toMatchObject([
      { code: 'DRM_UNSUPPORTED', recoverable: false },
    ]);
    expect(world.video().src).toBe('');
    expect(world.video().plays).toBe(0);
  });

  it('is refused where the browser has none of the key systems the source uses', async () => {
    withEme([]);
    driver.open(open(MP4, {}, 1, { drm: clearKey }));
    await flush();
    expect(failures()).toMatchObject([
      {
        code: 'DRM_UNSUPPORTED',
        message: expect.stringContaining('none of the key systems'),
      },
    ]);
    expect(world.video().src).toBe('');
  });

  it('lets go of its keys with the item', async () => {
    const eme = withEme();
    driver.open(open(MP4, {}, 1, { drm: clearKey }));
    await flush();
    const video = world.video();
    driver.open(open('https://cdn.example/other.mp4', {}, 2));
    expect(eme.sessions[0]!.closed).toBe(true);
    expect(video.keys).toBeNull();
  });

  it('is dropped, with nothing played, when the item is replaced while the keys are set up', async () => {
    withEme();
    driver.open(open(MP4, { playWhenReady: true }, 1, { drm: clearKey }));
    driver.open(open('https://cdn.example/other.mp4', {}, 2));
    await flush();
    expect(world.video().src).toBe('https://cdn.example/other.mp4');
    expect(rec.of('onNote').filter((n) => n[1] === 'drm')).toEqual([]);
  });

  it('refuses an encrypted stream that came with no DRM', () => {
    driver.open(open(MP4));
    world.video().dispatch('encrypted');
    expect(failures()).toMatchObject([
      {
        code: 'DRM_UNSUPPORTED',
        recoverable: false,
        message: expect.stringContaining('encrypted'),
      },
    ]);
  });

  it('does not refuse an encrypted stream that has DRM, or Shaka to decrypt it', async () => {
    withEme();
    driver.open(open(MP4, {}, 1, { drm: clearKey }));
    await flush();
    world
      .video()
      .dispatch('encrypted', { initDataType: 'cenc', initData: null });
    driver.open(open(MPD, {}, 2));
    await flush();
    world.video().dispatch('encrypted');
    expect(failures()).toEqual([]);
  });
});

describe('playing', () => {
  it.each([
    ['block', 'blocked'],
    ['fail', 'failed'],
    ['abort', 'started'],
    ['start', 'started'],
  ] as const)(
    'an element that %ss is a play that %s',
    async (behavior, attempt) => {
      driver.open(open(MP4));
      world.video().playBehavior = behavior;
      driver.play();
      await expect(driver.lastPlayAttempt).resolves.toBe(attempt);
    }
  );

  it('a refused play tells the player the autoplay policy paused it', async () => {
    driver.open(open(MP4));
    world.video().playBehavior = 'block';
    driver.play();
    await driver.lastPlayAttempt;
    expect(rec.of('onPausedExternally')).toEqual([[1, 'autoplay-blocked']]);
  });

  it('a refusal of a play that was replaced is not reported', async () => {
    driver.open(open(MP4));
    const video = world.video();
    video.playBehavior = 'defer';
    driver.play();
    const first = driver.lastPlayAttempt;
    video.playBehavior = 'start';
    driver.play();
    video.pendingPlays[0]!.reject(
      Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
    );
    await expect(first).resolves.toBe('started');
    expect(rec.of('onPausedExternally')).toEqual([]);
  });

  it('a play of an element that throws is a failed one', async () => {
    driver.open(open(MP4));
    world.video().playBehavior = 'throw';
    driver.play();
    await expect(driver.lastPlayAttempt).resolves.toBe('failed');
  });
});

describe('pausing', () => {
  it('is the engine\u2019s own, not the system\u2019s or the user\u2019s', () => {
    driver.open(open(MP4, { playWhenReady: true }));
    const video = world.video();
    video.controls = true;
    video.becomeReady(120);
    video.startPlaying();
    driver.pause();
    expect(video.paused).toBe(true);
    expect(rec.of('onPausedExternally')).toEqual([]);
    expect(rec.of('onUserCommand')).toEqual([]);
  });
});

describe('releasing', () => {
  it('releaseConnection and unload empty the element, unload forgets the source', () => {
    driver.open(open(MP4, { playWhenReady: true }));
    const video = world.video();
    video.startPlaying();
    driver.releaseConnection();
    expect(video.src).toBe('');
    expect(video.paused).toBe(true);
    driver.open(open(MP4));
    driver.unload();
    expect(video.src).toBe('');
    expect(driver.isStreamed).toBe(false);
  });

  it('destroy empties the element and closes the stream engine', async () => {
    driver.open(open(MKV));
    await flush();
    const remux = FakeRemuxStream.last();
    driver.destroy();
    expect(remux.closed).toBe(true);
    expect(world.video().src).toBe('');
  });

  it('a stream\u2019s remote playback restriction is lifted for the next item', () => {
    const video = world.video();
    video.disableRemotePlayback = true;
    driver.open(open(MP4));
    expect(video.disableRemotePlayback).toBe(false);
  });
});

describe('the source\u2019s own tracks', () => {
  const tracks = {
    audioTracks: [
      { id: '1', kind: 'main', label: 'English', language: 'en' },
      { id: '2', kind: 'description', label: 'Described', language: 'en' },
    ],
    textTracks: [
      ['subtitles', 'English', 'en'],
      ['captions', 'English CC', 'en'],
      ['metadata', 'Chapters', ''],
    ] as Array<[string, string, string]>,
  };

  it('are listed with the engine\u2019s picks applied', () => {
    setup(tracks);
    driver.selectTracks('track:a:1', 'track:t:1');
    driver.open(open(MP4));
    const video = world.video();
    expect(rec.of('onTracks').pop()).toEqual([
      1,
      [
        expect.objectContaining({
          id: 'track:a:0',
          kind: 'audio',
          default: true,
        }),
        expect.objectContaining({ id: 'track:a:1', describesVideo: true }),
        expect.objectContaining({ id: 'track:t:0', kind: 'subtitles' }),
        expect.objectContaining({
          id: 'track:t:1',
          kind: 'captions',
          sdh: true,
        }),
      ],
    ]);
    expect(video.audioTracks![1]!.enabled).toBe(true);
    expect(video.textTracks![0]!.mode).toBe('disabled');
    expect(video.textTracks![1]!.mode).toBe('hidden');
    driver.selectTracks('track:a:0', 'track:t:0');
    expect(video.audioTracks![0]!.enabled).toBe(true);
    expect(video.textTracks![0]!.mode).toBe('hidden');
    expect(video.textTracks![1]!.mode).toBe('disabled');
  });

  it('send the cues of the text track that is on to the player', () => {
    setup(tracks);
    driver.open(open(MP4));
    driver.selectTracks(null, 'track:t:0');
    world
      .video()
      .textTracks![0]!.showCues([
        { startTime: 1, endTime: 2.5, text: 'Hello' },
      ]);
    const [generation, cues] = rec.of('onSourceCues').pop()!;
    expect(generation).toBe(1);
    expect(cues).toEqual([
      expect.objectContaining({ start: 1, end: 2.5, text: 'Hello' }),
    ]);
  });

  it('are listed again when the element adds one', () => {
    setup(tracks);
    driver.open(open(MP4));
    world.video().audioTracks!.add({
      id: '3',
      kind: 'translation',
      label: 'Deutsch',
      language: 'de',
      enabled: false,
    });
    const [, list] = rec.of('onTracks').pop()!;
    expect(list).toHaveLength(5);
  });

  it('of an item that was replaced are no longer reported', () => {
    setup(tracks);
    driver.open(open(MP4));
    const video = world.video();
    driver.open(open('https://cdn.example/other.mp4', {}, 2));
    rec.calls.length = 0;
    video.audioTracks!.add({
      id: '3',
      kind: 'translation',
      label: 'Deutsch',
      language: 'de',
      enabled: false,
    });
    expect(rec.of('onTracks').every((a) => a[0] === 2)).toBe(true);
  });
});

describe('native HLS that fails', () => {
  it('is tried with hls.js before anything played', async () => {
    setup(
      {
        audioTracks: [
          { id: '1', kind: 'main', label: 'English', language: 'en' },
        ],
      },
      { nativeHls: true }
    );
    await flush();
    driver.open(open(HLS, { playWhenReady: true }));
    const video = world.video();
    expect(video.src).toBe(HLS);
    video.fail(4);
    await flush();
    expect(RichHls.last().source).toBe(HLS);
    expect(video.src).toBe('');
    expect(rec.of('onNote')).toContainEqual([
      1,
      'hls.js',
      { reason: 'native HLS could not open the source' },
    ]);
    expect(failures()).toEqual([]);
    expect(video.plays).toBe(2);
  });

  it('is a failure when there is no hls.js to try', async () => {
    setup(
      {
        audioTracks: [
          { id: '1', kind: 'main', label: 'English', language: 'en' },
        ],
      },
      { nativeHls: true }
    );
    FakeHls.supported = false;
    await flush();
    driver.open(open(HLS));
    world.video().fail(4);
    expect(failures()).toHaveLength(1);
    expect(RichHls.instances).toEqual([]);
  });
});

describe('an element on a Web Audio tap', () => {
  it('is replaced by a fresh one for a network source the tap cannot read', () => {
    driver.setVolume(0.4);
    driver.setRate(1.25);
    const old = world.video();
    driver.tapped = true;
    driver.open(open(MP4));
    const fresh = world.video();
    expect(fresh).not.toBe(old);
    expect(driver.element).toBe(fresh);
    expect(fresh.volume).toBe(0.4);
    expect(fresh.playbackRate).toBe(1.25);
    expect(fresh.src).toBe(MP4);
    expect(driver.tapped).toBe(false);
    expect(rec.of('onElementReplaced')).toEqual([[fresh]]);
  });

  it('is kept for a page-held file, and for hls.js, whose audio is same-origin', async () => {
    const old = world.video();
    driver.tapped = true;
    driver.open(open('blob:https://app.example/3'));
    expect(driver.element).toBe(old);
    await flush();
    driver.open(open(HLS, {}, 2));
    expect(driver.element).toBe(old);
    expect(rec.of('onElementReplaced')).toEqual([]);
  });
});

describe('readings', () => {
  it('say where the picture is and how far it is buffered', () => {
    driver.open(open(MP4, { playWhenReady: true }));
    const video = world.video();
    video.becomeReady(120);
    video.startPlaying();
    video.currentTime = 20;
    video.plainBuffered = ranges([[0, 50]]);
    video.playbackRate = 2;
    expect(driver.sample()).toEqual({ position: 20, bufferedPosition: 50 });
    expect(driver.progress()).toEqual({
      position: 20,
      duration: 120,
      buffered: 50,
      liveOffset: null,
      isPlaying: true,
      rate: 2,
    });
  });

  it('are at the start while the element has no position', () => {
    world.video().currentTime = Number.NaN;
    expect(driver.sample()).toEqual({ position: 0, bufferedPosition: 0 });
  });
});
