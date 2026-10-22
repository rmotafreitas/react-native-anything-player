// What `Player` needs from the platform it runs on. React Native installs a
// host backed by the TurboModule (src/Player.ts); the plain-web entry
// (src/web/index.ts) installs one backed by the browser engine. Nothing in
// src/core imports React or React Native, so the web entry stays framework-free.

/**
 * The JS ⇄ engine contract, as `Player` uses it: the TurboModule `Spec`
 * (src/native/NativeAnythingPlayer.ts) and the web module both satisfy it.
 */
export interface PlayerModule {
  createPlayer(options: object): string;
  releasePlayer(playerId: string): Promise<void>;
  load(playerId: string, source: object, options: object): Promise<object>;
  play(playerId: string): Promise<object>;
  pause(playerId: string): Promise<object>;
  stop(playerId: string): Promise<object>;
  reset(playerId: string): Promise<object>;
  seekTo(playerId: string, position: number): Promise<object>;
  setVolume(playerId: string, volume: number): Promise<object>;
  setMuted(playerId: string, muted: boolean): Promise<object>;
  setRate(playerId: string, rate: number): Promise<object>;
  updateNowPlaying(playerId: string, metadata: object): Promise<void>;
  getStatus(playerId: string): object;
  getProgress(playerId: string): object;
  getMetadata(playerId: string): object;
  getDiagnostics(playerId: string): object[];
  setDiagnosticsEnabled(playerId: string, enabled: boolean): void;
  setAudioSampling(playerId: string, enabled: boolean, points: number): boolean;
  showRoutePicker(playerId: string | null): Promise<void>;
  isRoutePickerAvailable(): boolean;
  getCastState(): object;
  configureCast(options: object): Promise<void>;
  showCastPicker(): Promise<void>;
  stopCasting(): Promise<void>;
  setCatalog(items: object[], options: object): Promise<void>;
  searchCatalog(request: object): Promise<object[]>;
  playFromSearch(request: object, playerId: string | null): Promise<object>;
  setSearchHandlerEnabled(enabled: boolean): void;
  resolveSearchRequest(requestId: string, result: object): void;
  onPlayerEvent(listener: (event: object) => void): { remove(): void };
}

export interface PlayerHost {
  /** The engine module. Throws when it is not available (e.g. Expo Go). */
  module(): PlayerModule;
  /** Calls `listener` whenever the app returns to the foreground. */
  onForeground(listener: () => void): void;
  /** Resolves `require('./file.mp3')` to a URI, or `null` when it cannot. */
  resolveAsset(module: number): string | null;
}

let installed: PlayerHost | null = null;

/** Installs the platform host. Each entry point calls it once, on import. */
export function installHost(next: PlayerHost): void {
  installed = next;
}

export function host(): PlayerHost {
  if (!installed)
    throw new Error(
      'react-native-anything-player: no platform host installed.'
    );
  return installed;
}
