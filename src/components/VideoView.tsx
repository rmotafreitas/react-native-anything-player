import { useEffect, useRef, type ComponentRef } from 'react';
import {
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import type { Player } from '../core/Player';

/** Props of {@link VideoView}. */
export interface VideoViewProps {
  /** A video player (`new Player({ video: true })`). */
  player: Player;
  /** How the picture fills the view. Default `contain` (letterboxed). */
  contentFit?: 'contain' | 'cover' | 'fill';
  /** Give it a size (e.g. `{ aspectRatio: 16 / 9 }`). */
  style?: StyleProp<ViewStyle>;
}

/**
 * Shows a video player's picture and subtitles. The player outlives it: an
 * unmounted view leaves the sound playing (`video.whenBackgrounded` decides
 * what happens in the background), and moving the player to another view
 * goes on without a gap.
 *
 * React Native Web and Expo web put the picture in the view's element. On
 * iOS and Android it is a native view, with the video module.
 */
export function VideoView({
  player,
  contentFit = 'contain',
  style,
}: Readonly<VideoViewProps>) {
  const view = useRef<ComponentRef<typeof View>>(null);
  useEffect(() => {
    // React Native Web: the view's ref is its element.
    const element = view.current as unknown;
    if (Platform.OS !== 'web' || element == null || player.isReleased)
      return undefined;
    player.attachTo(element, { contentFit });
    return () => {
      if (!player.isReleased) player.attachTo(null);
    };
  }, [player, contentFit]);
  return <View ref={view} style={[styles.box, style]} />;
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', backgroundColor: 'black' },
});
