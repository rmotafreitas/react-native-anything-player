import { sharedFake as fake } from './FakeSoundNative';

jest.mock('../../native/NativeAnythingPlayerSound', () => ({
  __esModule: true,
  default: require('./FakeSoundNative').sharedFake,
}));
jest.mock('react-native', () => ({
  Image: {
    resolveAssetSource: (module: number) =>
      module === 7 ? { uri: 'file:///bundle/laser.wav' } : null,
  },
  TurboModuleRegistry: { get: () => null },
}));

import { Sound, SoundClip, isPlayerError } from '../index';
import { _resetSound, installSoundBackend } from '../../core/sound';
import { nativeSoundBackend } from '../nativeBackend';

beforeEach(() => {
  fake.calls = [];
  fake.available = true;
  fake.rejectLoad = null;
  fake.nextId = 1;
  _resetSound();
  installSoundBackend(nativeSoundBackend);
});

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('did not reject');
};

describe('Sound on a native bundle', () => {
  it('loads a URI with the number of voices and returns a clip', async () => {
    const clip = await Sound.load('file:///tmp/shot.wav', { voices: 6 });
    expect(clip).toBeInstanceOf(SoundClip);
    expect(fake.last('load')).toEqual([
      'load',
      { uri: 'file:///tmp/shot.wav' },
      { voices: 6 },
    ]);
    expect(clip.duration).toBe(0.5);
    expect(clip.voices).toBe(6);
  });

  it('defaults to four voices and resolves a require()d asset', async () => {
    await Sound.load(7);
    expect(fake.last('load')).toEqual([
      'load',
      { uri: 'file:///bundle/laser.wav' },
      { voices: 4 },
    ]);
  });

  it('rejects an asset it cannot resolve, a bad URI and a Blob', async () => {
    expect(await caught(Sound.load(8))).toMatchObject({
      code: 'INVALID_SOURCE',
    });
    expect(await caught(Sound.load('  '))).toMatchObject({
      code: 'INVALID_SOURCE',
    });
    const blob = new Blob(['x']);
    expect(await caught(Sound.load(blob))).toMatchObject({
      code: 'INVALID_SOURCE',
    });
    expect(fake.calls).toEqual([]);
  });

  it('validates voices', async () => {
    for (const voices of [0, 33, 1.5, NaN])
      expect(await caught(Sound.load('a.wav', { voices }))).toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
  });

  it('plays with clamped parameters and unique voice ids', async () => {
    const clip = await Sound.load('a.wav');
    const first = clip.play({ volume: 3, rate: 9, pan: -4, loop: true });
    const second = clip.play();
    expect(fake.calls.filter((c) => c[0] === 'play')).toEqual([
      ['play', 's1', first.id, 1, 2, -1, true],
      ['play', 's1', second.id, 1, 1, 0, false],
    ]);
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ volume: 1, rate: 2, pan: -1 });
    clip.play({ rate: 0.1 });
    expect(fake.last('play')?.[4]).toBe(0.5);
  });

  it('rejects non-finite parameters', async () => {
    const clip = await Sound.load('a.wav');
    expect(() => clip.play({ volume: NaN })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
    expect(() => clip.play({ pan: Infinity })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
    expect(fake.calls.filter((c) => c[0] === 'play')).toEqual([]);
  });

  it('changes and stops a voice', async () => {
    const clip = await Sound.load('a.wav');
    const voice = clip.play({ volume: 0.5 });
    voice.setRate(1.5);
    voice.setPan(0.25);
    voice.setVolume(0.2);
    expect(fake.last('setVoice')).toEqual([
      'setVoice',
      voice.id,
      0.2,
      1.5,
      0.25,
    ]);
    voice.stop();
    expect(fake.last('stopVoice')).toEqual(['stopVoice', voice.id]);
  });

  it('stops a sound, all sounds, and unloads', async () => {
    const clip = await Sound.load('a.wav');
    clip.stop();
    expect(fake.last('stopSound')).toEqual(['stopSound', 's1']);
    Sound.stopAll();
    expect(fake.last('stopAll')).toEqual(['stopAll']);
    await clip.unload();
    await clip.unload();
    expect(fake.calls.filter((c) => c[0] === 'unload')).toHaveLength(1);
    expect(clip.unloaded).toBe(true);
    expect(() => clip.play()).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
    clip.stop();
    expect(fake.calls.filter((c) => c[0] === 'stopSound')).toHaveLength(1);
  });

  it('does nothing while disabled, and stops what plays when it turns off', async () => {
    const clip = await Sound.load('a.wav');
    Sound.setEnabled(false);
    expect(Sound.isEnabled()).toBe(false);
    expect(fake.last('stopAll')).toBeDefined();
    const voice = clip.play();
    voice.setPan(1);
    voice.stop();
    expect(fake.calls.filter((c) => c[0] === 'play')).toEqual([]);
    expect(fake.calls.filter((c) => c[0] === 'setVoice')).toEqual([]);
    expect(fake.calls.filter((c) => c[0] === 'stopVoice')).toEqual([]);
    Sound.setEnabled(true);
    clip.play();
    expect(fake.last('play')).toBeDefined();
  });

  it('configures the silent switch and remembers the setting', async () => {
    await Sound.configure({ respectSilentSwitch: true });
    expect(fake.last('configure')).toEqual([
      'configure',
      { respectSilentSwitch: true },
    ]);
    await Sound.configure({});
    expect(fake.last('configure')).toEqual([
      'configure',
      { respectSilentSwitch: true },
    ]);
  });

  it('unlock resolves at once', async () => {
    await expect(Sound.unlock()).resolves.toBeUndefined();
  });

  it('turns a native rejection into a PlayerError', async () => {
    fake.rejectLoad = { code: 'SOURCE_NOT_FOUND', message: 'No such file' };
    const error = await caught(Sound.load('file:///missing.wav'));
    expect(isPlayerError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'SOURCE_NOT_FOUND',
      message: 'No such file',
    });
  });

  it('reports SOUND_UNAVAILABLE, with how to enable it, when built without sound', async () => {
    fake.available = false;
    expect(Sound.isAvailable()).toBe(false);
    const error = await caught(Sound.load('a.wav'));
    expect(error).toMatchObject({ code: 'SOUND_UNAVAILABLE' });
    expect((error as Error).message).toContain('rnapSound=true');
    expect((error as Error).message).toContain('RNAP_SOUND=1');
    expect(
      await caught(Sound.configure({ respectSilentSwitch: true }))
    ).toMatchObject({
      code: 'SOUND_UNAVAILABLE',
    });
    expect(await caught(Sound.unlock())).toMatchObject({
      code: 'SOUND_UNAVAILABLE',
    });
    Sound.stopAll();
    Sound.setEnabled(false);
    expect(fake.calls).toEqual([]);
  });
});
