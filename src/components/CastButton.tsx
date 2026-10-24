import { useEffect } from 'react';
import {
  Image,
  Pressable,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { configureCast, showCastPicker } from '../core/system';
import { useCastStatus } from '../hooks';
import { CAST_CONNECTED_ICON, CAST_ICON } from './icons';

/** Props of {@link CastButton}. */
export interface CastButtonProps {
  /** Icon size in points. Default 24. */
  size?: number;
  /** Icon colour. Default `#8e8e93`. */
  color?: ColorValue;
  /** Icon colour while connecting or casting. Default `#0a84ff`. */
  activeColor?: ColorValue;
  /** Style of the button around the icon. */
  style?: StyleProp<ViewStyle>;
  /** Default "Cast" (or "Casting to …" while connected). */
  accessibilityLabel?: string;
}

const ignore = () => undefined;

/**
 * The Google Cast button: opens the device chooser, or the dialog to stop
 * casting. Shown only when Cast devices are found (Cast must be built in on
 * iOS and Android, see the Casting and AirPlay guide; Chrome on the web).
 */
export function CastButton({
  size = 24,
  color = '#8e8e93',
  activeColor = '#0a84ff',
  style,
  accessibilityLabel,
}: Readonly<CastButtonProps>) {
  const { state, device } = useCastStatus();
  // The web loads the Cast SDK here (before any tap); native resolves at once.
  useEffect(() => {
    configureCast().catch(ignore);
  }, []);
  if (
    state !== 'notConnected' &&
    state !== 'connecting' &&
    state !== 'connected'
  )
    return null;
  const active = state !== 'notConnected';
  const label =
    accessibilityLabel ??
    (state === 'connected' && device ? `Casting to ${device}` : 'Cast');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{
        selected: state === 'connected',
        busy: state === 'connecting',
      }}
      hitSlop={8}
      style={style}
      onPress={() => {
        // Synchronous: the web may only open the chooser inside the tap.
        showCastPicker().catch(ignore);
      }}
    >
      <Image
        source={state === 'connected' ? CAST_CONNECTED_ICON : CAST_ICON}
        style={{
          width: size,
          height: size,
          tintColor: active ? activeColor : color,
        }}
      />
    </Pressable>
  );
}
