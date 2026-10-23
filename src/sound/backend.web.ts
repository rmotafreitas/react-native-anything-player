// The backend for React Native Web and Expo web: Web Audio, with React
// Native's asset resolver for `require()`d files.
import { Image } from 'react-native';
import { createWebSoundBackend } from '../web/platform/WebSound';

export const soundBackend = createWebSoundBackend({
  resolveAsset: (module) => Image.resolveAssetSource?.(module)?.uri ?? null,
});
