// `react-native-anything-player/video`: what a video player is shown with in
// React Native, React Native Web and Expo web. The player itself is the same
// `Player` (`new Player({ video: true })`).
//
//   import { Player } from 'react-native-anything-player';
//   import { VideoView } from 'react-native-anything-player/video';
//
//   const player = new Player({ video: true });
//   <VideoView player={player} style={{ aspectRatio: 16 / 9 }} />
//
// iOS and Android need the video module; the web needs nothing.
export { VideoView } from '../components/VideoView';
export type { VideoViewProps } from '../components/VideoView';
export { useCues } from '../core/hooks';
export type {
  AudioOnlyReason,
  CueAlign,
  CueSpan,
  CueVertical,
  MediaTrack,
  PlaybackStats,
  Rendition,
  SubtitleCue,
  SubtitleFormat,
  SubtitleSource,
  SourceRefreshRequest,
  Thumbnail,
  TrackKind,
  VideoOptions,
  VideoQuality,
  VideoQualityOptions,
  VideoStatus,
} from '../types';
