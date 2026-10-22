// `react-native-anything-player/react`: React for the web (react-dom: Vite,
// Next.js, Create React App…), with no React Native. The browser engine, the
// same `Player` API and hooks as on React Native, and `<button>` versions of
// the output and Cast buttons.
//
//   import { Player, usePlayerStatus } from 'react-native-anything-player/react';
//
// Importing it touches no browser API, so a server-rendered page can import
// it; create players in the browser (an effect, or a client component).

export * from '../web/index';
export {
  useCastStatus,
  usePlaybackState,
  usePlayerEvent,
  usePlayerStatus,
  useProgress,
  useRoutePickerAvailable,
  useSleepTimer,
  useStreamMetadata,
} from '../core/hooks';
export type { SleepTimerState } from '../core/hooks';
export { RoutePicker } from './RoutePicker';
export type { RoutePickerProps } from './RoutePicker';
export { CastButton } from './CastButton';
export type { CastButtonProps } from './CastButton';
