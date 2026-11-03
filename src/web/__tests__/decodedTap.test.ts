import { AudioSampler } from '../platform/AudioSampler';
import { DecodedTap, type DecodedAudio } from '../platform/DecodedTap';
import type { AudioElementLike } from '../platform/dom';
import { concat, mp3Frame } from './audioFixtures';
import { FakeAudioContext, install, uninstall } from './FakeBrowser';

const RATE = 44100;
const FRAME_SAMPLES = 1152;
const FRAME_SECONDS = FRAME_SAMPLES / RATE;
/** Bytes of a 128 kbps 44.1 kHz frame without padding. */
const FRAME_BYTES = mp3Frame().length;

/** Frames whose payload byte is their index: the fake decoder's samples say which frame they came from. */
function frames(from: number, count: number): Uint8Array {
  return concat(
    ...Array.from({ length: count }, (_, i) => mp3Frame({ fill: from + i }))
  );
}

/** Decodes each frame to 1152 stereo samples of `fill / 100`. */
function decodeFill(bytes: ArrayBuffer): DecodedAudio {
  const data = new Uint8Array(bytes);
  const count = data.length / FRAME_BYTES;
  const left = new Float32Array(count * FRAME_SAMPLES);
  for (let i = 0; i < count; i++)
    left.fill(data[i * FRAME_BYTES + 4]! / 100, i * FRAME_SAMPLES);
  return { channels: [left, left.slice()], sampleRate: RATE };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('DecodedTap', () => {
  it('reads each frame at its own media time, across batches and their overlap', async () => {
    const decode = jest.fn((bytes: ArrayBuffer) =>
      Promise.resolve(decodeFill(bytes))
    );
    const tap = new DecodedTap(decode);
    tap.push({ codec: 'mp3', bytes: frames(0, 40), time: 0, fresh: true });
    await flush();
    // 0.4 s batches: two decoded, the second led by the first's last two frames.
    expect(decode).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(decode.mock.calls[1]![0]).length).toBe(
      18 * FRAME_BYTES
    );
    for (const frame of [3, 15, 16, 17, 30]) {
      const window = tap.window((frame + 1) * FRAME_SECONDS, 64)!;
      expect(window.sampleRate).toBe(RATE);
      expect(window.pcm[63]).toBeCloseTo(frame / 100);
      expect(window.pcm[0]).toBeCloseTo(frame / 100);
    }
    // Not decoded yet (the third batch is still filling).
    expect(tap.window(39 * FRAME_SECONDS, 64)).toBeNull();
  });

  it('starts over on a new item and drops what was still decoding for the old one', async () => {
    const release: Array<() => void> = [];
    const decode = jest.fn(
      (bytes: ArrayBuffer) =>
        new Promise<DecodedAudio>((resolve) => {
          release.push(() => resolve(decodeFill(bytes)));
        })
    );
    const tap = new DecodedTap(decode);
    tap.push({ codec: 'mp3', bytes: frames(50, 16), time: 0, fresh: true });
    // A new media source: its timeline starts at 0 again.
    tap.push({ codec: 'mp3', bytes: frames(1, 16), time: 0, fresh: true });
    await flush();
    release[0]!();
    await flush();
    expect(tap.window(FRAME_SECONDS, 64)).toBeNull();
    expect(decode).toHaveBeenCalledTimes(2);
    release[1]!();
    await flush();
    expect(tap.window(FRAME_SECONDS, 64)!.pcm[63]).toBeCloseTo(0.01);
  });

  it('continues a splice at the media time the new connection starts', async () => {
    const tap = new DecodedTap((bytes) => Promise.resolve(decodeFill(bytes)));
    tap.push({ codec: 'mp3', bytes: frames(0, 16), time: 0, fresh: true });
    const spliced = 16 * FRAME_SECONDS + 0.5;
    tap.push({
      codec: 'mp3',
      bytes: frames(80, 16),
      time: spliced,
      fresh: true,
    });
    await flush();
    expect(tap.window(spliced + FRAME_SECONDS, 64)!.pcm[63]).toBeCloseTo(0.8);
    expect(tap.window(FRAME_SECONDS, 64)!.pcm[63]).toBeCloseTo(0);
  });
});

describe('AudioSampler in WebKit', () => {
  const g = globalThis as Record<string, unknown>;

  beforeEach(() => {
    install();
    (g.navigator as { vendor: string }).vendor = 'Apple Computer, Inc.';
    g.OfflineAudioContext = class {
      decodeAudioData(bytes: ArrayBuffer) {
        const { channels } = decodeFill(bytes);
        return Promise.resolve({
          sampleRate: RATE,
          numberOfChannels: channels.length,
          getChannelData: (i: number) => channels[i]!,
        });
      }
    };
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    delete g.OfflineAudioContext;
    uninstall();
  });

  it('decodes the stream instead of routing the element (which would play silence)', async () => {
    const sampler = new AudioSampler();
    const onWindow = jest.fn();
    sampler.enabled = true;
    sampler.points = 16;
    sampler.onWindow = onWindow;
    const element = {
      currentTime: 10 * FRAME_SECONDS,
      paused: false,
    } as AudioElementLike;
    sampler.feed(element, {
      codec: 'mp3',
      bytes: frames(0, 20),
      time: 0,
      fresh: true,
    });
    await flush();
    expect(sampler.update(element, true)).toBe(false);
    jest.advanceTimersByTime(100);
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(onWindow).toHaveBeenCalled();
    const window = onWindow.mock.calls[0]![0];
    expect(window.waveform[15]).toBeCloseTo(0.09);
    expect(window.level).toBeGreaterThan(0);
    sampler.destroy();
  });

  it('keeps the audio fetched while sampling is off, so the scope has it when sampling returns', async () => {
    const sampler = new AudioSampler();
    const onWindow = jest.fn();
    sampler.enabled = true;
    sampler.points = 16;
    sampler.onWindow = onWindow;
    const element = { currentTime: 0, paused: false } as AudioElementLike;
    sampler.feed(element, {
      codec: 'mp3',
      bytes: frames(0, 16),
      time: 0,
      fresh: true,
    });
    sampler.update(element, true);
    sampler.enabled = false;
    sampler.stop();
    // Fetched ahead while the scope is away.
    sampler.feed(element, {
      codec: 'mp3',
      bytes: frames(16, 33),
      time: 16 * FRAME_SECONDS,
      fresh: false,
    });
    await flush();
    sampler.enabled = true;
    (element as { currentTime: number }).currentTime = 30 * FRAME_SECONDS;
    sampler.update(element, true);
    await flush();
    jest.advanceTimersByTime(100);
    expect(onWindow).toHaveBeenCalled();
    expect(onWindow.mock.calls[0]![0].waveform[15]).toBeCloseTo(0.29);
    sampler.destroy();
  });

  it('routes a local file through Web Audio, which reads a same-origin file in WebKit', async () => {
    const sampler = new AudioSampler();
    sampler.enabled = true;
    sampler.onWindow = jest.fn();
    const element = { currentTime: 0, paused: false } as AudioElementLike;
    sampler.update(element, true, true);
    await flush();
    expect(FakeAudioContext.instances[0]!.sources).toEqual([element]);
    expect(sampler.isAttached(element)).toBe(true);
    sampler.destroy();
  });
});
