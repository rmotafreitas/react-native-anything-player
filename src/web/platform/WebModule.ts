// The web module: the same contract as the TurboModule (see
// src/core/host.ts), implemented with the browser engine. Twin of
// `AnythingPlayerModule.kt` / `AnythingPlayerModule.mm`.
//
// Ordering, as native guarantees it: events are delivered asynchronously, in
// the order they were produced, and a command's promise settles after the
// events it caused.

import { PlayerError, toPlayerError } from '../../errors';
import type { PlayerModule } from '../../core/host';
import { detectCharset } from '../../core/subtitles/charset';
import { browser } from './dom';
import {
  parseFade,
  parseNowPlaying,
  parseOptions,
  parseSource,
  parseVideoParts,
} from './serialization';
import type { ContentFit } from './WebVideo';
import { WebCatalog, type StoredItem } from './WebCatalog';
import { WebOutputs } from './WebOutputs';
import { WebPlayerController } from './WebPlayerController';
import { WebRuntime } from './WebRuntime';

type Listener = (event: object) => void;

function released(): PlayerError {
  return new PlayerError({
    code: 'PLAYER_RELEASED',
    message: 'The player was released.',
    recoverable: false,
    platform: 'web',
  });
}

function autoplayBlocked(): PlayerError {
  return new PlayerError({
    code: 'AUTOPLAY_BLOCKED',
    message:
      'The browser blocked playback that did not start from a user gesture. Call play() from a tap or click.',
    recoverable: true,
    platform: 'web',
  });
}

function asError(error: unknown): PlayerError {
  return error instanceof PlayerError ? error : toPlayerError(error);
}

export class WebModule implements PlayerModule {
  private readonly runtime = new WebRuntime();
  private readonly outputs = new WebOutputs(this.runtime, (event) =>
    this.emit(event)
  );
  private readonly catalog = new WebCatalog();
  private readonly listeners = new Set<Listener>();
  private queue: object[] = [];
  private flushScheduled = false;
  private counter = 0;

  createPlayer(options: object): string {
    const requested = (options as { id?: unknown }).id;
    // An id that already exists attaches to that player.
    if (typeof requested === 'string' && this.runtime.players.has(requested))
      return requested;
    this.counter += 1;
    const id =
      typeof requested === 'string'
        ? requested
        : `web-${this.counter}-${Date.now().toString(36)}`;
    const controller = new WebPlayerController(
      id,
      parseOptions(options),
      this.runtime,
      (event) => this.emit(event)
    );
    this.runtime.register(controller);
    return id;
  }

  async releasePlayer(playerId: string): Promise<void> {
    const controller = this.runtime.players.get(playerId);
    if (!controller) return;
    controller.release();
    this.runtime.unregister(controller);
  }

  load(playerId: string, source: object, options: object): Promise<object> {
    const controller = this.runtime.players.get(playerId);
    if (!controller) return Promise.reject(released());
    // A picked file: the item plays from an object URL the controller owns.
    const blob = (source as { blob?: unknown }).blob;
    const objectUrl = blob == null ? null : browser().URL.createObjectURL(blob);
    try {
      const [descriptor, fields] = parseSource(
        objectUrl == null ? source : { ...source, uri: objectUrl }
      );
      const o = options as { autoplay?: unknown; startPosition?: unknown };
      controller.userGesture();
      const loaded = controller.load(
        descriptor,
        fields,
        typeof o.autoplay === 'boolean' ? o.autoplay : null,
        typeof o.startPosition === 'number' ? o.startPosition : null,
        objectUrl,
        parseVideoParts(source)
      );
      // An autoplay refusal leaves the load ready-but-paused (see status.interruption).
      controller.takePlayAttempt();
      return loaded;
    } catch (error) {
      if (objectUrl != null) browser().URL.revokeObjectURL(objectUrl);
      return Promise.reject(asError(error));
    }
  }

  play(playerId: string): Promise<object> {
    return this.command(playerId, (c) => {
      c.userGesture();
      c.engine.play();
    });
  }

  pause(playerId: string): Promise<object> {
    return this.command(playerId, (c) => c.engine.pause());
  }

  stop(playerId: string): Promise<object> {
    return this.command(playerId, (c) => c.engine.stop());
  }

  reset(playerId: string): Promise<object> {
    return this.command(playerId, (c) => c.reset());
  }

  seekTo(playerId: string, position: number): Promise<object> {
    return this.command(playerId, (c) => c.engine.seek(position));
  }

  setVolume(playerId: string, volume: number): Promise<object> {
    return this.command(playerId, (c) => c.engine.setVolume(volume));
  }

  setMuted(playerId: string, muted: boolean): Promise<object> {
    return this.command(playerId, (c) => c.engine.setMuted(muted));
  }

  setRate(playerId: string, rate: number): Promise<object> {
    return this.command(playerId, (c) => c.engine.setRate(rate));
  }

  fadeTo(playerId: string, volume: number, seconds: number): Promise<object> {
    const controller = this.runtime.players.get(playerId);
    if (!controller) return Promise.reject(released());
    return new Promise((resolve, reject) => {
      try {
        controller.engine.fadeTo(volume, seconds * 1000, () => {
          // Settle after the status the fade implies was delivered.
          browser().setTimeout(() => resolve(controller.statusMap()), 0);
        });
      } catch (error) {
        reject(asError(error));
      }
    });
  }

  sleep(playerId: string, timer: object): Promise<object> {
    const t = timer as { after?: unknown; fadeOut?: unknown };
    const after = typeof t.after === 'number' ? t.after * 1000 : null;
    const fadeOut = typeof t.fadeOut === 'number' ? t.fadeOut * 1000 : null;
    return this.command(playerId, (c) => c.engine.sleep(after, fadeOut));
  }

  setFade(playerId: string, fade: object): Promise<object> {
    const { fadeInMs, fadeOutMs } = parseFade(fade);
    return this.command(playerId, (c) =>
      c.engine.setFades(fadeInMs, fadeOutMs)
    );
  }

  async updateNowPlaying(playerId: string, metadata: object): Promise<void> {
    const controller = this.runtime.players.get(playerId);
    if (!controller) throw released();
    controller.updateNowPlaying(parseNowPlaying(metadata));
  }

  getStatus(playerId: string): object {
    const controller = this.runtime.players.get(playerId);
    if (!controller) throw released();
    return controller.statusMap();
  }

  getProgress(playerId: string): object {
    const controller = this.runtime.players.get(playerId);
    if (!controller) throw released();
    return controller.progressMap();
  }

  getMetadata(playerId: string): object {
    return (
      this.runtime.players.get(playerId)?.metadataMap() ?? { metadata: null }
    );
  }

  getDiagnostics(playerId: string): object[] {
    return this.runtime.players.get(playerId)?.diagnosticsArray() ?? [];
  }

  setDiagnosticsEnabled(playerId: string, enabled: boolean): void {
    const controller = this.runtime.players.get(playerId);
    if (controller) controller.diagnosticsEnabled = enabled;
  }

  setAudioSampling(
    playerId: string,
    enabled: boolean,
    points: number
  ): boolean {
    return (
      this.runtime.players.get(playerId)?.setAudioSampling(enabled, points) ??
      false
    );
  }

  // ── Outputs ──

  showRoutePicker(playerId: string | null): Promise<void> {
    if (playerId != null && !this.runtime.players.has(playerId))
      return Promise.reject(released());
    // Browsers open their pickers only inside the gesture: no await before it.
    return this.outputs.showRoutePicker(playerId);
  }

  isRoutePickerAvailable(): boolean {
    return this.outputs.isRoutePickerAvailable();
  }

  // ── Google Cast ──

  getCastState(): object {
    return this.outputs.getCastState();
  }

  configureCast(options: object = {}): Promise<void> {
    const id = (options as { receiverApplicationId?: unknown })
      .receiverApplicationId;
    return this.runtime.cast.configure(typeof id === 'string' ? id : undefined);
  }

  showCastPicker(): Promise<void> {
    // `requestSession` must be called inside the click, not after an await.
    return this.runtime.cast.requestSession();
  }

  stopCasting(): Promise<void> {
    return this.runtime.cast.endSession();
  }

  // ── Catalog ──

  async setCatalog(items: object[], options: object): Promise<void> {
    this.catalog.set(items, options);
  }

  async setFavorites(ids: string[]): Promise<void> {
    this.catalog.favoriteIds = ids.filter((id) =>
      this.catalog.items.some((item) => item.id === id)
    );
  }

  async searchCatalog(request: object): Promise<object[]> {
    return this.catalog.search(request as { query: string });
  }

  async playFromSearch(
    request: object,
    playerId: string | null
  ): Promise<object> {
    const spoken = (request as { query?: unknown }).query;
    let query = '';
    if (spoken != null)
      query = typeof spoken === 'string' ? spoken : JSON.stringify(spoken);
    const asked = {
      ...(request as Record<string, unknown>),
      query,
      origin: 'app',
    };
    let item = this.catalog.resolve(asked);
    if (!item && this.catalog.handlerEnabled)
      item = await this.catalog.ask(asked, (event) => this.emit(event));
    if (!item) return { item: null };
    await this.playItem(this.voicePlayer(playerId), item, asked);
    return { item };
  }

  setSearchHandlerEnabled(enabled: boolean): void {
    this.catalog.handlerEnabled = enabled;
  }

  resolveSearchRequest(requestId: string, result: object): void {
    this.catalog.answer(requestId, result);
  }

  // ── Video ──

  videoCommand(playerId: string, command: object): Promise<object> {
    const controller = this.runtime.players.get(playerId);
    if (!controller) return Promise.reject(released());
    let result: Promise<void> | void;
    try {
      // Synchronously: fullscreen and Picture in Picture need the user's tap.
      result = controller.videoCommand(command as Record<string, unknown>);
    } catch (error) {
      return Promise.reject(asError(error));
    }
    return Promise.resolve(result).then(
      () => controller.statusMap(),
      (error: unknown) => {
        throw asError(error);
      }
    );
  }

  getVideoStats(playerId: string): object {
    const controller = this.runtime.players.get(playerId);
    if (!controller) throw released();
    return controller.statsMap();
  }

  /** Puts a video player's picture in a page element (`attachTo`, `<VideoView>`). */
  attachVideo(
    playerId: string,
    element: unknown,
    fit?: ContentFit,
    controls = false
  ): void {
    const controller = this.runtime.players.get(playerId);
    if (!controller) throw released();
    controller.attachVideo(element, fit, controls);
  }

  async fetchText(
    uri: string,
    headers: object,
    encoding: string | null
  ): Promise<object> {
    const g = browser();
    let response;
    try {
      response = await g.fetch(uri, {
        headers: headers as Record<string, string>,
        cache: 'default',
        mode: 'cors',
      });
    } catch (error) {
      throw new PlayerError({
        code: 'NETWORK_ERROR',
        message: `${uri} could not be fetched (${String(error)}).`,
        recoverable: true,
        platform: 'web',
      });
    }
    if (!response.ok) {
      throw new PlayerError({
        code: 'HTTP_ERROR',
        message: `The server returned HTTP ${response.status} for ${uri}.`,
        recoverable: response.status >= 500,
        httpStatus: response.status,
        platform: 'web',
      });
    }
    const bytes = new Uint8Array(await response.arrayBuffer!());
    const charset = encoding ?? detectCharset(bytes);
    return { text: decode(bytes, charset), charset };
  }

  onPlayerEvent(listener: Listener): { remove(): void } {
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }

  // ── Internals ──

  /** The given player, else the one on the lock screen, else the catalog's (created). */
  private voicePlayer(playerId: string | null): WebPlayerController {
    if (playerId != null) {
      const given = this.runtime.players.get(playerId);
      if (!given) throw released();
      return given;
    }
    const active = this.runtime.activePlayer;
    if (active) return active;
    const id = this.createPlayer({
      ...this.catalog.playerOptions,
      id: this.catalog.playerId,
    });
    return this.runtime.players.get(id)!;
  }

  private async playItem(
    controller: WebPlayerController,
    item: StoredItem,
    request: Record<string, unknown>
  ): Promise<void> {
    const [descriptor, fields] = parseSource(item.source);
    controller.userGesture();
    const loaded = controller.load(descriptor, fields, true, null);
    controller.takePlayAttempt();
    this.catalog.played(item);
    this.emit({ playerId: controller.id, type: 'searchPlay', request, item });
    await loaded;
  }

  /**
   * Runs a command (synchronously: a play() must stay inside the user's tap),
   * then resolves with the status after it — or rejects with
   * `AUTOPLAY_BLOCKED` if the browser refused the play() it made.
   */
  private async command(
    playerId: string,
    block: (controller: WebPlayerController) => void
  ): Promise<object> {
    const controller = this.runtime.players.get(playerId);
    if (!controller) throw released();
    // A play() started outside a command (media keys, system resume) is nobody's to report.
    controller.takePlayAttempt();
    try {
      block(controller);
    } catch (error) {
      throw asError(error);
    }
    const attempt = controller.takePlayAttempt();
    // A refusal comes back as an already-rejected play(): one task is enough
    // to see it. Never wait for the audio itself (a dead network would hang).
    if (attempt) {
      const outcome = await Promise.race([
        attempt,
        new Promise<'pending'>((resolve) =>
          browser().setTimeout(() => resolve('pending'), 0)
        ),
      ]);
      if (outcome === 'blocked') throw autoplayBlocked();
    }
    return controller.statusMap();
  }

  private emit(event: object): void {
    this.queue.push(event);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    browser().queueMicrotask(() => {
      this.flushScheduled = false;
      const events = this.queue;
      this.queue = [];
      for (const e of events) this.listeners.forEach((listener) => listener(e));
    });
  }
}

/** Decodes in the given encoding (UTF-8 when the browser does not know it). */
function decode(bytes: Uint8Array, charset: string): string {
  const Decoder = browser().TextDecoder;
  if (!Decoder) return String.fromCodePoint(...bytes);
  try {
    return new Decoder(charset).decode(bytes);
  } catch {
    return new Decoder('utf-8').decode(bytes);
  }
}

let shared: WebModule | null = null;

/** The page's web module, created on first use (importing touches no browser API). */
export function webModule(): WebModule {
  shared ??= new WebModule();
  return shared;
}
