import { useEffect, useRef, type CSSProperties } from 'react';
import type { Player } from '../core/Player';

/** Props of the React DOM {@link VideoView}. */
export interface VideoViewProps {
  /** A video player (`new Player({ video: true })`). */
  player: Player;
  /** How the picture fills the box. Default `contain` (letterboxed). */
  contentFit?: 'contain' | 'cover' | 'fill';
  /** Class of the `<div>`. */
  className?: string;
  /** Style of the `<div>`; give it a size (e.g. `aspectRatio: '16 / 9'`). */
  style?: CSSProperties;
  /** The browser's own playback controls. Default `false`: build your own. */
  nativeControls?: boolean;
}

/**
 * Shows a video player's picture and subtitles. The player outlives it: an
 * unmounted view leaves the sound playing (`video.whenBackgrounded` decides
 * what happens in the background), and moving the player to another view
 * goes on without a gap.
 */
export function VideoView({
  player,
  contentFit = 'contain',
  className,
  style,
  nativeControls = false,
}: Readonly<VideoViewProps>) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (element == null || player.isReleased) return undefined;
    player.attachTo(element, { contentFit, nativeControls });
    return () => {
      if (!player.isReleased) player.attachTo(null);
    };
  }, [player, contentFit, nativeControls]);
  return <div ref={box} className={className} style={{ ...BOX, ...style }} />;
}

const BOX: CSSProperties = { position: 'relative' };
