// `react-native-anything-player/sound`: short effects with low latency.
//
//   import { Sound } from 'react-native-anything-player/sound';
//   const shot = await Sound.load(require('./laser.wav'), { voices: 6 });
//   shot.play({ volume: 0.8, pan: -0.5 });
//
// iOS and Android need the `sound` build option; React Native Web and Expo
// web play through Web Audio (`backend.web.ts`).
import { installSoundBackend } from '../core/sound';
import { soundBackend } from './backend';

installSoundBackend(soundBackend);

export * from './api';
