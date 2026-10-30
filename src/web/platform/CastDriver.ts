// The engine's driver over a Google Cast receiver: it loads the source on the
// receiver (which fetches it itself) and reports what the receiver does,
// tagged with the generation of the item that produced it. Twin of the
// native Cast drivers, over `cast.framework.RemotePlayer` and
// `RemotePlayerController`.
//
// The page is a remote control: the audio, the buffering and the network are
// the receiver's. Request headers are not sent (a receiver cannot use them).

import type { EngineDriver } from '../engine/PlaybackEngine';
import {
  engineError,
  type OpenRequest,
  type PlaybackSample,
  type SourceDescriptor,
} from '../engine/types';
import { castableUrl, type CastService, type CastSdk } from './CastService';
import {
  browser,
  type RemotePlayerControllerLike,
  type RemotePlayerLike,
} from './dom';
import type { DriverObserver, ProgressReading } from './MediaElementDriver';
import type { NowPlaying } from './WebPlayerController';

type CastObserver = Pick<
  DriverObserver,
  | 'onReady'
  | 'onPlaying'
  | 'onBuffering'
  | 'onEnded'
  | 'onFailed'
  | 'onPausedExternally'
  | 'onNote'
>;

/** The Cast media channel (`SET_PLAYBACK_RATE` goes there). */
const MEDIA_NAMESPACE = 'urn:x-cast:com.google.cast.media';
/**
 * A sender's requests carry their own ids (0 is the receiver's broadcasts).
 * These start far from the SDK's own, so a reply never settles one of its.
 */
let rateRequests = 0x40000000;

const CONTENT_TYPES: Array<[RegExp, string]> = [
  [/\.m3u8$/, 'application/x-mpegURL'],
  [/\.mpd$/, 'application/dash+xml'],
  [/\.(aac|adts)$/, 'audio/aac'],
  [/\.(m4a|mp4)$/, 'audio/mp4'],
  [/\.(ogg|oga|opus)$/, 'audio/ogg'],
  [/\.flac$/, 'audio/flac'],
  [/\.wav$/, 'audio/wav'],
];

/** A video player's files: the same manifests, and video containers. */
const VIDEO_CONTENT_TYPES: Array<[RegExp, string]> = [
  [/\.m3u8$/, 'application/x-mpegURL'],
  [/\.mpd$/, 'application/dash+xml'],
  [/\.webm$/, 'video/webm'],
  [/\.(ts|m2ts)$/, 'video/mp2t'],
  [/\.mkv$/, 'video/x-matroska'],
  [/\.mov$/, 'video/quicktime'],
  [/\.(m4a|aac)$/, 'audio/mp4'],
];

export function contentTypeOf(uri: string, video = false): string {
  const path = uri.split(/[?#]/)[0]!.toLowerCase();
  const [table, fallback] = video
    ? [VIDEO_CONTENT_TYPES, 'video/mp4']
    : [CONTENT_TYPES, 'audio/mpeg'];
  return table.find(([pattern]) => pattern.test(path))?.[1] ?? fallback;
}

/** What a video player hands the receiver besides the source. */
export interface CastMedia {
  video: boolean;
  /** The app's subtitle files, as WebVTT (already shifted by the subtitle delay). */
  subtitles: Array<{
    id: string;
    kind: 'subtitles' | 'captions';
    language: string | null;
    label: string | null;
    vtt: string;
  }>;
  /** The text track shown (`status.video.textTrack`). */
  textTrack: string | null;
}

const NO_MEDIA: CastMedia = { video: false, subtitles: [], textTrack: null };

/** A WebVTT file a receiver fetches without a server: a `data:` URL. */
export const vttDataUrl = (vtt: string) =>
  `data:text/vtt;charset=utf-8,${encodeURIComponent(vtt)}`;

const finite = (value: number): number | null =>
  Number.isFinite(value) && value >= 0 ? value : null;

export class CastDriver implements EngineDriver {
  private generation = 0;
  private source: SourceDescriptor | null = null;
  private player: RemotePlayerLike | null = null;
  private controller: RemotePlayerControllerLike | null = null;
  private changeType: string | null = null;
  private readonly changed = () => this.receiverChanged();
  /** An item is open on the receiver (between `open` and `unload`/`releaseConnection`). */
  private active = false;
  /** The receiver accepted the load: its state is now the item's. */
  private loaded = false;
  private flowed = false;
  private wantPlay = false;
  private expectingPause = false;
  private lastState: string | null = null;
  private startPosition = 0;
  private pendingSeek: number | null = null;
  private volume: number | null = null;
  /** The rate asked for, and whether the receiver was asked to play at it. */
  private rate = 1;
  private rateApplied = false;
  /** A non-1x rate was sent for this media: going back to 1x is sent too. */
  private rateSent = false;
  private live = false;
  /** The receiver's text track ids of the app's files (`sub:<n>` → 1, 2…). */
  private castTracks = new Map<string, number>();

  constructor(
    private readonly observer: CastObserver,
    private readonly nowPlaying: () => NowPlaying,
    private readonly cast: CastService,
    private readonly media: () => CastMedia = () => NO_MEDIA
  ) {}

  // ── EngineDriver ──

  open(request: OpenRequest): void {
    this.deactivate();
    this.generation = request.generation;
    this.source = request.source;
    this.active = true;
    this.wantPlay = request.playWhenReady;
    this.startPosition = request.startPosition ?? 0;
    const generation = request.generation;
    const sdk = this.cast.sdk();
    const session = this.cast.session();
    const url = castableUrl(request.source.uri);
    if (!sdk || !session || !url) {
      this.failLater(generation, 'There is no Cast session to play on.');
      return;
    }
    this.listen(sdk);
    this.live = request.source.liveHint === true;
    session.loadMedia(this.loadRequest(sdk, request, url)).then(
      (code) => this.loadSettled(generation, code ?? null),
      (error: unknown) => this.loadSettled(generation, String(error))
    );
  }

  play(): void {
    this.wantPlay = true;
    this.reconcile();
  }

  pause(): void {
    this.wantPlay = false;
    this.reconcile();
  }

  seek(seconds: number): void {
    if (!this.loaded) {
      this.pendingSeek = seconds;
      return;
    }
    this.player!.currentTime = seconds;
    this.controller!.seek();
  }

  releaseConnection(): void {
    this.stopReceiver();
    this.deactivate();
  }

  unload(): void {
    this.releaseConnection();
    this.source = null;
  }

  /**
   * The receiver's *media* volume (what this player's volume and mute map to),
   * where the receiver supports it. The device volume — the TV's — stays the
   * user's, on the TV remote; it is never changed from here.
   */
  setVolume(effective: number): void {
    this.volume = Math.min(1, Math.max(0, effective));
    this.applyVolume();
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.applyRate();
  }

  /**
   * The web sender has no rate call: the media channel's `SET_PLAYBACK_RATE`
   * is what the iOS and Android senders send. Receivers play 0.5x–2x, and a
   * live stream at 1x: anything else is said, and reported as 1x.
   */
  private applyRate(): void {
    this.rateApplied = false;
    const session = this.cast.session();
    const media = this.loaded ? session?.getMediaSession() : null;
    if (!media || (this.rate === 1 && !this.rateSent)) return;
    const supported = !this.live && this.rate >= 0.5 && this.rate <= 2;
    if (!supported)
      this.observer.onNote(this.generation, 'cast rate ignored', {
        rate: `${this.rate}`,
      });
    // Unsupported after a rate was sent: the receiver goes back to 1x.
    const target = supported ? this.rate : 1;
    if (!supported && !this.rateSent) return;
    if (media.mediaSessionId == null || !session?.sendMessage) {
      if (supported)
        this.observer.onNote(this.generation, 'cast rate ignored', {
          rate: `${this.rate}`,
        });
      return;
    }
    this.rateSent = target !== 1;
    this.rateApplied = supported;
    rateRequests += 1;
    const request = rateRequests;
    session
      .sendMessage(MEDIA_NAMESPACE, {
        type: 'SET_PLAYBACK_RATE',
        requestId: request,
        mediaSessionId: media.mediaSessionId,
        playbackRate: target,
      })
      // A message that could not be sent (a receiver that answers with an
      // error shows it in its status instead). A newer request replaced it?
      // Then its outcome is the one that counts.
      .catch((error: unknown) => {
        if (request === rateRequests) this.rateApplied = false;
        this.observer.onNote(this.generation, 'cast rate refused', {
          error: String(error),
        });
      });
  }

  switchOutput(): void {
    // The routing driver chooses the output; this one is the Cast output.
  }

  /** The text track to show: one of the app's files the receiver was given, or none. */
  selectTracks(_audio: string | null, text: string | null): void {
    if (!this.loaded) return;
    const sdk = this.cast.sdk();
    const media = this.cast.session()?.getMediaSession();
    const Request = sdk?.chrome.media.EditTracksInfoRequest;
    if (!media?.editTracksInfo || !Request) return;
    const id = text != null ? this.castTracks.get(text) : undefined;
    media.editTracksInfo(
      new Request(id != null ? [id] : []),
      () => undefined,
      (error) =>
        this.observer.onNote(this.generation, 'cast text track refused', {
          error: String(error),
        })
    );
  }

  sample(): PlaybackSample {
    const position = this.position();
    return { position, bufferedPosition: position };
  }

  // ── Readings ──

  progress(): ProgressReading {
    const position = this.position();
    return {
      position,
      duration: this.live ? null : this.duration(),
      buffered: position,
      liveOffset: null,
      isPlaying: this.loaded && this.player?.playerState === 'PLAYING',
      rate: this.effectiveRate(),
    };
  }

  /** What the receiver plays at: its own report, else what it was asked. */
  private effectiveRate(): number {
    const reported = this.loaded
      ? this.cast.session()?.getMediaSession()?.playbackRate
      : undefined;
    if (reported != null && reported > 0) return reported;
    return this.rateApplied ? this.rate : 1;
  }

  // ── Receiver ──

  private loadRequest(sdk: CastSdk, request: OpenRequest, url: string) {
    const { media } = sdk.chrome;
    const extra = this.media();
    const info = new media.MediaInfo(
      url,
      contentTypeOf(request.source.uri, extra.video)
    );
    info.streamType = this.live
      ? media.StreamType.LIVE
      : media.StreamType.BUFFERED;
    info.metadata = this.metadata(sdk, extra.video);
    const tracks = this.textTracks(sdk, extra);
    if (tracks.length > 0) info.tracks = tracks;
    const load = new media.LoadRequest(info);
    load.autoplay = request.playWhenReady;
    if (request.startPosition != null && request.startPosition > 0)
      load.currentTime = request.startPosition;
    const active =
      extra.textTrack != null ? this.castTracks.get(extra.textTrack) : null;
    if (tracks.length > 0) load.activeTrackIds = active != null ? [active] : [];
    return load;
  }

  /** What the receiver shows: a movie's title line for a video, else the song. */
  private metadata(sdk: CastSdk, video: boolean): unknown {
    const { media, Image } = sdk.chrome;
    const shown = this.nowPlaying();
    const artwork = shown.artwork ? castableUrl(shown.artwork) : null;
    const images = artwork ? [new Image(artwork)] : undefined;
    if (video && media.MovieMetadata) {
      const metadata = new media.MovieMetadata();
      metadata.title = shown.title ?? undefined;
      metadata.subtitle = shown.artist ?? shown.album ?? undefined;
      metadata.images = images;
      return metadata;
    }
    const metadata = new media.MusicTrackMediaMetadata();
    metadata.title = shown.title ?? undefined;
    metadata.artist = shown.artist ?? undefined;
    metadata.albumName = shown.album ?? undefined;
    metadata.images = images;
    return metadata;
  }

  /** The app's subtitle files as the receiver's WebVTT text tracks. */
  private textTracks(sdk: CastSdk, extra: CastMedia): unknown[] {
    const { Track, TrackType, TextTrackType } = sdk.chrome.media;
    this.castTracks = new Map();
    if (!Track || !TrackType || !TextTrackType) return [];
    return extra.subtitles.map((file, i) => {
      const id = i + 1;
      this.castTracks.set(file.id, id);
      const track = new Track(id, TrackType.TEXT);
      track.trackContentId = vttDataUrl(file.vtt);
      track.trackContentType = 'text/vtt';
      track.subtype =
        file.kind === 'captions'
          ? TextTrackType.CAPTIONS
          : TextTrackType.SUBTITLES;
      track.name = file.label ?? file.language;
      track.language = file.language;
      return track;
    });
  }

  /** The player and its controller are created once and outlive the sessions. */
  private listen(sdk: CastSdk): void {
    if (this.controller) return;
    const { framework } = sdk;
    this.player = new framework.RemotePlayer();
    this.controller = new framework.RemotePlayerController(this.player);
    this.changeType = framework.RemotePlayerEventType.ANY_CHANGE;
    this.controller.addEventListener(this.changeType, this.changed);
  }

  /** The player was released: stop observing the receiver (the SDK outlives players). */
  dispose(): void {
    if (this.controller && this.changeType)
      this.controller.removeEventListener(this.changeType, this.changed);
    this.controller = null;
    this.player = null;
    this.changeType = null;
  }

  private loadSettled(generation: number, code: string | null): void {
    if (!this.active || generation !== this.generation) return;
    if (code) {
      this.observer.onFailed(generation, this.failure(`load failed (${code})`));
      return;
    }
    this.loaded = true;
    const player = this.player!;
    const duration = this.duration();
    this.live =
      this.live || (this.source?.liveHint == null && duration == null);
    this.observer.onReady(
      generation,
      this.live
        ? { duration: null, isLive: true, seekable: false }
        : { duration, isLive: false, seekable: player.canSeek }
    );
    this.applyVolume();
    this.rateSent = false;
    this.applyRate();
    if (this.pendingSeek != null) {
      const seconds = this.pendingSeek;
      this.pendingSeek = null;
      this.seek(seconds);
    }
    this.reconcile();
    this.lastState = null;
    this.receiverChanged();
  }

  /** Maps the receiver's player state to the engine's observations. */
  private receiverChanged(): void {
    const player = this.player;
    // A session that is going away reports "idle": WebOutputs hands back.
    if (!this.active || !this.loaded || !player?.isConnected) return;
    const state = player.playerState;
    if (state === this.lastState) return;
    this.lastState = state;
    const generation = this.generation;
    switch (state) {
      case 'PLAYING':
        this.flowed = true;
        this.observer.onPlaying(generation);
        break;
      case 'BUFFERING':
        this.observer.onBuffering(generation);
        break;
      case 'PAUSED':
        this.paused(generation);
        break;
      case 'IDLE':
        this.idle(generation);
        break;
      default:
        break;
    }
  }

  private paused(generation: number): void {
    if (this.expectingPause) {
      this.expectingPause = false;
      return;
    }
    // Paused on the TV remote, or by another sender.
    if (this.wantPlay && this.flowed) {
      this.wantPlay = false;
      this.observer.onPausedExternally(generation, 'system');
    }
  }

  private idle(generation: number): void {
    const reason = this.cast.session()?.getMediaSession()?.idleReason;
    if (reason === 'FINISHED') {
      this.observer.onEnded(generation);
    } else if (reason === 'ERROR') {
      this.observer.onFailed(generation, this.failure('the receiver failed'));
    } else if (this.flowed) {
      // Cancelled or interrupted: another sender took the receiver over.
      this.wantPlay = false;
      this.observer.onPausedExternally(generation, 'system');
    } else {
      // Not started yet: nothing to report.
    }
  }

  /** Makes the receiver's play/pause match the intent (`play()` is latched until loaded). */
  private reconcile(): void {
    const player = this.player;
    if (!this.loaded || !player?.isConnected) return;
    const state = player.playerState;
    if (this.wantPlay && state === 'PAUSED') {
      this.expectingPause = false;
      this.controller!.playOrPause();
    } else if (
      !this.wantPlay &&
      (state === 'PLAYING' || state === 'BUFFERING')
    ) {
      this.expectingPause = true;
      this.controller!.playOrPause();
    } else {
      // Already as wanted, or nothing playing to pause.
    }
  }

  private applyVolume(): void {
    const sdk = this.cast.sdk();
    const media = this.loaded ? this.cast.session()?.getMediaSession() : null;
    if (this.volume == null || !sdk || !media) return;
    const { chrome } = sdk;
    if (!media.supportsCommand(chrome.media.MediaCommand.STREAM_VOLUME)) {
      this.observer.onNote(this.generation, 'cast volume ignored', {
        reason: 'receiver has no stream volume',
      });
      return;
    }
    const request = new chrome.media.VolumeRequest(
      new chrome.Volume(this.volume)
    );
    media.setVolume(
      request,
      () => undefined,
      () => undefined
    );
  }

  private stopReceiver(): void {
    const player = this.player;
    if (this.loaded && player?.isConnected && player.isMediaLoaded)
      this.controller!.stop();
  }

  private deactivate(): void {
    this.active = false;
    this.loaded = false;
    this.flowed = false;
    this.wantPlay = false;
    this.expectingPause = false;
    this.lastState = null;
    this.pendingSeek = null;
  }

  private failLater(generation: number, cause: string): void {
    browser().queueMicrotask(() => {
      if (this.active && generation === this.generation)
        this.observer.onFailed(generation, this.failure(cause));
    });
  }

  private failure(cause: string) {
    return engineError(
      'NETWORK_ERROR',
      'The Cast receiver could not play the stream.',
      true,
      { platformDomain: 'cast', cause }
    );
  }

  private position(): number {
    if (!this.loaded) return this.startPosition;
    return finite(this.player!.currentTime) ?? this.startPosition;
  }

  private duration(): number | null {
    const duration = this.player ? finite(this.player.duration) : null;
    return duration != null && duration > 0 ? duration : null;
  }
}
