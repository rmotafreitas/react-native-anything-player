/**
 * Sound effects: short sounds that start at once and mix with other audio.
 * `import { Sound } from 'react-native-anything-player/sound'`.
 *
 * @module sound
 */
// What the Sound entry exports, natively and on the web.
export { Sound, SoundClip, SoundVoice } from '../core/sound';
export type {
  SoundConfiguration,
  SoundInput,
  SoundLoadOptions,
  SoundPlayOptions,
} from '../core/sound';
export { PlayerError, isPlayerError } from '../errors';
