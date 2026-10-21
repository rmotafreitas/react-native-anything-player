// The web module: the same contract as the TurboModule (see
// src/core/host.ts), implemented with the browser engine. Twin of
// `AnythingPlayerModule.kt` / `AnythingPlayerModule.mm`.
//
// Ordering, as native guarantees it: events are delivered asynchronously, in
// the order they were produced, and a command's promise settles after the
// events it caused.

import { PlayerError, toPlayerError } from '../../errors';
import type { PlayerModule } from '../../core/host';
import { browser } from './dom';
import { parseNowPlaying, parseOptions, parseSource } from './serialization';
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
  private readonly listeners = new Set<Listener>();
  private queue: object[] = [];
  private flushScheduled = false;
  private counter = 0;

  createPlayer(options: object): string {
    this.counter += 1;
    const id = `web-${this.counter}-${Date.now().toString(36)}`;
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
    const [descriptor, fields] = parseSource(source);
    const o = options as { autoplay?: unknown; startPosition?: unknown };
    try {
      controller.userGesture();
      const loaded = controller.load(
        descriptor,
        fields,
        typeof o.autoplay === 'boolean' ? o.autoplay : null,
        typeof o.startPosition === 'number' ? o.startPosition : null
      );
      // An autoplay refusal leaves the load ready-but-paused (see status.interruption).
      controller.takePlayAttempt();
      return loaded;
    } catch (error) {
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
    return this.command(playerId, (c) => c.engine.reset());
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

  onPlayerEvent(listener: Listener): { remove(): void } {
    this.listeners.add(listener);
    return { remove: () => this.listeners.delete(listener) };
  }

  // ── Internals ──

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

let shared: WebModule | null = null;

/** The page's web module, created on first use (importing touches no browser API). */
export function webModule(): WebModule {
  shared ??= new WebModule();
  return shared;
}
