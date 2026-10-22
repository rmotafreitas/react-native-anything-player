import type { CSSProperties } from 'react';
import { OUTPUT_ICON } from '../components/icons';
import { usePlaysElsewhere, useRoutePickerAvailable } from '../core/hooks';
import type { Player } from '../core/Player';
import { showRoutePicker } from '../core/system';
import { BARE_BUTTON, Icon } from './Icon';

/** Props of the React DOM {@link RoutePicker}. */
export interface RoutePickerProps {
  /** The player whose output to change. Default: the one on the lock screen (no active colour then). */
  player?: Player;
  /** Icon size in CSS pixels. Default 24. */
  size?: number;
  /** Icon colour. Default `#8e8e93`. */
  color?: string;
  /** Icon colour while `player` plays on another device. Default `#0a84ff`. */
  activeColor?: string;
  /** Class of the `<button>`. */
  className?: string;
  /** Style of the `<button>`, on top of a bare one. */
  style?: CSSProperties;
  /** Accessible name. Default "Choose audio output". */
  label?: string;
}

const ignore = () => undefined;

/**
 * A `<button>` that opens the browser's output picker: AirPlay in Safari,
 * Remote Playback in Chrome. Renders nothing where there is none.
 */
export function RoutePicker({
  player,
  size = 24,
  color = '#8e8e93',
  activeColor = '#0a84ff',
  className,
  style,
  label = 'Choose audio output',
}: RoutePickerProps) {
  const available = useRoutePickerAvailable();
  const remote = usePlaysElsewhere(player);
  if (!available) return null;
  return (
    <button
      type="button"
      className={className}
      style={{ ...BARE_BUTTON, ...style }}
      aria-label={label}
      onClick={() => {
        // Synchronous: browsers open a picker only inside the click.
        showRoutePicker(player).catch(ignore);
      }}
    >
      <Icon
        src={OUTPUT_ICON}
        size={size}
        color={remote ? activeColor : color}
      />
    </button>
  );
}
