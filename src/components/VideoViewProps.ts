import type { StyleProp, ViewStyle } from 'react-native';
import type { Player } from '../core/Player';

/** Props of `<VideoView>`. */
export interface VideoViewProps {
  /** A video player (`new Player({ video: true })`). */
  player: Player;
  /** How the picture fills the view. Default `contain` (letterboxed). */
  contentFit?: 'contain' | 'cover' | 'fill';
  /** Give it a size (e.g. `{ aspectRatio: 16 / 9 }`). */
  style?: StyleProp<ViewStyle>;
  /** The system's own playback controls (iOS: AVKit's). Default `false`: build your own. */
  nativeControls?: boolean;
}
