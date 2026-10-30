/// <reference types="node" />
// HlsStream: hls.js on a video element. The variants and the caps that apply
// to them, the audio and subtitle renditions, bandwidth and level changes,
// timed metadata, the playlist's live and length, and how fatal and
// recoverable hls.js errors are reported.

import type { HlsLevel } from '../../core/hls';
import type { PlayerError } from '../../errors';
import type { QualityConstraints, SourceDescriptor } from '../engine/types';
import {
  HlsStream,
  hlsFailure,
  levelCap,
  variantsOf,
  type HlsListener,
} from '../platform/HlsStream';
import { id3TextTag } from './audioFixtures';
import { install, uninstall, type FakeWorld } from './FakeBrowser';
import { FakeHls } from './FakeHls';
import { RichHls, asHls } from './FakeStreams';
import { FakeVideo } from './FakeVideo';

const URI = 'https://cdn.example/movie/master.m3u8';

const LEVELS: HlsLevel[] = [
  { height: 0, bitrate: 128_000, audioCodec: 'mp4a.40.2' },
  { height: 360, bitrate: 800_000, name: 'Low', videoCodec: 'avc1' },
  { height: 720, bitrate: 2_500_000, videoCodec: 'avc1' },
  { height: 1080, bitrate: 6_000_000, videoCodec: 'avc1' },
];

const caps = (c: Partial<QualityConstraints>): QualityConstraints => ({
  maxHeight: null,
  maxBitrate: null,
  pinned: null,
  audioOnly: false,
  ...c,
});

let world: FakeWorld;
let element: FakeVideo;

function listener() {
  const events = {
    failures: [] as PlayerError[],
    notes: [] as Array<[string, Record<string, string>]>,
    variants: [] as unknown[],
    switched: [] as string[],
    bandwidth: [] as number[],
    tracks: 0,
    metadata: [] as Array<[unknown, number]>,
  };
  const l: HlsListener = {
    onMetadata: (metadata, time) => events.metadata.push([metadata, time]),
    onFailure: (error) => events.failures.push(error),
    onNote: (event, details) => events.notes.push([event, details]),
    onVariants: (variants) => events.variants.push(variants),
    onVariantSwitched: (id) => events.switched.push(id),
    onBandwidth: (bps) => events.bandwidth.push(bps),
    onTracks: () => {
      events.tracks += 1;
    },
  };
  return { events, listener: l };
}

function start(
  source: Partial<SourceDescriptor> = {},
  l: HlsListener = listener().listener,
  ctor: unknown = RichHls
) {
  const stream = new HlsStream(
    element as never,
    { uri: URI, headers: {}, liveHint: null, ...source },
    asHls(ctor),
    l
  );
  stream.start();
  return { stream, hls: RichHls.last() };
}

beforeEach(() => {
  world = install();
  element = new FakeVideo();
  FakeHls.reset();
});

afterEach(() => {
  uninstall();
});

describe('variants', () => {
  it('lists the levels as qualities, an audio-only level marked', () => {
    expect(variantsOf(LEVELS)).toEqual([
      {
        id: 'v0',
        height: null,
        bitrate: 128_000,
        audioOnly: true,
        label: null,
      },
      {
        id: 'v1',
        height: 360,
        bitrate: 800_000,
        audioOnly: false,
        label: 'Low',
      },
      {
        id: 'v2',
        height: 720,
        bitrate: 2_500_000,
        audioOnly: false,
        label: null,
      },
      {
        id: 'v3',
        height: 1080,
        bitrate: 6_000_000,
        audioOnly: false,
        label: null,
      },
    ]);
    expect(variantsOf([{}])).toEqual([
      { id: 'v0', height: null, bitrate: null, audioOnly: false, label: null },
    ]);
  });

  it('reports them once the master playlist is parsed', () => {
    const { events, listener: l } = listener();
    const { hls } = start({}, l);
    hls.parse(LEVELS);
    expect(events.notes).toEqual([['hls manifest', { levels: '4' }]]);
    expect(events.variants).toEqual([variantsOf(LEVELS)]);
    expect(events.tracks).toBe(1);
  });

  it('counts no levels for a playlist hls.js parsed without any', () => {
    const { events, listener: l } = listener();
    const { hls } = start({}, l);
    hls.emit(RichHls.Events.MANIFEST_PARSED, undefined);
    expect(events.notes).toEqual([['hls manifest', { levels: '0' }]]);
    expect(events.variants).toEqual([[]]);
  });

  it('reports the level that plays, as a quality id', () => {
    const { events, listener: l } = listener();
    const { hls } = start({}, l);
    hls.switched(2);
    hls.switched(0);
    hls.switched('high');
    hls.switched(undefined);
    expect(events.switched).toEqual(['v2', 'v0']);
  });

  it('reports hls.js’s bandwidth estimate when it is a usable number', () => {
    const { events, listener: l } = listener();
    const { hls } = start({}, l);
    hls.fragment(4_000_000);
    hls.fragment(undefined);
    hls.fragment(0);
    hls.fragment(Number.NaN);
    hls.fragment(Number.POSITIVE_INFINITY);
    expect(events.bandwidth).toEqual([4_000_000]);
  });

  it('works for a listener that wants none of the video events', () => {
    const { hls } = start(
      {},
      {
        onMetadata: () => undefined,
        onFailure: () => undefined,
        onNote: () => undefined,
      }
    );
    expect(() => {
      hls.parse(LEVELS);
      hls.switched(1);
      hls.fragment(1_000_000);
      hls.renditions([{ name: 'English' }], []);
    }).not.toThrow();
  });

  it('starts on an hls.js that has no video events at all', () => {
    const { events, listener: l } = listener();
    const { hls } = start({}, l, FakeHls);
    hls.emit(FakeHls.Events.MANIFEST_PARSED, { levels: [] });
    expect(events.variants).toEqual([[]]);
    hls.level(false, 60);
  });
});

describe('quality caps', () => {
  it('want none when nothing is capped', () => {
    expect(levelCap(LEVELS, caps({}))).toBe(-1);
  });

  it('keep to the highest level within the height', () => {
    expect(levelCap(LEVELS, caps({ maxHeight: 720 }))).toBe(2);
    expect(levelCap(LEVELS, caps({ maxHeight: 1080 }))).toBe(3);
  });

  it('keep to the highest level within the bitrate', () => {
    expect(levelCap(LEVELS, caps({ maxBitrate: 1_000_000 }))).toBe(1);
  });

  it('keep to both the height and the bitrate', () => {
    expect(
      levelCap(LEVELS, caps({ maxHeight: 1080, maxBitrate: 3_000_000 }))
    ).toBe(2);
  });

  it('never pick an audio-only level for the cap', () => {
    expect(levelCap(LEVELS, caps({ maxBitrate: 200_000 }))).toBe(1);
  });

  it('fall back to the lowest video level when nothing fits', () => {
    expect(levelCap(LEVELS, caps({ maxHeight: 144 }))).toBe(1);
  });

  it('have no level for a playlist of sound alone', () => {
    expect(levelCap([LEVELS[0]!], caps({ maxHeight: 144 }))).toBe(-1);
  });

  it('cap levels that do not say their size', () => {
    expect(levelCap([{}, {}], caps({ maxHeight: 100, maxBitrate: 100 }))).toBe(
      1
    );
  });

  it('apply to the levels as soon as they are known', () => {
    const { stream, hls } = start();
    stream.setQuality(caps({ maxHeight: 720 }));
    expect(hls.autoLevelCapping).toBeUndefined();
    hls.parse(LEVELS);
    expect(hls.autoLevelCapping).toBe(2);
    expect(hls.manualLevel).toBe(-1);
    expect(hls.flushes).toBe(0);
  });

  it('steer only the next loads: a cap never flushes the buffer, the same cap is not written again (#52)', () => {
    const { stream, hls } = start();
    hls.parse(LEVELS);
    stream.setQuality(caps({ maxHeight: 720 }));
    const writes = hls.capWrites;
    // A resize to another height that maps to the same level.
    stream.setQuality(caps({ maxHeight: 900 }));
    expect(hls.capWrites).toBe(writes);
    stream.setQuality(caps({ maxHeight: 360 }));
    expect(hls.autoLevelCapping).toBe(1);
    expect(hls.manualLevel).toBe(-1);
    expect(hls.flushes).toBe(0);
  });

  it('apply at once on levels hls.js already has', () => {
    const { stream, hls } = start();
    hls.parse(LEVELS);
    stream.setQuality(caps({ maxHeight: 360 }));
    expect(hls.autoLevelCapping).toBe(1);
    stream.setQuality(caps({}));
    expect(hls.autoLevelCapping).toBe(-1);
  });

  it('hold the level the app picked', () => {
    const { stream, hls } = start();
    hls.parse(LEVELS);
    stream.setQuality(caps({ pinned: 'v2' }));
    expect(hls.manualLevel).toBe(2);
    stream.setQuality(caps({ pinned: 'v9' }));
    expect(hls.manualLevel).toBe(-1);
    stream.setQuality(caps({ pinned: 'v2' }));
    stream.setQuality(caps({ pinned: null }));
    expect(hls.manualLevel).toBe(-1);
    // Switched at the next fragment, never flushed.
    expect(hls.flushes).toBe(0);
  });

  it('hold the audio-only level to listen alone, else the pick', () => {
    const { stream, hls } = start();
    hls.parse(LEVELS);
    stream.setQuality(caps({ audioOnly: true, pinned: 'v3' }));
    expect(hls.manualLevel).toBe(0);

    const video = start();
    video.hls.parse(LEVELS.slice(1));
    video.stream.setQuality(caps({ audioOnly: true, pinned: 'v1' }));
    expect(video.hls.manualLevel).toBe(1);
    video.stream.setQuality(caps({ audioOnly: true }));
    expect(video.hls.manualLevel).toBe(-1);
  });

  it('wait for a playlist that has no levels yet', () => {
    const { stream, hls } = start();
    hls.parse([]);
    stream.setQuality(caps({ maxHeight: 360 }));
    expect(hls.autoLevelCapping).toBeUndefined();
  });

  it('are kept for nothing once the stream is closed', () => {
    const { stream, hls } = start();
    hls.parse(LEVELS);
    stream.close();
    expect(() => stream.setQuality(caps({ maxHeight: 360 }))).not.toThrow();
    expect(hls.autoLevelCapping).toBeUndefined();
  });
});

describe('renditions', () => {
  const english = { name: 'English', lang: 'en', default: true };
  const german = { name: 'Deutsch', lang: 'de' };
  const forced = { name: 'Forced', lang: 'en', forced: true };

  it('are empty before hls.js runs and after it is gone', () => {
    const stream = new HlsStream(
      element as never,
      { uri: URI, headers: {}, liveHint: null },
      asHls(RichHls),
      listener().listener
    );
    expect(stream.audioTracks).toEqual([]);
    expect(stream.subtitleTracks).toEqual([]);
    stream.start();
    const hls = RichHls.last();
    hls.renditions([english], [forced]);
    expect(stream.audioTracks).toEqual([english]);
    expect(stream.subtitleTracks).toEqual([forced]);
    stream.close();
    expect(stream.audioTracks).toEqual([]);
    expect(stream.subtitleTracks).toEqual([]);
  });

  it('are announced when they change', () => {
    const { events, listener: l } = listener();
    const { hls } = start({}, l);
    hls.renditions([english, german], []);
    expect(events.tracks).toBe(2);
  });

  it('switch the audio rendition, only when it is another one', () => {
    const { stream, hls } = start();
    hls.renditions([english, german], []);
    hls.audioTrack = 0;
    stream.selectAudio(0);
    expect(hls.audioTrack).toBe(0);
    stream.selectAudio(1);
    expect(hls.audioTrack).toBe(1);
  });

  it('load a subtitle rendition hidden: RNAP draws the cues', () => {
    const { stream, hls } = start();
    expect(hls.subtitleDisplay).toBe(false);
    hls.subtitleDisplay = true;
    hls.subtitleTrack = -1;
    stream.selectSubtitles(1);
    expect(hls.subtitleDisplay).toBe(false);
    expect(hls.subtitleTrack).toBe(1);
    stream.selectSubtitles(1);
    expect(hls.subtitleTrack).toBe(1);
    stream.selectSubtitles(-1);
    expect(hls.subtitleTrack).toBe(-1);
  });

  it('are not switched once the stream is closed', () => {
    const { stream, hls } = start();
    hls.audioTrack = 0;
    hls.subtitleTrack = -1;
    stream.close();
    stream.selectAudio(1);
    stream.selectSubtitles(2);
    expect(hls.audioTrack).toBe(0);
    expect(hls.subtitleTrack).toBe(-1);
  });
});

describe('the playlist', () => {
  it('does not know whether it is live before a level loads', () => {
    const { stream } = start();
    expect(stream.live).toBeNull();
    expect(stream.readyInfo()).toBeNull();
  });

  it('is a live stream without a duration', () => {
    const { stream, hls } = start();
    hls.level(true);
    expect(stream.live).toBe(true);
    expect(stream.readyInfo()).toEqual({
      duration: null,
      isLive: true,
      seekable: false,
    });
  });

  it('is a seekable file of the length the playlist adds up to', () => {
    const { stream, hls } = start();
    hls.level(false, 5400);
    expect(stream.live).toBe(false);
    expect(stream.readyInfo()).toEqual({
      duration: 5400,
      isLive: false,
      seekable: true,
    });
  });

  it('has no length to give while the playlist adds up to nothing', () => {
    const { stream, hls } = start();
    hls.level(false, 0);
    expect(stream.readyInfo()).toBeNull();
    hls.level(false, Number.NaN);
    expect(stream.readyInfo()).toBeNull();
  });

  it('forgets a level that loaded without details', () => {
    const { stream, hls } = start();
    hls.level(true);
    hls.emit(RichHls.Events.LEVEL_LOADED, undefined);
    expect(stream.live).toBeNull();
  });

  it('says how far behind the live edge it is, once hls.js knows', () => {
    const { stream, hls } = start();
    expect(stream.liveOffset).toBeNull();
    hls.latency = 3.5;
    expect(stream.liveOffset).toBe(3.5);
    hls.latency = -1;
    expect(stream.liveOffset).toBe(0);
    hls.latency = Number.NaN;
    expect(stream.liveOffset).toBeNull();
    stream.close();
    expect(stream.liveOffset).toBeNull();
  });
});

describe('timed metadata', () => {
  it('reports an ID3 tag with the time it applies from', () => {
    const { events, listener: l } = listener();
    const { hls } = start({}, l);
    hls.emit(RichHls.Events.FRAG_PARSING_METADATA, {
      samples: [
        {
          pts: 12,
          data: id3TextTag(4, [{ id: 'TIT2', encoding: 3, text: 'Song' }]),
        },
        { pts: 13, data: new Uint8Array([1, 2, 3]) },
        { pts: 14 },
      ],
    });
    expect(events.metadata).toHaveLength(1);
    expect(events.metadata[0]![1]).toBe(12);
    expect(events.metadata[0]![0]).toMatchObject({ title: 'Song' });
  });

  it('has nothing to report for a fragment without samples', () => {
    const { events, listener: l } = listener();
    const { hls } = start({}, l);
    hls.emit(RichHls.Events.FRAG_PARSING_METADATA, undefined);
    expect(events.metadata).toEqual([]);
  });
});

describe('errors', () => {
  const NETWORK = RichHls.ErrorTypes.NETWORK_ERROR;
  const MEDIA = RichHls.ErrorTypes.MEDIA_ERROR;

  it('ignores the ones hls.js recovers from by itself', () => {
    const { events, listener: l } = listener();
    const { hls } = start({}, l);
    hls.hiccup();
    hls.emit(RichHls.Events.ERROR, undefined);
    expect(events.failures).toEqual([]);
    expect(hls.destroyed).toBe(false);
  });

  it('reports a fatal one once, and frees hls.js', () => {
    const { events, listener: l } = listener();
    const { stream, hls } = start({}, l);
    hls.fatal(NETWORK, 'levelLoadError', 503);
    hls.fatal(MEDIA);
    expect(events.failures).toHaveLength(1);
    expect(events.failures[0]).toMatchObject({
      code: 'NETWORK_ERROR',
      recoverable: true,
      platform: 'web',
      platformDomain: 'hls.js',
      httpStatus: 503,
      nativeCause: 'networkError: levelLoadError',
    });
    expect(stream.failed).toBe(true);
    expect(hls.destroyed).toBe(true);
  });

  it('says nothing once the stream was closed', () => {
    const { events, listener: l } = listener();
    const { stream, hls } = start({}, l);
    stream.close();
    hls.fatal(NETWORK);
    expect(events.failures).toEqual([]);
  });

  it('says it is offline when the device is', () => {
    world.navigator.onLine = false;
    expect(hlsFailure({ type: NETWORK, fatal: true }, RichHls)).toMatchObject({
      code: 'NETWORK_UNAVAILABLE',
      recoverable: true,
    });
  });

  it.each([404, 410])(
    'gives up on a playlist the server answers %i',
    (code) => {
      expect(
        hlsFailure(
          {
            type: NETWORK,
            details: 'manifestLoadError',
            fatal: true,
            response: { code },
          },
          RichHls
        )
      ).toMatchObject({
        code: 'SOURCE_NOT_FOUND',
        recoverable: false,
        httpStatus: code,
      });
    }
  );

  it('keeps trying after a fragment is missing', () => {
    expect(
      hlsFailure(
        {
          type: NETWORK,
          details: 'fragLoadError',
          fatal: true,
          response: { code: 404 },
        },
        RichHls
      )
    ).toMatchObject({
      code: 'NETWORK_ERROR',
      recoverable: true,
      httpStatus: 404,
    });
    expect(
      hlsFailure(
        {
          type: NETWORK,
          details: 'manifestLoadError',
          fatal: true,
          response: { code: 500 },
        },
        RichHls
      )
    ).toMatchObject({ code: 'NETWORK_ERROR', recoverable: true });
  });

  it('reports a network error without a response or details', () => {
    const error = hlsFailure({ type: NETWORK, fatal: true }, RichHls);
    expect(error).toMatchObject({
      code: 'NETWORK_ERROR',
      nativeCause: 'networkError',
    });
    expect(error.httpStatus).toBeUndefined();
  });

  it('reports media it could not decode as recoverable', () => {
    expect(
      hlsFailure(
        { type: MEDIA, details: 'bufferAppendError', fatal: true },
        RichHls
      )
    ).toMatchObject({ code: 'DECODER_ERROR', recoverable: true });
  });

  it('gives up on anything else', () => {
    expect(
      hlsFailure(
        { type: 'otherError', details: 'internalException', fatal: true },
        RichHls
      )
    ).toMatchObject({ code: 'UNSUPPORTED_FORMAT', recoverable: false });
  });
});

describe('closing', () => {
  it('frees hls.js once', () => {
    const { stream, hls } = start();
    let destroys = 0;
    hls.destroy = () => {
      destroys += 1;
    };
    stream.close();
    stream.close();
    expect(destroys).toBe(1);
  });

  it('survives an hls.js that fails to free itself', () => {
    const { stream, hls } = start();
    hls.destroy = () => {
      throw new Error('already gone');
    };
    expect(() => stream.close()).not.toThrow();
  });
});

describe('hls.js’s configuration', () => {
  it('plays the playlist into the element, with live durations as infinite', () => {
    const { hls } = start();
    expect(hls.source).toBe(URI);
    expect(hls.media).toBe(element);
    expect(hls.config).toEqual({ liveDurationInfinity: true });
  });

  it('sends the source’s headers on every request', () => {
    const { hls } = start({
      headers: { 'Authorization': 'Bearer t', 'X-Id': '7' },
    });
    const sent: Record<string, string> = {};
    hls.config.xhrSetup({
      setRequestHeader: (name: string, value: string) => {
        sent[name] = value;
      },
    });
    expect(sent).toEqual({ 'Authorization': 'Bearer t', 'X-Id': '7' });

    const init = { headers: new Headers() };
    const request = hls.config.fetchSetup(
      { url: 'https://cdn.example/seg1.ts' },
      init
    );
    expect(request.url).toBe('https://cdn.example/seg1.ts');
    expect(request.headers.get('authorization')).toBe('Bearer t');
    expect(request.headers.get('x-id')).toBe('7');
  });
});
