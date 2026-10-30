import type { PlayerError } from './errors';
import type { MediaTrack } from './core/subtitles/tracks';
import type { SubtitleCue, SubtitleFormat } from './core/subtitles/types';

export type { MediaTrack, TrackKind } from './core/subtitles/tracks';
export type {
  CueAlign,
  CueSpan,
  CueVertical,
  SubtitleCue,
  SubtitleFormat,
} from './core/subtitles/types';

/**
 * Playback state. Native owns it; JS mirrors it.
 *
 * | state | meaning |
 * | --- | --- |
 * | `idle` | nothing loaded |
 * | `loading` | a source is being opened, no audio yet |
 * | `buffering` | playback wanted, audio not flowing (stall or start) |
 * | `playing` | audio is flowing |
 * | `paused` | loaded, not playing — by the app/user, or by the system (see `interruption`) |
 * | `stopped` | network/decoder released; `play()` re-opens |
 * | `reconnecting` | the connection was lost while playback is wanted; recovery scheduled |
 * | `ended` | a finite source played to its end |
 * | `error` | unrecoverable failure (see `error`) |
 */
export type PlaybackState =
  | 'idle'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'stopped'
  | 'reconnecting'
  | 'ended'
  | 'error';

/** Why the system (not the app) paused playback or refused to start it. */
export type InterruptionReason =
  /** iOS audio-session interruption (call, Siri, an app that does not mix). */
  | 'interruption'
  /** Android: another app took audio focus for good. */
  | 'audio-focus-loss'
  /** Android: a call or short clip took focus; the system gives it back. */
  | 'audio-focus-loss-transient'
  /** Android: focus will be granted later; playback starts then. */
  | 'audio-focus-delayed'
  /** Focus/session refused (e.g. during a phone call). */
  | 'audio-focus-denied'
  /** Headphones unplugged / Bluetooth disconnected. */
  | 'output-disconnected'
  /** The platform paused without saying why. */
  | 'system'
  /** Web: the browser refused to start audio without a user gesture (autoplay policy). Call `play()` from a tap. */
  | 'autoplay-blocked'
  /** Video: the app went to the background (`video.whenBackgrounded`, ambient players). */
  | 'background'
  /** Video: an ambient player's view left the screen; it resumes when shown again. */
  | 'offscreen';

/** The system paused playback, or refused to start it. */
export interface Interruption {
  /** What caused it. */
  reason: InterruptionReason;
  /** The system may end it by resuming on its own (if auto-resume is on). */
  resumable: boolean;
  /** Epoch ms. */
  since: number;
}

/** Progress of automatic recovery (see the Recovery policy guide). */
export interface ReconnectInfo {
  /** 1-based attempt number. */
  attempt: number;
  /** Epoch ms of the next attempt, `null` while an attempt is running. */
  nextAttemptAt: number | null;
  /** The failure being recovered from, for logs (free text, not stable). */
  reason: string;
}

/**
 * Connectivity as the engine sees it. `online` means a validated internet
 * connection: a captive portal is `offline`.
 */
export type NetworkState = 'online' | 'offline' | 'unknown';

/** Serializable error shape inside a status snapshot. */
export interface PlayerErrorInfo {
  /** What went wrong. */
  code: PlayerErrorCode;
  /** Human-readable description. */
  message: string;
  /** Retrying (reconnect, or calling `play()` again) can succeed. */
  recoverable: boolean;
  /** The platform that reported it; absent for errors raised in JS. */
  platform?: 'ios' | 'android' | 'web';
  /** The server's HTTP status, for `HTTP_ERROR` and `SOURCE_NOT_FOUND`. */
  httpStatus?: number;
  /** Native error domain, e.g. `AVFoundationErrorDomain`. */
  platformDomain?: string;
  /** Native error code within `platformDomain`. */
  platformCode?: number;
  /** Native error chain (`PlayerError.nativeCause`). */
  cause?: string;
}

/** Every error code. The Errors guide lists the cause of each and whether it is recoverable. */
export type PlayerErrorCode =
  | 'INVALID_SOURCE'
  | 'SOURCE_NOT_FOUND'
  | 'UNSUPPORTED_FORMAT'
  | 'DECODER_ERROR'
  | 'NETWORK_UNAVAILABLE'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'STREAM_ENDED'
  | 'AUDIO_FOCUS_DENIED'
  | 'AUDIO_SESSION_ERROR'
  | 'NOT_SEEKABLE'
  | 'NO_SOURCE'
  | 'PLAYER_RELEASED'
  | 'INVALID_ARGUMENT'
  | 'NATIVE_PLAYER_ERROR'
  | 'AUTOPLAY_BLOCKED'
  | 'NATIVE_MODULE_MISSING'
  | 'ROUTE_PICKER_UNAVAILABLE'
  | 'CAST_UNAVAILABLE'
  | 'CAST_UNSUPPORTED_SOURCE'
  | 'SOUND_UNAVAILABLE'
  | 'VIDEO_UNAVAILABLE'
  | 'DRM_UNSUPPORTED'
  | 'DRM_LICENSE_FAILED'
  | 'SUBTITLE_LOAD_FAILED'
  | 'INTERNAL_ERROR';

/**
 * What kind of output a player's audio goes to.
 *
 * | kind | output |
 * | --- | --- |
 * | `speaker` | the device's own speaker (or earpiece) |
 * | `headphones` | wired headphones or a headset |
 * | `bluetooth` | Bluetooth headphones, speakers or a car kit (A2DP, LE, HFP) |
 * | `airplay` | an AirPlay receiver (iOS, Safari) |
 * | `cast` | a Google Cast receiver: the receiver plays the stream itself |
 * | `car` | CarPlay / a car's audio over USB |
 * | `hdmi` | HDMI or DisplayPort audio |
 * | `usb` | a USB audio device |
 * | `other` | an output the platform reports but RNAP does not classify |
 * | `unknown` | the platform does not say (a browser's local output) |
 */
export type AudioRouteKind =
  | 'speaker'
  | 'headphones'
  | 'bluetooth'
  | 'airplay'
  | 'cast'
  | 'car'
  | 'hdmi'
  | 'usb'
  | 'other'
  | 'unknown';

/** Where a player's audio goes (see the Casting and AirPlay guide). */
export interface AudioRoute {
  /** The kind of output. */
  kind: AudioRouteKind;
  /** The device's name when the platform tells it ("Living Room", "AirPods Pro"), else `null`. */
  name: string | null;
}

/** The authoritative snapshot of a player. */
export interface PlayerStatus {
  /** The playback state. */
  state: PlaybackState;
  /** Whether playback is wanted (what a play/pause button should show). */
  playWhenReady: boolean;
  /** Increments on every `load()`: which source this status describes. */
  loadId: number;
  /** A live / indefinite source (radio, live HLS). */
  isLive: boolean;
  /** Seconds; `null` for live or unknown. */
  duration: number | null;
  /** `seekTo` is allowed. */
  seekable: boolean;
  /** Set while the system holds playback paused (or refused to start it). */
  interruption: Interruption | null;
  /** Set when `state === 'error'`. */
  error: PlayerErrorInfo | null;
  /** Set while `reconnecting` (and while the reconnect attempt is loading). */
  reconnect: ReconnectInfo | null;
  /** Connectivity as the engine sees it. */
  network: NetworkState;
  /** 0…1, as set by `setVolume`. */
  volume: number;
  /** As set by `setMuted`. */
  muted: boolean;
  /** Playback rate, as set by `setRate`. */
  rate: number;
  /** Where the audio goes: the speaker, headphones, AirPlay, a Cast receiver… */
  route: AudioRoute;
  /**
   * Epoch ms when the sleep timer pauses the player, `null` when no timer is
   * set (see `Player.sleep`).
   */
  sleepAt: number | null;
  /** The picture, its qualities and tracks; `null` for an audio player. */
  video: VideoStatus | null;
}

/** Why a video player plays its sound alone. */
export type AudioOnlyReason =
  /** `setListenOnly(true)`. */
  | 'listen'
  /** The app is in the background with `whenBackgrounded: 'audio'`. */
  | 'background'
  /** The network is too slow for any picture (`fallbackToAudio`). */
  | 'fallback';

/** One quality of a video: an HLS/DASH variant, or one of `renditions`. */
export interface VideoQuality {
  /** Pass it to `selectQuality`. */
  id: string;
  /** Pixels, `null` when unknown. */
  height: number | null;
  /** Bits per second, `null` when unknown. */
  bitrate: number | null;
  /** The name the manifest or the rendition gave it, `null` when none. */
  label: string | null;
  /** Sound only. */
  audioOnly: boolean;
}

/** `status.video`: what a video player shows and can show. */
export interface VideoStatus {
  /** The picture's size in pixels, `null` until known. */
  width: number | null;
  /** The picture's height in pixels, `null` until known. */
  height: number | null;
  /** A high-dynamic-range picture. */
  hdr: boolean;
  /** A frame of the current source has been shown (hide the poster). */
  firstFrame: boolean;
  /** Why the sound plays alone, `null` while the picture plays. */
  audioOnly: AudioOnlyReason | null;
  /** The picture is in Picture in Picture. */
  pictureInPicture: boolean;
  /** The system's fullscreen player is up. */
  fullscreen: boolean;
  /** The qualities to pick from (`selectQuality`); empty for a single file. */
  qualities: VideoQuality[];
  /** The quality playing, `null` when unknown. */
  quality: string | null;
  /** The quality the app picked, `null` for automatic. */
  selectedQuality: string | null;
  /** The source's audio and text tracks, then the app's subtitle files. */
  tracks: MediaTrack[];
  /** The audio track playing, `null` when the source has none to pick from. */
  audioTrack: string | null;
  /** The subtitles shown, `null` for none. */
  textTrack: string | null;
  /** Seconds the subtitles are shown later (negative: earlier). */
  subtitleDelay: number;
}

/** A progress reading. Positions are seconds. */
export interface Progress {
  /** Playhead. */
  position: number;
  /** `null` for live/unknown. */
  duration: number | null;
  /** End of the buffered range. */
  buffered: number;
  /** Seconds of audio buffered past the playhead. */
  bufferedAhead: number;
  /**
   * Seconds behind the live edge, when it can be measured: HLS program dates,
   * ExoPlayer's live window, and on iOS any live HTTP stream (from the audio
   * the stream proxy has handed the player). Else `null`: use `bufferedAhead`.
   */
  liveOffset: number | null;
  /** Epoch ms of the reading. */
  timestamp: number;
}

/** An image by URI. */
export interface Artwork {
  /** Remote URL or local file URI. */
  uri: string;
}

/** Metadata carried by the stream itself (ICY, ID3, HLS timed metadata, file tags). */
export interface MediaMetadata {
  /** Song title (for ICY, parsed from `StreamTitle` by `metadata.streamTitleFormat`). */
  title?: string | null;
  /** Artist (for ICY, parsed from `StreamTitle`). */
  artist?: string | null;
  /** Album. */
  album?: string | null;
  /** Station name (ICY `icy-name` response header). */
  station?: string | null;
  /** Genre (ICY `icy-genre` response header). */
  genre?: string | null;
  /** Cover art. */
  artwork?: Artwork | null;
  /** Every raw field as sent by the stream (e.g. `StreamTitle`, `StreamUrl`, `TIT2`). */
  raw?: Record<string, string>;
  /** Epoch ms when it became audible. */
  timestamp: number;
}

/** Asset reference from `require('./file.mp3')`. */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- Public API name documents Metro asset references.
export type AssetModule = number;

/** An image: a URL or file URI, an `Artwork`, or `require('./cover.png')`. */
export type ArtworkInput = string | Artwork | AssetModule;

/** What the lock screen / notification shows for a source (app-provided). */
export interface NowPlayingMetadata {
  /** Title (e.g. a song, or a station name). */
  title?: string;
  /** Artist. */
  artist?: string;
  /** Album. */
  album?: string;
  /** Remote URL, local file URI, or `require('./cover.png')`. */
  artwork?: ArtworkInput;
  /**
   * The song's length in seconds. On a live stream (radio), giving it shows
   * the *song's* progress on the lock screen / notification instead of a
   * "live" badge; it stays non-seekable. Advances only while audio plays.
   */
  duration?: number;
  /** Seconds into the song when this call is made (default 0). Needs `duration`. */
  elapsed?: number;
  /**
   * Whether the lock screen / notification marks the item as live (the
   * "live" badge). Defaults to the stream's own liveness. Pass `false` on a
   * radio between songs (a jingle, a gap) to show plain metadata, without a
   * badge or a progress bar. A `duration` always wins: the song's progress.
   */
  live?: boolean;
}

/**
 * What to play, with per-source options: a `uri`, or (video) `renditions`,
 * separate files of one video at different qualities.
 */
export type Source = SourceOptions &
  (
    | {
        /**
         * `https://…`, `http://…`, `file://…`, `content://…` (Android) or an
         * absolute path. On the web also `blob:…` (an object URL you made)
         * and `data:…`; the app owns a `blob:` URL it made and revokes it.
         */
        uri: string;
        /** Video: separate files of this video at different qualities (`uri` is then ignored). */
        renditions?: Rendition[];
      }
    | {
        /** Not needed with `renditions` (the first picture's file stands in). */
        uri?: string;
        /** Video: separate files of this video at different qualities. */
        renditions: Rendition[];
      }
  );

/** A source's options besides where the media is (`Source`). */
export interface SourceOptions {
  /** HTTP headers sent with every request for this source (e.g. `User-Agent`, auth). */
  headers?: Record<string, string>;
  /**
   * Live-stream hint. Usually unnecessary — an indefinite duration is detected
   * as live — but it lets live behaviour (fast start, live-edge recovery)
   * apply from the very first byte.
   */
  live?: boolean;
  /** Lock-screen metadata (e.g. station name and logo). Stream metadata updates on top. */
  metadata?: NowPlayingMetadata;
  /** Video: subtitle files, besides the source's own tracks. */
  subtitles?: SubtitleSource[];
  /**
   * Called on a 401/403 and a minute before `expiresAt`, to get a fresh
   * source (a newly signed URL, a new token in `headers`). Playback goes on
   * where it was. While JavaScript is not running, the player retries the old
   * source with the usual backoff.
   */
  refresh?: (request: SourceRefreshRequest) => Promise<SourceInput>;
  /** Epoch ms when the URL stops working (a signed URL's expiry). */
  expiresAt?: number;
  /** Video: shown until the first frame. */
  poster?: ArtworkInput;
  /** Video: a WebVTT track of thumbnail sprites, for `getThumbnail`. */
  thumbnails?: string;
  /** Protected content: the key systems and their license servers (the Video guide, "DRM"). */
  drm?: DrmConfig;
}

/**
 * One file of a video at one quality (`Source.renditions`). Leave out what
 * you do not know: RNAP reads the height and bitrate from the file.
 */
export interface Rendition {
  /** The file. */
  uri: string;
  /** Default: the source's headers. */
  headers?: Record<string, string>;
  /** The picture's height in pixels (read from the file when absent). */
  height?: number;
  /** Bits per second (estimated from the height when absent). */
  bitrate?: number;
  /** Shown in quality menus, e.g. `'1080p'`. */
  label?: string;
  /** The sound alone: the last step of `fallbackToAudio` and of `whenBackgrounded: 'audio'`. */
  audioOnly?: boolean;
}

/** A subtitle file for `Source.subtitles` or `Player.addSubtitles`. */
export interface SubtitleSource {
  /** Default: `sub:<index>`. Pass it to `selectSubtitles`. */
  id?: string;
  /** Where the file is. */
  uri?: string;
  /** Or its contents. */
  text?: string;
  /** BCP 47 (`pt-BR`) or ISO 639 (`por`). */
  language?: string;
  /** What a menu shows (default: the language). */
  label?: string;
  /** Default: from the file name, else from the contents. */
  format?: SubtitleFormat;
  /** `captions`: for the deaf and hard of hearing (SDH). Default `subtitles`. */
  kind?: 'subtitles' | 'captions';
  /** Only what is not in the audio's language (signs, foreign lines). */
  forced?: boolean;
  /** The file to show when the user's choice does not decide. */
  default?: boolean;
  /** The file's text encoding (`windows-1252`, `shift_jis`…). Default: detected. */
  encoding?: string;
  /** HTTP headers for `uri`. Default: the source's. */
  headers?: Record<string, string>;
}

/** Why `Source.refresh` is called. */
export interface SourceRefreshRequest {
  /** `unauthorized`: the server answered 401/403. `expiring`: `expiresAt` is a minute away. */
  reason: 'unauthorized' | 'expiring';
}

/**
 * DRM, by key system: give every one the content is packaged for, and each
 * platform uses one it has (iOS and Safari FairPlay; Android Widevine, else
 * PlayReady, else Clear Key; other browsers Widevine, PlayReady or Clear
 * Key). A source with none the platform has fails with `DRM_UNSUPPORTED`;
 * a license that cannot be had, with `DRM_LICENSE_FAILED`.
 */
export interface DrmConfig {
  /** Apple FairPlay Streaming (iOS, Safari). */
  fairplay?: {
    /** Where the license (CKC) is requested: the SPC is POSTed as is. */
    licenseUrl: string;
    /** The application certificate. */
    certificateUrl: string;
    /** Headers for both requests. */
    headers?: Record<string, string>;
    /** The content id the SPC is made for; default: the `skd://` URI's host. */
    contentId?: string;
  };
  /** Google Widevine (Android, Chromium, Firefox, Edge). */
  widevine?: {
    /** Where the license is requested. */
    licenseUrl: string;
    /** Headers for the license request. */
    headers?: Record<string, string>;
  };
  /** Microsoft PlayReady (Edge, Android TVs). */
  playready?: {
    /** Where the license is requested. */
    licenseUrl: string;
    /** Headers for the license request. */
    headers?: Record<string, string>;
  };
  /** W3C Clear Key (tests, light protection; every browser and Android). */
  clearkey?: {
    /** Key id → key, hex: no license server at all. */
    keys?: Record<string, string>;
    /** Or where the keys are requested (the W3C JSON exchange). */
    licenseUrl?: string;
    /** Headers for the license request. */
    headers?: Record<string, string>;
  };
  /**
   * Exchanges the license itself: for a provider that wraps its requests (a
   * JSON envelope, a token fetched first). RNAP hands over the platform's
   * challenge and plays the license returned; the key system's `licenseUrl`
   * is then only passed along.
   */
  getLicense?(request: LicenseRequest): Promise<ArrayBuffer | Uint8Array>;
}

/** A license the platform needs, for {@link DrmConfig.getLicense}. */
export interface LicenseRequest {
  /** The key system the platform uses. */
  keySystem: 'fairplay' | 'widevine' | 'playready' | 'clearkey';
  /** The challenge to send (FairPlay's SPC). */
  challenge: Uint8Array;
  /** FairPlay: the content id the SPC was made for; `null` elsewhere. */
  contentId: string | null;
  /** The key system's `licenseUrl`, if configured. */
  licenseUrl: string | null;
  /** The key system's `headers`. */
  headers: Record<string, string>;
}

/** What `load()` accepts: a {@link Source}, a URI, or `require('./file.mp3')`. */
export type SourceInput = Source | string | AssetModule;

/**
 * A `Blob` or `File` for `Player.load()` on the web: a file the user picked or
 * dropped. Described by the two fields RNAP needs so the declarations compile
 * with React Native's own `Blob`, with the DOM's, and with neither.
 */
export interface BlobInput {
  /** Bytes. */
  readonly size: number;
  /** MIME type, `''` when unknown. */
  readonly type: string;
}

/** Options for `load()`. */
export interface LoadOptions {
  /**
   * Start playing once loaded. Default: keep the current intent — a playing
   * player keeps playing the new source (switching stations), a paused one
   * stays paused.
   */
  autoplay?: boolean;
  /** Seconds to start at (ignored for live streams). */
  startPosition?: number;
}

/** A lock-screen / notification / headset / car command. */
export type RemoteCommand =
  | 'play'
  | 'pause'
  | 'togglePlayPause'
  | 'stop'
  | 'seek'
  | 'next'
  | 'previous'
  | 'skipForward'
  | 'skipBackward';

/** Options for `new Player()`. All are optional; the defaults suit a radio app. */
export interface PlayerOptions {
  /**
   * A stable id of your choosing (e.g. `'main'`). A player with an id outlives
   * the JavaScript that created it: when native already has a player with
   * this id — one Siri or Google Assistant started while the app was not
   * running, or one that kept playing across a reload — `new Player({ id })`
   * attaches to it, keeping its source, state and options (the options passed
   * here are then ignored). Two live `Player` objects cannot share an id.
   */
  id?: string;
  /** Automatic recovery (see the Recovery policy guide). */
  recovery?: {
    /**
     * Re-open on its own after recoverable failures, stalls and network
     * changes while playback is wanted. `false`: a failure or a stall ends in
     * `error` and a network change re-opens nothing (`play()` still re-opens).
     * Default `true`.
     */
    reconnect?: boolean;
    /** Stop recovering after this long without stable playback (`null` = never). Default 10 min. */
    giveUpAfterMs?: number | null;
    /**
     * A live stream that has fallen this far behind (pauses + stalls) is
     * re-opened at the live edge when it resumes. Default 5000.
     */
    liveMaxDriftMs?: number;
  };
  /** Calls, Siri, other apps taking audio focus. */
  interruptions?: {
    /** Resume when the system ends a transient interruption (call, Siri, short focus loss). Default `true`. */
    autoResume?: boolean;
  };
  /** Lock screen, notification and car controls. */
  mediaSession?: {
    /** Show this player on the lock screen / notification / car. Default `true`. */
    enabled?: boolean;
    /**
     * Extra remote commands to enable and forward to JS as `remoteCommand`
     * events (`next`, `previous`, `skipForward`, `skipBackward`). Play, pause,
     * stop and seek are always handled natively — they work while JS is frozen.
     * A `play` / `togglePlayPause` while nothing is loaded is always forwarded:
     * only the app knows what to load (e.g. iOS relaunched the app in the
     * background because Play was pressed in Control Center).
     */
    commands?: RemoteCommand[];
  };
  /** Audio session (iOS) / audio focus (Android). */
  audio?: {
    /** `speech` pauses (instead of ducking) for navigation prompts. Default `music`. */
    contentType?: 'music' | 'speech';
    /** Play alongside other apps. Disables interruptions handling and lock-screen controls on iOS. */
    mixWithOthers?: boolean;
  };
  /** Stream metadata. */
  metadata?: {
    /** How the station formats ICY `StreamTitle`. Default `artist-title`. */
    streamTitleFormat?: 'artist-title' | 'title-artist' | 'title';
    /** Show stream metadata on the lock screen. Default `true`. */
    useStreamMetadataForNowPlaying?: boolean;
  };
  /** Android-only options. */
  android?: {
    /** Stop playback when the user swipes the app away from recents. Default `false`. */
    stopOnTaskRemoved?: boolean;
  };
  /**
   * Volume fades on play, pause and stop (see `Player.setFade`). Off by
   * default.
   */
  fade?: FadeOptions;
  /** Start with diagnostics enabled (see `setDiagnosticsEnabled`). */
  diagnostics?: boolean;
  /**
   * A video player: `true` for the defaults. On iOS and Android it needs the
   * video module (`npx rnap add video`); without it, `VIDEO_UNAVAILABLE`.
   */
  video?: boolean | VideoOptions;
  /**
   * Emit `progress` events this often (ms) while playing. They come from a
   * native timer, so they also run JS where the app's own timers are frozen
   * (Android in the background). Off by default; `getProgress()` is
   * synchronous and cheap for foreground UIs.
   */
  progressInterval?: number;
}

/** One engine decision from the diagnostics trace. */
export interface DiagnosticEntry {
  /** Epoch ms. */
  time: number;
  /** Source generation (increments on every open, including reconnects). */
  generation: number;
  /** The state when it was recorded. */
  state: PlaybackState;
  /** What happened, e.g. `load`, `transition`, `failure`, `reopen`, `stale event dropped`. */
  event: string;
  /** Event-specific fields, e.g. `{ from, to, cause }` for a `transition`. */
  details: Record<string, string>;
}

/** Payload of the `remoteCommand` event. */
export interface RemoteCommandEvent {
  /** The command the user sent. */
  command: RemoteCommand;
  /** Seconds, for `seek`. */
  position?: number;
}

/** Every event `Player.on()` accepts, with its listener's signature. */
export interface PlayerEventMap {
  /** Any status field changed. */
  status: (status: PlayerStatus) => void;
  /** `status.state` changed. */
  stateChange: (state: PlaybackState, previous: PlaybackState) => void;
  /** New stream metadata became audible. */
  metadata: (metadata: MediaMetadata) => void;
  /** A failure. `fatal: false` means recovery is in progress. */
  error: (error: PlayerError, info: { fatal: boolean }) => void;
  /** A finite source played to its end. */
  ended: () => void;
  /** A remote command the app opted into (`mediaSession.commands`). */
  remoteCommand: (event: RemoteCommandEvent) => void;
  /** Structured engine trace (only while diagnostics are enabled). */
  diagnostic: (entry: DiagnosticEntry) => void;
  /** A decoded-audio window (only while `setAudioSampling` is enabled). */
  audioSample: (sample: AudioSample) => void;
  /** A progress reading, every `progressInterval` ms while playing. */
  progress: (progress: Progress) => void;
  /**
   * A live stream's audio jumped: playback moved onto a fresh connection of
   * the same source (a dropped connection replaced without stopping). A new
   * Icecast/Shoutcast connection starts with the server's burst of recent
   * audio, so what is heard repeats or skips — no state change accompanies
   * it. Reported when the jump becomes audible.
   */
  discontinuity: (event: Discontinuity) => void;
  /** `status.route` changed (AirPlay chosen, headphones unplugged, casting started…). */
  routeChange: (route: AudioRoute, previous: AudioRoute) => void;
  /** A voice assistant, or `playFromSearch()`, started a catalog item on this player. */
  searchPlay: (event: SearchPlayEvent) => void;
  /** The sleep timer ran out (`status.sleepAt` is back to `null`). */
  sleep: (event: SleepEvent) => void;
  /** Video: the subtitles on screen changed (the selected text track's). */
  cues: (cues: SubtitleCue[]) => void;
  /** Video: the first frame of the source was shown. */
  firstFrame: () => void;
  /** Video: Picture in Picture started or ended. */
  pictureInPictureChange: (active: boolean) => void;
  /** Video: fullscreen started or ended. */
  fullscreenChange: (active: boolean) => void;
}

/** `PlayerOptions.video`. */
export interface VideoOptions {
  /**
   * When the app goes to the background: `pause` (default on iOS and
   * Android), `audio` (keep the sound and the lock screen, stop the picture;
   * the default on the web, where a hidden tab plays on) or `pip` (Picture
   * in Picture; pause when it is not possible).
   */
  whenBackgrounded?: 'pause' | 'audio' | 'pip';
  /**
   * A decorative loop: muted, looping, no audio focus or lock screen, paused
   * while off screen or in the background.
   */
  ambient?: boolean;
  /** Keep the screen on while playing in a visible view. Default `true`. */
  keepAwake?: boolean;
  /** A muted video takes audio focus and the lock screen anyway. Default `false`. */
  focusWhenMuted?: boolean;
  /**
   * On a network too slow for any picture, play the sound alone and bring
   * the picture back when it recovers. Default `false`; an object tunes the
   * thresholds.
   */
  fallbackToAudio?: boolean | AudioFallbackOptions;
  /** Caps on the quality, and where automatic starts. */
  quality?: VideoQualityOptions;
  /** How the starting audio and text tracks are chosen. */
  tracks?: {
    /** The user's languages, in order (default: the device's). */
    languages?: string[];
    /** Follow the OS's captions and audio-description settings. Default `true`. */
    followSystem?: boolean;
  };
}

/** The audio-only fallback's thresholds (`fallbackToAudio`). */
export interface AudioFallbackOptions {
  /** Drop when the bandwidth stays under this × the lowest video quality… (1.2) */
  dropBelowRatio?: number;
  /** …for this long, ms (10 000). */
  dropAfterMs?: number;
  /** Or after this many stalls… (2) */
  dropAfterStalls?: number;
  /** …within this window, ms (30 000). */
  stallWindowMs?: number;
  /** Return above this × the lowest video quality… (1.5) */
  returnAboveRatio?: number;
  /** …for this long, ms (30 000). */
  returnAfterMs?: number;
}

/** Quality caps (`video.quality`). */
export interface VideoQualityOptions {
  /** The tallest picture, pixels. */
  maxResolution?: number;
  /** Bits per second. */
  maxBitrate?: number;
  /** Caps on cellular and other metered networks. */
  cellular?: {
    /** The tallest picture on a metered network, pixels. */
    maxResolution?: number;
    /** Bits per second on a metered network. */
    maxBitrate?: number;
  };
  /** Where automatic quality starts (default `auto`: by the network). */
  startQuality?: 'auto' | 'lowest' | 'highest' | number;
  /** Data Saver, Low Data Mode, `saveData`: at most 480p. Default `true`. */
  followDataSaver?: boolean;
  /** Never more pixels than the view shows. Default `true`. */
  capToView?: boolean;
}

/** Quality-of-experience numbers since the last `load()` (`getStats()`). */
export interface PlaybackStats {
  /** `load()` to the first sound, ms; `null` until then. */
  startupMs: number | null;
  /** Times playback stalled after it had started. */
  rebufferCount: number;
  /** Time spent stalled, ms. */
  rebufferMs: number;
  /** Quality changes (renditions and pinned variants). */
  qualitySwitches: number;
  /** Times the sound went on alone (listen-only, background, fallback). */
  audioOnlySwitches: number;
  /** Frames the platform dropped, when it says. */
  droppedFrames: number | null;
  /** The last bandwidth estimate, bits per second. */
  bandwidth: number | null;
}

/** A seek-preview image (`getThumbnail`): `uri`, cropped to the rectangle when one is given. */
export interface Thumbnail {
  /** The image (a sprite sheet when a rectangle is given). */
  uri: string;
  /** The rectangle's left edge in the image, pixels (`null`: the whole image). */
  x: number | null;
  /** The rectangle's top edge, pixels. */
  y: number | null;
  /** The rectangle's width, pixels. */
  width: number | null;
  /** The rectangle's height, pixels. */
  height: number | null;
}

/**
 * Volume fades applied natively on play, pause and stop. Seconds; `0` or
 * absent = no fade.
 */
export interface FadeOptions {
  /** `play()` (and a `load` that starts playback) fades in from silence over this long, once the audio flows. */
  in?: number;
  /**
   * `pause()` and `stop()` fade out over this long, then pause or stop. Also
   * the sleep timer's fade-out when `Player.sleep` does not give one.
   */
  out?: number;
}

/** What `Player.sleep` takes. Seconds. */
export interface SleepTimer {
  /** Pause after this long (wall time: it counts while paused too). */
  after: number;
  /**
   * Fade the volume out over the last `fadeOut` seconds before the pause.
   * Defaults to `fade.out` (no fade without one).
   */
  fadeOut?: number;
}

/** See {@link PlayerEventMap.sleep}. */
export interface SleepEvent {
  /** `fired`: the timer ran out (the player paused, if it was playing). */
  reason: 'fired';
  /** Epoch ms. */
  timestamp: number;
}

/** See {@link PlayerEventMap.discontinuity}. */
export interface Discontinuity {
  /** Media position (s) where the new connection's audio starts. */
  position: number;
  /** Epoch ms when it was reported (as it became audible). */
  timestamp: number;
}

/**
 * One window of decoded audio, for visualizers. Produced natively from the
 * PCM on its way to the speaker: already downmixed to mono and resampled.
 */
export interface AudioSample {
  /** `points` values in -1…1 covering {@link duration} seconds of audio. */
  waveform: number[];
  /** RMS loudness of the window, 0…1. */
  level: number;
  /** Seconds of audio the window spans. */
  duration: number;
  /**
   * Seconds until this window is heard (output buffers + device latency).
   * Delay drawing by this much to match what the listener hears.
   */
  outputLatency: number;
  /** Epoch ms when the window was decoded. */
  timestamp: number;
}

/** Options for `setAudioSampling()`. */
export interface AudioSamplingOptions {
  /** Start (`true`) or stop (`false`) emitting `audioSample` events. */
  enabled: boolean;
  /** Points per waveform (16…4096, default 1024). */
  points?: number;
}

/** An event name. */
export type PlayerEvent = keyof PlayerEventMap;

/** What a voice request or `playFromSearch()` asked for. */
export interface SearchRequest {
  /**
   * What the user said, without the app's name: `"jazz radio"`. May be empty
   * ("play something on MyApp"): then the last catalog item played, or the
   * first one, plays.
   */
  query: string;
  /** A title the assistant recognised in the request. */
  title?: string;
  /** An artist the assistant recognised. */
  artist?: string;
  /** An album the assistant recognised. */
  album?: string;
  /** A genre the assistant recognised. */
  genre?: string;
  /** What the assistant thinks is meant; narrows results to items of that `kind` when any match. */
  focus?: SearchFocus;
  /**
   * Only items in this group or its subgroups (`"Podcasts"` matches
   * `"Podcasts/Daily"`) are searched. See {@link CatalogItem.group}.
   */
  group?: string;
  /**
   * Who asked: Siri, Google Assistant / Gemini, the app itself, or a person
   * picking an item from the car or watch browse tree (`'browse'`).
   */
  origin: 'siri' | 'assistant' | 'app' | 'browse';
}

/** See {@link SearchRequest.focus}. */
export type SearchFocus =
  | 'station'
  | 'song'
  | 'artist'
  | 'album'
  | 'genre'
  | 'playlist'
  | 'podcast'
  | 'any';

/** Something voice assistants (and `playFromSearch()`) can find and play. */
export interface CatalogItem {
  /**
   * Unique within the catalog. Must not start with `rnap:`, which the car and
   * watch browse tree reserves for its folders (`setCatalog` rejects it).
   */
  id: string;
  /** What people call it: a station's or a song's name. */
  title: string;
  /** Artist, or a station's network. */
  artist?: string;
  /** Album. */
  album?: string;
  /** Genre ("jazz", "news"). */
  genre?: string;
  /** Remote URL, local file URI, or `require('./cover.png')`. */
  artwork?: ArtworkInput;
  /** What to play. Its `metadata` defaults to this item's title, artist, album and artwork. */
  source: SourceInput;
  /** Other names people say for it: `["Radio One", "BBC 1"]`. */
  keywords?: string[];
  /** What it is (default `'station'`). */
  kind?: 'station' | 'song' | 'album' | 'podcast' | 'audiobook' | 'other';
  /**
   * Where the item sits in the browse tree that cars (Android Auto, Android
   * Automotive, CarPlay) and Wear OS show: `"Jazz"`, or `"Podcasts/Daily"` for
   * a folder inside a folder. `/` nests; segments are trimmed and compared
   * exactly. The top-level groups become the tabs. Items without a group are
   * listed under a "More" folder. See the Cars & watches guide.
   */
  group?: string;
}

/** Payload of the `searchPlay` event. */
export interface SearchPlayEvent {
  /** What was asked. */
  request: SearchRequest;
  /** What is playing because of it. */
  item: CatalogItem;
}

/** Options for `setCatalog()`. */
export interface CatalogOptions {
  /**
   * The id of the player voice requests use when the app has none: Siri or
   * Google Assistant may start the app with no JavaScript running. Native
   * creates it with {@link playerOptions}; the app's `new Player({ id })`
   * then attaches to it. Default `'default'`.
   */
  playerId?: string;
  /** Options for that player, when native has to create it. */
  playerOptions?: Omit<PlayerOptions, 'id'>;
  /** What the cars' browse tree adds to the catalog's groups. */
  browse?: BrowseOptions;
}

/**
 * Extras of the browse tree (Android Auto, Android Automotive, CarPlay,
 * Wear OS). The tree itself comes from {@link CatalogItem.group}.
 */
export interface BrowseOptions {
  /**
   * A "Recently played" folder with the last items played from the catalog
   * (by a search, a voice request or a pick in the car), newest first. `true`
   * keeps 10; a number keeps that many (1…50). Stored on the device. Default off.
   */
  recent?: boolean | number;
  /**
   * Ids of the items in a "Favorites" folder, in this order. Ids not in the
   * catalog are ignored; an empty list hides the folder. Call `setCatalog`
   * again to change it.
   */
  favorites?: string[];
  /** Top-level group names in the order the tabs should have; groups not named follow in catalog order. */
  rootOrder?: string[];
  /** Names of the folders RNAP adds (English by default). */
  titles?: {
    /** Default `"Recently played"`. */
    recent?: string;
    /** Default `"Favorites"`. */
    favorites?: string;
    /** Default `"More"`: ungrouped items, and groups that did not fit in the tabs. */
    more?: string;
  };
}

/**
 * Google Cast availability.
 *
 * | state | meaning |
 * | --- | --- |
 * | `unavailable` | no Cast here: built without the `cast` flag, or a browser without the Cast SDK (only Chrome has it) |
 * | `initializing` | the Cast SDK is starting (the web loads it on demand) |
 * | `noDevices` | no Cast device found on the network |
 * | `notConnected` | devices found, none in use |
 * | `connecting` | a session is starting |
 * | `connected` | casting |
 */
export type CastState =
  | 'unavailable'
  | 'initializing'
  | 'noDevices'
  | 'notConnected'
  | 'connecting'
  | 'connected';
