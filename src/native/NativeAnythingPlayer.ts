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

  readonly onPlayerEvent: CodegenTypes.EventEmitter<CodegenTypes.UnsafeObject>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('AnythingPlayer');
