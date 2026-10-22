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
import type { CastService, CastSdk } from './CastService';
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

const CONTENT_TYPES: Array<[RegExp, string]> = [
  [/\.m3u8$/, 'application/x-mpegURL'],
  [/\.(aac|adts)$/, 'audio/aac'],
  [/\.(m4a|mp4)$/, 'audio/mp4'],
  [/\.(ogg|oga|opus)$/, 'audio/ogg'],
  [/\.flac$/, 'audio/flac'],
  [/\.wav$/, 'audio/wav'],
];

/**
 * The absolute http(s) URL a receiver can fetch for `uri`, or `null` when it
 * cannot (`blob:`, `file:`, `data:`, anything else). A relative URL resolves
 * against the page.
 */
export function castableUrl(uri: string): string | null {
  const g = browser();
  try {
    const url = new g.URL(uri, g.location?.href);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function contentTypeOf(uri: string): string {
  const path = uri.split(/[?#]/)[0]!.toLowerCase();
  return (
    CONTENT_TYPES.find(([pattern]) => pattern.test(path))?.[1] ?? 'audio/mpeg'
  );
}

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
  private live = false;

  constructor(
    private readonly observer: CastObserver,
    private readonly nowPlaying: () => NowPlaying,
    private readonly cast: CastService
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
    // The Cast sender has no playback-rate request: say so, do not pretend.
    if (rate !== 1)
      this.observer.onNote(this.generation, 'cast rate ignored', {
        rate: `${rate}`,
      });
  }

  switchOutput(): void {
    // The routing driver chooses the output; this one is the Cast output.
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
      rate: 1,
    };
  }

  // ── Receiver ──

  private loadRequest(sdk: CastSdk, request: OpenRequest, url: string) {
    const { media, Image } = sdk.chrome;
    const info = new media.MediaInfo(url, contentTypeOf(request.source.uri));
    info.streamType = this.live
      ? media.StreamType.LIVE
      : media.StreamType.BUFFERED;
    const shown = this.nowPlaying();
    const metadata = new media.MusicTrackMediaMetadata();
    if (shown.title) metadata.title = shown.title;
    if (shown.artist) metadata.artist = shown.artist;
    if (shown.album) metadata.albumName = shown.album;
    const artwork = shown.artwork ? castableUrl(shown.artwork) : null;
    if (artwork) metadata.images = [new Image(artwork)];
    info.metadata = metadata;
    const load = new media.LoadRequest(info);
    load.autoplay = request.playWhenReady;
    if (request.startPosition != null && request.startPosition > 0)
      load.currentTime = request.startPosition;
    return load;
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
