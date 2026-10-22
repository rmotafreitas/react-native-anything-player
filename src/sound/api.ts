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
