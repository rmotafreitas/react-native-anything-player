// The Sound API: short effects (a tap, a shot, a notification chime) played
// with low latency, many at once, mixed with whatever else the device plays.
// It is separate from `Player`: no media session, no audio focus, no lock
// screen. This file is the platform-free part (validation, handles, voice
// bookkeeping); a backend does the audio: Web Audio in the browser
// (src/web/platform/WebSound.ts), the `AnythingPlayerSound` TurboModule on
// iOS and Android (src/sound/nativeBackend.ts).

import { PlayerError, toPlayerError } from '../errors';
import type { AssetModule, BlobInput, PlayerErrorCode } from '../types';

/** What {@link Sound.load} accepts: a URL or file URI, `require('./shot.wav')`, and on the web a `Blob` or `File`. */
export type SoundInput = string | AssetModule | BlobInput;

/** Options for {@link Sound.load}. */
export interface SoundLoadOptions {
  /**
   * How many copies of the sound can play at once (1–32, default 4). When all
   * are busy, `play()` stops the one that started first and reuses its voice.
   */
  voices?: number;
}

/** Options for {@link SoundClip.play}. Out-of-range numbers are clamped. */
export interface SoundPlayOptions {
  /** 0–1 (default 1). */
  volume?: number;
  /** Playback speed, 0.5–2 (default 1). It changes the pitch too. */
  rate?: number;
  /** -1 (left) to 1 (right), default 0. */
  pan?: number;
  /** Repeat until stopped (default false). */
  loop?: boolean;
}

/** App-wide behaviour, set with {@link Sound.configure}. */
export interface SoundConfiguration {
  /**
   * iOS: follow the ringer switch (the silent switch silences sounds, as for
   * most games' effects). Default `false`: sounds play with the switch on, as
   * `Player` does. Ignored on Android (it has no such switch) and on the web
   * (the browser decides; iPhone Safari silences Web Audio with the switch).
   */
  respectSilentSwitch?: boolean;
}

/** The parameters of one voice. */
export interface VoiceParams {
  volume: number;
  rate: number;
  pan: number;
}

/** What a backend loaded. `duration` is in seconds, `null` when the platform does not say. */
export interface LoadedSound {
  id: string;
  duration: number | null;
}

/** What a backend loads: a URI to read (or download), or a picked file (web). */
export type SoundSource = { uri: string } | { blob: BlobInput };

/** The platform's audio: the contract between this file and Web Audio / the TurboModule. */
export interface SoundBackend {
  /** Whether sounds can play here (`false`: the app was built without `rnapSound`). */
  readonly available: boolean;
  readonly acceptsBlobs: boolean;
  resolveAsset(module: number): string | null;
  /** The reason, with how to fix it, when `available` is false. */
  readonly unavailableMessage?: string;
  configure(configuration: Required<SoundConfiguration>): Promise<void>;
  load(source: SoundSource, voices: number): Promise<LoadedSound>;
  unload(soundId: string): Promise<void>;
  /** Starts a voice; stealing the oldest of the sound's when all are busy. */
  play(
    soundId: string,
    voiceId: number,
    params: VoiceParams & { loop: boolean }
  ): void;
  setVoice(voiceId: number, params: VoiceParams): void;
  stopVoice(voiceId: number): void;
  stopSound(soundId: string): void;
  stopAll(): void;
  /** Makes sure audio can start (the web's autoplay policy); rejects with `AUTOPLAY_BLOCKED`. */
  unlock(): Promise<void>;
}

export const MAX_VOICES = 32;
const DEFAULT_VOICES = 4;
const MIN_RATE = 0.5;
const MAX_RATE = 2;

let installed: SoundBackend | null = null;

/** Installs the platform backend. Each entry point calls it once, on import. */
export function installSoundBackend(next: SoundBackend): void {
  installed = next;
}

function error(
  code: PlayerErrorCode,
  message: string,
  recoverable = false
): PlayerError {
  return new PlayerError({ code, message, recoverable });
}

function invalid(message: string): PlayerError {
  return error('INVALID_ARGUMENT', message);
}

function backend(): SoundBackend {
  if (!installed)
    throw error(
      'INTERNAL_ERROR',
      "react-native-anything-player: no Sound backend installed. Import `Sound` from 'react-native-anything-player/sound' (or '/web', '/react')."
    );
  return installed;
}

function usable(): SoundBackend {
  const current = backend();
  if (!current.available)
    throw error(
      'SOUND_UNAVAILABLE',
      current.unavailableMessage ?? 'Sound is not available here.'
    );
  return current;
}

function finite(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw invalid(`${name} must be a finite number.`);
  return value;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function isBlob(value: unknown): value is BlobInput {
  const Blob = (globalThis as { Blob?: abstract new () => object }).Blob;
  return typeof Blob === 'function' && value instanceof Blob;
}

function sourceOf(input: SoundInput, current: SoundBackend): SoundSource {
  if (isBlob(input)) {
    if (!current.acceptsBlobs)
      throw error(
        'INVALID_SOURCE',
        'A Blob or File can be loaded on the web only. Pass a file: URI on iOS and Android.'
      );
    return { blob: input };
  }
  let uri: string | null;
  if (typeof input === 'number') uri = current.resolveAsset(input);
  else uri = typeof input === 'string' ? input.trim() : null;
  if (!uri)
    throw error(
      'INVALID_SOURCE',
      typeof input === 'number'
        ? `Asset ${input} could not be resolved.`
        : 'A sound needs a non-empty URI, a require()d file, or (on the web) a Blob.'
    );
  return { uri };
}

function resolveParams(
  options: SoundPlayOptions,
  previous: VoiceParams
): VoiceParams {
  return {
    volume:
      options.volume === undefined
        ? previous.volume
        : clamp(finite('volume', options.volume), 0, 1),
    rate:
      options.rate === undefined
        ? previous.rate
        : clamp(finite('rate', options.rate), MIN_RATE, MAX_RATE),
    pan:
      options.pan === undefined
        ? previous.pan
        : clamp(finite('pan', options.pan), -1, 1),
  };
}

const FRESH: VoiceParams = { volume: 1, rate: 1, pan: 0 };

let nextVoiceId = 1;
let enabled = true;
let configuration: Required<SoundConfiguration> = {
  respectSilentSwitch: false,
};

/**
 * One playing copy of a sound. Setting its volume, rate or pan, or stopping
 * it, after it finished (or was stopped to free its voice for a newer
 * `play()`) does nothing.
 */
export class SoundVoice {
  /** @internal */
  readonly id: number;
  private params: VoiceParams;

  /** @internal */
  constructor(id: number, params: VoiceParams) {
    this.id = id;
    this.params = params;
  }

  /** Current volume, 0–1. */
  get volume(): number {
    return this.params.volume;
  }

  /** Current speed, 0.5–2. */
  get rate(): number {
    return this.params.rate;
  }

  /** Current pan, -1 (left) to 1 (right). */
  get pan(): number {
    return this.params.pan;
  }

  /** Stops it now. */
  stop(): void {
    if (this.id > 0) backend().stopVoice(this.id);
  }

  /** Sets the volume, 0–1. */
  setVolume(volume: number): void {
    this.update({ volume });
  }

  /** Sets the speed, 0.5–2 (the pitch follows). */
  setRate(rate: number): void {
    this.update({ rate });
  }

  /** Sets the pan, -1 (left) to 1 (right). */
  setPan(pan: number): void {
    this.update({ pan });
  }

  private update(change: SoundPlayOptions): void {
    this.params = resolveParams(change, this.params);
    if (this.id > 0) backend().setVoice(this.id, this.params);
  }
}

/** A sound decoded into memory by {@link Sound.load}, ready to play with no delay. */
export class SoundClip {
  /** Length in seconds; `null` when the platform does not say (Android). */
  readonly duration: number | null;
  /** How many copies can play at once. */
  readonly voices: number;
  private readonly id: string;
  private released = false;

  /** @internal */
  constructor(loaded: LoadedSound, voices: number) {
    this.id = loaded.id;
    this.duration = loaded.duration;
    this.voices = voices;
  }

  /** Whether {@link unload} was called. */
  get unloaded(): boolean {
    return this.released;
  }

  /**
   * Plays a copy and returns its handle. Starts at once; when every voice is
   * busy the oldest is stopped. Throws `AUTOPLAY_BLOCKED` on the web before
   * the page had a gesture. Does nothing while {@link Sound.setEnabled} is
   * `false` (the handle it returns is inert).
   */
  play(options: SoundPlayOptions = {}): SoundVoice {
    if (this.released) throw invalid('The sound was unloaded.');
    const params = resolveParams(options, FRESH);
    if (!enabled) return new SoundVoice(0, params);
    const voice = new SoundVoice(nextVoiceId, params);
    nextVoiceId += 1;
    backend().play(this.id, voice.id, {
      ...params,
      loop: options.loop === true,
    });
    return voice;
  }

  /** Stops every copy of this sound that is playing. */
  stop(): void {
    if (!this.released) backend().stopSound(this.id);
  }

  /** Frees its memory and stops it. The handle cannot be played again. */
  async unload(): Promise<void> {
    if (this.released) return;
    this.released = true;
    await backend()
      .unload(this.id)
      .catch((cause: unknown) => {
        throw toPlayerError(cause);
      });
  }
}

async function load(
  input: SoundInput,
  options: SoundLoadOptions = {}
): Promise<SoundClip> {
  const voices = options.voices ?? DEFAULT_VOICES;
  if (!Number.isInteger(voices) || voices < 1 || voices > MAX_VOICES)
    throw invalid(`voices must be a whole number from 1 to ${MAX_VOICES}.`);
  const current = usable();
  const source = sourceOf(input, current);
  try {
    return new SoundClip(await current.load(source, voices), voices);
  } catch (cause) {
    throw toPlayerError(cause);
  }
}

/**
 * Short effects with low latency. See the Sound guide.
 *
 * ```ts
 * const shot = await Sound.load(require('./laser.wav'), { voices: 6 });
 * shot.play({ volume: 0.8, pan: -0.5 });
 * ```
 */
export const Sound = {
  /**
   * Decodes a sound into memory. Use it for effects of a few seconds: the
   * whole decoded sound stays in memory until {@link SoundClip.unload}.
   * Rejects with `SOUND_UNAVAILABLE` when the app was built without `rnapSound`.
   */
  load,

  /** Whether sounds can play here: always on the web, on iOS and Android only when built with the `sound` option. */
  isAvailable(): boolean {
    return installed?.available ?? false;
  },

  /** Sets how sounds mix with the rest of the device's audio (see {@link SoundConfiguration}). */
  async configure(next: SoundConfiguration): Promise<void> {
    configuration = {
      respectSilentSwitch:
        next.respectSilentSwitch ?? configuration.respectSilentSwitch,
    };
    await usable()
      .configure(configuration)
      .catch((cause: unknown) => {
        throw toPlayerError(cause);
      });
  },

  /**
   * Turns every sound off or on (a "sound effects" setting). While off,
   * `play()` does nothing, and turning off stops the ones playing.
   */
  setEnabled(next: boolean): void {
    enabled = next;
    if (!next && installed?.available) installed.stopAll();
  },

  /** Whether sounds are on (see {@link Sound.setEnabled}). */
  isEnabled(): boolean {
    return enabled;
  },

  /** Stops every sound that is playing. */
  stopAll(): void {
    if (installed?.available) installed.stopAll();
  },

  /**
   * Gets the audio output ready. On the web the browser keeps audio off until
   * the page had a gesture: call this from a tap or key press (RNAP also
   * unlocks on the first one by itself). Rejects with `AUTOPLAY_BLOCKED` when
   * called outside one. Resolves at once on iOS and Android.
   */
  async unlock(): Promise<void> {
    try {
      await usable().unlock();
    } catch (cause) {
      throw toPlayerError(cause);
    }
  },
};

/** @internal Resets module state between tests. */
export function _resetSound(): void {
  installed = null;
  nextVoiceId = 1;
  enabled = true;
  configuration = { respectSilentSwitch: false };
}
