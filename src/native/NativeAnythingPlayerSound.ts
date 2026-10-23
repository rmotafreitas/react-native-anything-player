import {
  TurboModuleRegistry,
  type CodegenTypes,
  type TurboModule,
} from 'react-native';

/**
 * The Sound API's native contract (src/core/sound.ts). Internal: apps use
 * `Sound` from `react-native-anything-player/sound`.
 *
 * A module of its own so the player's module is untouched. Without
 * `rnapSound` (Android) / `RNAP_SOUND` (iOS) the native class is a stub:
 * `isAvailable()` is false and `load` rejects with `SOUND_UNAVAILABLE`.
 *
 * Voice ids are chosen by JS, so `play` needs no answer: it returns at once
 * and native starts the voice on its own audio thread.
 */
export interface Spec extends TurboModule {
  isAvailable(): boolean;
  /** `{ respectSilentSwitch: boolean }` */
  configure(options: CodegenTypes.UnsafeObject): Promise<void>;
  /** Decodes `{ uri }` into memory: `{ id: string, duration: number | null }`. */
  load(
    source: CodegenTypes.UnsafeObject,
    options: CodegenTypes.UnsafeObject
  ): Promise<CodegenTypes.UnsafeObject>;
  unload(soundId: string): Promise<void>;
  /** Starts a voice; when the sound's voices are all busy the oldest stops. */
  play(
    soundId: string,
    voiceId: number,
    volume: number,
    rate: number,
    pan: number,
    loop: boolean
  ): void;
  setVoice(voiceId: number, volume: number, rate: number, pan: number): void;
  stopVoice(voiceId: number): void;
  stopSound(soundId: string): void;
  stopAll(): void;
}

// `get`, not `getEnforcing`: a binary without the module (Expo Go) must
// surface as a PlayerError when a sound is loaded, not as a crash on import.
export default TurboModuleRegistry.get<Spec>('AnythingPlayerSound');
