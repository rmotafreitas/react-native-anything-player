import {
  codegenNativeComponent,
  type ColorValue,
  type ViewProps,
} from 'react-native';

/**
 * iOS's own AirPlay / output button (`AVRoutePickerView`). Internal: apps use
 * `<RoutePicker />` (src/components/RoutePicker.ios.tsx). Other platforms
 * open their picker from a JS button.
 */
export interface NativeProps extends ViewProps {
  /** The glyph's colour. */
  tintColor?: ColorValue;
  /** The glyph's colour while audio goes to another device. */
  activeTintColor?: ColorValue;
}

export default codegenNativeComponent<NativeProps>('RNAPRoutePickerView', {
  excludedPlatforms: ['android'],
});
