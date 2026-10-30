// Value types shared by the web engine and its browser layer. Everything in
// `engine/` is free of DOM and React Native imports, so it runs under Jest.
// Twins: `ios/Core/Types.swift`, `android/.../core/Types.kt` — keep names and
// semantics identical.

import { PlayerError } from '../../errors';
import type { MediaTrack } from '../../core/subtitles/tracks';
import type {
  AudioRoute,
  InterruptionReason,
  NetworkState,
  PlaybackState,
  PlayerErrorCode,
} from '../../types';

export type { AudioRoute, InterruptionReason, NetworkState, PlaybackState };

/** The route before the platform reports one: the engine never guesses. */
export const UNKNOWN_ROUTE: AudioRoute = { kind: 'unknown', name: null };

export type FocusResult = 'granted' | 'delayed' | 'denied';

export interface Interruption {
  reason: InterruptionReason;
  /** Whether the system may end it by resuming playback on its own. */
  resumable: boolean;
  /** Wall-clock epoch ms when it began. */
  since: number;
}

/** An engine error: the public `PlayerError`, reported by the web platform. */
export function engineError(
  code: PlayerErrorCode,
  message: string,
  recoverable: boolean,
  details: {
    httpStatus?: number;
    platformDomain?: string;
    platformCode?: number;
    cause?: string;
  } = {}
): PlayerError {
  return new PlayerError({
    code,
    message,
    recoverable,
    platform: 'web',
    ...details,
  });
}

/** What the app asked to play. */
export interface SourceDescriptor {
  uri: string;
  headers: Record<string, string>;
  /** App hint. `null` = detect (indefinite duration ⇒ live). */
  liveHint: boolean | null;
  /**
   * Separate files of one video at different qualities. The engine picks one
   * and switches between them (`uri` is then unused); `null`: one file or an
   * adaptive manifest.
   */
  renditions?: Rendition[] | null;
  /** The app can hand over a new source on 401/403 or before `expiresAt`. */
  refreshable?: boolean;
  /** Wall-clock epoch ms when the source's URL stops working. */
  expiresAt?: number | null;
  /** Protected content: its key systems (the platform's driver plays it). */
  drm?: DrmDescriptor | null;
}

/** A key system's license server. */
export interface LicenseServer {
  licenseUrl: string;
  headers: Record<string, string>;
}

/** A source's `drm`, validated (see src/core/drm.ts). */
export interface DrmDescriptor {
  fairplay?: LicenseServer & {
    certificateUrl: string;
    contentId: string | null;
  };
  widevine?: LicenseServer;
  playready?: LicenseServer;
  clearkey?: {
    /** Key id → key, hex. */
    keys: Record<string, string> | null;
    licenseUrl: string | null;
    headers: Record<string, string>;
  };
  /** The app answers license requests itself (`getLicense`). */
  hook: boolean;
}

/** One file of a video at one quality (`SourceDescriptor.renditions`). */
export interface Rendition {
  uri: string;
  /** `null`: the source's headers. */
  headers: Record<string, string> | null;
  /** Pixels; `null` until the platform reads it from the file. */
  height: number | null;
  /** Bits per second; `null` until known. */
  bitrate: number | null;
  label: string | null;
  /** Sound only: the last step of the audio-only fallback. */
  audioOnly: boolean;
}

/** A quality of an adaptive source, as the driver reports it. */
export interface VideoVariant {
  id: string;
  height: number | null;
  bitrate: number | null;
  /** An audio-only variant (or, for HLS/DASH, the audio rendition alone). */
  audioOnly: boolean;
  label: string | null;
}

/** A quality the app can pick (`status.video.qualities`). */
export type VideoQuality = VideoVariant;

/** What the driver learned about the picture. */
export interface VideoInfo {
  width: number;
  height: number;
  hdr: boolean;
  /** The variant playing (adaptive sources), when the driver knows it. */
  variantId: string | null;
}

/** What the engine asks an adaptive source's driver to keep to. */
export interface QualityConstraints {
  maxHeight: number | null;
  maxBitrate: number | null;
  /** A variant the app picked; `null`: the driver's own ABR. */
  pinned: string | null;
  /** Prefer an audio-only variant (listen-only, background, fallback). */
  audioOnly: boolean;
}

/** Why a video player plays its sound alone. */
export type AudioOnlyReason = 'listen' | 'background' | 'fallback';

/** What a video player does when the app goes to the background. */
export type BackgroundMode = 'pause' | 'audio' | 'pip';

/** The audio-only fallback's thresholds (`fallbackToAudio`). */
export interface FallbackPolicy {
  /** Drop when the bandwidth stays under this × the lowest video quality… */
  dropBelowRatio: number;
  /** …for this long. */
  dropAfterMs: number;
  /** Or after this many stalls… */
  dropAfterStalls: number;
  /** …within this window. */
  stallWindowMs: number;
  /** Return when the bandwidth stays above this × the lowest video quality… */
  returnAboveRatio: number;
  /** …for this long. */
  returnAfterMs: number;
}

/** Quality caps (`PlayerOptions.video.quality`). */
export interface QualityPolicy {
  maxHeight: number | null;
  maxBitrate: number | null;
  cellularMaxHeight: number | null;
  cellularMaxBitrate: number | null;
  /** `auto`, `lowest`, `highest`, or a height to start at (or below). */
  startQuality: 'auto' | 'lowest' | 'highest' | number;
  /** Data Saver, Low Data Mode, `saveData`: at most 480p. */
  followDataSaver: boolean;
  /** Never more pixels than the view shows. */
  capToView: boolean;
}

/** A video player's engine rules (`EngineOptions.video`). */
export interface VideoEngineOptions {
  whenBackgrounded: BackgroundMode;
  /** Decorative: no focus, no media session, paused off screen and in the background. */
  ambient: boolean;
  keepAwake: boolean;
  focusWhenMuted: boolean;
  /** `null`: no audio-only fallback. */
  fallback: FallbackPolicy | null;
  quality: QualityPolicy;
  tracks: TrackPolicy;
}

/** How the starting audio and text tracks are chosen (`PlayerOptions.video.tracks`). */
export interface TrackPolicy {
  /** The user's languages, in order. */
  languages: string[];
  /** Follow the OS's captions and audio-description settings. */
  followSystem: boolean;
}

/** What the OS says about the user (`systemPreferencesChanged`). */
export interface SystemPreferences {
  /** The device's languages, in order. */
  languages: string[];
  captions: boolean;
  audioDescriptions: boolean;
}

export type { MediaTrack };

/** The view showing a video player (`viewChanged`). */
export interface ViewState {
  attached: boolean;
  visible: boolean;
  /** Physical pixels; 0 when unknown. */
  width: number;
  height: number;
}

/** Quality-of-experience numbers the engine counts (`getStats()`). */
export interface EngineStats {
  /** `load()` to the first audio, ms; `null` until then. */
  startupMs: number | null;
  rebufferCount: number;
  rebufferMs: number;
  qualitySwitches: number;
  audioOnlySwitches: number;
}

/** A video player's part of the status (`status.video`). */
export interface EngineVideoStatus {
  width: number | null;
  height: number | null;
  hdr: boolean;
  /** A frame of the current item has been shown. */
  firstFrame: boolean;
  audioOnly: AudioOnlyReason | null;
  pictureInPicture: boolean;
  qualities: VideoQuality[];
  /** The quality playing (`null` when unknown). */
  quality: string | null;
  /** The app's pick; `null` = automatic. */
  selectedQuality: string | null;
  /** The audio and text tracks: the source's, then the app's subtitle files. */
  tracks: MediaTrack[];
  audioTrack: string | null;
  /** `null`: no subtitles. */
  textTrack: string | null;
  /** Seconds the subtitles are shown later (negative: earlier). */
  subtitleDelay: number;
  fullscreen: boolean;
}

export function isNetworkSource(source: SourceDescriptor): boolean {
  const lower = source.uri.toLowerCase();
  return lower.startsWith('http://') || lower.startsWith('https://');
}

/** What the engine asks the driver to open. */
export interface OpenRequest {
  generation: number;
  source: SourceDescriptor;
  /** Seconds to start at; `null` = default (live edge / beginning). */
  startPosition: number | null;
  playWhenReady: boolean;
  /**
   * The engine re-opens on its own (`recovery.reconnect`): a driver may then
   * continue a dropped live connection itself. `false`: it never reconnects.
   */
  allowReconnect: boolean;
  /**
   * Open behind the current item and swap on its first frame (a quality
   * switch): the current item keeps playing until this one reports
   * `playing`, and is dropped then.
   */
  swap?: boolean;
  /** Index into the source's renditions, when it has them. */
  rendition?: number | null;
}

/** A point-in-time reading of the media element, taken on demand. */
export interface PlaybackSample {
  position: number;
  /** End of the buffered range, in the same timeline as `position`. */
  bufferedPosition: number;
}

/** What the driver learned when the item became ready. */
export interface ReadyInfo {
  /** Seconds; `null` when indefinite (live) or unknown. */
  duration: number | null;
  isLive: boolean;
  seekable: boolean;
}

export interface ReconnectInfo {
  /** 1-based attempt number of the next/current attempt. */
  attempt: number;
  /** Wall-clock epoch ms of the next attempt, `null` while an attempt runs. */
  nextAttemptAt: number | null;
  reason: string;
}

/** The authoritative snapshot published to JS. Mirrors `PlayerStatus`. */
export interface EngineStatus {
  state: PlaybackState;
  playWhenReady: boolean;
  /** Increments on every `load()`; identifies the source this status describes. */
  loadId: number;
  isLive: boolean;
  duration: number | null;
  seekable: boolean;
  interruption: Interruption | null;
  error: PlayerError | null;
  reconnect: ReconnectInfo | null;
  network: NetworkState;
  volume: number;
  muted: boolean;
  rate: number;
  route: AudioRoute;
  /** Wall-clock epoch ms when the sleep timer pauses the player, `null` when off. */
  sleepAt: number | null;
  /** `null` for an audio player. */
  video: EngineVideoStatus | null;
}

/** A linear move from `from` to `to` between two monotonic instants (ms). */
export interface Ramp {
  from: number;
  to: number;
  startAt: number;
  endAt: number;
}

/** The ramp's value at `t`: `from` before it starts, `to` once it ends. */
export function rampValue(ramp: Ramp, t: number): number {
  if (t >= ramp.endAt) return ramp.to;
  if (t <= ramp.startAt) return ramp.from;
  return (
    ramp.from +
    (ramp.to - ramp.from) * ((t - ramp.startAt) / (ramp.endAt - ramp.startAt))
  );
}

/** One structured diagnostic line (ring-buffered, optionally streamed). */
export interface EngineDiagnostic {
  wallTime: number;
  generation: number;
  state: PlaybackState;
  event: string;
  details: Record<string, string>;
}
