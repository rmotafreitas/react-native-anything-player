/// <reference types="node" />
// DASH through an injected Shaka Player (`DashStream`, on a scripted Shaka):
// loading the manifest, the pictures and quality caps, the audio and text
// tracks, Shaka's errors as RNAP's, the app's license through the
// `rnap-license:` scheme (answered, failing and timing out), and closing.

import type { PlayerError } from '../../errors';
import type { ShakaError } from '../../core/shaka';
import type { DrmDescriptor, SourceDescriptor } from '../engine/types';
import type { DashListener } from '../platform/DashStream';
import { requestLicense } from '../platform/licenseRequests';
import { FakeEncryptedVideo } from './FakeEme';
import { FakeShaka, track, type FakeShakaOptions } from './FakeShaka';

type DashModule = typeof import('../platform/DashStream');

let dash: DashModule;

const URI = 'https://cdn.example/show/manifest.mpd';
const CHALLENGE = new Uint8Array([9, 8, 7]);
const LICENSE = new Uint8Array([5, 6]);
const LICENSE_REQUEST = 2;

const WIDEVINE = {
  licenseUrl: 'https://lic.example/wv',
  headers: { 'X-Token': 'abc' },
};

const drmOf = (parts: Partial<DrmDescriptor>): DrmDescriptor => ({
  hook: false,
  ...parts,
});

const sourceOf = (parts: Partial<SourceDescriptor> = {}): SourceDescriptor => ({
  uri: URI,
  headers: {},
  liveHint: null,
  ...parts,
});

function listenerOf() {
  const listener = {
    onFailure: jest.fn(),
    onNote: jest.fn(),
    onVariants: jest.fn(),
    onVariantSwitched: jest.fn(),
    onBandwidth: jest.fn(),
    onTracks: jest.fn(),
    onLoaded: jest.fn(),
    requestLicense: jest.fn(
      async (_request: unknown): Promise<Uint8Array> => LICENSE
    ),
  };
  return listener satisfies DashListener;
}

interface Options extends FakeShakaOptions {
  source?: Partial<SourceDescriptor>;
  listener?: ReturnType<typeof listenerOf>;
  shaka?: FakeShaka;
  startTime?: number | null;
}

/** A stream on a fresh Shaka, not started. */
function unstarted(options: Options = {}) {
  const shaka = options.shaka ?? new FakeShaka(options);
  const listener = options.listener ?? listenerOf();
  const element = new FakeEncryptedVideo();
  const stream = new dash.DashStream(
    element,
    sourceOf(options.source),
    shaka.namespace,
    listener
  );
  return { stream, shaka, listener, element };
}

/** A stream on a fresh Shaka, started (the manifest loaded unless Shaka fails). */
async function started(options: Options = {}) {
  const { stream, shaka, listener, element } = unstarted(options);
  const starting = stream.start(options.startTime ?? null);
  const instance = shaka.last();
  await starting;
  return { stream, shaka, listener, element, player: () => instance };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  jest.isolateModules(() => {
    dash = require('../platform/DashStream');
  });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("Shaka's errors as RNAP's", () => {
  const error = (
    category: number,
    code: number,
    data?: unknown[]
  ): ShakaError => ({ severity: 2, category, code, data });

  test.each([
    [404, 'SOURCE_NOT_FOUND', false],
    [410, 'SOURCE_NOT_FOUND', false],
    [500, 'HTTP_ERROR', true],
    [503, 'HTTP_ERROR', true],
    [429, 'HTTP_ERROR', true],
    [403, 'HTTP_ERROR', false],
  ])('HTTP %i is %s, recoverable: %s', (status, code, recoverable) => {
    const failure = dash.shakaFailure(error(1, 1001, ['uri', status]));
    expect(failure).toMatchObject({
      code,
      recoverable,
      httpStatus: status,
      platformDomain: 'shaka',
      platformCode: 1001,
      message: `The server returned HTTP ${status}.`,
    });
  });

  test('a network error without a status is a recoverable NETWORK_ERROR', () => {
    expect(dash.shakaFailure(error(1, 1002))).toMatchObject({
      code: 'NETWORK_ERROR',
      recoverable: true,
      platformCode: 1002,
    });
    // A bad status that does not carry its number is the same.
    expect(dash.shakaFailure(error(1, 1001, ['uri']))).toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  test('a media error is a recoverable DECODER_ERROR', () => {
    expect(dash.shakaFailure(error(3, 3016))).toMatchObject({
      code: 'DECODER_ERROR',
      recoverable: true,
      nativeCause: 'category 3, code 3016',
    });
  });

  test('a manifest Shaka cannot read is UNSUPPORTED_FORMAT, not recoverable', () => {
    expect(dash.shakaFailure(error(4, 4001))).toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      recoverable: false,
      platformDomain: 'shaka',
    });
  });
});

describe('the pictures a manifest offers', () => {
  test('one per video id, the lowest bandwidth of each, lowest first', () => {
    const pictures = dash.picturesOf([
      track({ id: 1, videoId: 2, height: 1080, bandwidth: 5_000_000 }),
      track({ id: 2, videoId: 2, height: 1080, bandwidth: 4_000_000 }),
      track({ id: 3, videoId: 1, height: 480, bandwidth: 900_000 }),
      track({ id: 4, videoId: null, height: 240 }),
      track({ id: 5, videoId: 3, height: null, bandwidth: undefined }),
    ]);
    expect(pictures).toEqual([
      { id: 'v3', height: null, bitrate: null, audioOnly: false, label: null },
      {
        id: 'v1',
        height: 480,
        bitrate: 900_000,
        audioOnly: false,
        label: null,
      },
      {
        id: 'v2',
        height: 1080,
        bitrate: 4_000_000,
        audioOnly: false,
        label: null,
      },
    ]);
  });

  test('a variant without a bandwidth does not displace one that has it', () => {
    const pictures = dash.picturesOf([
      track({ id: 1, videoId: 1, bandwidth: undefined }),
      track({ id: 2, videoId: 1, bandwidth: 700_000 }),
    ]);
    expect(pictures).toHaveLength(1);
    expect(pictures[0]!.bitrate).toBeNull();
  });
});

describe('loading', () => {
  test('it attaches the element, loads the manifest at the start time and reports it', async () => {
    const variants = [
      track({ id: 1, videoId: 1, height: 480, active: true }),
      track({ id: 2, videoId: 2, height: 1080 }),
    ];
    const { stream, listener, element, player } = await started({
      startTime: 42,
      variants,
      textVisibility: true,
    });
    expect(player().attached).toBe(element);
    expect(player().loaded).toEqual({ uri: URI, startTime: 42 });
    expect(player().textVisibility).toEqual([false]);
    expect(player().config('streaming')).toEqual({ alwaysStreamText: true });
    expect(listener.onNote).toHaveBeenCalledWith('dash manifest', {
      variants: '2',
    });
    expect(listener.onVariants).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'v1', height: 480 }),
      expect.objectContaining({ id: 'v2', height: 1080 }),
    ]);
    expect(listener.onVariantSwitched).toHaveBeenCalledWith('v1');
    expect(listener.onTracks).toHaveBeenCalledTimes(1);
    expect(listener.onLoaded).toHaveBeenCalledTimes(1);
    expect(listener.onFailure).not.toHaveBeenCalled();
    expect(stream.failed).toBe(false);
  });

  test('a live manifest is not seekable and has no duration', async () => {
    const { stream, player, element } = await started();
    expect(stream.live).toBe(false);
    player().live = true;
    expect(stream.live).toBe(true);
    expect(stream.readyInfo()).toEqual({
      duration: null,
      isLive: true,
      seekable: false,
    });
    expect(element.duration).toBeNaN();
  });

  test("a file's duration is read from the element once the manifest is loaded", async () => {
    const { stream, element } = await started();
    expect(stream.readyInfo()).toBeNull();
    element.duration = 3600;
    expect(stream.readyInfo()).toEqual({
      duration: 3600,
      isLive: false,
      seekable: true,
    });
    element.duration = Infinity;
    expect(stream.readyInfo()).toBeNull();
  });

  test('nothing is known before the manifest loads, or after closing', async () => {
    const { stream } = unstarted();
    expect(stream.live).toBeNull();
    expect(stream.readyInfo()).toBeNull();
    await stream.start(null);
    stream.close();
    expect(stream.live).toBeNull();
    expect(stream.readyInfo()).toBeNull();
  });

  test('the polyfills are installed once, with the first player', async () => {
    const shaka = new FakeShaka();
    await started({ shaka });
    await started({ shaka });
    expect(shaka.players).toHaveLength(2);
    expect(shaka.polyfills).toBe(1);
  });

  test('a Shaka without polyfills still plays', async () => {
    const { listener } = await started({ noPolyfill: true });
    expect(listener.onLoaded).toHaveBeenCalledTimes(1);
  });

  test("the source's headers go on every request", async () => {
    const { player } = await started({
      source: { headers: { 'Authorization': 'Bearer t', 'X-A': '1' } },
    });
    expect(player().filtered(0)).toEqual({
      'Authorization': 'Bearer t',
      'X-A': '1',
    });
    expect(player().filtered(LICENSE_REQUEST)).toEqual({
      'Authorization': 'Bearer t',
      'X-A': '1',
    });
  });

  test('without headers no request filter is registered', async () => {
    const { player } = await started();
    expect(player().filters).toEqual([]);
  });

  test('Shaka 4 hides the cues it loads; Shaka 5 has no such switch', async () => {
    const shaka4 = await started({ textVisibility: true });
    expect(shaka4.player().textVisibility).toEqual([false]);
    const shaka5 = await started({ audioTracks: true });
    expect(shaka5.player().textVisibility).toEqual([]);
    expect(shaka5.listener.onLoaded).toHaveBeenCalled();
  });
});

describe('when Shaka cannot load', () => {
  const notFound = { severity: 2, category: 1, code: 1001, data: ['uri', 404] };

  test('a Shaka error from load is mapped and ends the stream', async () => {
    const { stream, shaka, listener } = unstarted({ loadError: notFound });
    await stream.start(null);
    expect(listener.onFailure).toHaveBeenCalledTimes(1);
    expect(listener.onFailure.mock.calls[0]![0]).toMatchObject({
      code: 'SOURCE_NOT_FOUND',
      httpStatus: 404,
    });
    expect(listener.onLoaded).not.toHaveBeenCalled();
    expect(shaka.last().destroyed).toBe(true);
    expect(stream.failed).toBe(true);
  });

  test('an error that is not Shaka’s is UNSUPPORTED_FORMAT with what it said', async () => {
    const { stream, listener } = unstarted({
      attachError: new Error('no MSE'),
    });
    await stream.start(null);
    expect(listener.onFailure.mock.calls[0]![0]).toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      recoverable: false,
      message: 'Shaka Player could not load the stream (Error: no MSE).',
    });
  });

  test('a stream closed while loading reports nothing', async () => {
    const { stream, listener } = unstarted({ loadError: notFound });
    const starting = stream.start(null);
    stream.close();
    await starting;
    expect(listener.onFailure).not.toHaveBeenCalled();
    expect(listener.onLoaded).not.toHaveBeenCalled();
  });

  test('a stream closed after loading does not announce itself', async () => {
    const { stream, listener } = unstarted();
    const starting = stream.start(null);
    stream.close();
    await starting;
    expect(listener.onLoaded).not.toHaveBeenCalled();
    expect(listener.onNote).not.toHaveBeenCalled();
  });
});

describe("Shaka's events", () => {
  test('a critical error fails the stream once and frees Shaka', async () => {
    const { stream, listener, player } = await started();
    player().emit('error', {
      detail: { severity: 2, category: 3, code: 3016 },
    });
    player().emit('error', {
      detail: { severity: 2, category: 1, code: 1002 },
    });
    expect(listener.onFailure).toHaveBeenCalledTimes(1);
    expect(listener.onFailure.mock.calls[0]![0]).toMatchObject({
      code: 'DECODER_ERROR',
    });
    expect(stream.failed).toBe(true);
    expect(player().destroyed).toBe(true);
  });

  test('a recoverable error, or an event without detail, is ignored', async () => {
    const { stream, listener, player } = await started();
    player().emit('error', {
      detail: { severity: 1, category: 1, code: 1001 },
    });
    player().emit('error', {});
    player().emit('error', undefined);
    expect(listener.onFailure).not.toHaveBeenCalled();
    expect(stream.failed).toBe(false);
  });

  test('the picture switching is reported once per picture', async () => {
    const variants = [
      track({ id: 1, videoId: 1, active: true }),
      track({ id: 2, videoId: 2, height: 1080 }),
    ];
    const { listener, player } = await started({ variants });
    expect(listener.onVariantSwitched.mock.calls).toEqual([['v1']]);
    player().emit('variantchanged');
    expect(listener.onVariantSwitched).toHaveBeenCalledTimes(1);

    player().variants = [
      track({ id: 1, videoId: 1 }),
      track({ id: 2, videoId: 2, height: 1080, active: true }),
    ];
    player().emit('variantchanged');
    expect(listener.onVariantSwitched.mock.calls).toEqual([['v1'], ['v2']]);
  });

  test('a variant that has no picture is not reported', async () => {
    const { listener, player } = await started({
      variants: [track({ id: 1, videoId: null, active: true })],
    });
    player().emit('variantchanged');
    expect(listener.onVariantSwitched).not.toHaveBeenCalled();
  });

  test('an adaptation reports the picture and the bandwidth estimate', async () => {
    const variants = [track({ id: 1, videoId: 1, active: true })];
    const { listener, player } = await started({ variants });
    player().bandwidth = 4_500_000;
    player().emit('adaptation');
    expect(listener.onBandwidth).toHaveBeenCalledWith(4_500_000);
  });

  test.each([undefined, 0, -1, Number.NaN, Infinity])(
    'an estimate of %s is not reported',
    async (estimate) => {
      const { listener, player } = await started();
      player().bandwidth = estimate;
      player().emit('adaptation');
      expect(listener.onBandwidth).not.toHaveBeenCalled();
    }
  );

  test('the tracks changing tells the listener the pictures and tracks again', async () => {
    const { listener, player } = await started({
      variants: [track({ id: 1, videoId: 1 })],
    });
    expect(listener.onVariants).toHaveBeenCalledTimes(1);
    player().variants = [
      track({ id: 1, videoId: 1 }),
      track({ id: 2, videoId: 2, height: 1080 }),
    ];
    player().emit('trackschanged');
    expect(listener.onVariants).toHaveBeenCalledTimes(2);
    expect(listener.onVariants.mock.calls[1]![0]).toHaveLength(2);
    expect(listener.onTracks).toHaveBeenCalledTimes(2);
  });

  test('tracks changing before the manifest loaded, or after closing, are ignored', async () => {
    const { stream, shaka, listener } = unstarted();
    const starting = stream.start(null);
    shaka.last().emit('trackschanged');
    await starting;
    expect(listener.onVariants).toHaveBeenCalledTimes(1);
    stream.close();
    shaka.last().emit('trackschanged');
    expect(listener.onVariants).toHaveBeenCalledTimes(1);
  });
});

describe('the sounds and texts of the source', () => {
  test('Shaka 5 lists its sounds, one per language and role', async () => {
    const { stream, player } = await started({ audioTracks: true });
    player().audios = [
      { language: 'en', active: true, label: 'English', roles: ['main'] },
      { language: 'en', active: false, label: 'Again', roles: ['main'] },
      {
        language: 'en',
        active: false,
        label: 'English AD',
        roles: ['description'],
      },
      { language: 'und', active: false },
    ];
    player().emit('trackschanged');
    expect(stream.audioTracks).toEqual([
      { name: 'English', lang: 'en', characteristics: undefined },
      {
        name: 'English AD',
        lang: 'en',
        characteristics: 'public.accessibility.describes-video',
      },
      { name: undefined, lang: undefined, characteristics: undefined },
    ]);
  });

  test("Shaka 4's sounds are its variants' languages and roles", async () => {
    const { stream, player, listener } = await started({
      variants: [
        track({ id: 1, language: 'fr', label: 'Français' }),
        track({ id: 2, language: 'fr', videoId: 2 }),
        track({ id: 3, language: 'fr', audioRoles: ['description'] }),
        track({ id: 4, language: 'und', audioRoles: [] }),
      ],
    });
    expect(player().getAudioTracks).toBeUndefined();
    expect(stream.audioTracks).toEqual([
      { name: 'Français', lang: 'fr', characteristics: undefined },
      {
        name: undefined,
        lang: 'fr',
        characteristics: 'public.accessibility.describes-video',
      },
      { name: undefined, lang: undefined, characteristics: undefined },
    ]);
    expect(listener.onTracks).toHaveBeenCalledTimes(1);
  });

  test('the text tracks keep their label, language, forced flag and captions', async () => {
    const { stream, player } = await started({ variants: [track()] });
    player().texts = [
      track({ id: 10, language: 'en', label: 'English', kind: 'subtitle' }),
      track({ id: 11, language: 'und', kind: 'caption', forced: true }),
    ];
    player().emit('trackschanged');
    expect(stream.subtitleTracks).toEqual([
      {
        name: 'English',
        lang: 'en',
        forced: false,
        characteristics: undefined,
      },
      {
        name: undefined,
        lang: undefined,
        forced: true,
        characteristics: 'public.accessibility.transcribes-spoken-dialog',
      },
    ]);
  });

  describe('choosing a sound', () => {
    async function withSounds(options: FakeShakaOptions) {
      const result = await started({
        ...options,
        variants: [
          track({ id: 1, videoId: 1, language: 'en', active: true }),
          track({
            id: 2,
            videoId: 1,
            language: 'fr',
            audioRoles: ['description'],
          }),
        ],
      });
      result.player().audios = [
        { language: 'en', active: true, roles: ['main'] },
        { language: 'fr', active: false, roles: ['description'] },
      ];
      result.player().emit('trackschanged');
      return result;
    }

    test('Shaka 5 selects the sound in that language and role', async () => {
      const { stream, player } = await withSounds({ audioTracks: true });
      stream.selectAudio(1);
      expect(player().selectedAudio).toEqual([player().audios[1]]);
    });

    test('Shaka 5 leaves the sound that is playing alone', async () => {
      const { stream, player } = await withSounds({ audioTracks: true });
      stream.selectAudio(0);
      expect(player().selectedAudio).toEqual([]);
    });

    test('Shaka 5 takes no sound that was not offered', async () => {
      const { stream, player } = await withSounds({ audioTracks: true });
      player().audios = [];
      stream.selectAudio(1);
      expect(player().selectedAudio).toEqual([]);
    });

    test('Shaka 4 selects by language and role', async () => {
      const { stream, player } = await withSounds({});
      stream.selectAudio(1);
      expect(player().selectedLanguages).toEqual([
        { language: 'fr', role: 'description' },
      ]);
    });

    test('Shaka 4 leaves the language that is playing alone', async () => {
      const { stream, player } = await withSounds({});
      stream.selectAudio(0);
      expect(player().selectedLanguages).toEqual([]);
    });

    test('an index outside the list, or a closed stream, selects nothing', async () => {
      const { stream, player } = await withSounds({});
      stream.selectAudio(5);
      stream.selectAudio(-1);
      stream.close();
      stream.selectAudio(1);
      expect(player().selectedLanguages).toEqual([]);
    });
  });

  describe('choosing subtitles', () => {
    async function withTexts(options: FakeShakaOptions, active = 0) {
      const result = await started({ ...options, variants: [track()] });
      result.player().texts = [
        track({ id: 10, language: 'en', active: active === 10 }),
        track({ id: 11, language: 'fr', active: active === 11 }),
      ];
      result.player().emit('trackschanged');
      return result;
    }

    test('it shows the track chosen', async () => {
      const { stream, player } = await withTexts({});
      stream.selectSubtitles(1);
      expect(player().selectedText).toEqual([player().texts[1]]);
    });

    test('the track already shown is left alone', async () => {
      const { stream, player } = await withTexts({}, 11);
      stream.selectSubtitles(1);
      expect(player().selectedText).toEqual([]);
    });

    test('none unloads the text on Shaka 5 when one is shown', async () => {
      const { stream, player } = await withTexts({ audioTracks: true }, 10);
      stream.selectSubtitles(-1);
      expect(player().selectedText).toEqual([null]);
    });

    test('none leaves Shaka 5 alone when no text is shown', async () => {
      const { stream, player } = await withTexts({ audioTracks: true });
      stream.selectSubtitles(-1);
      expect(player().selectedText).toEqual([]);
    });

    test('none keeps the text hidden on Shaka 4 and changes nothing', async () => {
      const { stream, player } = await withTexts({}, 10);
      stream.selectSubtitles(-1);
      expect(player().selectedText).toEqual([]);
    });

    test('a closed stream selects nothing', async () => {
      const { stream, player } = await withTexts({});
      stream.close();
      stream.selectSubtitles(0);
      expect(player().selectedText).toEqual([]);
    });
  });
});

describe('quality', () => {
  const noCaps = {
    maxHeight: null,
    maxBitrate: null,
    pinned: null,
    audioOnly: false,
  };
  const variants = [
    track({ id: 1, videoId: 1, height: 480, active: true, language: 'en' }),
    track({ id: 2, videoId: 2, height: 1080, language: 'en' }),
    track({ id: 3, videoId: 2, height: 1080, language: 'fr' }),
  ];

  test('caps become ABR restrictions, with ABR on', async () => {
    const { stream, player } = await started({ variants });
    stream.setQuality({ ...noCaps, maxHeight: 720, maxBitrate: 2_000_000 });
    expect(player().config('abr')).toEqual({
      enabled: true,
      restrictions: { maxHeight: 720, maxBandwidth: 2_000_000 },
    });
    expect(player().selectedVariants).toEqual([]);
  });

  test('no caps lift the restrictions', async () => {
    const { stream, player } = await started({ variants });
    stream.setQuality({ ...noCaps, maxHeight: 720 });
    stream.setQuality(noCaps);
    expect(player().config('abr')).toEqual({
      enabled: true,
      restrictions: { maxHeight: Infinity, maxBandwidth: Infinity },
    });
  });

  test('a picture the app picked turns ABR off and plays that picture, in the sound playing', async () => {
    const { stream, player } = await started({ variants });
    stream.setQuality({ ...noCaps, pinned: 'v2' });
    expect(player().config('abr').enabled).toBe(false);
    expect(player().selectedVariants).toEqual([
      { track: variants[1], clearBuffer: true },
    ]);
  });

  test('the picture already playing is not selected again', async () => {
    const { stream, player } = await started({ variants });
    stream.setQuality({ ...noCaps, pinned: 'v1' });
    expect(player().config('abr').enabled).toBe(false);
    expect(player().selectedVariants).toEqual([]);
  });

  test('a picture the manifest does not have selects nothing', async () => {
    const { stream, player } = await started({ variants });
    stream.setQuality({ ...noCaps, pinned: 'v9' });
    expect(player().selectedVariants).toEqual([]);
  });

  test('constraints set before the manifest loads apply when it has', async () => {
    const { stream, shaka } = unstarted();
    const starting = stream.start(null);
    stream.setQuality({ ...noCaps, maxHeight: 360 });
    expect(shaka.last().config('abr')).toBeUndefined();
    await starting;
    expect(shaka.last().config('abr')).toEqual({
      enabled: true,
      restrictions: { maxHeight: 360, maxBandwidth: Infinity },
    });
  });

  test('a closed stream configures nothing', async () => {
    const { stream, player } = await started({ variants });
    stream.close();
    stream.setQuality({ ...noCaps, maxHeight: 360 });
    expect(player().config('abr')).toBeUndefined();
  });
});

describe('protected content', () => {
  const widevine = drmOf({ widevine: WIDEVINE });

  test("the source's servers and the license headers go to Shaka", async () => {
    const { player } = await started({
      source: {
        drm: drmOf({
          widevine: WIDEVINE,
          playready: {
            licenseUrl: 'https://lic.example/pr',
            headers: { 'X-Pr': '2' },
          },
        }),
      },
    });
    expect(player().config('drm')).toEqual({
      servers: {
        'com.widevine.alpha': 'https://lic.example/wv',
        'com.microsoft.playready': 'https://lic.example/pr',
      },
    });
    expect(player().filtered(LICENSE_REQUEST)).toEqual({
      'X-Token': 'abc',
      'X-Pr': '2',
    });
    expect(player().filtered(1)).toEqual({});
  });

  test('a source without license headers registers no filter', async () => {
    const { player } = await started({
      source: {
        drm: drmOf({
          widevine: { licenseUrl: WIDEVINE.licenseUrl, headers: {} },
        }),
      },
    });
    expect(player().filters).toEqual([]);
  });

  test('a source without DRM leaves Shaka’s DRM alone', async () => {
    const { player } = await started();
    expect(player().config('drm')).toBeUndefined();
  });

  test("Clear Key's keys are Shaka's, with no server", async () => {
    const kid = 'a7e61c373e219033c21091fa607bf3b8';
    const key = '76a6c65c5ea762046bd749a2e632ccbb';
    const { player } = await started({
      source: {
        drm: drmOf({
          clearkey: { keys: { [kid]: key }, licenseUrl: null, headers: {} },
        }),
      },
    });
    expect(player().config('drm')).toEqual({
      servers: {},
      clearKeys: { [kid]: key },
    });
  });

  test('without the app answering, the hook is not routed through a scheme', async () => {
    const shaka = new FakeShaka();
    const listener = listenerOf();
    const withoutHook = { ...listener, requestLicense: undefined };
    await started({
      shaka,
      listener: withoutHook as never,
      source: { drm: drmOf({ widevine: WIDEVINE, hook: true }) },
    });
    expect(shaka.schemes.size).toBe(0);
    expect(shaka.last().config('drm').servers).toEqual({
      'com.widevine.alpha': 'https://lic.example/wv',
    });
  });

  test('a Shaka without networking keeps the servers as they are', async () => {
    const { player, shaka } = await started({
      noNetworking: true,
      source: { drm: drmOf({ widevine: WIDEVINE, hook: true }) },
    });
    expect(shaka.schemes.size).toBe(0);
    expect(player().config('drm').servers).toEqual({
      'com.widevine.alpha': 'https://lic.example/wv',
    });
  });

  describe("the app's getLicense through rnap-license:", () => {
    const hooked = {
      drm: drmOf({
        widevine: WIDEVINE,
        fairplay: {
          licenseUrl: 'https://lic.example/fps',
          headers: { 'X-Fps': '1' },
          certificateUrl: 'https://lic.example/cert',
          contentId: 'asset-1',
        },
        hook: true,
      }),
    };

    /** The `rnap-license:` URI Shaka was given for `system`. */
    const licenseUri = (
      player: { config(key: string): any },
      name: string
    ): string => {
      const servers = player.config('drm').servers as Record<string, string>;
      return Object.values(servers).find((u) => u.endsWith(`/${name}`))!;
    };

    test('every server is the stream’s scheme, and the license comes from the app', async () => {
      const { player, shaka, listener } = await started({ source: hooked });
      const uri = licenseUri(player(), 'widevine');
      expect(uri).toMatch(/^rnap-license:\/\/\d+\/widevine$/);
      expect(licenseUri(player(), 'fairplay')).toMatch(/\/fairplay$/);

      const operation = shaka.request(uri, CHALLENGE);
      const response = await operation.promise;
      expect(listener.requestLicense).toHaveBeenCalledWith({
        keySystem: 'widevine',
        challenge: CHALLENGE,
        contentId: null,
        licenseUrl: WIDEVINE.licenseUrl,
        headers: WIDEVINE.headers,
      });
      expect(response).toMatchObject({ uri, originalUri: uri, headers: {} });
      expect(Array.from(new Uint8Array(response.data))).toEqual([5, 6]);
    });

    test('FairPlay’s request carries the content id of the source', async () => {
      const { player, shaka, listener } = await started({ source: hooked });
      await shaka.request(licenseUri(player(), 'fairplay'), CHALLENGE).promise;
      expect(listener.requestLicense).toHaveBeenCalledWith(
        expect.objectContaining({
          keySystem: 'fairplay',
          contentId: 'asset-1',
          licenseUrl: 'https://lic.example/fps',
          headers: { 'X-Fps': '1' },
        })
      );
    });

    test('a key system the source has no server for gets no URL and no headers', async () => {
      const { player, shaka, listener } = await started({ source: hooked });
      const uri = licenseUri(player(), 'widevine');
      await shaka.request(uri.replace('/widevine', '/playready'), CHALLENGE)
        .promise;
      expect(listener.requestLicense).toHaveBeenCalledWith({
        keySystem: 'playready',
        challenge: CHALLENGE,
        contentId: null,
        licenseUrl: null,
        headers: {},
      });
    });

    test('the challenge is the request body, as an ArrayBuffer or a view', async () => {
      const { player, shaka, listener } = await started({ source: hooked });
      const uri = licenseUri(player(), 'widevine');
      const bytes = new Uint8Array([0, 1, 2, 3, 4]);
      await shaka.request(uri, bytes.slice(1, 4).buffer).promise;
      await shaka.request(uri, bytes.subarray(2)).promise;
      await shaka.request(uri, null).promise;
      expect(
        listener.requestLicense.mock.calls.map((c) =>
          Array.from((c[0] as { challenge: Uint8Array }).challenge)
        )
      ).toEqual([[1, 2, 3], [2, 3, 4], []]);
    });

    test('a hook that fails fails the license request', async () => {
      const { player, shaka, listener } = await started({ source: hooked });
      listener.requestLicense.mockRejectedValueOnce(new Error('token expired'));
      const operation = shaka.request(
        licenseUri(player(), 'widevine'),
        CHALLENGE
      );
      await expect(operation.promise).rejects.toThrow('token expired');
    });

    test('an app that never answers fails the request after 30 s', async () => {
      const events: Array<{ requestId: number }> = [];
      const listener = listenerOf();
      listener.requestLicense.mockImplementation((request) =>
        requestLicense((e) => events.push(e), request as never)
      );
      const { player, shaka } = await started({ source: hooked, listener });
      const operation = shaka.request(
        licenseUri(player(), 'widevine'),
        CHALLENGE
      );
      const outcome = operation.promise.then(
        () => null,
        (error: PlayerError) => error
      );
      await jest.advanceTimersByTimeAsync(30_000);
      expect(events).toHaveLength(1);
      expect(await outcome).toMatchObject({
        code: 'DRM_LICENSE_FAILED',
        recoverable: false,
      });
    });

    test('the scheme is registered once per Shaka, and each stream has its own id', async () => {
      const shaka = new FakeShaka();
      const first = await started({ shaka, source: hooked });
      const second = await started({ shaka, source: hooked });
      const register = jest.spyOn(
        shaka.namespace.net!.NetworkingEngine,
        'registerScheme'
      );
      await started({ shaka, source: hooked });
      expect(register).not.toHaveBeenCalled();
      const [a, b] = [first, second].map((s) =>
        licenseUri(s.player(), 'widevine')
      );
      expect(a).not.toBe(b);
      expect(shaka.schemes.size).toBe(1);
    });

    test('a request for a stream that is gone is refused', async () => {
      const { player, shaka, listener, stream } = await started({
        source: hooked,
      });
      const uri = licenseUri(player(), 'widevine');
      stream.close();
      const operation = shaka.request(uri, CHALLENGE);
      await expect(operation.promise).rejects.toThrow('The player is gone.');
      expect(listener.requestLicense).not.toHaveBeenCalled();
    });

    test('a request for an id nobody has is refused', async () => {
      const { shaka } = await started({ source: hooked });
      const operation = shaka.request('rnap-license://999/widevine', CHALLENGE);
      await expect(operation.promise).rejects.toThrow('The player is gone.');
    });
  });

  test("Shaka's configuration is built for the app's scheme and for the source's own servers", () => {
    expect(dash.shakaDrm(widevine, null)).toEqual({
      servers: { 'com.widevine.alpha': 'https://lic.example/wv' },
    });
    expect(dash.shakaDrm(widevine, 'rnap-license://3')).toEqual({
      servers: { 'com.widevine.alpha': 'rnap-license://3/widevine' },
    });
    expect(
      dash.shakaDrm(
        drmOf({ clearkey: { keys: null, licenseUrl: null, headers: {} } }),
        null
      )
    ).toEqual({ servers: {} });
  });
});

describe('closing', () => {
  test('it frees Shaka once', async () => {
    const { stream, player } = await started();
    const destroy = jest.spyOn(player(), 'destroy');
    stream.close();
    stream.close();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(player().destroyed).toBe(true);
  });

  test('a Shaka that fails to destroy is ignored', async () => {
    const { stream, player, listener } = await started();
    player().destroyError = new Error('already gone');
    stream.close();
    await Promise.resolve();
    expect(player().destroyed).toBe(true);
    expect(listener.onFailure).not.toHaveBeenCalled();
  });

  test('a critical error after closing is not reported', async () => {
    const { stream, player, listener } = await started();
    stream.close();
    player().emit('error', {
      detail: { severity: 2, category: 1, code: 1002 },
    });
    expect(listener.onFailure).not.toHaveBeenCalled();
    expect(stream.failed).toBe(false);
  });

  test('closing a stream that never started does nothing', () => {
    const { stream, shaka } = unstarted();
    stream.close();
    expect(shaka.players).toEqual([]);
  });
});
