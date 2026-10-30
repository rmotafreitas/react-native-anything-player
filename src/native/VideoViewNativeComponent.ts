import {
  codegenNativeComponent,
  type CodegenTypes,
  type ViewProps,
} from 'react-native';

/**
 * A video player's picture and subtitles on iOS and Android. Internal: apps
 * use `<VideoView player={player} />` (src/components/VideoView.tsx), which
 * passes the player's id; the native side finds the player and shows it.
 */
export interface NativeProps extends ViewProps {
  /** The `Player`'s id. */
  playerId: string;
  /** `contain` (letterboxed), `cover` (cropped) or `fill` (stretched). */
  contentFit?: CodegenTypes.WithDefault<
    'contain' | 'cover' | 'fill',
    'contain'
  >;
  /** The system's own playback controls (iOS: AVPlayerViewController's). */
  nativeControls?: CodegenTypes.WithDefault<boolean, false>;
}

export default codegenNativeComponent<NativeProps>('RNAPVideoView');
