/**
 * Sound effects: short sounds that start at once and mix with other audio.
 * `import { Sound } from 'react-native-anything-player/sound'`.
 *
 * @module sound
 */
// What every Sound entry exports: `react-native-anything-player/sound`
// (native and web) and the web entries (`/web`, `/react`).
export { Sound, SoundClip, SoundVoice } from '../core/sound';
export type {
  SoundConfiguration,
  SoundInput,
  SoundLoadOptions,
  SoundPlayOptions,
} from '../core/sound';
export { PlayerError, isPlayerError } from '../errors';
