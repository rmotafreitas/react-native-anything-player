/// <reference types="node" />
// SwapDriver: a quality switch between separate files of one video. The new
// file opens behind the picture, waits for the picture to reach it, and takes
// over on its first frame; a stalled picture, a late or failing file, an
// abandoned switch and a released driver are handled on the same two elements.

import { uninstall } from './FakeBrowser';
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

function setup(optional = true): void {
  world = installVideo();
  rec = recorder(optional);
  shows = [];
  driver = new SwapDriver(
    rec.observer,
    (observer) => {
      proxy = observer;
      return new MediaElementDriver(observer, 'artist-title', 'video');
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

  it('starts the new file at once on a live stream', () => {
    playing();
    driver.open(swap(2, HD, null));
    const next = world.videos[1]!;
    next.becomeReady(Number.POSITIVE_INFINITY);
    expect(next.currentTime).toBe(0);
    expect(next.plays).toBe(1);
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
    playing();
    driver.open(swap(2, HD, null));
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

  it('leaves the old element untapped for the next switch', () => {
    const old = playing();
    driver.tapped = true;
    driver.open(swap(2, HD, null));
    const next = world.videos[1]!;
    next.becomeReady(120);
    next.startPlaying();
    expect(driver.tapped).toBe(false);

    driver.open(swap(3, SD, null));
    old.becomeReady(120);
    old.startPlaying();
    expect(driver.element).toBe(old);
    expect(driver.tapped).toBe(false);
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
    proxy.onElementReplaced(world.elements[0]! as never);
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
