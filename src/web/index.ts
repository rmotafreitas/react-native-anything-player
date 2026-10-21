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
export type {
  Artwork,
  AudioSample,
  AudioSamplingOptions,
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
  Source,
  SourceInput,
} from '../types';
