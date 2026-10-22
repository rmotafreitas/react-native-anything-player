import { Image } from 'react-native';
import { PlayerError } from '../errors';
import NativeSound from '../native/NativeAnythingPlayerSound';
import type { LoadedSound, SoundBackend, SoundSource } from '../core/sound';

// The iOS and Android backend: the `AnythingPlayerSound` TurboModule (an
// AVAudioEngine on iOS, a SoundPool on Android). Chosen for native bundles;
// `backend.web.ts` replaces this file for React Native Web and Expo web.

const MISSING_MODULE =
  "RNAP's native module is not in this app binary. Expo Go cannot load it: " +
  'use a development build (`npx expo run:ios` / `npx expo run:android`, or EAS Build). ' +
  'In a bare app, rebuild after installing (`pod install` on iOS). ' +
  'See https://github.com/rmotafreitas/react-native-anything-player/blob/main/docs/getting-started.md#expo-go';

const NOT_BUILT_IN =
  'Sound is not built into this app. Set `rnapSound=true` in android/gradle.properties and ' +
  'install the pods with `RNAP_SOUND=1 pod install` (or `"sound": true` in the Expo plugin options), ' +
  'then rebuild. See https://github.com/rmotafreitas/react-native-anything-player/blob/main/docs/sound.md#enabling-it';

function native() {
  if (!NativeSound)
    throw new PlayerError({
      code: 'NATIVE_MODULE_MISSING',
      message: MISSING_MODULE,
      recoverable: false,
    });
  return NativeSound;
}

export const nativeSoundBackend: SoundBackend = {
  get available() {
    // A missing module surfaces from `load` with its own advice.
    return NativeSound ? NativeSound.isAvailable() : true;
  },
  acceptsBlobs: false,
  unavailableMessage: NOT_BUILT_IN,
  resolveAsset: (module) => Image.resolveAssetSource?.(module)?.uri ?? null,
  async configure(configuration) {
    await native().configure(configuration);
  },
  async load(source: SoundSource, voices: number): Promise<LoadedSound> {
    const loaded = (await native().load(source, { voices })) as {
      id: string;
      duration?: number | null;
    };
    return { id: loaded.id, duration: loaded.duration ?? null };
  },
  unload: (soundId) => native().unload(soundId),
  play(soundId, voiceId, { volume, rate, pan, loop }) {
    native().play(soundId, voiceId, volume, rate, pan, loop);
  },
  setVoice(voiceId, { volume, rate, pan }) {
    native().setVoice(voiceId, volume, rate, pan);
  },
  stopVoice: (voiceId) => native().stopVoice(voiceId),
  stopSound: (soundId) => native().stopSound(soundId),
  // Safe without the module: there is nothing to stop (nothing could load).
  stopAll: () => NativeSound?.stopAll(),
  unlock: () => Promise.resolve(),
};
