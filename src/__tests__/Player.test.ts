import { AppState, Image } from 'react-native';
import { fake } from './FakeNative';

jest.mock('../native/NativeAirwave', () => ({
  __esModule: true,
  default: require('./FakeNative').fake,
}));

import {
  Player,
  _livePlayerCount,
  normalizeNowPlaying,
  normalizeSource,
} from '../Player';
import { PlayerError, isPlayerError } from '../errors';

const flush = () => new Promise<void>((r) => setImmediate(() => r()));

beforeEach(() => {
  fake.calls = [];
  fake.rejectNext = null;
});

describe('Player lifecycle', () => {
  it('creates a native player, subscribes to native events once for all players', async () => {
    const a = new Player({ recovery: { reconnect: false } });
    const b = new Player();
    expect(a.id).not.toBe(b.id);
    expect(fake.subscribeCount).toBe(1);
    expect(fake.calls[0]).toEqual([
      'createPlayer',
      { recovery: { reconnect: false } },
    ]);
    await a.release();
    await b.release();
  });

  it('starts diagnostics when asked to', async () => {
    const p = new Player({ diagnostics: true });
    expect(fake.calls).toContainEqual(['setDiagnosticsEnabled', p.id, true]);
    p.setDiagnosticsEnabled(false);
    expect(fake.calls).toContainEqual(['setDiagnosticsEnabled', p.id, false]);
    expect(p.getDiagnostics()).toHaveLength(1);
    await p.release();
  });

  it('release frees the native player, clears listeners and rejects later commands', async () => {
    const before = _livePlayerCount();
    const p = new Player();
    expect(_livePlayerCount()).toBe(before + 1);
    p.on('status', () => {});
    expect(p.listenerCount()).toBe(1);
    await p.release();
    await p.release(); // idempotent
    expect(p.isReleased).toBe(true);
    expect(_livePlayerCount()).toBe(before);
    expect(p.listenerCount()).toBe(0);
    expect(fake.calls.filter((c) => c[0] === 'releasePlayer')).toHaveLength(1);
    await expect(p.play()).rejects.toMatchObject({ code: 'PLAYER_RELEASED' });
    await expect(p.load('https://x.example/a.mp3')).rejects.toMatchObject({
      code: 'PLAYER_RELEASED',
    });
    await expect(p.updateNowPlaying({ title: 'x' })).rejects.toMatchObject({
      code: 'PLAYER_RELEASED',
    });
    expect(p.getDiagnostics()).toEqual([]);
    expect(p.refresh()).toBe(p.status);
    // Events for a released player are ignored.
    const seen = jest.fn();
    p.on('status', seen);
    fake.emitStatus(p.id, { seq: 99, state: 'playing' });
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('status mirroring', () => {
  it('applies newer snapshots and drops stale or duplicate ones', async () => {
    const p = new Player();
    const states: string[] = [];
    const changes: Array<[string, string]> = [];
    p.on('status', (s) => states.push(s.state));
    p.on('stateChange', (s, prev) => changes.push([s, prev]));
    fake.emitStatus(p.id, { seq: 5, state: 'loading' });
    fake.emitStatus(p.id, { seq: 4, state: 'error' }); // stale: older than 5
    fake.emitStatus(p.id, { seq: 5, state: 'error' }); // duplicate
    fake.emitStatus(p.id, { seq: 6, state: 'loading', volume: 0.5 }); // same state, other field
    fake.emitStatus(p.id, { seq: 7, state: 'playing' });
    expect(states).toEqual(['loading', 'loading', 'playing']);
    expect(changes).toEqual([
      ['loading', 'idle'],
      ['playing', 'loading'],
    ]);
    expect(p.state).toBe('playing');
    expect(p.status.volume).toBe(0.5);
    expect('playerId' in p.status).toBe(false);
    expect('type' in p.status).toBe(false);
    await p.release();
  });

  it('a command result is applied unless an event already delivered something newer', async () => {
    const p = new Player();
    await p.play();
    expect(p.playWhenReady).toBe(true);
    expect(p.state).toBe('buffering');
    fake.emitStatus(p.id, { seq: 50, state: 'playing' });
    // A late command result with an older seq must not roll the state back.
    fake.statuses.set(p.id, { ...fake.statuses.get(p.id)!, seq: 10 });
    await p.pause();
    expect(p.state).toBe('playing');
    await p.release();
  });

  it('routes events by player id', async () => {
    const a = new Player();
    const b = new Player();
    fake.emitStatus(a.id, { seq: 1, state: 'playing' });
    expect(a.state).toBe('playing');
    expect(b.state).toBe('idle');
    fake.emit({ type: 'status', seq: 1, state: 'playing' }); // no playerId: ignored
    fake.emit({
      playerId: 'unknown',
      type: 'status',
      seq: 1,
      state: 'playing',
    });
    await a.release();
    await b.release();
  });

  it('refresh adopts the native snapshot (e.g. after JS was suspended)', async () => {
    const p = new Player();
    fake.statuses.set(p.id, {
      ...fake.statuses.get(p.id)!,
      seq: 9,
      state: 'reconnecting',
    });
    fake.metadata.set(p.id, { title: 'T', timestamp: 42 });
    expect(p.refresh().state).toBe('reconnecting');
    expect(p.metadata?.title).toBe('T');
    await p.release();
  });

  it('refreshes every player when the app becomes active', async () => {
    const p = new Player();
    fake.statuses.set(p.id, {
      ...fake.statuses.get(p.id)!,
      seq: 3,
      state: 'playing',
    });
    const listener = (AppState.addEventListener as jest.Mock).mock.calls.find(
      (c) => c[0] === 'change'
    )?.[1];
    expect(listener).toBeDefined();
    listener('background');
    expect(p.state).toBe('idle');
    listener('active');
    expect(p.state).toBe('playing');
    await p.release();
  });
});

describe('events', () => {
  it('maps metadata, error, ended, remote commands and diagnostics', async () => {
    const p = new Player();
    const got: unknown[] = [];
    p.on('metadata', (m) => got.push(['metadata', m.title]));
    p.on('error', (e, info) =>
      got.push(['error', e.code, e.recoverable, e.nativeCause, info.fatal])
    );
    p.on('ended', () => got.push(['ended']));
    p.on('remoteCommand', (c) => got.push(['remote', c.command, c.position]));
    p.on('diagnostic', (d) => got.push(['diagnostic', d.event]));
    fake.emit({
      playerId: p.id,
      seq: 1,
      type: 'metadata',
      metadata: { title: 'Song', timestamp: 1 },
    });
    fake.emit({
      playerId: p.id,
      seq: 2,
      type: 'error',
      fatal: false,
      error: {
        code: 'NETWORK_ERROR',
        message: 'lost',
        recoverable: true,
        cause: 'NSURLErrorDomain(-1005)',
      },
    });
    fake.emit({ playerId: p.id, seq: 3, type: 'ended' });
    fake.emit({
      playerId: p.id,
      seq: 4,
      type: 'remoteCommand',
      command: 'seek',
      position: 12,
    });
    fake.emit({
      playerId: p.id,
      seq: 5,
      type: 'diagnostic',
      entry: { event: 'transition' },
    });
    fake.emit({ playerId: p.id, seq: 6, type: 'something-new' });
    expect(got).toEqual([
      ['metadata', 'Song'],
      ['error', 'NETWORK_ERROR', true, 'NSURLErrorDomain(-1005)', false],
      ['ended'],
      ['remote', 'seek', 12],
      ['diagnostic', 'transition'],
    ]);
    expect(p.metadata?.title).toBe('Song');
    await p.release();
  });

  it('streams decoded-audio windows while sampling is on', async () => {
    const p = new Player();
    expect(p.setAudioSampling({ enabled: true })).toBe(true);
    expect(fake.calls).toContainEqual(['setAudioSampling', p.id, true, 1024]);
    p.setAudioSampling({ enabled: true, points: 256 });
    expect(fake.calls).toContainEqual(['setAudioSampling', p.id, true, 256]);
    expect(() => p.setAudioSampling({ enabled: true, points: NaN })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
    const windows: unknown[] = [];
    p.on('audioSample', (w) => windows.push(w));
    fake.emit({
      playerId: p.id,
      type: 'audioSample',
      waveform: [0, 0.5, -0.5],
      level: 0.4,
      duration: 0.023,
      outputLatency: 0.12,
      timestamp: 7,
    });
    expect(windows).toEqual([
      {
        waveform: [0, 0.5, -0.5],
        level: 0.4,
        duration: 0.023,
        outputLatency: 0.12,
        timestamp: 7,
      },
    ]);
    await p.release();
    expect(p.setAudioSampling({ enabled: true })).toBe(false);
  });

  it('passes progressInterval to native and maps progress events', async () => {
    expect(() => new Player({ progressInterval: -1 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
    expect(() => new Player({ progressInterval: NaN })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
    const p = new Player({ progressInterval: 1000 });
    expect(fake.calls).toContainEqual([
      'createPlayer',
      expect.objectContaining({ progressInterval: 1000 }),
    ]);
    const readings: unknown[] = [];
    p.on('progress', (r) => readings.push(r));
    fake.emit({
      playerId: p.id,
      type: 'progress',
      position: 12.5,
      duration: null,
      buffered: 18,
      bufferedAhead: 5.5,
      liveOffset: null,
      timestamp: 9,
      seq: 4,
    });
    expect(readings).toEqual([
      {
        position: 12.5,
        duration: null,
        buffered: 18,
        bufferedAhead: 5.5,
        liveOffset: null,
        timestamp: 9,
      },
    ]);
    await p.release();
  });

  it('a throwing listener does not break other listeners', async () => {
    jest.useFakeTimers();
    const p = new Player();
    const second = jest.fn();
    p.on('status', () => {
      throw new Error('boom');
    });
    p.on('status', second);
    fake.emitStatus(p.id, { seq: 1, state: 'playing' });
    expect(second).toHaveBeenCalledTimes(1);
    expect(() => jest.runOnlyPendingTimers()).toThrow('boom');
    jest.useRealTimers();
    await p.release();
  });

  it('unsubscribe removes exactly that listener', async () => {
    const p = new Player();
    const a = jest.fn();
    const off = p.on('status', a);
    expect(p.listenerCount('status')).toBe(1);
    off();
    off();
    expect(p.listenerCount('status')).toBe(0);
    await p.release();
  });
});

describe('commands', () => {
  it('passes commands through in order with validated arguments', async () => {
    const p = new Player();
    fake.calls = [];
    await p.load(
      {
        uri: ' https://radio.example/live ',
        live: true,
        headers: { 'User-Agent': 'x' },
      },
      { autoplay: true, startPosition: 3 }
    );
    await p.play();
    await p.seekTo(10);
    await p.setVolume(0.3);
    await p.setMuted(true);
    await p.setRate(1.5);
    await p.stop();
    await p.reset();
    await p.updateNowPlaying({
      title: 'Station',
      artwork: { uri: 'https://img.example/a.png' },
    });
    expect(fake.calls.map((c) => c[0])).toEqual([
      'load',
      'play',
      'seekTo',
      'setVolume',
      'setMuted',
      'setRate',
      'stop',
      'reset',
      'updateNowPlaying',
    ]);
    expect(fake.calls[0]).toEqual([
      'load',
      p.id,
      {
        uri: 'https://radio.example/live',
        live: true,
        headers: { 'User-Agent': 'x' },
      },
      { autoplay: true, startPosition: 3 },
    ]);
    expect(fake.calls[8]![2]).toEqual({
      title: 'Station',
      artwork: 'https://img.example/a.png',
    });
    await p.release();
  });

  it('toggle follows the play intent', async () => {
    const p = new Player();
    await p.toggle();
    expect(fake.calls.at(-1)![0]).toBe('play');
    await p.toggle();
    expect(fake.calls.at(-1)![0]).toBe('pause');
    await p.release();
  });

  it('normalizes native rejections into PlayerError with native details', async () => {
    const p = new Player();
    fake.rejectNext = {
      code: 'AUDIO_FOCUS_DENIED',
      message: 'The system refused audio focus',
      userInfo: {
        recoverable: true,
        platform: 'android',
        platformCode: 7,
        platformDomain: 'focus',
        cause: 'call',
      },
    };
    const error = await p.play().catch((e) => e);
    expect(isPlayerError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'AUDIO_FOCUS_DENIED',
      recoverable: true,
      platform: 'android',
      platformCode: 7,
      nativeCause: 'call',
    });
    fake.rejectNext = { code: 'WEIRD', message: 'unknown failure' };
    await expect(p.updateNowPlaying({})).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      recoverable: false,
    });
    await p.release();
  });

  it('rejects invalid arguments before reaching native', async () => {
    const p = new Player();
    fake.calls = [];
    await expect(p.seekTo(Number.NaN)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(p.setVolume(Infinity)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(p.setRate(Number.NaN)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(
      p.load('https://a.example/x.mp3', { startPosition: Number.NaN })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fake.calls).toEqual([]);
    await p.release();
  });

  it('progress is a synchronous native read', async () => {
    const p = new Player();
    expect(p.getProgress()).toMatchObject({
      position: 12.5,
      bufferedAhead: 7.5,
    });
    await p.release();
  });
});

describe('source normalization', () => {
  it('accepts strings, objects, absolute paths and resource names', () => {
    expect(normalizeSource('https://a.example/x.mp3')).toEqual({
      uri: 'https://a.example/x.mp3',
    });
    expect(normalizeSource('file:///data/x.mp3')).toEqual({
      uri: 'file:///data/x.mp3',
    });
    expect(normalizeSource('content://media/1')).toEqual({
      uri: 'content://media/1',
    });
    expect(normalizeSource('/var/mobile/x.mp3')).toEqual({
      uri: '/var/mobile/x.mp3',
    });
    expect(normalizeSource('assets_tone')).toEqual({ uri: 'assets_tone' });
    expect(
      normalizeSource({ uri: 'HTTPS://A.example/x', live: false })
    ).toEqual({ uri: 'HTTPS://A.example/x', live: false });
  });

  it('resolves required assets', () => {
    const spy = jest.spyOn(Image, 'resolveAssetSource').mockReturnValue({
      uri: 'http://localhost:8081/assets/a.mp3',
      width: 0,
      height: 0,
      scale: 1,
    });
    expect(normalizeSource(42)).toEqual({
      uri: 'http://localhost:8081/assets/a.mp3',
    });
    expect(normalizeNowPlaying({ artwork: 7 })).toEqual({
      artwork: 'http://localhost:8081/assets/a.mp3',
    });
    spy.mockReturnValue(null as never);
    expect(() => normalizeSource(43)).toThrow(PlayerError);
    spy.mockRestore();
  });

  it('rejects empty and unsupported sources', () => {
    expect(() => normalizeSource('')).toThrow(
      expect.objectContaining({ code: 'INVALID_SOURCE' })
    );
    expect(() => normalizeSource({ uri: '   ' })).toThrow(
      expect.objectContaining({ code: 'INVALID_SOURCE' })
    );
    expect(() => normalizeSource({} as never)).toThrow(
      expect.objectContaining({ code: 'INVALID_SOURCE' })
    );
    expect(() => normalizeSource('ftp://a.example/x.mp3')).toThrow(
      expect.objectContaining({ code: 'INVALID_SOURCE' })
    );
    expect(() => normalizeSource('mailto:someone@example.com')).toThrow(
      expect.objectContaining({ code: 'INVALID_SOURCE' })
    );
  });

  it('normalizes now-playing metadata', () => {
    expect(
      normalizeNowPlaying({
        title: 'T',
        artist: 'A',
        album: 'B',
        artwork: 'https://i.example/a.png',
      })
    ).toEqual({
      title: 'T',
      artist: 'A',
      album: 'B',
      artwork: 'https://i.example/a.png',
    });
    expect(normalizeNowPlaying({})).toEqual({});
    expect(
      normalizeSource({ uri: 'https://a.example/s', metadata: { title: 'S' } })
    ).toEqual({ uri: 'https://a.example/s', metadata: { title: 'S' } });
  });

  it('passes song progress for the lock screen and validates it', () => {
    expect(normalizeNowPlaying({ duration: 205.9, elapsed: 12.5 })).toEqual({
      duration: 205.9,
      elapsed: 12.5,
    });
    // Negative readings clamp; elapsed without a duration means nothing.
    expect(normalizeNowPlaying({ duration: 30, elapsed: -2 })).toEqual({
      duration: 30,
      elapsed: 0,
    });
    expect(normalizeNowPlaying({ elapsed: 5 })).toEqual({});
    expect(() => normalizeNowPlaying({ duration: Number.NaN })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
    expect(() =>
      normalizeNowPlaying({ duration: 10, elapsed: Infinity })
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }));
  });
});

describe('errors', () => {
  it('serializes and survives arbitrary thrown values', async () => {
    const { toPlayerError } = await import('../errors');
    const e = new PlayerError({
      code: 'TIMEOUT',
      message: 't',
      recoverable: true,
      httpStatus: 504,
    });
    expect(e.toJSON()).toMatchObject({
      code: 'TIMEOUT',
      recoverable: true,
      httpStatus: 504,
    });
    expect(toPlayerError(e)).toBe(e);
    expect(toPlayerError('plain string')).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'plain string',
    });
    expect(toPlayerError(null)).toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(
      toPlayerError({
        userInfo: { code: 'HTTP_ERROR', message: 'm', recoverable: false },
      })
    ).toMatchObject({ code: 'HTTP_ERROR', message: 'm' });
    await flush();
  });
});
