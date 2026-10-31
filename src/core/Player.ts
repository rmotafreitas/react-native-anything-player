import { PlayerError, toPlayerError } from '../errors';
import { WEB_ONLY_SCHEMES, host } from './host';
import { answerLicense, type LicenseRequestEvent } from './drm';
import { dispatchModuleEvent } from './moduleEvents';
import type { SubtitleCue } from './subtitles/types';
import {
  callRefresh,
  normalizeVideoSource,
  SubtitleLoader,
  subtitleTracks,
  ThumbnailTrack,
} from './video';
import type {
  ArtworkInput,
  AudioRoute,
  AudioSamplingOptions,
  BlobInput,
  DiagnosticEntry,
  FadeOptions,
  LoadOptions,
  MediaMetadata,
  NowPlayingMetadata,
  PlaybackState,
  PlaybackStats,
  PlayerEvent,
  PlayerEventMap,
  PlayerOptions,
  PlayerStatus,
  Progress,
  RemoteCommandEvent,
  SearchPlayEvent,
  SleepTimer,
  Source,
  SourceInput,
  SubtitleSource,
  Thumbnail,
} from '../types';

type NativeStatus = PlayerStatus & { seq: number };
type AnyListener = (...args: never[]) => void;

/** Live players by native id. Holding them here is deliberate: a player keeps
 * playing when the component that created it unmounts, until `release()`. */
const players = new Map<string, Player>();
let subscribed = false;

/** The platform's engine module (throws when it is missing, e.g. in Expo Go). */
const native = () => host().module();

/** @internal Subscribes to the engine module's events (once). */
export function ensureSubscription(): void {
  if (subscribed) return;
  native().onPlayerEvent((event) => {
    const e = event as { playerId?: string };
    if (typeof e.playerId === 'string')
      players.get(e.playerId)?._handleEvent(event);
    else dispatchModuleEvent(event as Record<string, unknown>);
  });
  subscribed = true;
  // Native kept running while JS was suspended; adopt its current truth.
  host().onForeground(() => players.forEach((p) => p.refresh()));
}

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const ALLOWED_SCHEMES = new Set([
  'http',
  'https',
  'file',
  'content',
  'asset',
  'android.resource',
  'ipod-library',
]);

function resolveAsset(module: number): string {
  const uri = host().resolveAsset(module);
  if (!uri) {
    throw new PlayerError({
      code: 'INVALID_SOURCE',
      message: `Asset ${module} could not be resolved.`,
      recoverable: false,
    });
  }
  return uri;
}

function invalidSource(message: string): PlayerError {
  return new PlayerError({
    code: 'INVALID_SOURCE',
    message,
    recoverable: false,
  });
}

/** Whether `value` is a `Blob` or `File` (React Native, the browser and Node all have a global one). */
function isBlob(value: unknown): value is BlobInput {
  const Blob = (globalThis as { Blob?: abstract new () => object }).Blob;
  return typeof Blob === 'function' && value instanceof Blob;
}

/** A picked file's name without its extension: what the lock screen shows for it. */
function titleOfFile(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * A `Blob` or `File` for `load()`, on the web: the web module makes an object
 * URL for it and revokes that when the item goes. Exported for tests.
 */
export function normalizeBlob(blob: BlobInput): Record<string, unknown> {
  if (!host().acceptsBlobs) {
    throw invalidSource(
      'A Blob or File can be played on the web only. Pass a file: URI on iOS and Android.'
    );
  }
  const name = (blob as { name?: unknown }).name;
  const out: Record<string, unknown> = { uri: '', blob };
  if (typeof name === 'string' && name !== '')
    out.metadata = { title: titleOfFile(name) };
  return out;
}

/** Validates and normalizes what apps pass to `load()`. Exported for tests. */
export function normalizeSource(input: SourceInput): Record<string, unknown> {
  if (isBlob(input)) {
    throw invalidSource(
      'A Blob or File can only be passed to Player.load(), on the web. A catalog item needs a URL.'
    );
  }
  let source;
  if (typeof input === 'string') source = { uri: input };
  else if (typeof input === 'number') source = { uri: resolveAsset(input) };
  else source = input;
  const uri = sourceUri(source);
  if (uri === '') {
    throw new PlayerError({
      code: 'INVALID_SOURCE',
      message:
        'A source needs a non-empty `uri` (or, for a video, `renditions`).',
      recoverable: false,
    });
  }
  const scheme = URI_SCHEME.exec(uri)?.[0]?.slice(0, -1).toLowerCase();
  // No scheme: an absolute path, or (Android release builds) a bundled asset's resource name.
  if (
    scheme &&
    !ALLOWED_SCHEMES.has(scheme) &&
    !host().acceptsScheme?.(scheme)
  ) {
    throw invalidSource(
      WEB_ONLY_SCHEMES.has(scheme)
        ? `"${scheme}:" sources can be played on the web only. Pass a file: URI on iOS and Android.`
        : `Unsupported URI scheme "${scheme}:".`
    );
  }
  const out: Record<string, unknown> = { uri };
  if (source.headers) out.headers = { ...source.headers };
  if (typeof source.live === 'boolean') out.live = source.live;
  if (source.metadata) out.metadata = normalizeNowPlaying(source.metadata);
  return { ...out, ...normalizeVideoSource(source, artworkUri) };
}

/**
 * `LoadOptions.quality`, checked before anything changes: an id the source's
 * renditions lack is refused (an adaptive source's variants are only known
 * once it loads).
 */
export function checkQuality(quality: unknown, renditions: unknown): void {
  if (typeof quality !== 'string' || quality === '') {
    throw new PlayerError({
      code: 'INVALID_ARGUMENT',
      message: "`quality` must be a quality id or `'auto'`.",
      recoverable: false,
    });
  }
  if (quality === 'auto' || !Array.isArray(renditions)) return;
  const ids = (renditions as Array<{ id?: string }>).map(
    (r, i) => r.id ?? `r${i}`
  );
  if (!ids.includes(quality)) {
    throw new PlayerError({
      code: 'INVALID_ARGUMENT',
      message: `No quality "${quality}" among the source's renditions.`,
      recoverable: false,
    });
  }
}

/** The source's `uri`; with renditions and no `uri`, the first picture's file. */
function sourceUri(source: Source | null | undefined): string {
  if (source == null || typeof source !== 'object') return '';
  if (typeof source.uri === 'string' && source.uri.trim() !== '')
    return source.uri.trim();
  const renditions = Array.isArray(source.renditions) ? source.renditions : [];
  const first = renditions.find((r) => !r?.audioOnly) ?? renditions[0];
  return typeof first?.uri === 'string' ? first.uri.trim() : '';
}

/** Frees a player the app cannot use; nothing waits for it. */
function releaseQuietly(id: string): void {
  native().willReleasePlayer(id);
  native()
    .releasePlayer(id)
    .catch(() => undefined);
}

function wantsVideo(options: PlayerOptions): boolean {
  return options.video != null && options.video !== false;
}

/** An artwork or poster as a URI (`require()` assets resolved). */
function artworkUri(art: ArtworkInput): string | null {
  if (typeof art === 'number') return resolveAsset(art);
  if (typeof art === 'string') return art;
  return typeof art?.uri === 'string' ? art.uri : null;
}

/** Exported for tests. */
export function normalizeNowPlaying(
  metadata: NowPlayingMetadata
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (metadata.title != null) out.title = String(metadata.title);
  if (metadata.artist != null) out.artist = String(metadata.artist);
  if (metadata.album != null) out.album = String(metadata.album);
  // Absent or unsupported artwork is left out.
  const art = metadata.artwork != null ? artworkUri(metadata.artwork) : null;
  if (art != null) out.artwork = art;
  if (metadata.duration != null) {
    assertFinite('duration', metadata.duration);
    out.duration = Math.max(0, metadata.duration);
    if (metadata.elapsed != null) {
      assertFinite('elapsed', metadata.elapsed);
      out.elapsed = Math.max(0, metadata.elapsed);
    }
  }
  if (typeof metadata.live === 'boolean') out.live = metadata.live;
  return out;
}

/** The longest sleep timer or fade, in seconds (24 h): the engines reject more. */
const MAX_TIMER_SECONDS = 86_400;

/** Timer and fade seconds: finite, from 0 to 24 h. */
function assertDuration(name: string, value: number): void {
  assertFinite(name, value);
  if (value < 0 || value > MAX_TIMER_SECONDS) {
    throw new PlayerError({
      code: 'INVALID_ARGUMENT',
      message: `${name} must be from 0 to ${MAX_TIMER_SECONDS} seconds (24 h).`,
      recoverable: false,
    });
  }
}

/** Validates `fade` options; exported for tests. */
export function normalizeFade(
  fade: FadeOptions | null | undefined
): Record<string, number> {
  const out: Record<string, number> = {};
  if (fade?.in != null) {
    assertDuration('fade.in', fade.in);
    out.in = fade.in;
  }
  if (fade?.out != null) {
    assertDuration('fade.out', fade.out);
    out.out = fade.out;
  }
  return out;
}

function assertFinite(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PlayerError({
      code: 'INVALID_ARGUMENT',
      message: `${name} must be a finite number.`,
      recoverable: false,
    });
  }
}

/**
 * An audio player. Playback, recovery, interruptions and the lock screen are
 * owned by native code; this object sends commands and mirrors native state.
 *
 * ```ts
 * const player = new Player();
 * await player.load('https://radio.example.com/stream');
 * await player.play();
 * ```
 *
 * Players live until `release()` — unmounting a component does not stop audio.
 */
export class Player {
  /** Native player id (stable for the player's lifetime). */
  readonly id: string;
  private _status: NativeStatus;
  private _metadata: MediaMetadata | null = null;
  private readonly listeners = new Map<PlayerEvent, Set<AnyListener>>();
  private released = false;
  /** The current source's `refresh`, its headers and its thumbnail track. */
  private refreshSource: Source['refresh'] | null = null;
  /** Counts the loads, so an answer for an earlier one changes nothing. */
  private loads = 0;
  /** The current source's `drm.getLicense`. */
  private licenseHook: NonNullable<Source['drm']>['getLicense'] | null = null;
  private sourceHeaders: Record<string, string> = {};
  private thumbnails: ThumbnailTrack | null = null;
  private cuesOnScreen: SubtitleCue[] = [];
  private readonly subtitles = new SubtitleLoader({
    sendCues: async (session, trackId, cues) => {
      await native().videoCommand(this.id, {
        op: 'cues',
        session,
        trackId,
        cues,
      });
    },
    failed: (error) => this.emit('error', error, { fatal: false }),
  });

  constructor(options: PlayerOptions = {}) {
    if (options.progressInterval != null) {
      assertFinite('progressInterval', options.progressInterval);
      if (options.progressInterval < 0) {
        throw new PlayerError({
          code: 'INVALID_ARGUMENT',
          message: 'progressInterval must be ≥ 0 (ms).',
          recoverable: false,
        });
      }
    }
    if (options.id != null) {
      if (typeof options.id !== 'string' || options.id.trim() === '') {
        throw new PlayerError({
          code: 'INVALID_ARGUMENT',
          message: 'A player id must be a non-empty string.',
          recoverable: false,
        });
      }
      if (players.has(options.id)) {
        throw new PlayerError({
          code: 'INVALID_ARGUMENT',
          message: `A live Player already has the id "${options.id}".`,
          recoverable: false,
        });
      }
    }
    if (options.fade != null) normalizeFade(options.fade);
    ensureSubscription();
    // With an id native already knows, this attaches to that player.
    this.id = native().createPlayer(options as object);
    players.set(this.id, this);
    this._status = native().getStatus(this.id) as NativeStatus;
    if (wantsVideo(options) && this._status.video == null) {
      players.delete(this.id);
      releaseQuietly(this.id);
      throw new PlayerError({
        code: 'VIDEO_UNAVAILABLE',
        message:
          'Video is not built into this app. Turn the video module on and rebuild: ' +
          '`npx rnap add video`, or `rnapVideo=true` in android/gradle.properties and ' +
          "`RNAP_VIDEO=1 pod install` on iOS, or the Expo plugin's `video` option.",
        recoverable: false,
      });
    }
    if (options.diagnostics) native().setDiagnosticsEnabled(this.id, true);
  }

  // ── State ──

  /** Last known status (updated by events and command results; cheap, stable identity). */
  get status(): PlayerStatus {
    return this._status;
  }

  /** The playback state (`status.state`). */
  get state(): PlaybackState {
    return this._status.state;
  }

  /** Whether playback is wanted (what a play/pause button should show). */
  get playWhenReady(): boolean {
    return this._status.playWhenReady;
  }

  /** Latest stream metadata (ICY / ID3 / timed metadata), or `null`. */
  get metadata(): MediaMetadata | null {
    return this._metadata;
  }

  /** Reads the authoritative status from native now and applies it if newer. */
  refresh(): PlayerStatus {
    if (this.released) return this._status;
    this.apply(native().getStatus(this.id) as NativeStatus);
    const meta = (
      native().getMetadata(this.id) as {
        metadata: MediaMetadata | null;
      }
    ).metadata;
    if (meta && meta.timestamp !== this._metadata?.timestamp)
      this._metadata = meta;
    return this._status;
  }

  /**
   * Current position/duration/buffer, read synchronously from native and
   * extrapolated to "now". Cheap enough to call every animation frame.
   */
  getProgress(): Progress {
    return native().getProgress(this.id) as Progress;
  }

  // ── Commands ──
  // Commands are applied by native in call order and resolve with the status
  // after they were applied. They reject with a PlayerError.

  /**
   * Opens a source. Resolves once it is ready to play (or when a later `load`
   * replaced it); rejects if it cannot be opened. Keeps the current play
   * intent unless `autoplay` is given — a playing player switches sources
   * seamlessly.
   *
   * On the web the source may also be a `Blob` or `File` (a picked or dropped
   * file): RNAP plays it from an object URL it revokes when the item is
   * replaced, reset or released. Native rejects it with `INVALID_SOURCE`.
   */
  async load(
    source: SourceInput | BlobInput,
    options: LoadOptions = {}
  ): Promise<void> {
    this.ensureAlive();
    const normalized = isBlob(source)
      ? normalizeBlob(source)
      : normalizeSource(source);
    if (options.startPosition != null)
      assertFinite('startPosition', options.startPosition);
    const nativeOptions: Record<string, unknown> = {};
    if (options.autoplay != null) nativeOptions.autoplay = options.autoplay;
    if (options.startPosition != null)
      nativeOptions.startPosition = options.startPosition;
    if (options.quality != null) {
      checkQuality(options.quality, normalized.renditions);
      nativeOptions.quality = options.quality;
    }
    this._metadata = null;
    const full =
      typeof source === 'object' && !isBlob(source) ? (source as Source) : null;
    this.beginVideoLoad(full, normalized);
    const loading = this.run(() =>
      native().load(this.id, normalized, nativeOptions)
    );
    // Subtitle files load alongside: their cues are ready about when the picture is.
    if (full?.subtitles != null)
      this.subtitles.add(subtitleTracks(full.subtitles), this.sourceHeaders);
    await loading;
  }

  /** A new source: its refresh, thumbnails and subtitle session. */
  private beginVideoLoad(
    source: Source | null,
    normalized: Record<string, unknown>
  ): void {
    this.loads += 1;
    this.refreshSource = source?.refresh ?? null;
    this.licenseHook = source?.drm?.getLicense ?? null;
    this.sourceHeaders = { ...source?.headers };
    this.thumbnails =
      source?.thumbnails != null
        ? new ThumbnailTrack(source.thumbnails, this.sourceHeaders)
        : null;
    this.cuesOnScreen = [];
    this.subtitles.cancel();
    const session = this.subtitles.begin();
    // Subtitle files are a video player's; an audio load stays as it was.
    if (this._status.video != null) normalized.subtitleSession = session;
  }

  /** Starts or resumes playback (re-opens live streams at the live edge when needed). */
  async play(): Promise<void> {
    await this.run(() => native().play(this.id));
  }

  /** Pauses. A paused live stream releases its network connection after 30 s. */
  async pause(): Promise<void> {
    await this.run(() => native().pause(this.id));
  }

  /** Pauses when playback is wanted, plays otherwise. */
  async toggle(): Promise<void> {
    return this._status.playWhenReady ? this.pause() : this.play();
  }

  /** Stops and releases network/decoder resources; the source stays loaded. */
  async stop(): Promise<void> {
    await this.run(() => native().stop(this.id));
  }

  /** Unloads the source (back to `idle`). */
  async reset(): Promise<void> {
    this._metadata = null;
    await this.run(() => native().reset(this.id));
  }

  /**
   * Seconds. Rejects with `NOT_SEEKABLE` for live streams. `exact`: to the
   * frame (slower); by default the nearest keyframe is fine.
   */
  async seekTo(
    position: number,
    options: { exact?: boolean } = {}
  ): Promise<void> {
    assertFinite('position', position);
    if (options.exact === true) {
      await this.video({ op: 'seek', position, exact: true });
      return;
    }
    await this.run(() => native().seekTo(this.id, position));
  }

  /** 0…1 (clamped). Independent of `muted`. */
  async setVolume(volume: number): Promise<void> {
    assertFinite('volume', volume);
    await this.run(() => native().setVolume(this.id, volume));
  }

  /** Mutes without losing the volume. */
  async setMuted(muted: boolean): Promise<void> {
    await this.run(() => native().setMuted(this.id, !!muted));
  }

  /**
   * Playback rate (1 = normal; rejects with `INVALID_ARGUMENT` when ≤ 0).
   * Meant for files: a live stream runs out of buffer above 1.
   */
  async setRate(rate: number): Promise<void> {
    assertFinite('rate', rate);
    await this.run(() => native().setRate(this.id, rate));
  }

  /**
   * Moves the volume to `volume` (0…1, clamped) over `seconds`. Resolves when
   * it gets there, or when `setVolume` or another `fadeTo` takes over.
   * `status.volume` is the target from the start. Runs natively, so it keeps
   * going while JavaScript is frozen in the background. Instant on a Cast
   * receiver.
   */
  async fadeTo(volume: number, seconds: number): Promise<void> {
    assertFinite('volume', volume);
    assertDuration('seconds', seconds);
    await this.run(() => native().fadeTo(this.id, volume, seconds));
  }

  /**
   * Pauses after `timer.after` seconds, fading out over the last
   * `timer.fadeOut` seconds. `null` cancels. A new timer replaces the
   * previous one. The timer runs natively (it fires while JavaScript is
   * frozen); `status.sleepAt` shows when it fires, and a `sleep` event says it
   * did. A paused live stream then releases its connection after 30 s, as
   * after any pause.
   */
  async sleep(timer: SleepTimer | null): Promise<void> {
    const request: Record<string, number | null> = { after: null };
    if (timer != null) {
      assertDuration('after', timer.after);
      request.after = timer.after;
      if (timer.fadeOut != null) {
        assertDuration('fadeOut', timer.fadeOut);
        request.fadeOut = timer.fadeOut;
      }
    }
    await this.run(() => native().sleep(this.id, request));
  }

  /**
   * Replaces the fades of play, pause and stop (`PlayerOptions.fade`); `null`
   * turns them off. A fade under way keeps its course.
   */
  async setFade(fade: FadeOptions | null): Promise<void> {
    const normalized = normalizeFade(fade);
    await this.run(() => native().setFade(this.id, normalized));
  }

  /**
   * Overrides what the lock screen shows (until the next `load`). Each call
   * replaces the previous overrides; pass `{}` to fall back to stream/source
   * metadata.
   */
  async updateNowPlaying(metadata: NowPlayingMetadata): Promise<void> {
    this.ensureAlive();
    const normalized = normalizeNowPlaying(metadata);
    try {
      await native().updateNowPlaying(this.id, normalized);
    } catch (error) {
      throw toPlayerError(error);
    }
  }

  // ── Video ──

  /** Repeats a finite source from the start, seamlessly where the platform can. */
  async setLoop(loop: boolean): Promise<void> {
    await this.video({ op: 'loop', value: !!loop });
  }

  /** Pins a quality from `status.qualities`, or `'auto'`. */
  async selectQuality(id: string): Promise<void> {
    this.ensureAlive();
    // Nothing to pick from (one file): an id cannot be had. `'auto'` still
    // goes through: it lets go of a pick kept for the next loads.
    if (this._status.qualities.length === 0 && id !== 'auto') {
      throw new PlayerError({
        code: 'INVALID_ARGUMENT',
        message: `No quality "${id}".`,
        recoverable: false,
      });
    }
    await this.video({ op: 'selectQuality', id: id === 'auto' ? null : id });
  }

  /** Plays an audio track from `status.video.tracks`, or `'auto'`. */
  async selectAudioTrack(id: string): Promise<void> {
    await this.video({ op: 'selectAudioTrack', id: id === 'auto' ? null : id });
  }

  /** Shows a text track from `status.video.tracks`; `null` turns subtitles off. */
  async selectSubtitles(id: string | null): Promise<void> {
    await this.video({ op: 'selectTextTrack', id });
  }

  /** Shows the subtitles `seconds` later (negative: earlier), to fix a file out of sync. */
  async setSubtitleDelay(seconds: number): Promise<void> {
    assertFinite('seconds', seconds);
    await this.video({ op: 'subtitleDelay', seconds });
  }

  /** Adds subtitle files to the current source. */
  async addSubtitles(files: SubtitleSource[]): Promise<void> {
    const tracks = subtitleTracks(files, this.subtitles.size);
    await this.video({ op: 'addSubtitles', tracks: tracks.map((t) => t.info) });
    this.subtitles.add(tracks, this.sourceHeaders);
  }

  /** Plays the sound alone (an audio-only variant or rendition where there is one). */
  async setListenOnly(enabled: boolean): Promise<void> {
    await this.video({ op: 'listenOnly', value: !!enabled });
  }

  /** The system's fullscreen player. `lockOrientation` holds the screen while it lasts. */
  async presentFullscreen(
    options: { lockOrientation?: 'landscape' | 'portrait' | false } = {}
  ): Promise<void> {
    await this.video({
      op: 'fullscreen',
      active: true,
      lockOrientation: options.lockOrientation ?? false,
    });
  }

  /** Closes the system's fullscreen player. */
  async dismissFullscreen(): Promise<void> {
    await this.video({ op: 'fullscreen', active: false });
  }

  /** Picture in Picture. Rejects with `INVALID_ARGUMENT` where the platform has none. */
  async startPictureInPicture(): Promise<void> {
    await this.video({ op: 'pictureInPicture', active: true });
  }

  /** Closes Picture in Picture (on Android, the app comes back to the front). */
  async stopPictureInPicture(): Promise<void> {
    await this.video({ op: 'pictureInPicture', active: false });
  }

  /** Start-up time, rebuffers, switches and the last bandwidth since `load()`. */
  getStats(): PlaybackStats {
    return native().getVideoStats(this.id) as PlaybackStats;
  }

  /** The seek-preview image for `time` (seconds) from `Source.thumbnails`, or `null`. */
  async getThumbnail(time: number): Promise<Thumbnail | null> {
    assertFinite('time', time);
    return (await this.thumbnails?.at(time)) ?? null;
  }

  /** The subtitles on screen now (the `cues` event's latest). */
  getCues(): SubtitleCue[] {
    return this.cuesOnScreen;
  }

  /**
   * The web: shows the picture in `element` (`null` takes it out). In React
   * and React Native, use `<VideoView player={player} />`.
   */
  attachTo(
    element: unknown,
    options: {
      contentFit?: 'contain' | 'cover' | 'fill';
      /** The browser's own controls on the picture. */
      nativeControls?: boolean;
    } = {}
  ): void {
    this.ensureAlive();
    const attach = host().attachVideo;
    if (!attach) {
      throw new PlayerError({
        code: 'INVALID_ARGUMENT',
        message:
          'attachTo() is for web pages. In React Native, use <VideoView player={player} />.',
        recoverable: false,
      });
    }
    attach(
      this.id,
      element,
      options.contentFit,
      options.nativeControls === true
    );
  }

  /**
   * `<VideoView>`'s cleanup: the picture leaves `element` only if it is still
   * there (a newer view keeps it), and goes back to the newest view left.
   * @internal
   */
  detachFrom(element: unknown): void {
    if (this.isReleased) return;
    host().detachVideo?.(this.id, element);
  }

  private async video(command: Record<string, unknown>): Promise<void> {
    await this.run(() => native().videoCommand(this.id, command));
  }

  /** The platform needs a license: the app's `drm.getLicense` answers. */
  private async licenseRequested(event: LicenseRequestEvent): Promise<void> {
    const hook = this.licenseHook;
    const answer = hook
      ? await answerLicense(hook, event)
      : { error: 'The source has no drm.getLicense.' };
    if (this.released) return;
    await native()
      .videoCommand(this.id, {
        op: 'license',
        requestId: event.requestId,
        ...answer,
      })
      .catch(() => undefined);
  }

  /** The engine asks for a fresh source: the app's `refresh` answers. */
  private async refreshRequested(
    loadId: number,
    reason: 'unauthorized' | 'expiring'
  ): Promise<void> {
    const refresh = this.refreshSource;
    const load = this.loads;
    const next = refresh ? await callRefresh(refresh, reason) : null;
    if (this.released) return;
    let source: Record<string, unknown> | null = null;
    try {
      if (next != null) source = normalizeSource(next as SourceInput);
    } catch {
      source = null;
    }
    // A refreshed source's own DRM hook answers from now on (unless a new
    // source was loaded meanwhile).
    const drm = source != null ? (next as Source).drm : undefined;
    if (drm != null && this.loads === load) {
      this.licenseHook = drm.getLicense ?? null;
    }
    const command =
      source != null
        ? { op: 'refreshed', loadId, source }
        : { op: 'refreshFailed', loadId };
    await native()
      .videoCommand(this.id, command)
      .catch(() => undefined);
  }

  /** Stops playback and frees every native resource. The player is unusable afterwards. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.subtitles.cancel();
    players.delete(this.id);
    // Native lets go of the id now: a Player created with it next (a remount,
    // in the same tick) is a new one, not this one being released.
    native().willReleasePlayer(this.id);
    try {
      await native().releasePlayer(this.id);
    } finally {
      this.listeners.clear();
    }
  }

  /** Whether `release()` was called. */
  get isReleased(): boolean {
    return this.released;
  }

  // ── Diagnostics ──

  /** Streams engine traces as `diagnostic` events and to the native log. */
  setDiagnosticsEnabled(enabled: boolean): void {
    if (!this.released) native().setDiagnosticsEnabled(this.id, enabled);
  }

  // ── Visualizer ──

  /**
   * Streams decoded audio as `audioSample` events (for oscilloscopes and
   * spectrum views). Off by default; costs nothing while off. Returns whether
   * the platform supports it.
   */
  setAudioSampling(options: AudioSamplingOptions): boolean {
    if (this.released) return false;
    const points = options.points ?? 1024;
    assertFinite('points', points);
    return native().setAudioSampling(this.id, options.enabled, points);
  }

  /** The last ~300 engine traces (kept natively even while diagnostics are off). */
  getDiagnostics(): DiagnosticEntry[] {
    if (this.released) return [];
    return native().getDiagnostics(this.id) as DiagnosticEntry[];
  }

  // ── Events ──

  /** Subscribes; returns the unsubscribe function. */
  on<E extends PlayerEvent>(event: E, listener: PlayerEventMap[E]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as AnyListener);
    return () => {
      this.listeners.get(event)?.delete(listener as AnyListener);
    };
  }

  /** Number of listeners (useful to verify cleanup). */
  listenerCount(event?: PlayerEvent): number {
    if (event) return this.listeners.get(event)?.size ?? 0;
    let n = 0;
    this.listeners.forEach((s) => (n += s.size));
    return n;
  }

  private emit<E extends PlayerEvent>(
    event: E,
    ...args: Parameters<PlayerEventMap[E]>
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // A snapshot: a listener that re-subscribes during dispatch must not run again in this pass.
    const snapshot = [...set];
    for (const listener of snapshot) {
      try {
        (listener as (...a: Parameters<PlayerEventMap[E]>) => void)(...args);
      } catch (error) {
        // A throwing listener must not break the others or the player.
        setTimeout(() => {
          throw error;
        }, 0);
      }
    }
  }

  /** @internal Native event entry point. */
  _handleEvent(raw: object): void {
    if (this.released) return;
    const event = raw as { type: string; seq: number } & Record<
      string,
      unknown
    >;
    switch (event.type) {
      case 'status':
        this.apply(event as unknown as NativeStatus);
        break;
      case 'metadata': {
        const meta = event.metadata as MediaMetadata;
        this._metadata = meta;
        this.emit('metadata', meta);
        break;
      }
      case 'error':
        this.emit(
          'error',
          toPlayerError({
            code: (event.error as { code: string }).code,
            message: (event.error as { message: string }).message,
            userInfo: event.error,
          }),
          {
            fatal: event.fatal === true,
          }
        );
        break;
      case 'ended':
        this.emit('ended');
        break;
      case 'remoteCommand':
        this.emit('remoteCommand', {
          command: event.command,
          position: event.position,
        } as RemoteCommandEvent);
        break;
      case 'diagnostic':
        this.emit('diagnostic', event.entry as DiagnosticEntry);
        break;
      case 'progress':
        this.emit('progress', {
          position: event.position as number,
          duration: (event.duration as number | null) ?? null,
          buffered: event.buffered as number,
          bufferedAhead: event.bufferedAhead as number,
          liveOffset: (event.liveOffset as number | null) ?? null,
          timestamp: event.timestamp as number,
        });
        break;
      case 'searchPlay':
        this.emit('searchPlay', {
          request: event.request,
          item: event.item,
        } as SearchPlayEvent);
        break;
      case 'sleep':
        this.emit('sleep', {
          reason: 'fired',
          timestamp: event.timestamp as number,
        });
        break;
      case 'discontinuity':
        this.emit('discontinuity', {
          position: event.position as number,
          timestamp: event.timestamp as number,
        });
        break;
      case 'cues':
        this.cuesOnScreen = event.cues as SubtitleCue[];
        this.emit('cues', this.cuesOnScreen);
        break;
      case 'refreshRequest':
        this.refreshRequested(
          event.loadId as number,
          event.reason as 'unauthorized' | 'expiring'
        ).catch(() => undefined);
        break;
      case 'licenseRequest':
        this.licenseRequested(event as unknown as LicenseRequestEvent).catch(
          () => undefined
        );
        break;
      case 'audioSample':
        this.emit('audioSample', {
          waveform: event.waveform as number[],
          level: event.level as number,
          duration: event.duration as number,
          outputLatency: event.outputLatency as number,
          timestamp: event.timestamp as number,
        });
        break;
      default:
        break;
    }
  }

  // ── Internals ──

  /** Applies a status snapshot unless an equal-or-newer one was already applied. */
  private apply(next: NativeStatus): void {
    if (!next || typeof next.seq !== 'number' || next.seq <= this._status.seq)
      return;
    const previous = this._status;
    // Events carry routing fields; the public status is the snapshot alone.
    const snapshot = { ...next } as NativeStatus & {
      playerId?: string;
      type?: string;
    };
    delete snapshot.playerId;
    delete snapshot.type;
    this._status = snapshot;
    this.emit('status', this._status);
    if (previous.state !== this._status.state)
      this.emit('stateChange', this._status.state, previous.state);
    if (!sameRoute(previous.route, this._status.route))
      this.emit('routeChange', this._status.route, previous.route);
    this.emitVideoChanges(previous.video ?? null, this._status.video ?? null);
  }

  private emitVideoChanges(
    previous: PlayerStatus['video'],
    next: PlayerStatus['video']
  ): void {
    if (next == null) return;
    if (next.firstFrame && !previous?.firstFrame) this.emit('firstFrame');
    if (next.pictureInPicture !== (previous?.pictureInPicture ?? false))
      this.emit('pictureInPictureChange', next.pictureInPicture);
    if (next.fullscreen !== (previous?.fullscreen ?? false))
      this.emit('fullscreenChange', next.fullscreen);
  }

  private ensureAlive(): void {
    if (this.released) {
      throw new PlayerError({
        code: 'PLAYER_RELEASED',
        message: 'The player was released.',
        recoverable: false,
      });
    }
  }

  private async run(command: () => Promise<object>): Promise<void> {
    this.ensureAlive();
    let result: object;
    try {
      result = await command();
    } catch (error) {
      throw toPlayerError(error);
    }
    if (result) this.apply(result as NativeStatus);
  }
}

function sameRoute(a: AudioRoute, b: AudioRoute): boolean {
  return a.kind === b.kind && a.name === b.name;
}

/** @internal The live `Player` with this native id, if any. */
export function _livePlayer(id: string): Player | undefined {
  return players.get(id);
}

/** @internal Test hook. */
export function _livePlayerCount(): number {
  return players.size;
}
