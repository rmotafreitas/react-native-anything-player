// The Sound API in the browser: Web Audio. One shared AudioContext, each
// sound decoded into an AudioBuffer at load, each voice an
// AudioBufferSourceNode → GainNode → StereoPannerNode → destination. Nothing
// here touches a browser global at import (server rendering).

import { PlayerError } from '../../errors';
import type { PlayerErrorCode } from '../../types';
import type {
  LoadedSound,
  SoundBackend,
  SoundSource,
  VoiceParams,
} from '../../core/sound';

interface ParamLike {
  value: number;
  setTargetAtTime(
    target: number,
    startTime: number,
    timeConstant: number
  ): void;
}

interface NodeLike {
  connect(destination: unknown): void;
  disconnect(): void;
}

interface GainLike extends NodeLike {
  readonly gain: ParamLike;
}

interface PannerLike extends NodeLike {
  readonly pan: ParamLike;
}

interface SourceLike extends NodeLike {
  buffer: unknown;
  loop: boolean;
  readonly playbackRate: ParamLike;
  onended: (() => void) | null;
  start(when?: number): void;
  stop(when?: number): void;
}

interface BufferLike {
  readonly duration: number;
}

interface WebAudioContext {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  decodeAudioData(
    data: ArrayBuffer,
    onSuccess: (buffer: BufferLike) => void,
    onError: (error: unknown) => void
  ): unknown;
  createBuffer(
    channels: number,
    length: number,
    sampleRate: number
  ): BufferLike;
  createBufferSource(): SourceLike;
  createGain(): GainLike;
  createStereoPanner?(): PannerLike;
}

interface ResponseBody {
  readonly ok: boolean;
  readonly status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface GestureTarget {
  addEventListener(
    type: string,
    listener: () => void,
    options?: { capture?: boolean; signal?: unknown }
  ): void;
}

interface WebSoundGlobals {
  AudioContext?: new (options?: { latencyHint?: string }) => WebAudioContext;
  webkitAudioContext?: new () => WebAudioContext;
  fetch?(url: string): Promise<ResponseBody>;
  AbortController?: new () => { signal: unknown; abort(): void };
  document?: GestureTarget;
  navigator?: { readonly userActivation?: { readonly hasBeenActive: boolean } };
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const globals = () => globalThis as unknown as WebSoundGlobals;

/** Events that count as a gesture to the autoplay policy. */
const GESTURES = ['pointerdown', 'touchend', 'keydown', 'click'];
/** Fade-out when a voice stops, so a cut waveform does not click. */
const STOP_FADE_S = 0.005;
const STOP_AFTER_S = 0.03;
/** How long `unlock()` waits for a context to start before calling the page blocked. */
const UNLOCK_WAIT_MS = 1_000;

interface Voice {
  readonly id: number;
  readonly soundId: string;
  readonly source: SourceLike;
  readonly gain: GainLike;
  readonly panner: PannerLike | null;
  released: boolean;
}

interface Loaded {
  readonly buffer: BufferLike;
  readonly voices: number;
  /** Playing voices, the one that started first at index 0. */
  active: Voice[];
}

function fail(
  code: PlayerErrorCode,
  message: string,
  recoverable = false
): PlayerError {
  return new PlayerError({ code, message, recoverable, platform: 'web' });
}

function blocked(): PlayerError {
  return fail(
    'AUTOPLAY_BLOCKED',
    'The browser keeps audio off until the page had a user gesture (a tap, a click or a key press). Call Sound.unlock() or play() from a handler of one.',
    true
  );
}

/** What a platform adds on top of the browser: how a `require()`d asset becomes a URL. */
export interface WebSoundOptions {
  resolveAsset?: (module: number) => string | null;
}

/** Creates the Web Audio backend (the context is made on first use). */
export function createWebSoundBackend(
  options: WebSoundOptions = {}
): SoundBackend {
  const sounds = new Map<string, Loaded>();
  const voices = new Map<number, Voice>();
  let context: WebAudioContext | null = null;
  let counter = 0;

  /** After a gesture the browser lets the context run: start it, then forget the listeners. */
  function listenForGesture(created: WebAudioContext): void {
    const { document, AbortController: Controller } = globals();
    if (!document || !Controller) return;
    const controller = new Controller();
    const unlock = () => {
      created.resume().then(
        () => {
          if (created.state === 'running') controller.abort();
        },
        () => undefined
      );
      // Older iOS Safari starts a context only when a sound starts in the gesture.
      const silence = created.createBufferSource();
      silence.buffer = created.createBuffer(1, 1, 22_050);
      silence.connect(created.destination);
      silence.start(0);
    };
    for (const type of GESTURES)
      document.addEventListener(type, unlock, {
        capture: true,
        signal: controller.signal,
      });
  }

  function audio(): WebAudioContext {
    if (context) return context;
    const g = globals();
    const Context = g.AudioContext ?? g.webkitAudioContext;
    if (!Context)
      throw fail('UNSUPPORTED_FORMAT', 'This browser has no Web Audio.');
    const created = new Context({ latencyHint: 'interactive' });
    context = created;
    if (created.state !== 'running') listenForGesture(created);
    return created;
  }

  async function bytesOf(source: SoundSource): Promise<ArrayBuffer> {
    if ('blob' in source)
      return (
        source.blob as unknown as { arrayBuffer(): Promise<ArrayBuffer> }
      ).arrayBuffer();
    const fetchFn = globals().fetch;
    if (!fetchFn) throw fail('INTERNAL_ERROR', 'This browser has no fetch().');
    let response: ResponseBody;
    try {
      response = await fetchFn(source.uri);
    } catch (cause) {
      throw fail(
        'NETWORK_ERROR',
        `Could not fetch the sound (${String(cause)}). A page on another origin needs CORS headers.`,
        true
      );
    }
    if (!response.ok)
      throw new PlayerError({
        code:
          response.status === 404 || response.status === 410
            ? 'SOURCE_NOT_FOUND'
            : 'HTTP_ERROR',
        message: `The server returned HTTP ${response.status}.`,
        recoverable:
          response.status >= 500 ||
          response.status === 408 ||
          response.status === 429,
        platform: 'web',
        httpStatus: response.status,
      });
    return response.arrayBuffer();
  }

  function release(voice: Voice): void {
    if (voice.released) return;
    voice.released = true;
    voices.delete(voice.id);
    const sound = sounds.get(voice.soundId);
    if (sound) sound.active = sound.active.filter((v) => v !== voice);
  }

  function stopVoice(voice: Voice): void {
    if (voice.released) return;
    release(voice);
    const ctx = context;
    if (!ctx) return;
    const now = ctx.currentTime;
    voice.gain.gain.setTargetAtTime(0, now, STOP_FADE_S);
    try {
      voice.source.stop(now + STOP_AFTER_S);
    } catch {
      // Already stopped.
    }
  }

  function apply(voice: Voice, params: VoiceParams): void {
    voice.gain.gain.value = params.volume;
    voice.source.playbackRate.value = params.rate;
    if (voice.panner) voice.panner.pan.value = params.pan;
  }

  function notRunning(ctx: WebAudioContext): void {
    ctx.resume().catch(() => undefined);
    // Where the browser says no gesture happened yet, nothing will play.
    if (globals().navigator?.userActivation?.hasBeenActive === false)
      throw blocked();
  }

  return {
    available: true,
    acceptsBlobs: true,
    resolveAsset: options.resolveAsset ?? (() => null),

    // The browser (and iPhone's ringer switch) decides; nothing to configure.
    configure: () => Promise.resolve(),

    async load(source: SoundSource, voiceCount: number): Promise<LoadedSound> {
      const ctx = audio();
      const bytes = await bytesOf(source);
      const buffer = await new Promise<BufferLike>((resolve, reject) => {
        // Callbacks too: Safari before 14.1 has no promise form.
        ctx.decodeAudioData(bytes, resolve, reject);
      }).catch((cause: unknown) => {
        throw fail(
          'UNSUPPORTED_FORMAT',
          `The browser could not decode this sound (${String(cause)}).`
        );
      });
      counter += 1;
      const id = `sound-${counter}`;
      sounds.set(id, { buffer, voices: voiceCount, active: [] });
      return { id, duration: buffer.duration };
    },

    unload(soundId: string): Promise<void> {
      this.stopSound(soundId);
      sounds.delete(soundId);
      return Promise.resolve();
    },

    play(soundId, voiceId, params) {
      const sound = sounds.get(soundId);
      if (!sound) return;
      const ctx = audio();
      if (ctx.state !== 'running') notRunning(ctx);
      if (sound.active.length >= sound.voices) {
        const oldest = sound.active[0];
        if (oldest) stopVoice(oldest);
      }
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      const panner = ctx.createStereoPanner?.() ?? null;
      source.buffer = sound.buffer;
      source.loop = params.loop;
      source.connect(gain);
      if (panner) {
        gain.connect(panner);
        panner.connect(ctx.destination);
      } else gain.connect(ctx.destination);
      const voice: Voice = {
        id: voiceId,
        soundId,
        source,
        gain,
        panner,
        released: false,
      };
      apply(voice, params);
      source.onended = () => {
        release(voice);
        source.disconnect();
        gain.disconnect();
        panner?.disconnect();
      };
      sound.active.push(voice);
      voices.set(voiceId, voice);
      source.start(0);
    },

    setVoice(voiceId, params) {
      const voice = voices.get(voiceId);
      if (voice) apply(voice, params);
    },

    stopVoice(voiceId) {
      const voice = voices.get(voiceId);
      if (voice) stopVoice(voice);
    },

    stopSound(soundId) {
      for (const voice of [...(sounds.get(soundId)?.active ?? [])])
        stopVoice(voice);
    },

    stopAll() {
      for (const voice of [...voices.values()]) stopVoice(voice);
    },

    async unlock() {
      const ctx = audio();
      if (ctx.state === 'running') return;
      if (globals().navigator?.userActivation?.hasBeenActive === false)
        throw blocked();
      const { setTimeout, clearTimeout } = globals();
      let timer = 0;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, UNLOCK_WAIT_MS);
      });
      await Promise.race([ctx.resume().catch(() => undefined), timeout]);
      clearTimeout(timer);
      if (ctx.state !== 'running') throw blocked();
    },
  };
}
