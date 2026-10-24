// One player: the engine, its <audio> driver and everything that crosses to
// `Player`. Twin of `PlayerController.kt` / `PlayerController.swift`, on the
// browser's single thread.

import type { LicenseRequestEvent } from '../../core/drm';
import { answerLicense } from './licenseRequests';
import type { PlayerError } from '../../errors';
import {
  PlaybackEngine,
  type EngineClock,
  type EngineDelegate,
  type LoadOutcome,
} from '../engine/PlaybackEngine';
import type { StreamMetadata } from '../engine/StreamMetadata';
import { TrackClock } from '../engine/TrackClock';
import {
  engineError,
  UNKNOWN_ROUTE,
  type AudioRoute,
  type EngineDiagnostic,
  type EngineStatus,
  type FocusResult,
  type InterruptionReason,
  type ReadyInfo,
  type SourceDescriptor,
  type VideoInfo,
  type VideoVariant,
} from '../engine/types';
import type { MediaTrack } from '../../core/subtitles/tracks';
import { cuesToVtt } from '../../core/subtitles/vtt';
import type { CastMedia } from './CastDriver';
import type { SubtitleCue } from '../../core/subtitles/types';
import { AudioSampler } from './AudioSampler';
import type { CastService } from './CastService';
import { browser, monotonicNow, type AudioElementLike } from './dom';
import { ElementRoute } from './ElementRoute';
import {
  MediaElementDriver,
  type DriverObserver,
  type PlayAttempt,
  type ProgressReading,
} from './MediaElementDriver';
import { RoutingDriver } from './RoutingDriver';
import {
  NO_FIELDS,
  diagnosticToMap,
  errorToMap,
  metadataToMap,
  parseSource,
  parseSubtitleTracks,
  progressToMap,
  statusToMap,
  type NowPlayingFields,
  type VideoLoadParts,
  type WebPlayerOptions,
} from './serialization';
import { SwapDriver, type LocalDriver } from './SwapDriver';
import { WebVideo, type ContentFit, type VideoHost } from './WebVideo';

export type EventSink = (event: Record<string, unknown>) => void;

/** What the page-wide runtime does for a player (media session, network). */
export interface PlayerRuntime {
  onStatusChanged(controller: WebPlayerController): void;
  onNowPlayingChanged(controller: WebPlayerController): void;
  /** The Cast SDK, shared by every player. */
  readonly cast: CastService;
  /** A player is about to load `source` (its output may need to move first). */
  beforeLoad(
    controller: WebPlayerController,
    source: SourceDescriptor,
    autoplay: boolean | null
  ): void;
  /** What the browser says about a player's route or output picker changed. */
  onOutputsChanged(controller: WebPlayerController): void;
}

/** What the media session shows (merged). */
export interface NowPlaying {
  title: string | null;
  artist: string | null;
  album: string | null;
  artwork: string | null;
  /** The app gave a song duration: its progress replaces the stream's timeline. */
  track: { duration: number; elapsed: number } | null;
  live: boolean | null;
}

export const webClock: EngineClock = {
  get monotonicMs() {
    return monotonicNow();
  },
  get wallMs() {
    return Date.now();
  },
};

const DIAGNOSTICS_CAPACITY = 300;

interface PendingLoad {
  resolve: (status: object) => void;
  reject: (error: PlayerError) => void;
}

export class WebPlayerController
  implements EngineDelegate, DriverObserver, VideoHost
{
  /** The local output: the <audio> element, or a video player's <video>s. */
  readonly driver: LocalDriver;
  /** A video player's stage, subtitles and system UI (`null` for audio). */
  readonly video: WebVideo | null;
  /** What the engine commands: the local output or the Cast receiver. */
  readonly routing: RoutingDriver;
  readonly engine: PlaybackEngine;
  /** What the browser knows about where the element plays (AirPlay, Remote Playback). */
  readonly elementRoute: ElementRoute;
  readonly sampler = new AudioSampler();
  private seq = 0;
  private statusSnapshot: { status: EngineStatus; seq: number };
  private _streamMetadata: StreamMetadata | null = null;
  private station: { name: string | null; genre: string | null } = {
    name: null,
    genre: null,
  };
  private streamMetadataAt = 0;
  diagnosticsEnabled = false;
  private readonly diagnostics: EngineDiagnostic[] = [];
  private sourceFields: NowPlayingFields = NO_FIELDS;
  private overrides: NowPlayingFields = NO_FIELDS;
  private trackClock: TrackClock | null = null;
  private readonly pendingLoads = new Map<number, PendingLoad>();
  private released = false;
  private wakeupTimer: number | null = null;
  private progressTimer: number | null = null;
  private localRoute: AudioRoute = UNKNOWN_ROUTE;
  /** The object URL of the loaded `Blob`/`File`, revoked when the item goes. */
  private objectUrl: string | null = null;

  constructor(
    readonly id: string,
    readonly options: WebPlayerOptions,
    private readonly runtime: PlayerRuntime,
    private readonly sink: EventSink
  ) {
    const video = options.engine.video != null ? new WebVideo(this) : null;
    this.video = video;
    this.driver = video
      ? new SwapDriver(
          this,
          (observer) =>
            new MediaElementDriver(observer, options.titleFormat, 'video'),
          video
        )
      : new MediaElementDriver(this, options.titleFormat);
    video?.show(this.driver.element, null);
    this.routing = new RoutingDriver(this.driver, () => {
      const parts = runtime.cast.parts;
      return parts
        ? new parts.CastDriver(
            this,
            () => this.nowPlaying(),
            runtime.cast,
            () => this.castMedia()
          )
        : null;
    });
    this.engine = new PlaybackEngine(this.routing, webClock, options.engine);
    this.statusSnapshot = { status: this.engine.status, seq: 0 };
    this.engine.delegate = this;
    this.elementRoute = new ElementRoute(() => this.elementRouteChanged());
    this.elementRoute.attach(this.driver.element);
  }

  get status(): EngineStatus {
    return this.statusSnapshot.status;
  }

  get streamMetadata(): StreamMetadata | null {
    return this._streamMetadata;
  }

  // ── Commands ──

  /**
   * Opens `source`. `objectUrl`: the object URL of a `Blob`/`File` it plays
   * from; this player owns it from here and revokes it with the item.
   */
  load(
    source: SourceDescriptor,
    fields: NowPlayingFields,
    autoplay: boolean | null,
    start: number | null,
    objectUrl: string | null = null,
    parts: VideoLoadParts | null = null
  ): Promise<object> {
    this.sourceFields = fields;
    this.overrides = NO_FIELDS;
    this.trackClock = null;
    this._streamMetadata = null;
    this.station = { name: null, genre: null };
    this.driver.lastPlayAttempt = null;
    this.runtime.beforeLoad(this, source, autoplay);
    this.video?.beginSession(parts?.session ?? null);
    this.video?.setPoster(parts?.poster ?? null);
    this.engine.load(source, autoplay, start);
    if (this.video && parts && parts.subtitles.length > 0)
      this.engine.setAppTracks(parts.subtitles);
    // The replaced item is gone from the element: nothing can ask for it again.
    this.revoke(this.objectUrl);
    this.objectUrl = objectUrl;
    const promise = new Promise<object>((resolve, reject) => {
      this.pendingLoads.set(this.engine.loadId, { resolve, reject });
    });
    this.runtime.onNowPlayingChanged(this);
    return promise;
  }

  /** The play() attempt the last command made, if any (to report an autoplay refusal). */
  takePlayAttempt(): Promise<PlayAttempt> | null {
    const attempt = this.driver.lastPlayAttempt;
    this.driver.lastPlayAttempt = null;
    return attempt;
  }

  /** A command arrived from a user gesture: the sampler may start its audio context now. */
  userGesture(): void {
    this.updateSampler();
  }

  updateNowPlaying(fields: NowPlayingFields): void {
    this.overrides = fields;
    this.trackClock =
      fields.duration != null
        ? new TrackClock(
            fields.elapsed ?? 0,
            fields.duration,
            webClock.monotonicMs,
            this.status.state === 'playing'
          )
        : null;
    this.runtime.onNowPlayingChanged(this);
  }

  setAudioSampling(enabled: boolean, points: number): boolean {
    this.sampler.points = Math.max(16, Math.min(4096, Math.round(points)));
    this.sampler.enabled = enabled;
    this.sampler.onWindow = enabled
      ? (window) => {
          if (this.released) return;
          // A stream, never a state to order: outside the event sequence.
          this.sink({
            playerId: this.id,
            type: 'audioSample',
            waveform: window.waveform,
            level: window.level,
            duration: window.durationSeconds,
            outputLatency: window.outputLatencySeconds,
            timestamp: window.timestampMs,
          });
        }
      : null;
    if (!enabled) this.sampler.stop();
    this.updateSampler();
    return AudioSampler.supported;
  }

  // ── Video ──

  /** `VideoHost`: the `<video>` on screen now. */
  element(): AudioElementLike {
    return this.driver.element;
  }

  /** `videoCommand` from `Player` (`{ op, … }`). */
  videoCommand(command: Record<string, unknown>): Promise<void> | void {
    const op = command.op;
    if (op === 'loop') return this.engine.setLoop(command.value === true);
    if (op === 'seek')
      return this.engine.seek(
        command.position as number,
        command.exact === true
      );
    if (op === 'refreshed') {
      const [source] = parseSource(command.source);
      return this.engine.sourceRefreshed(command.loadId as number, source);
    }
    if (op === 'refreshFailed')
      return this.engine.sourceRefreshFailed(command.loadId as number);
    if (op === 'license') return answerLicense(command);
    return this.videoOnly(op, command);
  }

  /** The commands only a video player has. */
  private videoOnly(
    op: unknown,
    c: Record<string, unknown>
  ): Promise<void> | void {
    const video = this.video;
    if (video == null) {
      throw engineError(
        'INVALID_ARGUMENT',
        'This is not a video player (create it with `video`).',
        false
      );
    }
    const id = (c.id as string | null | undefined) ?? null;
    switch (op) {
      case 'selectQuality':
        return this.engine.selectQuality(id);
      case 'selectAudioTrack':
        return this.engine.selectAudioTrack(id);
      case 'selectTextTrack':
        return this.engine.selectTextTrack(id);
      case 'subtitleDelay':
        return this.engine.setSubtitleDelay(c.seconds as number);
      case 'listenOnly':
        return this.engine.setListenOnly(c.value === true);
      case 'addSubtitles': {
        const added = parseSubtitleTracks(c.tracks);
        const known =
          this.status.video?.tracks.filter((t) => t.kind !== 'audio') ?? [];
        const app = known.filter((t) => !t.id.startsWith('track:'));
        return this.engine.setAppTracks([...app, ...added]);
      }
      case 'cues':
        return video.setCues(
          c.session as string,
          c.trackId as string,
          c.cues as SubtitleCue[]
        );
      case 'fullscreen':
        return video.setFullscreen(
          c.active === true,
          (c.lockOrientation as string | false) ?? false
        );
      case 'pictureInPicture':
        return video.setPictureInPicture(c.active === true);
      default:
        throw engineError(
          'INVALID_ARGUMENT',
          `Unknown video command "${String(op)}".`,
          false
        );
    }
  }

  /** `attachTo` / `<VideoView>`: the page element the picture goes in. */
  attachVideo(
    element: unknown,
    fit: ContentFit = 'contain',
    controls = false
  ): void {
    if (this.video == null) {
      throw engineError(
        'INVALID_ARGUMENT',
        'This is not a video player (create it with `video`).',
        false
      );
    }
    this.video.attach(element as never, fit, controls);
  }

  /** `getStats()`: the engine's counters, the dropped frames and the bandwidth. */
  statsMap(): Record<string, unknown> {
    const quality = (
      this.driver.element as {
        getVideoPlaybackQuality?: () => { droppedVideoFrames: number };
      }
    ).getVideoPlaybackQuality?.();
    return {
      ...this.engine.stats,
      droppedFrames: quality?.droppedVideoFrames ?? null,
      bandwidth: this.engine.bandwidthEstimate,
    };
  }

  /** Unloads the source (back to `idle`) and frees a picked file's object URL. */
  reset(): void {
    this.engine.reset();
    this.revoke(this.objectUrl);
    this.objectUrl = null;
  }

  private revoke(url: string | null): void {
    if (url != null) browser().URL.revokeObjectURL(url);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.sampler.destroy();
    this.clearTimers();
    this.engine.release();
    this.elementRoute.detach();
    this.video?.release();
    this.routing.destroy();
    this.revoke(this.objectUrl);
    this.objectUrl = null;
    this.pendingLoads.clear();
  }

  // ── Readings ──

  statusMap(): Record<string, unknown> {
    return statusToMap(this.statusSnapshot.status, this.statusSnapshot.seq);
  }

  /** Where the item is, on the current output. */
  progress(): ProgressReading {
    return this.routing.progress();
  }

  progressMap(): Record<string, unknown> {
    return progressToMap(this.progress(), webClock.wallMs);
  }

  // ── Outputs ──

  /** The route of the local output, as the browser reports it. */
  get currentLocalRoute(): AudioRoute {
    return this.localRoute;
  }

  /** Whether the browser offers an output picker (AirPlay, Remote Playback) for this item. */
  pickerAvailable(): boolean {
    return this.elementRoute.available(this.driver.isStreamed);
  }

  /** Opens the browser's output picker; call it synchronously inside a gesture. */
  showPicker(): Promise<void> {
    return this.elementRoute.showPicker(this.driver.isStreamed);
  }

  private elementRouteChanged(): void {
    const route = this.elementRoute.route;
    if (route.kind !== this.localRoute.kind) {
      this.localRoute = route;
      this.engine.routeChanged(route);
    }
    this.runtime.onOutputsChanged(this);
  }

  metadataMap(): Record<string, unknown> {
    const meta = this._streamMetadata;
    return {
      metadata: meta ? metadataToMap(meta, this.streamMetadataAt) : null,
    };
  }

  diagnosticsArray(): object[] {
    return this.diagnostics.map(diagnosticToMap);
  }

  /** Media session fields: app overrides > stream metadata > source metadata. */
  nowPlaying(): NowPlaying {
    const stream = this.options.useStreamMetadata ? this._streamMetadata : null;
    const o = this.overrides;
    const s = this.sourceFields;
    const clock = this.trackClock;
    // A station name stands in for the album, as on the native lock screens.
    const station = stream?.station ?? null;
    return {
      title: o.title ?? stream?.title ?? s.title,
      artist: o.artist ?? stream?.artist ?? s.artist,
      album: o.album ?? stream?.album ?? s.album ?? station,
      artwork: o.artwork ?? stream?.artworkUri ?? s.artwork,
      track: clock
        ? {
            duration: clock.duration,
            elapsed: clock.elapsed(webClock.monotonicMs),
          }
        : null,
      live: o.live ?? s.live,
    };
  }

  /** Forwards a remote command (media keys, lock screen) the app opted into. */
  emitRemoteCommand(command: string, position?: number): void {
    this.emit(
      'remoteCommand',
      position != null ? { command, position } : { command }
    );
  }

  emit(type: string, payload: Record<string, unknown>): void {
    if (this.released && type !== 'status') return;
    this.seq += 1;
    this.sink({ ...payload, playerId: this.id, type, seq: this.seq });
  }

  private updateSampler(): void {
    // The visualizer is audio's: a <video> is never routed through Web Audio.
    if (this.video) return;
    const element = this.driver.element;
    this.sampler.update(element, this.driver.isStreamed);
    this.driver.tapped = this.sampler.isAttached(element);
  }

  private clearTimers(): void {
    const g = browser();
    g.clearTimeout(this.wakeupTimer);
    g.clearInterval(this.progressTimer);
    this.wakeupTimer = null;
    this.progressTimer = null;
  }

  /** `progress` events while playing (`progressInterval`). */
  private updateProgressTicks(state: EngineStatus['state']): void {
    const wanted =
      this.options.progressIntervalMs > 0 &&
      state === 'playing' &&
      !this.released;
    if (wanted === (this.progressTimer !== null)) return;
    const g = browser();
    if (wanted) {
      this.progressTimer = g.setInterval(
        () => this.emit('progress', this.progressMap()),
        this.options.progressIntervalMs
      );
    } else {
      g.clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  // ── EngineDelegate ──

  engineRequestsAudioFocus(): FocusResult {
    // Browsers have no audio focus; the autoplay policy is reported by play().
    return 'granted';
  }

  engineStatusChanged(status: EngineStatus): void {
    this.seq += 1;
    this.statusSnapshot = { status, seq: this.seq };
    this.sink({
      ...statusToMap(status, this.seq),
      playerId: this.id,
      type: 'status',
    });
    // The song advances with the audio, not the wall clock.
    this.trackClock?.setRunning(
      status.state === 'playing',
      webClock.monotonicMs
    );
    this.updateProgressTicks(status.state);
    if (status.state === 'playing') this.updateSampler();
    this.video?.statusChanged(status);
    this.runtime.onStatusChanged(this);
  }

  engineRequestsSourceRefresh(
    loadId: number,
    reason: 'unauthorized' | 'expiring'
  ): void {
    this.emit('refreshRequest', { loadId, reason });
  }

  engineLoadSettled(loadId: number, outcome: LoadOutcome): void {
    const pending = this.pendingLoads.get(loadId);
    if (!pending) return;
    this.pendingLoads.delete(loadId);
    // Settle after the status this outcome implies was delivered.
    browser().setTimeout(() => {
      if (outcome.kind === 'failed') pending.reject(outcome.error);
      else pending.resolve(this.statusMap());
    }, 0);
  }

  engineError(error: PlayerError, fatal: boolean): void {
    this.emit('error', { error: errorToMap(error), fatal });
  }

  engineDidEnd(): void {
    this.emit('ended', {});
  }

  engineSleepFired(): void {
    this.emit('sleep', { reason: 'fired', timestamp: webClock.wallMs });
  }

  engineDiagnostic(entry: EngineDiagnostic): void {
    this.diagnostics.push(entry);
    if (this.diagnostics.length > DIAGNOSTICS_CAPACITY)
      this.diagnostics.shift();
    if (this.diagnosticsEnabled) {
      console.debug(
        `[RNAP ${this.id}] ${entry.event}`,
        entry.details,
        `(gen=${entry.generation} state=${entry.state})`
      );
      this.emit('diagnostic', { entry: diagnosticToMap(entry) });
    }
  }

  engineWakeupAt(at: number | null): void {
    const g = browser();
    g.clearTimeout(this.wakeupTimer);
    this.wakeupTimer = null;
    if (!this.released && at != null) {
      this.wakeupTimer = g.setTimeout(
        () => this.engine.onWakeup(),
        Math.max(0, at - webClock.monotonicMs)
      );
    }
  }

  // ── DriverObserver ──

  onReady(generation: number, info: ReadyInfo): void {
    this.engine.onReady(generation, info);
  }

  onPlaying(generation: number): void {
    this.engine.onPlaying(generation);
  }

  onBuffering(generation: number): void {
    this.engine.onBuffering(generation);
  }

  onEnded(generation: number): void {
    this.engine.onEnded(generation);
  }

  onFailed(generation: number, error: PlayerError): void {
    this.engine.onFailed(generation, error);
  }

  onPausedExternally(generation: number, reason: InterruptionReason): void {
    this.engine.onPausedExternally(generation, reason);
  }

  onStreamMetadata(generation: number, metadata: StreamMetadata): void {
    if (!this.engine.accepts(generation)) return;
    // As on iOS: station info (response headers) lands on top of the last
    // metadata; a song (an ICY block) carries the known station along.
    let merged: StreamMetadata;
    if (Object.keys(metadata.raw).some(isSongKey)) {
      merged = {
        ...metadata,
        station: metadata.station ?? this.station.name,
        genre: metadata.genre ?? this.station.genre,
      };
    } else {
      this.station = { name: metadata.station, genre: metadata.genre };
      const previous = this._streamMetadata ?? metadata;
      merged = {
        ...previous,
        station: metadata.station,
        genre: metadata.genre,
        raw: { ...previous.raw, ...metadata.raw },
      };
    }
    this._streamMetadata = merged;
    this.streamMetadataAt = webClock.wallMs;
    this.emit('metadata', {
      metadata: metadataToMap(merged, this.streamMetadataAt),
    });
    this.runtime.onNowPlayingChanged(this);
  }

  onDiscontinuity(generation: number, position: number): void {
    if (!this.engine.accepts(generation)) return;
    this.emit('discontinuity', { position, timestamp: webClock.wallMs });
  }

  onNote(
    generation: number,
    event: string,
    details: Record<string, string>
  ): void {
    this.engineDiagnostic({
      wallTime: webClock.wallMs,
      generation,
      state: this.engine.state,
      event,
      details,
    });
  }

  onElementReplaced(element: AudioElementLike): void {
    this.driver.tapped = false;
    this.elementRoute.attach(element);
  }

  onVideoInfo(generation: number, info: VideoInfo): void {
    this.engine.onVideoInfo(generation, info);
  }

  onFirstFrame(generation: number): void {
    this.engine.onFirstFrame(generation);
  }

  onVariants(generation: number, variants: VideoVariant[]): void {
    this.engine.onVariants(generation, variants);
  }

  onBandwidth(generation: number, bitsPerSecond: number): void {
    this.engine.onBandwidth(generation, bitsPerSecond);
  }

  /** What a Cast receiver gets besides the source: the app's subtitle files as WebVTT. */
  private castMedia(): CastMedia {
    const video = this.video;
    const status = this.engine.status.video;
    if (video == null || status == null)
      return { video: false, subtitles: [], textTrack: null };
    // The app's files whose cues have loaded (the source's own reach the receiver with it).
    const subtitles = status.tracks.flatMap((track) => {
      const cues =
        track.kind === 'audio' || track.id.startsWith('track:')
          ? null
          : video.cuesFor(track.id);
      if (cues == null) return [];
      return [
        {
          id: track.id,
          kind: track.kind === 'captions' ? 'captions' : 'subtitles',
          language: track.language,
          label: track.label,
          vtt: cuesToVtt(cues, status.subtitleDelay),
        } as const,
      ];
    });
    return { video: true, subtitles, textTrack: status.textTrack };
  }

  onTracks(generation: number, tracks: MediaTrack[]): void {
    this.engine.onTracks(generation, tracks);
  }

  /** The browser's own controls: the user's command, as if the app had sent it. */
  onUserCommand(
    generation: number,
    command: 'play' | 'pause' | 'seek',
    position: number
  ): void {
    if (!this.engine.accepts(generation)) return;
    try {
      if (command === 'play') this.engine.play();
      else if (command === 'pause') this.engine.pause();
      else this.engine.seek(position, true);
    } catch {
      // Nothing to play or not seekable: the element's own state stays.
    }
  }

  onLicenseRequest(generation: number, request: LicenseRequestEvent): void {
    if (this.engine.accepts(generation))
      this.emit('licenseRequest', { ...request });
  }

  onSourceCues(generation: number, cues: SubtitleCue[]): void {
    if (this.engine.accepts(generation)) this.video?.sourceCues(cues);
  }
}

/** A field of a song (an ICY block's `StreamTitle`, an ID3 frame), not of the station's response headers (`icy-name`). */
function isSongKey(key: string): boolean {
  return !key.toLowerCase().startsWith('icy-');
}
