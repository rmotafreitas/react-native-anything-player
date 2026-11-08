/// <reference types="node" />
// SwapDriver: a quality switch between separate files of one video. The new
// file opens behind the picture, waits for the picture to reach it, and takes
// over on its first frame; a stalled picture, a late or failing file, an
// abandoned switch and a released driver are handled on the same two elements.

import { ranges, uninstall } from './FakeBrowser';
import {
  installVideo,
  recorder,
  type FakeVideo,
  type FakeVideoWorld,
} from './FakeVideo';
import { engineError } from '../engine/types';
import type {
  OpenRequest,
  QualityConstraints,
  SourceDescriptor,
} from '../engine/types';
import { MediaElementDriver } from '../platform/MediaElementDriver';
import type { DriverObserver } from '../platform/MediaElementDriver';
import { SwapDriver } from '../platform/SwapDriver';

const SD = 'https://cdn.example/movie-480.mp4';
const HD = 'https://cdn.example/movie-1080.mp4';
const UHD = 'https://cdn.example/movie-2160.mp4';

let world: FakeVideoWorld;
let rec: ReturnType<typeof recorder>;
let shows: Array<[unknown, unknown]>;
let proxy: DriverObserver;
let driver: SwapDriver;

/** The elements play from a MediaSource RNAP feeds (a stream it reads): `null` as they are. */
let fed: boolean | null = null;

function setup(optional = true): void {
  world = installVideo();
  rec = recorder(optional);
  shows = [];
  const feeds = fed;
  driver = new SwapDriver(
    rec.observer,
    (observer) => {
      proxy = observer;
      const made = new MediaElementDriver(observer, 'artist-title', 'video');
      if (feeds != null)
        Object.defineProperty(made, 'feedsItself', { get: () => feeds });
      return made;
    },
    { show: (element, hidden) => shows.push([element, hidden]) }
  );
}

const source = (uri: string): SourceDescriptor => ({
  uri,
  headers: {},
  liveHint: null,
});

const open = (
  generation: number,
  uri: string,
  extra: Partial<OpenRequest> = {}
): OpenRequest => ({
  generation,
  source: source(uri),
  startPosition: null,
  playWhenReady: false,
  allowReconnect: true,
  ...extra,
});

const swap = (generation: number, uri: string, startPosition: number | null) =>
  open(generation, uri, { swap: true, startPosition, playWhenReady: true });

/** The first file playing at 10 s (generation 1). */
function playing(uri = SD, at = 10): FakeVideo {
  driver.open(open(1, uri, { playWhenReady: true }));
  const element = world.videos[0]!;
  element.becomeReady(120);
  element.currentTime = at;
  element.startPlaying();
  return element;
}

beforeEach(() => {
  jest.useFakeTimers();
  setup();
});

afterEach(() => {
  jest.useRealTimers();
  uninstall();
});

describe('a quality switch', () => {
  it('opens the new file a little ahead of the picture, and takes over on its first frame', () => {
    const old = playing();
    driver.setVolume(0.5);
    driver.open(swap(2, HD, 10));

    const next = world.videos[1]!;
    expect(next.src).toBe(HD);
    expect(next.muted).toBe(true);
    next.becomeReady(120);
    expect(next.currentTime).toBe(11.5);
    expect(rec.of('onReady').map((a) => a[0])).toEqual([1, 2]);
    // The picture has not reached it yet: it waits, and the old one stays.
    jest.advanceTimersByTime(40);
    expect(next.plays).toBe(0);
    expect(shows).toEqual([]);
    expect(driver.element).toBe(old);

    old.currentTime = 11.5;
    jest.advanceTimersByTime(40);
    expect(next.plays).toBe(1);
    expect(shows).toEqual([]);

    next.startPlaying();
    expect(shows).toEqual([[next, old]]);
    expect(driver.element).toBe(next);
    expect(next.muted).toBe(false);
    expect(next.volume).toBe(0.5);
    expect(old.src).toBe('');
    expect(old.paused).toBe(true);
    expect(rec.of('onPlaying').map((a) => a[0])).toEqual([1, 2]);
  });

  it('switches up and down on the same two elements', () => {
    const first = playing(HD, 30);
    for (const [generation, uri] of [
      [2, SD],
      [3, UHD],
      [4, HD],
    ] as const) {
      const old = driver.element as FakeVideo;
      driver.open(swap(generation, uri, old.currentTime));
      const next = old === first ? world.videos[1]! : first;
      expect(next.src).toBe(uri);
      next.becomeReady(120);
      old.currentTime = next.currentTime;
      jest.advanceTimersByTime(40);
      next.startPlaying();
      expect(driver.element).toBe(next);
      expect(next.src).toBe(uri);
      expect(old.src).toBe('');
    }
    expect(world.videos).toHaveLength(2);
    expect(shows).toHaveLength(3);
  });

  it('starts a live switch at once when what is heard has stalled', () => {
    fed = true;
    uninstall();
    setup();
    fed = null;
    playing();
    driver.open(swap(2, HD, null));
    const next = world.videos[1]!;
    next.becomeReady(Number.POSITIVE_INFINITY);
    expect(next.currentTime).toBe(0);
    expect(next.plays).toBe(1);
    expect(rec.of('onNote')).toContainEqual([
      2,
      'quality switch not aligned',
      { reason: 'stalled' },
    ]);
  });

  it('starts the new file at once when the picture is stalled', () => {
    const old = playing();
    old.pause();
    driver.open(swap(2, HD, 10));
    const next = world.videos[1]!;
    next.becomeReady(120);
    expect(next.plays).toBe(1);
  });

  it('starts the new file at once when the picture is already at its position', () => {
    const old = playing();
    driver.open(swap(2, HD, 10));
    const next = world.videos[1]!;
    old.currentTime = 11.7;
    next.becomeReady(120);
    expect(next.plays).toBe(1);
    expect(next.currentTime).toBe(11.5);
  });

  it('opens again a little further ahead when the picture ran past the new file', () => {
    const old = playing();
    driver.open(swap(2, HD, 10));
    const next = world.videos[1]!;
    old.currentTime = 20;
    next.becomeReady(120);
    expect(next.plays).toBe(0);
    expect(next.currentTime).toBe(21.5);

    old.currentTime = 21.5;
    jest.advanceTimersByTime(40);
    expect(next.plays).toBe(1);
  });

  it('plays the engine’s rate, loop, quality and track picks on the new file', () => {
    world = installVideo(
      {},
      {
        audioTracks: [
          { id: '1', kind: 'main', label: 'English', language: 'en' },
          { id: '2', kind: 'alternative', label: 'Deutsch', language: 'de' },
        ],
      }
    );
    driver = new SwapDriver(
      rec.observer,
      (observer) => new MediaElementDriver(observer, 'artist-title', 'video'),
      { show: (element, hidden) => shows.push([element, hidden]) }
    );
    const quality: QualityConstraints = {
      maxHeight: 720,
      maxBitrate: null,
      pinned: null,
      audioOnly: false,
    };
    playing();
    driver.setRate(1.5);
    driver.setLoop(true);
    driver.setQuality(quality);
    driver.selectTracks('track:a:1', null);
    driver.open(swap(2, HD, 10));

    const next = world.videos[1]!;
    expect(next.playbackRate).toBe(1.5);
    expect(next.loop).toBe(true);
    expect(next.audioTracks![0]!.enabled).toBe(false);
    expect(next.audioTracks![1]!.enabled).toBe(true);
    expect(world.videos[0]!.loop).toBe(true);
  });

  it('tells the engine the new file’s tracks once it took over', () => {
    world = installVideo(
      {},
      {
        audioTracks: [
          { id: '1', kind: 'main', label: 'English', language: 'en' },
        ],
      }
    );
    rec = recorder();
    driver = new SwapDriver(
      rec.observer,
      (observer) => new MediaElementDriver(observer, 'artist-title', 'video'),
      { show: (element, hidden) => shows.push([element, hidden]) }
    );
    playing().pause();
    driver.open(swap(2, HD, 10));
    const next = world.videos[1]!;
    next.becomeReady(120);
    rec.calls.length = 0;
    next.startPlaying();
    expect(rec.names()).toEqual(['onPlaying', 'onTracks']);
    expect(rec.of('onTracks')[0]).toEqual([
      2,
      [expect.objectContaining({ id: 'track:a:0', kind: 'audio' })],
    ]);
  });

  it('remembers that the old element is tapped: Web Audio keeps it for good (council C1)', () => {
    const old = playing();
    driver.tapped = true;
    driver.open(swap(2, HD, null));
    const next = world.videos[1]!;
    next.becomeReady(120);
    next.startPlaying();
    // The new element was never routed through Web Audio.
    expect(driver.tapped).toBe(false);

    // The old element is still tapped: a cross-origin file on it would play
    // silence, so the switch plays on a fresh element instead.
    driver.open(swap(3, SD, null));
    const fresh = world.videos[2]!;
    expect(fresh).not.toBe(old);
    expect(fresh.src).toBe(SD);
    fresh.becomeReady(120);
    fresh.startPlaying();
    expect(driver.element).toBe(fresh);
    expect(driver.tapped).toBe(false);
    // The hidden one's new element was never the controller's (council C2).
    expect(rec.of('onElementReplaced')).toEqual([]);
  });

  it('says it plays one item while its element is on AirPlay: the engine re-opens in place (council C8)', () => {
    const video = playing();
    expect(driver.swapsInPlace).toBe(false);
    (
      video as unknown as { webkitCurrentPlaybackTargetIsWireless: boolean }
    ).webkitCurrentPlaybackTargetIsWireless = true;
    expect(driver.swapsInPlace).toBe(true);
  });

  it('hears nothing from the element it left', () => {
    const old = playing();
    driver.open(swap(2, HD, null));
    const next = world.videos[1]!;
    next.becomeReady(120);
    next.startPlaying();
    rec.calls.length = 0;

    old.dispatch('playing');
    old.dispatch('waiting');
    old.dispatch('ended');
    old.fail(3);
    expect(rec.calls).toEqual([]);

    next.dispatch('waiting');
    expect(rec.of('onBuffering')).toEqual([[2]]);
  });
});

describe('a switch that does not complete', () => {
  it('drops the previous switch when another one starts', () => {
    const old = playing();
    driver.open(swap(2, HD, 10));
    const next = world.videos[1]!;
    next.becomeReady(120);

    driver.open(swap(3, UHD, 10));
    expect(next.src).toBe(UHD);
    // The first switch’s waiting for the picture is over.
    old.currentTime = 11.5;
    jest.advanceTimersByTime(1000);
    expect(next.plays).toBe(0);

    rec.calls.length = 0;
    next.becomeReady(120);
    expect(rec.of('onReady')).toEqual([[3, expect.anything()]]);
    jest.advanceTimersByTime(40);
    expect(next.plays).toBe(1);
  });

  it('drops the switch the engine cancels, and only that one', () => {
    const old = playing();
    driver.open(swap(2, HD, 10));
    const next = world.videos[1]!;
    next.becomeReady(120);

    driver.cancelSwap(5);
    expect(next.src).toBe(HD);

    driver.cancelSwap(2);
    expect(next.src).toBe('');
    old.currentTime = 11.5;
    jest.advanceTimersByTime(1000);
    expect(next.plays).toBe(0);
    expect(driver.element).toBe(old);
  });

  it('ignores a cancel when no switch is under way', () => {
    const old = playing();
    driver.cancelSwap(2);
    expect(old.src).toBe(SD);
  });

  it('keeps the old file playing and reports the failure of the new one', () => {
    const old = playing();
    driver.open(swap(2, HD, 10));
    const next = world.videos[1]!;
    next.fail(4, 'MEDIA_ELEMENT_ERROR: Format error');

    expect(rec.of('onFailed')).toEqual([
      [2, expect.objectContaining({ code: 'UNSUPPORTED_FORMAT' })],
    ]);
    expect(shows).toEqual([]);
    expect(driver.element).toBe(old);
    expect(old.paused).toBe(false);
    expect(old.src).toBe(SD);
  });

  it('opens in place when the engine re-opens instead (the old file is stalled)', () => {
    const old = playing();
    driver.open(swap(2, HD, 10));
    const next = world.videos[1]!;
    next.becomeReady(120);

    driver.open(open(3, UHD, { startPosition: 10, playWhenReady: true }));
    expect(old.src).toBe(UHD);
    expect(next.src).toBe('');
    expect(driver.element).toBe(old);
    expect(shows).toEqual([]);
    old.currentTime = 11.5;
    jest.advanceTimersByTime(1000);
    expect(next.plays).toBe(0);
  });
});

describe('the commands', () => {
  it('go to the element on screen', () => {
    const old = playing();
    old.pause();
    driver.play();
    expect(old.plays).toBe(2);
    driver.pause();
    expect(old.paused).toBe(true);
    driver.seek(40);
    expect(old.currentTime).toBe(40);
    driver.seek(50, true);
    expect(old.currentTime).toBe(50);
    driver.setVolume(0.25);
    expect(old.volume).toBe(0.25);
    driver.setRate(2);
    expect(old.playbackRate).toBe(2);
    driver.setLoop(true);
    expect(old.loop).toBe(true);
    expect(driver.sample().position).toBe(50);
    expect(driver.progress()).toMatchObject({ position: 50, duration: 120 });
  });

  it('keep the volume a switch gives the new element', () => {
    playing();
    driver.setVolume(0.3);
    driver.open(swap(2, HD, null));
    const next = world.videos[1]!;
    next.becomeReady(120);
    next.startPlaying();
    expect(next.volume).toBe(0.3);
    driver.setVolume(0.8);
    expect(next.volume).toBe(0.8);
  });

  it('apply the rate and the loop to the element being prepared too', () => {
    playing();
    driver.open(swap(2, HD, 10));
    const next = world.videos[1]!;
    driver.setRate(2);
    driver.setLoop(true);
    expect(next.playbackRate).toBe(2);
    expect(next.loop).toBe(true);
  });

  it('read the play attempt and the tap of the element on screen', async () => {
    const old = playing();
    old.playBehavior = 'block';
    driver.play();
    await expect(driver.lastPlayAttempt).resolves.toBe('blocked');
    driver.lastPlayAttempt = null;
    expect(driver.lastPlayAttempt).toBeNull();
    driver.tapped = true;
    expect(driver.tapped).toBe(true);
    expect(driver.isStreamed).toBe(false);
  });

  it('leave the element alone for the calls only the routing driver makes', () => {
    const old = playing();
    driver.setVideoEnabled();
    driver.switchOutput();
    expect(old.paused).toBe(false);
    expect(old.src).toBe(SD);
  });
});

describe('releasing', () => {
  it('releaseConnection and unload empty the element and drop a switch', () => {
    const old = playing();
    driver.open(swap(2, HD, 10));
    const next = world.videos[1]!;
    next.becomeReady(120);

    driver.releaseConnection();
    expect(old.src).toBe('');
    expect(next.src).toBe('');

    driver.open(open(3, SD));
    driver.open(swap(4, HD, 10));
    expect(next.src).toBe(HD);
    driver.unload();
    expect(old.src).toBe('');
    expect(next.src).toBe('');
  });

  it('destroy empties both elements and ends the wait for the picture', () => {
    const old = playing();
    driver.open(swap(2, HD, 10));
    const next = world.videos[1]!;
    next.becomeReady(120);

    driver.destroy();
    expect(old.src).toBe('');
    expect(next.src).toBe('');
    old.currentTime = 11.5;
    jest.advanceTimersByTime(1000);
    expect(next.plays).toBe(0);
  });

  it('destroy works before any switch made a second element', () => {
    const old = playing();
    driver.destroy();
    expect(old.src).toBe('');
    expect(world.videos).toHaveLength(1);
  });
});

describe('what the elements report', () => {
  it('goes to the player as it is, tagged with its generation', () => {
    const error = engineError('NETWORK_ERROR', 'offline', true);
    const metadata = { raw: {} } as never;
    const info = { width: 1, height: 1, hdr: false, variantId: null };
    const cues = [] as never;
    const license = { requestId: 'r' } as never;
    proxy.onBuffering(1);
    proxy.onEnded(1);
    proxy.onFailed(1, error);
    proxy.onPausedExternally(1, 'system');
    proxy.onStreamMetadata(1, metadata);
    proxy.onDiscontinuity(1, 4);
    proxy.onNote(1, 'event', { a: 'b' });
    proxy.onElementReplaced(world.elements[0]!);
    proxy.onVideoInfo?.(1, info);
    proxy.onFirstFrame?.(1);
    proxy.onVariants?.(1, []);
    proxy.onBandwidth?.(1, 2_000_000);
    proxy.onTracks?.(1, []);
    proxy.onSourceCues?.(1, cues);
    proxy.onUserCommand?.(1, 'seek', 7);
    proxy.onLicenseRequest?.(1, license);
    proxy.onWarning?.(1, error);
    proxy.onPlaying(1);
    proxy.onReady(1, { duration: 5, isLive: false, seekable: true });

    expect(rec.calls.map((c) => c.name)).toEqual([
      'onBuffering',
      'onEnded',
      'onFailed',
      'onPausedExternally',
      'onStreamMetadata',
      'onDiscontinuity',
      'onNote',
      'onElementReplaced',
      'onVideoInfo',
      'onFirstFrame',
      'onVariants',
      'onBandwidth',
      'onTracks',
      'onSourceCues',
      'onUserCommand',
      'onLicenseRequest',
      'onWarning',
      'onPlaying',
      'onReady',
    ]);
    expect(rec.of('onFailed')).toEqual([[1, error]]);
    expect(rec.of('onWarning')).toEqual([[1, error]]);
    expect(rec.of('onUserCommand')).toEqual([[1, 'seek', 7]]);
    expect(rec.of('onBandwidth')).toEqual([[1, 2_000_000]]);
    expect(rec.of('onNote')).toEqual([[1, 'event', { a: 'b' }]]);
  });

  it('is told only what a player listens to', () => {
    setup(false);
    const error = engineError('NETWORK_ERROR', 'offline', true);
    const callAll = () => {
      proxy.onVideoInfo?.(1, {
        width: 1,
        height: 1,
        hdr: false,
        variantId: null,
      });
      proxy.onFirstFrame?.(1);
      proxy.onVariants?.(1, []);
      proxy.onBandwidth?.(1, 1);
      proxy.onTracks?.(1, []);
      proxy.onSourceCues?.(1, []);
      proxy.onUserCommand?.(1, 'play', 0);
      proxy.onLicenseRequest?.(1, {} as never);
      proxy.onWarning?.(1, error);
    };
    expect(callAll).not.toThrow();
    expect(rec.calls).toEqual([]);
  });

  it('does not take over for an element that is not being switched to', () => {
    playing();
    rec.calls.length = 0;
    proxy.onPlaying(1);
    proxy.onReady(1, { duration: 5, isLive: false, seekable: true });
    expect(shows).toEqual([]);
    expect(rec.names()).toEqual(['onPlaying', 'onReady']);
  });
});

/** The page runs in Firefox (or, `false`, in Chrome as the fake browser does). */
function firefox(on = true): void {
  (globalThis.navigator as unknown as { userAgent: string }).userAgent = on
    ? 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0'
    : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
}

describe('a live switch', () => {
  beforeEach(() => {
    uninstall();
    fed = true;
    setup();
  });

  afterEach(() => {
    fed = null;
  });

  /**
   * Two connections of one station on the fake elements: the old one heard
   * (`oldLag` s behind its buffered edge), the new one with a burst of
   * `burst` s arriving at 8× real time, then at real time. Each tick moves
   * both playheads as the elements would and the clock by 40 ms.
   */
  function stations(oldLag: number, burst: number, required = false) {
    const old = playing(SD, 50);
    old.readyState = 4;
    driver.open({ ...swap(2, HD, null), required });
    const next = world.videos[1]!;
    let t = 0;
    let flowing = false;
    const update = () => {
      old.plainBuffered = ranges([[0, old.currentTime + oldLag]]);
      const received = Math.min(8 * t, burst + t);
      next.plainBuffered = ranges([[0, received]]);
      next.readyState = 4;
    };
    update();
    next.becomeReady(Number.POSITIVE_INFINITY);
    next.readyState = 4;
    const tick = (ms = 40) => {
      for (let done = 0; done < ms; done += 40) {
        t += 0.04;
        if (driver.element === old && !old.paused) old.currentTime += 0.04;
        if (!next.paused) {
          if (!flowing) next.startPlaying();
          flowing = true;
          next.currentTime += 0.04 * next.playbackRate;
        } else {
          flowing = false;
        }
        update();
        jest.advanceTimersByTime(40);
      }
    };
    return { old, next, tick };
  }

  it('moves a new connection that is behind within what it holds, holds it, and takes over by volume alone', () => {
    firefox();
    driver.setVolume(0.7);
    const { old, next, tick } = stations(1.6, 17);
    rec.calls.length = 0;
    for (let i = 0; i < 400 && next.currentTime === 0; i++) tick(40);
    // Lined up first: the burst settled, then it was moved just ahead and is held.
    expect(next.currentTime).toBeGreaterThan(5);
    expect(next.paused).toBe(true);
    // Firefox: not muted but −80 dB (its clock slips when a silent element is heard again).
    expect(next.muted).toBe(false);
    expect(next.volume).toBe(0.0001);
    expect(driver.element).toBe(old);
    expect(rec.of('onPlaying')).toEqual([]);
    const before = driver.sample().position;
    for (let i = 0; i < 400 && driver.element !== next; i++) tick(40);
    expect(driver.element).toBe(next);
    expect(next.muted).toBe(false);
    expect(next.volume).toBe(0.7);
    expect(next.playbackRate).toBe(1);
    // Muted at once (iPhone Safari ignores the volume), released once its
    // last audio is out, and unmuted for the next switch.
    expect(old.muted).toBe(true);
    expect(old.paused).toBe(false);
    jest.advanceTimersByTime(300);
    expect(old.src).toBe('');
    expect(old.paused).toBe(true);
    expect(old.muted).toBe(false);
    expect(rec.of('onPlaying')).toEqual([[2]]);
    expect(rec.of('onDiscontinuity')).toEqual([]);
    const aligned = rec
      .of('onNote')
      .find((call) => call[1] === 'quality switch aligned');
    expect(aligned).toBeDefined();
    // What the new one plays is what the old one did: k maps the timelines.
    const details = aligned![2] as { residual: string; offset: string };
    expect(Math.abs(Number(details.residual))).toBeLessThanOrEqual(0.05);
    expect(Number(details.offset)).toBeCloseTo(17 - 50 - 1.6, 0);
    // The position goes on (it does not jump to the new connection's time).
    expect(driver.sample().position).toBeGreaterThan(before);
    expect(driver.sample().position).toBeLessThan(before + 5);
  });

  it('runs a new connection that is behind faster in WebKit rather than moving it', () => {
    (globalThis.navigator as unknown as { userAgent: string }).userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
    const { next, tick } = stations(1.6, 17);
    for (let i = 0; i < 400 && next.paused; i++) tick(40);
    expect(next.playbackRate).toBe(4);
    expect(next.muted).toBe(true);
    for (let i = 0; i < 600 && driver.element !== next; i++) tick(40);
    expect(driver.element).toBe(next);
    expect(rec.of('onDiscontinuity')).toEqual([]);
  });

  it('keeps catching up at its multiple of the app rate when the app changes it', () => {
    (globalThis.navigator as unknown as { userAgent: string }).userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
    const { next, tick } = stations(1.6, 17);
    for (let i = 0; i < 400 && next.paused; i++) tick(40);
    expect(next.playbackRate).toBe(4);
    driver.setRate(1.25);
    expect(next.playbackRate).toBe(5);
  });

  it('tells the title the new element reached once it is heard', () => {
    const { next, tick } = stations(17, 1.6);
    tick(4_000);
    const metadata = { title: 'Song B', artist: null, raw: {} } as never;
    proxy.onStreamMetadata(2, metadata);
    for (let i = 0; i < 600 && driver.element !== next; i++) tick(40);
    expect(driver.element).toBe(next);
    expect(rec.of('onStreamMetadata').at(-1)).toEqual([2, metadata]);
  });

  it('does not tell an older title again when the old element told a later one since', () => {
    const { next, tick } = stations(17, 1.6);
    tick(4_000);
    const a = { title: 'Song A', artist: null, raw: {} } as never;
    const b = { title: 'Song B', artist: null, raw: {} } as never;
    proxy.onStreamMetadata(2, a);
    proxy.onStreamMetadata(1, b);
    for (let i = 0; i < 600 && driver.element !== next; i++) tick(40);
    expect(driver.element).toBe(next);
    expect(rec.of('onStreamMetadata').at(-1)).toEqual([1, b]);
  });

  it('mutes the new element outside Firefox', () => {
    firefox(false);
    const { next, tick } = stations(17, 1.6);
    tick(5_000);
    expect(next.muted).toBe(true);
    for (let i = 0; i < 600 && driver.element !== next; i++) tick(40);
    expect(driver.element).toBe(next);
    expect(next.muted).toBe(false);
  });

  it('mutes the new element in Firefox too where the page may not play audible media yet', async () => {
    firefox();
    const { next, tick } = stations(1.6, 17);
    // Audible playback needs the user's activation (WebKit): refused.
    const play = next.play.bind(next);
    next.play = () =>
      next.muted
        ? play()
        : Promise.reject(
            Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
          );
    for (let i = 0; i < 400 && next.paused; i++) {
      tick(40);
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(next.muted).toBe(true);
    expect(next.paused).toBe(false);
    for (let i = 0; i < 400 && driver.element !== next; i++) tick(40);
    expect(driver.element).toBe(next);
    expect(next.muted).toBe(false);
  });

  it.each([
    ['the player needs it', true],
    ['it could wait (it never can be lined up)', false],
  ])(
    'switches a station on a plain <audio> anyway when %s, and reports the jump',
    (_why, required) => {
      fed = false;
      uninstall();
      setup();
      const { next, tick } = stations(1.6, 17, required);
      expect(next.paused).toBe(false);
      expect(rec.of('onNote')).toContainEqual([
        2,
        'quality switch not aligned',
        { reason: 'plain' },
      ]);
      tick(40);
      expect(driver.element).toBe(next);
      expect(rec.of('onFailed')).toEqual([]);
      // The position goes on from where the old one was.
      expect(rec.of('onDiscontinuity')).toEqual([
        [2, expect.closeTo(50, 0), 'switch', null],
      ]);
    }
  );

  it('switches an adaptive source (HLS, DASH) at once, as before, even when it could wait', () => {
    const spy = jest
      .spyOn(MediaElementDriver.prototype, 'alignReading')
      .mockReturnValue(null);
    try {
      const { next, tick } = stations(1.6, 17);
      expect(next.paused).toBe(false);
      expect(rec.of('onNote')).toContainEqual([
        2,
        'quality switch not aligned',
        { reason: 'adaptive' },
      ]);
      tick(40);
      expect(driver.element).toBe(next);
      expect(rec.of('onFailed')).toEqual([]);
      expect(rec.of('onDiscontinuity')).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it('lines up HLS or DASH renditions by their program dates: moved, held, taken over unheard', () => {
    const real = MediaElementDriver.prototype.alignReading;
    // The new rendition's timeline is 40 s behind the old one's on the stream's clock.
    const spy = jest
      .spyOn(MediaElementDriver.prototype, 'alignReading')
      .mockImplementation(function (this: MediaElementDriver) {
        const r = real.call(this);
        const isNext = this.element === world.videos[1];
        return r && { ...r, clock: isNext ? 1_000_040 : 1_000_000 };
      });
    try {
      const { old, next, tick } = stations(1.6, 17);
      for (let i = 0; i < 400 && driver.element === old; i++) tick(40);
      expect(driver.element).toBe(next);
      // What the old one played (50 s on) is at 10 s on the new one's timeline.
      expect(next.currentTime).toBeCloseTo(old.currentTime - 40, 0);
      expect(rec.of('onDiscontinuity')).toEqual([]);
      expect(rec.of('onFailed')).toEqual([]);
      const aligned = rec
        .of('onNote')
        .find((n) => n[1] === 'quality switch aligned');
      expect(aligned).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('holds a new connection that is ahead until the old one gets there', () => {
    const { old, next, tick } = stations(17, 1.6);
    tick(10_000);
    expect(next.paused).toBe(true);
    expect(driver.element).toBe(old);
    tick(10_000);
    expect(driver.element).toBe(next);
    expect(rec.of('onDiscontinuity')).toEqual([]);
  });

  it('takes over at once, as a discontinuity, when the old one stalls while it lines up', () => {
    const { old, next, tick } = stations(17, 1.6);
    tick(5_000);
    expect(next.paused).toBe(true);
    old.readyState = 2;
    tick(40);
    expect(next.paused).toBe(false);
    expect(rec.of('onNote')).toContainEqual([
      2,
      'quality switch not aligned',
      { reason: 'stalled', gap: expect.any(String) },
    ]);
    tick(40);
    expect(driver.element).toBe(next);
    expect(rec.of('onPlaying').at(-1)).toEqual([2]);
    expect(rec.of('onDiscontinuity')).toHaveLength(1);
    expect(rec.of('onDiscontinuity')[0]![0]).toBe(2);
  });

  it('tells a fallback’s jump before the title the new connection reached, which is heard after it', () => {
    const { old, next, tick } = stations(17, 1.6);
    tick(4_000);
    const metadata = { title: 'Song B', artist: null, raw: {} } as never;
    proxy.onStreamMetadata(2, metadata);
    tick(1_000);
    rec.calls.length = 0;
    old.readyState = 2;
    tick(80);
    expect(driver.element).toBe(next);
    const told = rec.calls
      .map((c) => c.name)
      .filter(
        (name) => name === 'onDiscontinuity' || name === 'onStreamMetadata'
      );
    expect(told).toEqual(['onDiscontinuity', 'onStreamMetadata']);
  });

  it('gives up lining up when a connection jumps: switched anyway when needed, the jump unknown', () => {
    const { next, tick } = stations(17, 1.6, true);
    tick(5_000);
    expect(next.paused).toBe(true);
    proxy.onDiscontinuity(1, 40);
    // Held: it plays at once and takes over on its first audio.
    expect(next.paused).toBe(false);
    tick(40);
    expect(driver.element).toBe(next);
    const calls = rec.of('onDiscontinuity');
    expect(calls.map((call) => [call[0], call[2]])).toEqual([
      [1, undefined],
      [2, 'switch'],
    ]);
    // The gap read before the jump belongs to a mapping that no longer holds.
    expect(calls[1]![3]).toBeNull();
  });

  it('drops the jump of a switch already given up when a connection jumps before it takes over', () => {
    const { old, next, tick } = stations(17, 1.6);
    tick(5_000);
    expect(next.paused).toBe(true);
    // The old one stalls: given up and needed, it plays to take over on its first audio.
    old.pause();
    tick(40);
    expect(next.paused).toBe(false);
    expect(driver.element).toBe(old);
    proxy.onDiscontinuity(2, 40);
    tick(40);
    expect(driver.element).toBe(next);
    const calls = rec.of('onDiscontinuity');
    expect(calls.at(-1)![2]).toBe('switch');
    expect(calls.at(-1)![3]).toBeNull();
  });

  it('gives up an optional switch when a connection jumps: the current one plays on', () => {
    const { old, tick } = stations(17, 1.6);
    tick(5_000);
    proxy.onDiscontinuity(1, 40);
    expect(rec.of('onFailed').map((call) => call[0])).toEqual([2]);
    expect(driver.element).toBe(old);
  });

  it('is dropped with the switch: a pause cancels the lining up', () => {
    const { old, next, tick } = stations(17, 1.6);
    tick(5_000);
    driver.cancelSwap(2);
    tick(20_000);
    expect(driver.element).toBe(old);
    expect(next.src).toBe('');
    expect(rec.of('onPlaying').filter((call) => call[0] === 2)).toEqual([]);
  });
});

describe("the queue's next item", () => {
  const NEXT = 'https://cdn.example/next.mp4';

  it('opens paused on the spare element and plays from it when the current item ends', () => {
    const first = playing();
    driver.setVolume(0.7);
    driver.prepareNext(open(5, NEXT));
    const next = world.videos[1]!;
    expect(next.src).toBe(NEXT);
    expect(next.plays).toBe(0);
    next.becomeReady(200);
    expect(rec.of('onReady').map((a) => a[0])).toEqual([1, 5]);
    expect(driver.element).toBe(first);

    first.dispatch('ended');
    expect(rec.of('onEnded').map((a) => a[0])).toEqual([1]);
    driver.advance(5);
    expect(next.plays).toBe(1);
    expect(next.volume).toBe(0.7);
    expect(driver.element).toBe(next);
    expect(shows).toEqual([[next, first]]);
    expect(first.src).toBe('');
    next.startPlaying();
    expect(rec.of('onPlaying').map((a) => a[0])).toEqual([1, 5]);
  });

  it('a cancelled next item empties the spare; an advance to it then does nothing', () => {
    playing();
    driver.prepareNext(open(5, NEXT));
    driver.cancelNext(5);
    expect(world.videos[1]!.src).toBe('');
    driver.advance(5);
    expect(driver.element).toBe(world.videos[0]);
  });

  it('a quality switch takes the spare: the next item opens on the current element when its turn comes', () => {
    const first = playing();
    driver.prepareNext(open(5, NEXT));
    driver.open(swap(2, HD, 10));
    expect(world.videos[1]!.src).toBe(HD);
    driver.cancelSwap(2);
    driver.advance(5);
    expect(driver.element).toBe(first);
    expect(first.src).toBe(NEXT);
  });

  it('a new open drops the prepared item', () => {
    playing();
    driver.prepareNext(open(5, NEXT));
    driver.open(open(6, UHD, { playWhenReady: true }));
    expect(world.videos[1]!.src).toBe('');
    driver.advance(5);
    expect((driver.element as FakeVideo).src).toBe(UHD);
  });
});
