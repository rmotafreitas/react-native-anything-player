import { useEffect, useRef, type ComponentRef } from 'react';
import { StyleSheet, View } from 'react-native';
import type { VideoViewProps } from './VideoViewProps';

export type { VideoViewProps } from './VideoViewProps';

/**
 * Shows a video player's picture and subtitles. The player outlives it: an
 * unmounted view leaves the sound playing (`video.whenBackgrounded` decides
 * what happens in the background), and moving the player to another view
 * goes on without a gap.
 *
 * This is React Native Web and Expo web: the picture goes in the view's
 * element. iOS and Android show it in a native view (`VideoView.native.tsx`).
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
    if (element == null || player.isReleased) return undefined;
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
