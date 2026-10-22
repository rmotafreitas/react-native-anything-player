import { useRoutePickerAvailable } from '../hooks';
import RoutePickerView from '../native/RoutePickerViewNativeComponent';
import type { RoutePickerProps } from './RoutePicker';

export type { RoutePickerProps } from './RoutePicker';

/**
 * iOS: the system's own AirPlay / output button (`AVRoutePickerView`). It
 * highlights itself while audio plays on AirPlay; `player` is not needed.
 * Renders nothing where the native view is missing (Expo Go).
 */
export function RoutePicker({
  size = 24,
  color = '#8e8e93',
  activeColor = '#0a84ff',
  style,
  accessibilityLabel = 'Choose audio output',
}: RoutePickerProps) {
  const available = useRoutePickerAvailable();
  if (!available) return null;
  return (
    <RoutePickerView
      accessibilityLabel={accessibilityLabel}
      style={[{ width: size, height: size }, style]}
      tintColor={color}
      activeTintColor={activeColor}
    />
  );
}
