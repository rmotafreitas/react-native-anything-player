// `react-native-anything-player/sound` for web pages (React DOM, Vite,
// Next.js, plain pages): the same API on Web Audio, with no React Native.
// The package's `exports` map picks this file for everything but React Native.
import { installSoundBackend } from '../core/sound';
import { createWebSoundBackend } from '../web/platform/WebSound';

installSoundBackend(createWebSoundBackend());

export * from './api';
