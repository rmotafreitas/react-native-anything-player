import { AppState, Image } from 'react-native';
import NativeAirwave from './native/NativeAirwave';
import { PlayerError, toPlayerError } from './errors';
import type {
  AudioSamplingOptions,
  DiagnosticEntry,
  LoadOptions,
  MediaMetadata,
  NowPlayingMetadata,
  PlaybackState,
  PlayerEvent,
  PlayerEventMap,
  PlayerOptions,
  PlayerStatus,
  Progress,
  RemoteCommandEvent,
  SourceInput,
} from './types';

type NativeStatus = PlayerStatus & { seq: number };
type AnyListener = (...args: never[]) => void;

/** Live players by native id. Holding them here is deliberate: a player keeps
 * playing when the component that created it unmounts, until `release()`. */
const players = new Map<string, Player>();
let subscribed = false;

function ensureSubscription(): void {
  if (subscribed) return;
  subscribed = true;
  NativeAirwave.onPlayerEvent((event) => {
    const e = event as { playerId?: string };
    if (typeof e.playerId === 'string')
      players.get(e.playerId)?._handleEvent(event);
  });
  // Native kept running while JS was suspended; adopt its current truth.
  AppState.addEventListener('change', (state) => {
    if (state === 'active') players.forEach((p) => p.refresh());
  });
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
  const resolved = Image.resolveAssetSource(module);
  if (!resolved?.uri) {
    throw new PlayerError({
      code: 'INVALID_SOURCE',
      message: `Asset ${module} could not be resolved.`,
      recoverable: false,
    });
  }
  return resolved.uri;
}

/** Validates and normalizes what apps pass to `load()`. Exported for tests. */
export function normalizeSource(input: SourceInput): Record<string, unknown> {
  const source =
    typeof input === 'string'
      ? { uri: input }
      : typeof input === 'number'
        ? { uri: resolveAsset(input) }
        : input;
  if (!source || typeof source.uri !== 'string' || source.uri.trim() === '') {
    throw new PlayerError({
      code: 'INVALID_SOURCE',
      message: 'A source needs a non-empty `uri`.',
      recoverable: false,
    });
  }
  const uri = source.uri.trim();
  const scheme = URI_SCHEME.exec(uri)?.[0]?.slice(0, -1).toLowerCase();
  // No scheme: an absolute path, or (Android release builds) a bundled asset's resource name.
  if (scheme && !ALLOWED_SCHEMES.has(scheme)) {
    throw new PlayerError({
      code: 'INVALID_SOURCE',
      message: `Unsupported URI scheme "${scheme}:".`,
      recoverable: false,
    });
  }
  const out: Record<string, unknown> = { uri };
  if (source.headers) out.headers = { ...source.headers };
  if (typeof source.live === 'boolean') out.live = source.live;
  if (source.metadata) out.metadata = normalizeNowPlaying(source.metadata);
  return out;
}

/** Exported for tests. */
export function normalizeNowPlaying(
  metadata: NowPlayingMetadata
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (metadata.title != null) out.title = String(metadata.title);
  if (metadata.artist != null) out.artist = String(metadata.artist);
  if (metadata.album != null) out.album = String(metadata.album);
  const art = metadata.artwork;
  if (typeof art === 'number') out.artwork = resolveAsset(art);
  else if (typeof art === 'string') out.artwork = art;
  else if (art && typeof art.uri === 'string') out.artwork = art.uri;
  if (metadata.duration != null) {
    assertFinite('duration', metadata.duration);
    out.duration = Math.max(0, metadata.duration);
    if (metadata.elapsed != null) {
      assertFinite('elapsed', metadata.elapsed);
      out.elapsed = Math.max(0, metadata.elapsed);
    }
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
    ensureSubscription();
    this.id = NativeAirwave.createPlayer(options as object);
    players.set(this.id, this);
    this._status = NativeAirwave.getStatus(this.id) as NativeStatus;
    if (options.diagnostics) NativeAirwave.setDiagnosticsEnabled(this.id, true);
  }

  // ── State ──

  /** Last known status (updated by events and command results; cheap, stable identity). */
  get status(): PlayerStatus {
    return this._status;
  }

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
    this.apply(NativeAirwave.getStatus(this.id) as NativeStatus);
    const meta = (
      NativeAirwave.getMetadata(this.id) as { metadata: MediaMetadata | null }
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
    return NativeAirwave.getProgress(this.id) as Progress;
  }

  // ── Commands ──
  // Commands are applied by native in call order and resolve with the status
  // after they were applied. They reject with a PlayerError.

  /**
   * Opens a source. Resolves once it is ready to play (or when a later `load`
   * replaced it); rejects if it cannot be opened. Keeps the current play
   * intent unless `autoplay` is given — a playing player switches sources
   * seamlessly.
   */
  async load(source: SourceInput, options: LoadOptions = {}): Promise<void> {
    this.ensureAlive();
    const normalized = normalizeSource(source);
    if (options.startPosition != null)
      assertFinite('startPosition', options.startPosition);
    const nativeOptions: Record<string, unknown> = {};
    if (options.autoplay != null) nativeOptions.autoplay = options.autoplay;
    if (options.startPosition != null)
      nativeOptions.startPosition = options.startPosition;
    this._metadata = null;
    await this.run(() =>
      NativeAirwave.load(this.id, normalized, nativeOptions)
    );
  }

  /** Starts or resumes playback (re-opens live streams at the live edge when needed). */
  async play(): Promise<void> {
    await this.run(() => NativeAirwave.play(this.id));
  }

  async pause(): Promise<void> {
    await this.run(() => NativeAirwave.pause(this.id));
  }

  /** Pauses when playback is wanted, plays otherwise. */
  async toggle(): Promise<void> {
    return this._status.playWhenReady ? this.pause() : this.play();
  }

  /** Stops and releases network/decoder resources; the source stays loaded. */
  async stop(): Promise<void> {
    await this.run(() => NativeAirwave.stop(this.id));
  }

  /** Unloads the source (back to `idle`). */
  async reset(): Promise<void> {
    this._metadata = null;
    await this.run(() => NativeAirwave.reset(this.id));
  }

  /** Seconds. Rejects with `NOT_SEEKABLE` for live streams. */
  async seekTo(position: number): Promise<void> {
    assertFinite('position', position);
    await this.run(() => NativeAirwave.seekTo(this.id, position));
  }

  /** 0…1 (clamped). Independent of `muted`. */
  async setVolume(volume: number): Promise<void> {
    assertFinite('volume', volume);
    await this.run(() => NativeAirwave.setVolume(this.id, volume));
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.run(() => NativeAirwave.setMuted(this.id, !!muted));
  }

  async setRate(rate: number): Promise<void> {
    assertFinite('rate', rate);
    await this.run(() => NativeAirwave.setRate(this.id, rate));
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
      await NativeAirwave.updateNowPlaying(this.id, normalized);
    } catch (error) {
      throw toPlayerError(error);
    }
  }

  /** Stops playback and frees every native resource. The player is unusable afterwards. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    players.delete(this.id);
    try {
      await NativeAirwave.releasePlayer(this.id);
    } finally {
      this.listeners.clear();
    }
  }

  get isReleased(): boolean {
    return this.released;
  }

  // ── Diagnostics ──

  /** Streams engine traces as `diagnostic` events and to the native log. */
  setDiagnosticsEnabled(enabled: boolean): void {
    if (!this.released) NativeAirwave.setDiagnosticsEnabled(this.id, enabled);
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
    return NativeAirwave.setAudioSampling(this.id, options.enabled, points);
  }

  /** The last ~300 engine traces (kept natively even while diagnostics are off). */
  getDiagnostics(): DiagnosticEntry[] {
    if (this.released) return [];
    return NativeAirwave.getDiagnostics(this.id) as DiagnosticEntry[];
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
    for (const listener of [...set]) {
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

/** @internal Test hook. */
export function _livePlayerCount(): number {
  return players.size;
}
