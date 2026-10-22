import { AppState, Image, Platform } from 'react-native';
import NativeAnythingPlayer from './nativeModule';
import { PlayerError } from './errors';
import { WEB_ONLY_SCHEMES, installHost, type PlayerModule } from './core/host';

// The React Native host: the TurboModule (on React Native Web and Expo web,
// the bundler resolves `nativeModule.web.ts`: the browser engine), AppState
// for foreground returns, and Metro's asset registry for `require()`d files.

const MISSING_MODULE =
  "RNAP's native module is not in this app binary. Expo Go cannot load it: " +
  'use a development build (`npx expo run:ios` / `npx expo run:android`, or EAS Build). ' +
  'In a bare app, rebuild after installing (`pod install` on iOS). ' +
  'See https://github.com/rmotafreitas/react-native-anything-player/blob/main/docs/getting-started.md#expo-go';

installHost({
  module(): PlayerModule {
    if (!NativeAnythingPlayer) {
      throw new PlayerError({
        code: 'NATIVE_MODULE_MISSING',
        message: MISSING_MODULE,
        recoverable: false,
      });
    }
    return NativeAnythingPlayer as unknown as PlayerModule;
  },
  onForeground(listener) {
    AppState.addEventListener('change', (state) => {
      if (state === 'active') listener();
    });
  },
  isForeground: () => AppState.currentState !== 'background',
  onForegroundChange(listener) {
    const subscription = AppState.addEventListener('change', (state) =>
      listener(state === 'active')
    );
    return () => subscription.remove();
  },
  resolveAsset(module) {
    // React Native Web has no asset resolver: `require()`d audio is a URL there.
    return Image.resolveAssetSource?.(module)?.uri ?? null;
  },
  // Picked files and inline data play on React Native Web, not on a device.
  acceptsScheme: (scheme) =>
    Platform.OS === 'web' && WEB_ONLY_SCHEMES.has(scheme),
  get acceptsBlobs() {
    return Platform.OS === 'web';
  },
});

export {
  Player,
  normalizeSource,
  normalizeNowPlaying,
  _livePlayerCount,
} from './core/Player';
