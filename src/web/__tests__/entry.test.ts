// The entry points: `react-native-anything-player/web` (plain pages) and the
// React Native Web module, plus option parsing.

import { FakeCast } from './FakeCast';
import { install, uninstall, type FakeWorld } from './FakeBrowser';
import {
  parseNowPlaying,
  parseOptions,
  parseSource,
} from '../platform/serialization';

let world: FakeWorld;

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  world = install({ airplay: true });
});

afterEach(() => {
  uninstall();
  jest.useRealTimers();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}

describe('react-native-anything-player/web', () => {
  it('plays with the Player API and no React Native', async () => {
    let web!: typeof import('../index');
    jest.isolateModules(() => {
      web = require('../index');
    });
    const player = new web.Player();
    expect(player.state).toBe('idle');
    const statuses: string[] = [];
    player.on('stateChange', (state) => statuses.push(state));

    const loading = player.load('https://cdn.example/song.mp3', {
      autoplay: true,
    });
    world.element().becomeReady(60);
    world.element().startPlaying();
    await flush();
    await loading;
    expect(player.state).toBe('playing');
    expect(statuses).toContain('playing');

    // Bundled assets do not exist on a plain page.
    await expect(player.load(1)).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });

    // Back in the foreground: the snapshot is read again.
    const refresh = jest.spyOn(player, 'refresh');
    world.document.visibilityState = 'hidden';
    world.document.dispatch('visibilitychange');
    expect(refresh).not.toHaveBeenCalled();
    world.document.visibilityState = 'visible';
    world.document.dispatch('visibilitychange');
    expect(refresh).toHaveBeenCalled();
    await player.release();
    expect(
      web.isPlayerError(
        new web.PlayerError({
          code: 'NO_SOURCE',
          message: '',
          recoverable: false,
        })
      )
    ).toBe(true);
  });

  it('reaches outputs and Cast without React or React Native', async () => {
    let web!: typeof import('../index');
    jest.isolateModules(() => {
      jest.doMock('react', () => {
        throw new Error('react was imported');
      });
      jest.doMock('react-native', () => {
        throw new Error('react-native was imported');
      });
      web = require('../index');
    });
    const cast = new FakeCast();
    cast.install();
    cast.setDevicesAvailable(true);
    expect(web.getCastStatus()).toEqual({ state: 'unavailable', device: null });
    const states: string[] = [];
    web.addCastStateListener((status) => states.push(status.state));
    const availability: boolean[] = [];
    web.addRoutePickerAvailabilityListener((a) => availability.push(a));
    await web.configureCast({ receiverApplicationId: 'ABCD1234' });
    expect(web.getCastStatus().state).toBe('notConnected');
    expect(cast.options.receiverApplicationId).toBe('ABCD1234');

    const player = new web.Player();
    world.element().setAirplayTargets(true);
    await flush();
    expect(web.isRoutePickerAvailable()).toBe(true);
    await web.showRoutePicker(player);
    expect(world.element().airplayPickers).toBe(1);
    await web.showCastPicker();
    expect(cast.requests).toBe(1);
    cast.connect();
    await flush();
    expect(states).toEqual([
      'initializing',
      'notConnected',
      'connecting',
      'connected',
    ]);
    await web.stopCasting();
    expect(web.getCastStatus().state).toBe('notConnected');
    expect(availability).toEqual([true]);
    await player.release();
    jest.dontMock('react');
    jest.dontMock('react-native');
  });

  it('serves the browser engine to React Native Web', () => {
    jest.isolateModules(() => {
      const { WebModule } = require('../platform/WebModule');
      expect(require('../../nativeModule.web').default).toBeInstanceOf(
        WebModule
      );
    });
  });

  it('refuses to run without a platform host', () => {
    jest.isolateModules(() => {
      const { host } = require('../../core/host');
      expect(() => host()).toThrow('no platform host installed');
    });
  });
});

describe('option parsing', () => {
  it('applies the defaults', () => {
    const options = parseOptions(undefined);
    expect(options).toMatchObject({
      engine: {
        reconnect: true,
        giveUpAfterMs: 600_000,
        autoResumeAfterInterruption: true,
        liveMaxDriftMs: 5_000,
      },
      mediaSession: true,
      titleFormat: 'artist-title',
      useStreamMetadata: true,
      progressIntervalMs: 0,
    });
    expect([...options.remoteCommands]).toEqual([]);
  });

  it('reads every option', () => {
    const options = parseOptions({
      recovery: {
        reconnect: false,
        giveUpAfterMs: null,
        liveMaxDriftMs: 9_000,
      },
      interruptions: { autoResume: false },
      mediaSession: { enabled: false, commands: ['next', 7, 'previous'] },
      metadata: {
        streamTitleFormat: 'title',
        useStreamMetadataForNowPlaying: false,
      },
      progressInterval: 250,
    });
    expect(options).toMatchObject({
      engine: {
        reconnect: false,
        giveUpAfterMs: null,
        autoResumeAfterInterruption: false,
        liveMaxDriftMs: 9_000,
      },
      mediaSession: false,
      titleFormat: 'title',
      useStreamMetadata: false,
      progressIntervalMs: 250,
    });
    expect([...options.remoteCommands]).toEqual(['next', 'previous']);
    expect(
      parseOptions({
        metadata: { streamTitleFormat: 'title-artist' },
        progressInterval: -1,
      })
    ).toMatchObject({
      titleFormat: 'title-artist',
      progressIntervalMs: 0,
    });
  });

  it('reads sources and now-playing fields', () => {
    const [source, fields] = parseSource({
      uri: 'https://a.example/x',
      headers: { Authorization: 'Bearer t', Bad: 3 },
      live: true,
      metadata: {
        title: 'T',
        artwork: { uri: 'https://img.example/a.png' },
        duration: 30,
        live: false,
      },
    });
    expect(source).toEqual({
      uri: 'https://a.example/x',
      headers: { Authorization: 'Bearer t' },
      liveHint: true,
    });
    expect(fields).toMatchObject({
      title: 'T',
      artwork: 'https://img.example/a.png',
      duration: 30,
      live: false,
    });
    expect(parseSource(null)[0]).toEqual({
      uri: '',
      headers: {},
      liveHint: null,
    });
    expect(
      parseNowPlaying({ artwork: 'https://img.example/b.png' }).artwork
    ).toBe('https://img.example/b.png');
  });
});
