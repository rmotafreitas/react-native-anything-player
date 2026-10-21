import type { PlayerError } from './errors';

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
  | 'system';

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
  platform?: 'ios' | 'android';
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
  | 'INTERNAL_ERROR';

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

/** What the lock screen / notification shows for a source (app-provided). */
export interface NowPlayingMetadata {
  /** Title (e.g. a song, or a station name). */
  title?: string;
  /** Artist. */
  artist?: string;
  /** Album. */
  album?: string;
  /** Remote URL, local file URI, or `require('./cover.png')`. */
  artwork?: string | Artwork | AssetModule;
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

/** What to play, with per-source options. */
export interface Source {
  /** `https://…`, `http://…`, `file://…`, `content://…` (Android) or an absolute path. */
  uri: string;
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
}

/** What `load()` accepts: a {@link Source}, a URI, or `require('./file.mp3')`. */
export type SourceInput = Source | string | AssetModule;

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
  /** Automatic recovery (see the Recovery policy guide). */
  recovery?: {
    /** Reconnect after recoverable failures while playback is wanted. Default `true`. */
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
  /** Start with diagnostics enabled (see `setDiagnosticsEnabled`). */
  diagnostics?: boolean;
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
