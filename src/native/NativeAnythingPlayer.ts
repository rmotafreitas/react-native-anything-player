import {
  TurboModuleRegistry,
  type CodegenTypes,
  type TurboModule,
} from 'react-native';

/**
 * The JS ⇄ native contract. Internal: apps use `Player` (src/Player.ts).
 *
 * - Commands resolve with the authoritative status snapshot *after* native
 *   applied them, and are applied in call order on one native thread.
 * - Rejections carry a normalized error code (see src/errors.ts).
 * - `get*` methods are synchronous JSI reads of a snapshot native publishes;
 *   they never block on the player thread.
 * - Every event is `{ playerId, seq, type, ...payload }`; `seq` increases per
 *   player, so JS can drop anything older than what it already applied.
 */
export interface Spec extends TurboModule {
  createPlayer(options: CodegenTypes.UnsafeObject): string;
  /**
   * Before `releasePlayer`: native lets go of the id at once, so a
   * `createPlayer` with it right after makes a new player, not this one.
   * Returns a value so that it runs synchronously (a `void` TurboModule
   * method is queued, like the promise ones): whether a player had the id.
   */
  willReleasePlayer(playerId: string): boolean;
  releasePlayer(playerId: string): Promise<void>;

  load(
    playerId: string,
    source: CodegenTypes.UnsafeObject,
    options: CodegenTypes.UnsafeObject
  ): Promise<CodegenTypes.UnsafeObject>;
  play(playerId: string): Promise<CodegenTypes.UnsafeObject>;
  pause(playerId: string): Promise<CodegenTypes.UnsafeObject>;
  stop(playerId: string): Promise<CodegenTypes.UnsafeObject>;
  reset(playerId: string): Promise<CodegenTypes.UnsafeObject>;
  seekTo(
    playerId: string,
    position: number
  ): Promise<CodegenTypes.UnsafeObject>;
  setVolume(
    playerId: string,
    volume: number
  ): Promise<CodegenTypes.UnsafeObject>;
  setMuted(
    playerId: string,
    muted: boolean
  ): Promise<CodegenTypes.UnsafeObject>;
  setRate(playerId: string, rate: number): Promise<CodegenTypes.UnsafeObject>;
  /** Resolves when the volume got there (or a later volume command replaced the fade). */
  fadeTo(
    playerId: string,
    volume: number,
    seconds: number
  ): Promise<CodegenTypes.UnsafeObject>;
  /** `{ after: seconds, fadeOut?: seconds }`; `{ after: null }` cancels. */
  sleep(
    playerId: string,
    timer: CodegenTypes.UnsafeObject
  ): Promise<CodegenTypes.UnsafeObject>;
  /** `{ in?: seconds, out?: seconds }` replaces the play/pause/stop fades. */
  setFade(
    playerId: string,
    fade: CodegenTypes.UnsafeObject
  ): Promise<CodegenTypes.UnsafeObject>;
  /** Replaces the app's now-playing overrides (`{}` clears them). */
  updateNowPlaying(
    playerId: string,
    metadata: CodegenTypes.UnsafeObject
  ): Promise<void>;

  getStatus(playerId: string): CodegenTypes.UnsafeObject;
  getProgress(playerId: string): CodegenTypes.UnsafeObject;
  /** `{ metadata: StreamMetadata | null }` */
  getMetadata(playerId: string): CodegenTypes.UnsafeObject;
  getDiagnostics(playerId: string): CodegenTypes.UnsafeObject[];
  setDiagnosticsEnabled(playerId: string, enabled: boolean): void;
  /** Returns whether decoded-audio sampling is supported here. */
  setAudioSampling(playerId: string, enabled: boolean, points: number): boolean;

  // ── Outputs (app-global) ──
  /** Opens the system output picker for `playerId` (`null` = the active player). */
  showRoutePicker(playerId: string | null): Promise<void>;
  isRoutePickerAvailable(): boolean;

  // ── Google Cast (app-global) ──
  /** `{ state: CastState, device: string | null }` */
  getCastState(): CodegenTypes.UnsafeObject;
  /** Native reads the receiver id at build time; the web loads the SDK here. */
  configureCast(options: CodegenTypes.UnsafeObject): Promise<void>;
  showCastPicker(): Promise<void>;
  stopCasting(): Promise<void>;

  // ── Catalog & voice (app-global, persisted natively) ──
  setCatalog(
    items: CodegenTypes.UnsafeObject[],
    options: CodegenTypes.UnsafeObject
  ): Promise<void>;
  /** Replaces the ids in the browse tree's Favorites folder, without touching the catalog. */
  setFavorites(ids: string[]): Promise<void>;
  /** Ranked matches, best first. */
  searchCatalog(
    request: CodegenTypes.UnsafeObject
  ): Promise<CodegenTypes.UnsafeObject[]>;
  /** `{ item: CatalogItem | null }`: what was played. */
  playFromSearch(
    request: CodegenTypes.UnsafeObject,
    playerId: string | null
  ): Promise<CodegenTypes.UnsafeObject>;
  /** Whether native may ask JS (`searchRequest` events) when the catalog has no match. */
  setSearchHandlerEnabled(enabled: boolean): void;
  /** Answers a `searchRequest` event: `{ item: CatalogItem | null }`. */
  resolveSearchRequest(
    requestId: string,
    result: CodegenTypes.UnsafeObject
  ): void;

  // ── Video ──
  /** A video command (`{ op, … }`); resolves with the status after it. */
  videoCommand(
    playerId: string,
    command: CodegenTypes.UnsafeObject
  ): Promise<CodegenTypes.UnsafeObject>;
  /** Quality-of-experience numbers since the last load. */
  getVideoStats(playerId: string): CodegenTypes.UnsafeObject;
  /** Fetches a text file and decodes it, detecting the encoding: `{ text, charset }`. */
  fetchText(
    uri: string,
    headers: CodegenTypes.UnsafeObject,
    encoding: string | null
  ): Promise<CodegenTypes.UnsafeObject>;

  /**
   * Player events carry `playerId`. App-global events have none:
   * `{ type: 'castState', state, device }`,
   * `{ type: 'routePickerAvailability', available }`,
   * `{ type: 'searchRequest', requestId, request }`.
   */
  readonly onPlayerEvent: CodegenTypes.EventEmitter<CodegenTypes.UnsafeObject>;
}

// `get`, not `getEnforcing`: a missing module (Expo Go, a stale binary) must
// surface as a PlayerError with setup advice when a Player is created, not as
// a crash on import. See src/Player.ts.
export default TurboModuleRegistry.get<Spec>('AnythingPlayer');
