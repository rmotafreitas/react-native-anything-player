// What a media element driver reports to its player (the engine's
// callbacks), each tagged with the generation of the item it is about.

import type { PlayerError } from '../../errors';
import type { StreamMetadata } from '../engine/StreamMetadata';
import type {
  InterruptionReason,
  ReadyInfo,
  VideoInfo,
  VideoVariant,
} from '../engine/types';
import type { LicenseRequestEvent } from '../../core/drm';
import type { AudioElementLike } from './dom';
import type { MediaTrack } from '../../core/subtitles/tracks';
import type { SubtitleCue } from '../../core/subtitles/types';

export interface DriverObserver {
  onReady(generation: number, info: ReadyInfo): void;
  onPlaying(generation: number): void;
  onBuffering(generation: number): void;
  onEnded(generation: number): void;
  onFailed(generation: number, error: PlayerError): void;
  onPausedExternally(generation: number, reason: InterruptionReason): void;
  onStreamMetadata(generation: number, metadata: StreamMetadata): void;
  onDiscontinuity(generation: number, position: number): void;
  onNote(
    generation: number,
    event: string,
    details: Record<string, string>
  ): void;
  /** The element changed (a new one replaced a tapped one); the sampler re-attaches. */
  onElementReplaced(element: AudioElementLike): void;
  /** Video: the picture's size (and the variant playing). */
  onVideoInfo?(generation: number, info: VideoInfo): void;
  /** Video: the first frame was shown. */
  onFirstFrame?(generation: number): void;
  /** Video: an adaptive source's variants. */
  onVariants?(generation: number, variants: VideoVariant[]): void;
  /** Video: a bandwidth estimate, bits per second. */
  onBandwidth?(generation: number, bitsPerSecond: number): void;
  /** Video: the source's own audio and text tracks. */
  onTracks?(generation: number, tracks: MediaTrack[]): void;
  /** Video: the cues of the source's text track on screen now. */
  onSourceCues?(generation: number, cues: SubtitleCue[]): void;
  /** Video: the user played, paused or sought with the browser's own controls. */
  onUserCommand?(
    generation: number,
    command: 'play' | 'pause' | 'seek',
    position: number
  ): void;
  /** Protected content needs a license from the app's `drm.getLicense`. */
  onLicenseRequest?(generation: number, request: LicenseRequestEvent): void;
}

/** What a play() attempt came to: the module rejects `play` on `blocked`. */
export type PlayAttempt = 'started' | 'blocked' | 'failed';

/** Live progress for the module's synchronous `getProgress`. */
export interface ProgressReading {
  position: number;
  duration: number | null;
  buffered: number;
  liveOffset: number | null;
  isPlaying: boolean;
  rate: number;
}
