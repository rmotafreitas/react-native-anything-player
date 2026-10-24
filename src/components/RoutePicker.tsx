import {
  Image,
  Pressable,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { showRoutePicker } from '../core/system';
import { usePlaysElsewhere, useRoutePickerAvailable } from '../core/hooks';
import type { Player } from '../Player';
import { OUTPUT_ICON } from './icons';

/** Props of {@link RoutePicker}. */
export interface RoutePickerProps {
  /**
   * The player whose output to show (and, on the web, to change). Default:
   * the one on the lock screen — the button then has no active colour.
   */
  player?: Player;
  /** Icon size in points. Default 24. */
  size?: number;
  /** Icon colour. Default `#8e8e93`. */
  color?: ColorValue;
  /** Icon colour while `player` plays on another device. Default `#0a84ff`. */
  activeColor?: ColorValue;
  /** Style of the button around the icon. */
  style?: StyleProp<ViewStyle>;
  /** Default "Choose audio output". */
  accessibilityLabel?: string;
}

const ignore = () => undefined;

/**
 * Opens the system output picker: the Output Switcher on Android, AirPlay in
 * Safari, Remote Playback in Chrome (`<RoutePicker />` on iOS is the system's
 * own AirPlay button). Renders nothing where there is no picker.
 */
export function RoutePicker({
  player,
  size = 24,
  color = '#8e8e93',
  activeColor = '#0a84ff',
  style,
  accessibilityLabel = 'Choose audio output',
}: Readonly<RoutePickerProps>) {
  const available = useRoutePickerAvailable();
  const remote = usePlaysElsewhere(player);
  if (!available) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={8}
      style={style}
      onPress={() => {
        // Synchronous: the web may only open a picker inside the tap.
        showRoutePicker(player).catch(ignore);
      }}
    >
      <Image
        source={OUTPUT_ICON}
        style={{
          width: size,
          height: size,
          tintColor: remote ? activeColor : color,
        }}
      />
    </Pressable>
  );
}
