/// <reference types="node" />
// WebPlayerController for a video player: the stage and its two <video>
// elements, the `videoCommand`s from `Player`, what the driver reports (the
// picture, the tracks, the browser's own controls, warnings, license requests)
// and what the Cast receiver is given.

import type { CastService } from '../platform/CastService';
import type { PlayerRuntime } from '../platform/WebPlayerController';
import { WebPlayerController } from '../platform/WebPlayerController';
import {
  NO_FIELDS,
  parseOptions,
  type VideoLoadParts,
} from '../platform/serialization';
import { SwapDriver } from '../platform/SwapDriver';
import { vttCue } from '../../core/subtitles/vtt';
import { engineError } from '../engine/types';
import type { SourceDescriptor } from '../engine/types';
import { liveBlobUrls, uninstall } from './FakeBrowser';
import { requestLicense } from '../platform/licenseRequests';
import {
  FakeBox,
  installVideo,
  type FakeVideo,
  type FakeVideoWorld,
} from './FakeVideo';

type Event = Record<string, unknown> & { type: string };

const MP4 = 'https://cdn.example/movie.mp4';

const TRACKS = {
  audioTracks: [
    { id: '1', kind: 'main', label: 'English', language: 'en' },
    { id: '2', kind: 'alternative', label: 'Deutsch', language: 'de' },
  ],
  textTracks: [['subtitles', 'English', 'en']] as Array<
    [string, string, string]
  >,
};

let world: FakeVideoWorld;
let events: Event[];
let runtime: PlayerRuntime & {
  statuses: number;
  loads: Array<[SourceDescriptor, boolean | null]>;
};
let controller: WebPlayerController;
let castMedia: (() => unknown) | null;

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}

const ofType = (type: string) => events.filter((e) => e.type === type);

const source = (extra: Partial<SourceDescriptor> = {}): SourceDescriptor => ({
  uri: MP4,
  headers: {},
  liveHint: null,
  ...extra,
});

function makeRuntime(cast: boolean) {
  const r = {
    statuses: 0,
    loads: [] as Array<[SourceDescriptor, boolean | null]>,
    cast: {
      parts: cast
        ? {
            CastDriver: class {
              constructor(
                _observer: unknown,
                _nowPlaying: unknown,
                _service: unknown,
                media: () => unknown
              ) {
                castMedia = media;
              }
              setVolume() {}
              setRate() {}
              unload() {}
              releaseConnection() {}
              dispose() {}
            },
          }
        : null,
    } as unknown as CastService,
    onStatusChanged: () => {
      r.statuses += 1;
    },
    onNowPlayingChanged: () => undefined,
    beforeLoad: (
      _controller: WebPlayerController,
      s: SourceDescriptor,
      autoplay: boolean | null
    ) => {
      r.loads.push([s, autoplay]);
    },
    onOutputsChanged: () => undefined,
  };
  return r;
}

function setup(
  options: unknown = { video: true },
  features: Parameters<typeof installVideo>[1] = {},
  cast = false
) {
  controller?.release();
  world = installVideo({}, features);
  events = [];
  castMedia = null;
  runtime = makeRuntime(cast);
  controller = new WebPlayerController(
    'p1',
    parseOptions(options),
    runtime,
    (event) => events.push(event as Event)
  );
}

/** Loads a file and plays it from 10 s. */
async function playing(
  parts: VideoLoadParts | null = null,
  src: Partial<SourceDescriptor> = {}
): Promise<FakeVideo> {
  const loading = controller.load(
    source(src),
    NO_FIELDS,
    true,
    null,
    null,
    parts
  );
  loading.catch(() => undefined);
  const video = world.videos[0]!;
  video.becomeReady(src.liveHint ? Number.POSITIVE_INFINITY : 120);
  video.currentTime = 10;
  video.startPlaying();
  await flush();
  await loading;
  return video;
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  setup();
});

afterEach(() => {
  controller.release();
  uninstall();
  jest.useRealTimers();
});

describe('a video player', () => {
  it('shows its <video> on the stage, driven through the swap driver', () => {
    const video = world.video();
    expect(controller.video).not.toBeNull();
    expect(controller.driver).toBeInstanceOf(SwapDriver);
    expect(controller.element()).toBe(video);
    expect(video.parentNode).toBe(controller.video!.stage);
    expect(video.style).toMatchObject({
      position: 'absolute',
      visibility: 'visible',
    });
  });

  it('plays the file loaded, reporting the picture in its status', async () => {
    const video = world.video();
    video.size(1920, 1080);
    await playing();
    expect(controller.status.state).toBe('playing');
    expect(controller.status.video).toMatchObject({
      width: 1920,
      height: 1080,
      firstFrame: false,
    });
    video.dispatch('loadeddata');
    expect(controller.status.video!.firstFrame).toBe(true);
    expect(controller.statusMap()).toMatchObject({ state: 'playing' });
    expect(runtime.loads).toEqual([[source(), true]]);
    expect(ofType('status').length).toBeGreaterThan(0);
  });

  it('is an audio player without `video`: <audio> elements, no stage', () => {
    setup({});
    expect(controller.video).toBeNull();
    expect(world.videos).toEqual([]);
    expect(() => controller.attachVideo(new FakeBox())).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
    expect(() => controller.videoCommand({ op: 'setListenOnly' })).toThrow(
      'This is not a video player'
    );
    // Qualities are any player's: nothing to pick from is automatic already.
    expect(() =>
      controller.videoCommand({ op: 'selectQuality', id: null })
    ).not.toThrow();
  });

  it('puts the picture in the page element it is attached to', () => {
    const container = new FakeBox();
    controller.attachVideo(container, 'cover', true);
    expect(container.children).toEqual([controller.video!.stage]);
    expect(world.video().style.objectFit).toBe('cover');
    expect(world.video().controls).toBe(true);
    controller.attachVideo(null);
    expect(container.children).toEqual([]);
  });

  it('shows the poster until the first frame', async () => {
    await playing({
      poster: 'https://cdn.example/poster.jpg',
      session: null,
      subtitles: [],
    });
    expect(world.video().poster).toBe('https://cdn.example/poster.jpg');
  });

  it('counts the dropped frames and the bandwidth in its stats', async () => {
    const video = await playing();
    expect(controller.statsMap()).toMatchObject({
      droppedFrames: null,
      bandwidth: null,
    });
    Object.assign(video, {
      getVideoPlaybackQuality: () => ({ droppedVideoFrames: 7 }),
    });
    controller.onBandwidth(controller.engine.generation, 4_000_000);
    expect(controller.statsMap()).toMatchObject({ droppedFrames: 7 });
    expect(controller.statsMap().bandwidth).not.toBeNull();
  });

  it('does not tap a <video> for the visualizer', async () => {
    await playing();
    controller.userGesture();
    expect(controller.setAudioSampling(true, 64)).toBe(true);
    expect(controller.driver.tapped).toBe(false);
  });

  it('is released with its elements emptied and its stage taken off the page', async () => {
    const container = new FakeBox();
    controller.attachVideo(container);
    const video = await playing();
    controller.release();
    expect(video.src).toBe('');
    expect(container.children).toEqual([]);
  });
});

describe('the player', () => {
  it('hands over the refused or started play of the last command, once', async () => {
    controller.load(source(), NO_FIELDS, true, null).catch(() => undefined);
    const attempt = controller.takePlayAttempt();
    await expect(attempt).resolves.toBe('started');
    expect(controller.takePlayAttempt()).toBeNull();
  });

  it('reports its progress at the interval the app asked for, while playing', async () => {
    setup({ video: true, progressInterval: 1000 });
    await playing();
    const ticks = () => ofType('progress').length;
    const before = ticks();
    await jest.advanceTimersByTimeAsync(2500);
    expect(ticks() - before).toBe(2);
    expect(ofType('progress').at(-1)).toMatchObject({ position: 10 });
    world.videos[0]!.pause();
    await flush();
    const paused = ticks();
    await jest.advanceTimersByTimeAsync(2500);
    expect(ticks()).toBe(paused);
  });

  it('frees a picked file\u2019s object URL when the item goes', async () => {
    const url = URL.createObjectURL(new Blob(['x']));
    controller
      .load(source({ uri: url }), NO_FIELDS, true, null, url)
      .catch(() => undefined);
    expect(liveBlobUrls()).toEqual([url]);
    const other = URL.createObjectURL(new Blob(['y']));
    controller
      .load(source({ uri: other }), NO_FIELDS, true, null, other)
      .catch(() => undefined);
    expect(liveBlobUrls()).toEqual([other]);
    controller.reset();
    expect(liveBlobUrls()).toEqual([]);
    expect(controller.status.state).toBe('idle');
  });

  it('shows the app\u2019s fields over the source\u2019s for the media session', async () => {
    await playing();
    controller
      .load(
        source(),
        { ...NO_FIELDS, title: 'Movie', artist: 'Studio' },
        true,
        null
      )
      .catch(() => undefined);
    expect(controller.nowPlaying()).toMatchObject({
      title: 'Movie',
      artist: 'Studio',
      track: null,
    });
    controller.updateNowPlaying({
      ...NO_FIELDS,
      title: 'Cut',
      duration: 90,
      elapsed: 30,
    });
    expect(controller.nowPlaying()).toMatchObject({
      title: 'Cut',
      artist: 'Studio',
      track: { duration: 90, elapsed: 30 },
    });
  });
});

describe('what the element does', () => {
  it('buffers, plays again and ends', async () => {
    const video = await playing();
    video.dispatch('waiting');
    await jest.advanceTimersByTimeAsync(600);
    expect(controller.status.state).toBe('buffering');
    video.dispatch('playing');
    expect(controller.status.state).toBe('playing');
    video.dispatch('ended');
    expect(controller.status.state).toBe('ended');
    expect(ofType('ended')).toHaveLength(1);
  });

  it('fails with the error the browser reports', async () => {
    const video = await playing();
    video.fail(3, 'DECODE');
    expect(ofType('error').at(-1)).toMatchObject({
      fatal: expect.any(Boolean),
      error: expect.objectContaining({ code: 'DECODER_ERROR' }),
    });
  });

  it('is paused by the system', async () => {
    const video = await playing();
    video.pause();
    expect(controller.status.interruption).toMatchObject({ reason: 'system' });
    expect(controller.status.playWhenReady).toBe(false);
  });

  it('is told of a refused autoplay as the browser\u2019s interruption', async () => {
    const video = world.videos[0]!;
    video.playBehavior = 'block';
    controller.load(source(), NO_FIELDS, true, null).catch(() => undefined);
    video.becomeReady(120);
    await expect(controller.takePlayAttempt()).resolves.toBe('blocked');
    expect(controller.status.interruption).toMatchObject({
      reason: 'autoplay-blocked',
    });
    expect(controller.status.playWhenReady).toBe(false);
  });

  it('notes a splice and a note of the driver in the diagnostics', async () => {
    const debug = jest
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);
    await playing();
    controller.diagnosticsEnabled = true;
    const g = controller.engine.generation;
    controller.onNote(g, 'hls.js', { reason: 'test' });
    controller.onDiscontinuity(g, 12);
    controller.onDiscontinuity(g + 5, 13);
    expect(controller.diagnosticsArray()).toContainEqual(
      expect.objectContaining({ event: 'hls.js' })
    );
    expect(ofType('diagnostic')).toHaveLength(1);
    expect(ofType('discontinuity')).toEqual([
      expect.objectContaining({ position: 12 }),
    ]);
    expect(debug).toHaveBeenCalledTimes(1);
    controller.diagnosticsEnabled = false;
    debug.mockRestore();
  });
});

describe('remote commands', () => {
  it('forwards a media key the app opted into, with its position when it has one', () => {
    controller.emitRemoteCommand('seekforward', 15);
    controller.emitRemoteCommand('nexttrack');
    expect(ofType('remoteCommand')).toEqual([
      expect.objectContaining({ command: 'seekforward', position: 15 }),
      expect.objectContaining({ command: 'nexttrack' }),
    ]);
    expect(ofType('remoteCommand')[1]).not.toHaveProperty('position');
  });
});

describe('the video commands', () => {
  it('loops, seeks and refreshes the source', async () => {
    const video = await playing(null, { refreshable: true });
    controller.videoCommand({ op: 'loop', value: true });
    expect(video.loop).toBe(true);
    controller.videoCommand({ op: 'loop', value: false });
    expect(video.loop).toBe(false);

    controller.videoCommand({ op: 'seek', position: 60, exact: true });
    expect(video.currentTime).toBe(60);
    controller.videoCommand({ op: 'seek', position: 80 });
    expect(video.currentTime).toBe(80);

    const loadId = controller.engine.loadId;
    controller.engine.onFailed(
      controller.engine.generation,
      engineError('HTTP_ERROR', 'forbidden', false, { httpStatus: 403 })
    );
    expect(ofType('refreshRequest')).toEqual([
      expect.objectContaining({ loadId, reason: 'unauthorized' }),
    ]);
    controller.videoCommand({
      op: 'refreshed',
      loadId,
      source: { uri: 'https://cdn.example/fresh.mp4', headers: {} },
    });
    expect(video.src).toBe('https://cdn.example/fresh.mp4');
    controller.videoCommand({ op: 'refreshFailed', loadId });
  });

  it('hands the app\u2019s license to the request that waits for it', async () => {
    await playing();
    let requestId = -1;
    const license = requestLicense((event) => (requestId = event.requestId), {
      keySystem: 'clearkey',
      challenge: new Uint8Array([1]),
      contentId: null,
      licenseUrl: null,
      headers: {},
    });
    controller.videoCommand({ op: 'license', requestId, license: 'AQI=' });
    await expect(license).resolves.toEqual(new Uint8Array([1, 2]));
  });

  it('picks the audio and subtitle tracks the source lists', async () => {
    setup({ video: true }, TRACKS);
    await playing();
    expect(controller.status.video!.tracks.map((t) => t.id)).toEqual([
      'track:a:0',
      'track:a:1',
      'track:t:0',
    ]);
    controller.videoCommand({ op: 'selectAudioTrack', id: 'track:a:1' });
    expect(controller.status.video!.audioTrack).toBe('track:a:1');
    expect(world.video().audioTracks![1]!.enabled).toBe(true);
    controller.videoCommand({ op: 'selectTextTrack', id: 'track:t:0' });
    expect(controller.status.video!.textTrack).toBe('track:t:0');
    controller.videoCommand({ op: 'selectTextTrack' });
    expect(controller.status.video!.textTrack).toBeNull();
    controller.videoCommand({ op: 'selectQuality', id: null });
    expect(controller.status.selectedQuality).toBeNull();
  });

  it('delays the subtitles and listens to the sound alone', async () => {
    await playing();
    controller.videoCommand({ op: 'subtitleDelay', seconds: 1.5 });
    expect(controller.status.video!.subtitleDelay).toBe(1.5);
    controller.videoCommand({ op: 'listenOnly', value: true });
    expect(controller.status.video!.audioOnly).toBe('listen');
    controller.videoCommand({ op: 'listenOnly', value: false });
    expect(controller.status.video!.audioOnly).toBeNull();
  });

  it('adds subtitle files next to the app’s, keeping the source’s own tracks out of the list', async () => {
    setup({ video: true }, TRACKS);
    await playing({
      poster: null,
      session: 's1',
      subtitles: [
        {
          id: 'en',
          kind: 'subtitles',
          language: 'en',
          label: 'English',
          forced: false,
          default: false,
          sdh: false,
          describesVideo: false,
        },
      ],
    });
    controller.videoCommand({
      op: 'addSubtitles',
      tracks: [
        { id: 'fr', kind: 'captions', language: 'fr', label: 'Français' },
      ],
    });
    expect(controller.status.video!.tracks.map((t) => t.id)).toEqual([
      'track:a:0',
      'track:a:1',
      'track:t:0',
      'en',
      'fr',
    ]);
    expect(controller.status.video!.tracks.at(-1)).toMatchObject({
      kind: 'captions',
      sdh: true,
    });
  });

  it('draws the cues of a subtitle file it was given', async () => {
    await playing({
      poster: null,
      session: 's1',
      subtitles: [
        {
          id: 'en',
          kind: 'subtitles',
          language: 'en',
          label: 'English',
          forced: false,
          default: false,
          sdh: false,
          describesVideo: false,
        },
      ],
    });
    const cues = [vttCue(0, 20_000, '', 'Hello')!];
    controller.videoCommand({
      op: 'cues',
      session: 'other',
      trackId: 'en',
      cues,
    });
    controller.videoCommand({ op: 'cues', session: 's1', trackId: 'en', cues });
    controller.videoCommand({ op: 'selectTextTrack', id: 'en' });
    expect(ofType('cues').at(-1)).toMatchObject({ cues });
  });

  it('goes fullscreen and into Picture in Picture inside the gesture', async () => {
    const video = await playing();
    const stage = controller.video!.stage as unknown as FakeBox & {
      requestFullscreen?: () => Promise<void>;
    };
    let fullscreens = 0;
    stage.requestFullscreen = () => {
      fullscreens += 1;
      return Promise.resolve();
    };
    let pips = 0;
    Object.assign(video, {
      requestPictureInPicture: () => {
        pips += 1;
        return Promise.resolve({});
      },
    });
    await controller.videoCommand({ op: 'fullscreen', active: true });
    await controller.videoCommand({
      op: 'fullscreen',
      active: true,
      lockOrientation: 'landscape',
    });
    await controller.videoCommand({ op: 'fullscreen', active: false });
    await controller.videoCommand({ op: 'pictureInPicture', active: true });
    await controller.videoCommand({ op: 'pictureInPicture', active: false });
    expect([fullscreens, pips]).toEqual([2, 1]);
  });

  it('refuses fullscreen and Picture in Picture a browser does not have', async () => {
    await playing();
    await expect(
      controller.videoCommand({ op: 'fullscreen', active: true })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(
      controller.videoCommand({ op: 'pictureInPicture', active: true })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('refuses a command it does not know', () => {
    expect(() => controller.videoCommand({ op: 'rewind' })).toThrow(
      'Unknown video command "rewind"'
    );
  });
});

describe('what the driver reports', () => {
  it('passes the picture, the variants and the bandwidth to the engine', async () => {
    await playing();
    const g = controller.engine.generation;
    controller.onVideoInfo(g, {
      width: 1280,
      height: 720,
      hdr: true,
      variantId: 'v2',
    });
    controller.onVariants(g, [
      { id: 'v1', height: 360, bitrate: 1, audioOnly: false, label: null },
      { id: 'v2', height: 720, bitrate: 2, audioOnly: false, label: null },
    ]);
    controller.onFirstFrame(g);
    expect(controller.status.video).toMatchObject({
      width: 1280,
      height: 720,
      hdr: true,
      firstFrame: true,
    });
    expect(controller.status.quality).toBe('v2');
    expect(controller.status.qualities.map((q) => q.id)).toEqual(['v1', 'v2']);
  });

  it('passes the source’s tracks and cues on', async () => {
    setup({ video: true }, TRACKS);
    await playing();
    const g = controller.engine.generation;
    controller.videoCommand({ op: 'selectTextTrack', id: 'track:t:0' });
    const cues = [vttCue(0, 5000, '', 'Hi')!];
    controller.onSourceCues(g, cues);
    expect(ofType('cues').at(-1)).toMatchObject({ cues });
    controller.onSourceCues(g + 1, []);
    expect(ofType('cues').at(-1)).toMatchObject({ cues });
    controller.onTracks(g, []);
    expect(controller.status.video!.tracks).toEqual([]);
  });

  it('treats the browser’s own controls as the user’s commands', async () => {
    const video = await playing();
    video.controls = true;
    video.pause();
    expect(controller.status.playWhenReady).toBe(false);

    video.dispatch('play');
    expect(controller.status.playWhenReady).toBe(true);
    video.currentTime = 90;
    video.dispatch('seeking');
    expect(video.currentTime).toBe(90);
  });

  it('ignores a user command of an item that is gone', async () => {
    await playing();
    const g = controller.engine.generation;
    controller.onUserCommand(g + 5, 'pause', 0);
    expect(controller.status.playWhenReady).toBe(true);
  });

  it('keeps going when a user command cannot be carried out', async () => {
    await playing(null, { liveHint: true });
    const g = controller.engine.generation;
    expect(() => controller.onUserCommand(g, 'seek', 5)).not.toThrow();
    expect(controller.status.state).toBe('playing');
  });

  it('reports a warning as an error that is not fatal', async () => {
    await playing();
    const g = controller.engine.generation;
    const warning = engineError(
      'UNSUPPORTED_FORMAT',
      'No sound: AC-3 is not supported.',
      false
    );
    controller.onWarning(g, warning);
    expect(ofType('error')).toEqual([
      expect.objectContaining({
        fatal: false,
        error: expect.objectContaining({ code: 'UNSUPPORTED_FORMAT' }),
      }),
    ]);
    expect(controller.status.state).toBe('playing');
    controller.onWarning(g + 5, warning);
    expect(ofType('error')).toHaveLength(1);
  });

  it('asks the app for a license', async () => {
    await playing();
    const g = controller.engine.generation;
    const request = {
      requestId: 3,
      keySystem: 'widevine' as const,
      challenge: 'AQI=',
      contentId: null,
      licenseUrl: 'https://lic.example/wv',
      headers: {},
    };
    controller.onLicenseRequest(g, request);
    controller.onLicenseRequest(g + 5, request);
    expect(ofType('licenseRequest')).toEqual([
      expect.objectContaining({ playerId: 'p1', ...request }),
    ]);
  });

  it('asks the app for a fresh source when the engine wants one', () => {
    controller.engineRequestsSourceRefresh(4, 'expiring');
    expect(ofType('refreshRequest')).toEqual([
      expect.objectContaining({ loadId: 4, reason: 'expiring' }),
    ]);
  });

  it('keeps the stream metadata a source gives', async () => {
    setup({});
    const loading = controller.load(
      source({ liveHint: true }),
      NO_FIELDS,
      true,
      null
    );
    loading.catch(() => undefined);
    expect(controller.streamMetadata).toBeNull();
    const g = controller.engine.generation;
    controller.onStreamMetadata(g, {
      title: 'Song',
      artist: 'Artist',
      album: null,
      station: null,
      genre: null,
      artworkUri: null,
      raw: { StreamTitle: 'Artist - Song' },
    });
    expect(controller.streamMetadata).toMatchObject({ title: 'Song' });
    expect(ofType('metadata')).toHaveLength(1);
  });
});

describe('the Cast receiver', () => {
  const track = (
    id: string,
    kind: 'subtitles' | 'captions',
    label: string
  ) => ({
    id,
    kind,
    language: 'en',
    label,
    forced: false,
    default: false,
    sdh: kind === 'captions',
    describesVideo: false,
  });

  it('is given the app’s subtitle files whose cues loaded, as WebVTT', async () => {
    setup({ video: true }, TRACKS, true);
    await playing({
      poster: null,
      session: 's1',
      subtitles: [
        track('en', 'subtitles', 'English'),
        track('cc', 'captions', 'English CC'),
        track('late', 'subtitles', 'Not loaded yet'),
      ],
    });
    controller.videoCommand({
      op: 'cues',
      session: 's1',
      trackId: 'en',
      cues: [vttCue(1000, 2500, '', 'Hello')!],
    });
    controller.videoCommand({
      op: 'cues',
      session: 's1',
      trackId: 'cc',
      cues: [vttCue(0, 1000, '', 'Door slams')!],
    });
    controller.videoCommand({ op: 'selectTextTrack', id: 'cc' });
    controller.routing.switchOutput('cast:tv');

    const media = castMedia!() as {
      video: boolean;
      textTrack: string | null;
      subtitles: Array<{
        id: string;
        kind: string;
        label: string;
        vtt: string;
      }>;
    };
    expect(media.video).toBe(true);
    expect(media.textTrack).toBe('cc');
    expect(media.subtitles.map((s) => [s.id, s.kind, s.label])).toEqual([
      ['en', 'subtitles', 'English'],
      ['cc', 'captions', 'English CC'],
    ]);
    expect(media.subtitles[0]!.vtt).toContain('00:00:01.000 --> 00:00:02.500');
    expect(media.subtitles[0]!.vtt).toContain('Hello');
  });

  it('shifts the cues by the subtitle delay', async () => {
    setup({ video: true }, {}, true);
    await playing({
      poster: null,
      session: 's1',
      subtitles: [track('en', 'subtitles', 'English')],
    });
    controller.videoCommand({
      op: 'cues',
      session: 's1',
      trackId: 'en',
      cues: [vttCue(1000, 2000, '', 'Hello')!],
    });
    controller.videoCommand({ op: 'subtitleDelay', seconds: 2 });
    controller.routing.switchOutput('cast:tv');
    const media = castMedia!() as { subtitles: Array<{ vtt: string }> };
    expect(media.subtitles[0]!.vtt).toContain('00:00:03.000 --> 00:00:04.000');
  });

  it('is given a sound player’s media without a picture', () => {
    setup({}, {}, true);
    controller.routing.switchOutput('cast:tv');
    expect(castMedia!()).toEqual({
      video: false,
      subtitles: [],
      textTrack: null,
    });
  });
});
