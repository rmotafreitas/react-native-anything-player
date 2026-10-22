import { _resetSound, installSoundBackend, Sound } from '../../core/sound';
import { createWebSoundBackend } from '../platform/WebSound';
import { FakeAudioContext } from './FakeWebAudio';

type Listener = () => void;

/** A page: listeners by event type, a fetch() over canned responses, user activation. */
class Page {
  listeners = new Map<
    string,
    Array<{ fn: Listener; signal: { aborted: boolean } }>
  >();
  responses = new Map<string, { status: number; bytes: number } | Error>();
  fetched: string[] = [];
  activation: { hasBeenActive: boolean } | undefined = { hasBeenActive: true };

  document = {
    addEventListener: (
      type: string,
      fn: Listener,
      options?: { signal?: { aborted: boolean } }
    ) => {
      const list = this.listeners.get(type) ?? [];
      list.push({ fn, signal: options?.signal ?? { aborted: false } });
      this.listeners.set(type, list);
    },
  };

  fetch = async (url: string) => {
    this.fetched.push(url);
    const answer = this.responses.get(url) ?? { status: 200, bytes: 2000 };
    if (answer instanceof Error) throw answer;
    return {
      ok: answer.status < 400,
      status: answer.status,
      arrayBuffer: async () => new ArrayBuffer(answer.bytes),
    };
  };

  gesture(type = 'pointerdown'): void {
    for (const { fn, signal } of this.listeners.get(type) ?? [])
      if (!signal.aborted) fn();
  }

  active(type: string): number {
    return (this.listeners.get(type) ?? []).filter((l) => !l.signal.aborted)
      .length;
  }
}

const g = globalThis as unknown as Record<string, unknown>;
let page: Page;
const saved: Record<string, unknown> = {};
const KEYS = [
  'AudioContext',
  'webkitAudioContext',
  'document',
  'fetch',
  'navigator',
];

beforeEach(() => {
  for (const key of KEYS) saved[key] = g[key];
  FakeAudioContext.reset();
  page = new Page();
  g.AudioContext = FakeAudioContext;
  g.webkitAudioContext = undefined;
  g.document = page.document;
  g.fetch = page.fetch;
  g.navigator = { userActivation: page.activation };
  Object.defineProperty(g.navigator, 'userActivation', {
    get: () => page.activation,
  });
  _resetSound();
  installSoundBackend(createWebSoundBackend());
});

afterEach(() => {
  for (const key of KEYS) g[key] = saved[key];
});

const ctx = () => FakeAudioContext.instances[0]!;
const caught = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('did not reject');
};

describe('Sound on the web: loading', () => {
  it('fetches and decodes a URL, and reports the duration', async () => {
    const clip = await Sound.load('https://x.test/laser.wav');
    expect(page.fetched).toEqual(['https://x.test/laser.wav']);
    expect(clip.duration).toBe(2);
    expect(FakeAudioContext.options).toEqual([{ latencyHint: 'interactive' }]);
  });

  it('decodes a Blob or File without fetching', async () => {
    const clip = await Sound.load(new Blob(['x'.repeat(500)]));
    expect(page.fetched).toEqual([]);
    expect(clip.duration).toBe(0.5);
  });

  it('shares one context', async () => {
    await Sound.load('a');
    await Sound.load('b');
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('maps HTTP, network and decode failures to PlayerErrors', async () => {
    page.responses.set('missing', { status: 404, bytes: 0 });
    page.responses.set('busy', { status: 503, bytes: 0 });
    page.responses.set('down', new TypeError('Failed to fetch'));
    page.responses.set('junk', { status: 200, bytes: 0 });
    FakeAudioContext.decode = (bytes) =>
      bytes.byteLength > 0 ? { duration: 1 } : null;
    expect(await caught(Sound.load('missing'))).toMatchObject({
      code: 'SOURCE_NOT_FOUND',
      httpStatus: 404,
      recoverable: false,
      platform: 'web',
    });
    expect(await caught(Sound.load('busy'))).toMatchObject({
      code: 'HTTP_ERROR',
      httpStatus: 503,
      recoverable: true,
    });
    expect(await caught(Sound.load('down'))).toMatchObject({
      code: 'NETWORK_ERROR',
      recoverable: true,
    });
    expect(await caught(Sound.load('junk'))).toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
  });

  it('fails clearly without Web Audio or fetch', async () => {
    g.AudioContext = undefined;
    expect(await caught(Sound.load('a'))).toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
    g.AudioContext = FakeAudioContext;
    g.fetch = undefined;
    expect(await caught(Sound.load('a'))).toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('uses the prefixed context where that is all there is', async () => {
    g.AudioContext = undefined;
    g.webkitAudioContext = FakeAudioContext;
    await Sound.load('a');
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('resolves require()d assets with the platform resolver', async () => {
    installSoundBackend(
      createWebSoundBackend({ resolveAsset: (m) => `/assets/${m}.wav` })
    );
    await Sound.load(5);
    expect(page.fetched).toEqual(['/assets/5.wav']);
    installSoundBackend(createWebSoundBackend());
    await expect(Sound.load(5)).rejects.toMatchObject({
      code: 'INVALID_SOURCE',
    });
  });

  it('is always available and has nothing to configure', async () => {
    expect(Sound.isAvailable()).toBe(true);
    await expect(
      Sound.configure({ respectSilentSwitch: true })
    ).resolves.toBeUndefined();
  });
});

describe('Sound on the web: playing', () => {
  it('wires source → gain → panner → destination and starts it now', async () => {
    const clip = await Sound.load('a');
    clip.play({ volume: 0.4, rate: 1.5, pan: -0.5, loop: true });
    const c = ctx();
    const [source] = c.sources;
    const [gain] = c.gains;
    const [panner] = c.panners;
    expect(source!.buffer).toMatchObject({ duration: 2 });
    expect(source!.loop).toBe(true);
    expect(source!.playbackRate.value).toBe(1.5);
    expect(gain!.gain.value).toBe(0.4);
    expect(panner!.pan.value).toBe(-0.5);
    expect(source!.connections).toEqual([gain]);
    expect(gain!.connections).toEqual([panner]);
    expect(panner!.connections).toEqual([c.destination]);
    expect(source!.started).toEqual([0]);
  });

  it('skips the panner where the browser has none', async () => {
    FakeAudioContext.withPanner = false;
    const clip = await Sound.load('a');
    clip.play({ pan: 1 });
    const c = ctx();
    expect(c.panners).toHaveLength(0);
    expect(c.gains[0]!.connections).toEqual([c.destination]);
  });

  it('changes a voice while it plays', async () => {
    const clip = await Sound.load('a');
    const voice = clip.play();
    voice.setVolume(0.2);
    voice.setRate(0.75);
    voice.setPan(1);
    const c = ctx();
    expect(c.gains[0]!.gain.value).toBe(0.2);
    expect(c.sources[0]!.playbackRate.value).toBe(0.75);
    expect(c.panners[0]!.pan.value).toBe(1);
  });

  it('stops a voice with a short fade, and ignores it afterwards', async () => {
    const clip = await Sound.load('a');
    const voice = clip.play();
    voice.stop();
    const c = ctx();
    expect(c.gains[0]!.gain.targets).toEqual([
      { target: 0, time: 10, constant: 0.005 },
    ]);
    expect(c.sources[0]!.stopped).toEqual([10.03]);
    voice.stop();
    voice.setVolume(1);
    expect(c.sources[0]!.stopped).toHaveLength(1);
    expect(c.gains[0]!.gain.value).toBe(1);
  });

  it('tolerates a source the browser already stopped', async () => {
    const clip = await Sound.load('a');
    const voice = clip.play();
    ctx().sources[0]!.stop = () => {
      throw new Error('InvalidStateError');
    };
    expect(() => voice.stop()).not.toThrow();
  });

  it('steals the oldest voice when all are busy', async () => {
    const clip = await Sound.load('a', { voices: 2 });
    clip.play();
    clip.play();
    clip.play();
    const [first, second, third] = ctx().sources;
    expect(first!.stopped).toHaveLength(1);
    expect(second!.stopped).toHaveLength(0);
    expect(third!.started).toEqual([0]);
    clip.play();
    expect(second!.stopped).toHaveLength(1);
  });

  it('frees a voice when its sound ends, and does not steal then', async () => {
    const clip = await Sound.load('a', { voices: 1 });
    clip.play();
    const [first] = ctx().sources;
    first!.end();
    expect(first!.disconnected).toBe(true);
    clip.play();
    expect(first!.stopped).toEqual([]);
  });

  it('keeps voices of different sounds apart', async () => {
    const a = await Sound.load('a', { voices: 1 });
    const b = await Sound.load('b', { voices: 1 });
    a.play();
    b.play();
    expect(ctx().sources.every((s) => s.stopped.length === 0)).toBe(true);
  });

  it('stops one sound, or everything', async () => {
    const a = await Sound.load('a');
    const b = await Sound.load('b');
    a.play();
    a.play();
    b.play();
    a.stop();
    const sources = ctx().sources;
    expect(sources.map((s) => s.stopped.length)).toEqual([1, 1, 0]);
    Sound.stopAll();
    expect(sources.map((s) => s.stopped.length)).toEqual([1, 1, 1]);
  });

  it('unload stops the sound and forgets it', async () => {
    const clip = await Sound.load('a');
    clip.play();
    await clip.unload();
    expect(ctx().sources[0]!.stopped).toHaveLength(1);
    expect(() => clip.play()).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    );
  });

  it('ignores a voice for a sound it does not know', async () => {
    const backend = createWebSoundBackend();
    backend.play('ghost', 1, { volume: 1, rate: 1, pan: 0, loop: false });
    backend.setVoice(1, { volume: 1, rate: 1, pan: 0 });
    backend.stopVoice(1);
    backend.stopSound('ghost');
    backend.stopAll();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('can be switched off', async () => {
    const clip = await Sound.load('a');
    clip.play();
    Sound.setEnabled(false);
    expect(ctx().sources[0]!.stopped).toHaveLength(1);
    clip.play();
    expect(ctx().sources).toHaveLength(1);
  });
});

describe('Sound on the web: the autoplay policy', () => {
  it('resumes a suspended context from play() inside a gesture', async () => {
    const clip = await Sound.load('a');
    expect(ctx().state).toBe('suspended');
    clip.play();
    expect(ctx().resumes).toBe(1);
    expect(ctx().sources[0]!.started).toEqual([0]);
  });

  it('throws AUTOPLAY_BLOCKED before the page had a gesture', async () => {
    page.activation = { hasBeenActive: false };
    FakeAudioContext.allowStart = false;
    const clip = await Sound.load('a');
    let error: unknown;
    try {
      clip.play();
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({
      code: 'AUTOPLAY_BLOCKED',
      recoverable: true,
    });
    expect(ctx().sources).toHaveLength(0);
  });

  it('plays when the browser does not report activation', async () => {
    page.activation = undefined;
    const clip = await Sound.load('a');
    clip.play();
    expect(ctx().sources).toHaveLength(1);
  });

  it('unlocks the context on the first gesture, then stops listening', async () => {
    await Sound.load('a');
    expect(page.active('pointerdown')).toBe(1);
    expect(page.active('keydown')).toBe(1);
    expect(page.active('touchend')).toBe(1);
    expect(page.active('click')).toBe(1);
    page.gesture('keydown');
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx().state).toBe('running');
    // A silent buffer starts in the gesture, for older iOS Safari.
    expect(ctx().sources[0]!.started).toEqual([0]);
    expect(page.active('pointerdown')).toBe(0);
  });

  it('keeps listening when the gesture was not enough', async () => {
    FakeAudioContext.allowStart = false;
    await Sound.load('a');
    page.gesture();
    await Promise.resolve();
    await Promise.resolve();
    expect(page.active('pointerdown')).toBe(1);
  });

  it('listens for nothing when the context starts running', async () => {
    class Running extends FakeAudioContext {
      override state = 'running';
    }
    g.AudioContext = Running;
    await Sound.load('a');
    expect(page.active('pointerdown')).toBe(0);
  });

  it('unlock() resolves once running, and rejects without a gesture', async () => {
    await Sound.load('a');
    await expect(Sound.unlock()).resolves.toBeUndefined();
    await expect(Sound.unlock()).resolves.toBeUndefined();

    FakeAudioContext.reset();
    _resetSound();
    installSoundBackend(createWebSoundBackend());
    page.activation = { hasBeenActive: false };
    FakeAudioContext.allowStart = false;
    expect(await caught(Sound.unlock())).toMatchObject({
      code: 'AUTOPLAY_BLOCKED',
    });
  });

  it('unlock() gives up when the context stays suspended', async () => {
    jest.useFakeTimers();
    try {
      FakeAudioContext.allowStart = false;
      const result = caught(Sound.unlock());
      await jest.advanceTimersByTimeAsync(1_100);
      expect(await result).toMatchObject({ code: 'AUTOPLAY_BLOCKED' });
    } finally {
      jest.useRealTimers();
    }
  });
});
