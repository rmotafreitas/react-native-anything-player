// `react-native-anything-player/web`: the player for any web page, with no
// React or React Native. The same `Player` API, on the browser engine.
//
//   import { Player } from 'react-native-anything-player/web';
//   const player = new Player();
//   button.onclick = () => player.load('https://radio.example/stream', { autoplay: true });

import { installHost } from '../core/host';
import { browser } from './platform/dom';
import { webModule } from './platform/WebModule';

installHost({
  module: webModule,
  onForeground(listener) {
    const g = browser();
    g.document?.addEventListener('visibilitychange', () => {
      if (g.document?.visibilityState === 'visible') listener();
    });
  },
  // A web page has no bundled-asset registry: sources are URLs.
  resolveAsset: () => null,
});

export { Player } from '../core/Player';
export { PlayerError, isPlayerError } from '../errors';
export {
  addCastStateListener,
  addRoutePickerAvailabilityListener,
  configureCast,
  getCastStatus,
  isRoutePickerAvailable,
  playFromSearch,
  searchCatalog,
  setCatalog,
  setSearchHandler,
  showCastPicker,
  showRoutePicker,
  stopCasting,
} from '../core/system';
export type {
  CastConfiguration,
  CastStatus,
  SearchHandler,
  SearchInput,
} from '../core/system';
export type {
  Artwork,
  AudioRoute,
  AudioRouteKind,
  AudioSample,
  AudioSamplingOptions,
  CastState,
  CatalogItem,
  CatalogOptions,
  DiagnosticEntry,
  Discontinuity,
  Interruption,
  InterruptionReason,
  LoadOptions,
  MediaMetadata,
  NetworkState,
  NowPlayingMetadata,
  PlaybackState,
  PlayerErrorCode,
  PlayerErrorInfo,
  PlayerEvent,
  PlayerEventMap,
  PlayerOptions,
  PlayerStatus,
  Progress,
  ReconnectInfo,
  RemoteCommand,
  RemoteCommandEvent,
  SearchFocus,
  SearchPlayEvent,
  SearchRequest,
  Source,
  SourceInput,
} from '../types';
