/**
 * `react-native-anything-player/web`: the player for any web page, with no
 * React or React Native. The same `Player` API, on the browser engine.
 *
 * ```ts
 * import { Player } from 'react-native-anything-player/web';
 * const player = new Player();
 * button.onclick = () => player.load('https://radio.example/stream', { autoplay: true });
 * ```
 *
 * @module web
 */

import { WEB_ONLY_SCHEMES, installHost } from '../core/host';
import { browser } from './platform/dom';
import { webModule } from './platform/WebModule';
import type { ContentFit } from './platform/WebVideo';

installHost({
  module: webModule,
  onForeground(listener) {
    const g = browser();
    g.document?.addEventListener('visibilitychange', () => {
      if (g.document?.visibilityState === 'visible') listener();
    });
  },
  // A page without a document (server rendering) counts as in the foreground.
  isForeground: () => browser().document?.visibilityState !== 'hidden',
  onForegroundChange(listener) {
    const document = browser().document;
    if (!document) return () => undefined;
    const changed = () => listener(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  },
  // A web page has no bundled-asset registry: sources are URLs.
  resolveAsset: () => null,
  acceptsScheme: (scheme) => WEB_ONLY_SCHEMES.has(scheme),
  acceptsBlobs: true,
  attachVideo: (playerId, element, fit, controls) =>
    webModule().attachVideo(
      playerId,
      element,
      fit as ContentFit | undefined,
      controls
    ),
  detachVideo: (playerId, element) =>
    webModule().detachVideo(playerId, element),
});

export { Player } from '../core/Player';
export { PlayerError, isPlayerError } from '../errors';
export { configureHls } from '../core/hls';
export { configureShaka } from '../core/shaka';
export type {
  ShakaLike,
  ShakaPlayerLike,
  ShakaTrack,
  ShakaAudioTrack,
  ShakaError,
} from '../core/shaka';
export type {
  HlsConstructor,
  HlsLevel,
  HlsLike,
  HlsMediaTrack,
} from '../core/hls';
export {
  addCastStateListener,
  addRoutePickerAvailabilityListener,
  configureCast,
  getCastStatus,
  isRoutePickerAvailable,
  playFromSearch,
  searchCatalog,
  setCatalog,
  setFavorites,
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
  ArtworkInput,
  AudioFallbackOptions,
  AudioOnlyReason,
  CueAlign,
  CueSpan,
  CueVertical,
  DrmConfig,
  LicenseRequest,
  MediaTrack,
  PlaybackStats,
  Rendition,
  SourceRefreshRequest,
  SubtitleCue,
  SubtitleFormat,
  SubtitleSource,
  Thumbnail,
  TrackKind,
  VideoOptions,
  Quality,
  VideoQualityOptions,
  VideoStatus,
  Artwork,
  AudioRoute,
  AudioRouteKind,
  AudioSample,
  AudioSamplingOptions,
  BlobInput,
  BrowseOptions,
  CastState,
  CatalogItem,
  CatalogOptions,
  DiagnosticEntry,
  Discontinuity,
  FadeOptions,
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
  SleepEvent,
  SleepTimer,
  Source,
  SourceOptions,
  SourceInput,
} from '../types';
