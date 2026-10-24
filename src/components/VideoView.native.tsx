import { StyleSheet } from 'react-native';
import RNAPVideoView from '../native/VideoViewNativeComponent';
import type { VideoViewProps } from './VideoViewProps';

export type { VideoViewProps } from './VideoViewProps';

/**
 * Shows a video player's picture and subtitles, in a native view (iOS and
 * Android, with the video module). The player outlives it: an unmounted view
 * leaves the sound playing (`video.whenBackgrounded` decides what happens in
 * the background), and moving the player to another view goes on without a
 * gap.
 */
export function VideoView({
  player,
  contentFit = 'contain',
  style,
  nativeControls = false,
}: Readonly<VideoViewProps>) {
  return (
    <RNAPVideoView
      playerId={player.id}
      contentFit={contentFit}
      nativeControls={nativeControls}
      style={[styles.box, style]}
    />
  );
}

const styles = StyleSheet.create({
  box: { overflow: 'hidden', backgroundColor: 'black' },
});
