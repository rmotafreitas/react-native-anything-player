// Built-in icons for the output and Cast buttons: white 24 pt glyphs (1x, 2x,
// 3x) that `tintColor` colours. Image assets, so Metro ships them as files,
// not inside the JS bundle. Glyphs: Material Icons `airplay`, `cast`,
// `cast_connected` (Google, Apache-2.0). The React DOM buttons draw the same
// paths as inline SVG (src/react/icons.ts).
import type { ImageRequireSource } from 'react-native';

/** An output device: a screen with a triangle (AirPlay-style). */
export const OUTPUT_ICON: ImageRequireSource = require('./assets/output.png');

/** Google Cast, not connected. */
export const CAST_ICON: ImageRequireSource = require('./assets/cast.png');

/** Google Cast, connected. */
export const CAST_CONNECTED_ICON: ImageRequireSource = require('./assets/cast-connected.png');
