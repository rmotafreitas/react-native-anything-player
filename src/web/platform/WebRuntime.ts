// Page-wide coordination shared by every player: connectivity, page
// visibility (the web's foreground) and the Media Session (one per page: the
// browser's lock screen, notification, media keys and headset controls).
// Twin of `AnythingPlayerRuntime.kt` / `AnythingPlayerRuntime.swift`.

import type { PlayerError } from '../../errors';
import type { NetworkState } from '../engine/types';
import {
  browser,
  type MediaSessionAction,
  type MediaSessionActionDetails,
  type MediaSessionLike,
} from './dom';
import type { PlayerRuntime, WebPlayerController } from './WebPlayerController';

/** Media Session actions → RNAP remote commands. */
const FORWARDED: Array<[MediaSessionAction, string]> = [
  ['nexttrack', 'next'],
  ['previoustrack', 'previous'],
  ['seekforward', 'skipForward'],
  ['seekbackward', 'skipBackward'],
];

export class WebRuntime implements PlayerRuntime {
  readonly players = new Map<string, WebPlayerController>();
  /** The player the system media controls show and control. */
  private active: WebPlayerController | null = null;
  private started = false;
  private network: NetworkState = 'unknown';
  private connectionType: string | undefined;
  private handlers = '';

  /** The player on the lock screen (Media Session), if any. */
  get activePlayer(): WebPlayerController | null {
    return this.active;
  }

  register(controller: WebPlayerController): void {
    this.start();
    this.players.set(controller.id, controller);
    controller.engine.networkChanged(this.network, false);
    // The system controls answer as soon as a player with a session exists:
    // a Play with nothing loaded is forwarded to the app (see `remote`).
    if (!this.active && controller.options.mediaSession) {
      this.active = controller;
      this.refreshSession();
    }
  }

  unregister(controller: WebPlayerController): void {
    this.players.delete(controller.id);
    if (this.active === controller) {
      this.active =
        [...this.players.values()]
          .reverse()
          .find((p) => p.options.mediaSession && p.status.state !== 'idle') ??
        null;
    }
    this.refreshSession();
  }

  // ── State fan-in ──

  onStatusChanged(controller: WebPlayerController): void {
    const status = controller.status;
    if (controller.options.mediaSession && status.playWhenReady)
      this.active = controller;
    if (
      this.active == null &&
      controller.options.mediaSession &&
      status.state !== 'idle'
    )
      this.active = controller;
    this.refreshSession();
  }

  onNowPlayingChanged(controller: WebPlayerController): void {
    if (controller === this.active) this.refreshSession();
  }

  // ── Connectivity & visibility ──

  private start(): void {
    if (this.started) return;
    this.started = true;
    const g = browser();
    if (g.navigator) this.network = g.navigator.onLine ? 'online' : 'offline';
    this.connectionType = g.navigator?.connection?.type;
    g.addEventListener?.('online', () => this.setNetwork('online', false));
    g.addEventListener?.('offline', () => this.setNetwork('offline', false));
    // Chromium on Android: a switch of the default network (Wi-Fi ↔ cellular).
    g.navigator?.connection?.addEventListener('change', () => {
      const type = g.navigator?.connection?.type;
      const changed = type !== this.connectionType;
      this.connectionType = type;
      if (changed && g.navigator?.onLine) this.setNetwork('online', true);
    });
    g.document?.addEventListener('visibilitychange', () => {
      if (g.document?.visibilityState === 'visible')
        this.players.forEach((p) => p.engine.appForegrounded());
    });
  }

  private setNetwork(state: NetworkState, handoff: boolean): void {
    this.network = state;
    this.players.forEach((p) => p.engine.networkChanged(state, handoff));
  }

  // ── Media session ──

  /** A command from the system media controls. */
  remote(command: string, position?: number): void {
    const target = this.active;
    if (!target) return;
    let nothingLoaded = false;
    try {
      switch (command) {
        case 'play':
          target.engine.play();
          break;
        case 'pause':
          target.engine.pause();
          break;
        case 'stop':
          target.engine.stop();
          break;
        case 'seek':
          if (position != null) target.engine.seek(position);
          break;
        default:
          // next / previous / skips have no meaning here: forwarded below.
          break;
      }
    } catch (error) {
      // Play with nothing loaded: only the app knows what to load.
      nothingLoaded = (error as PlayerError).code === 'NO_SOURCE';
    }
    if (nothingLoaded || target.options.remoteCommands.has(command))
      target.emitRemoteCommand(command, position);
  }

  private refreshSession(): void {
    const g = browser();
    const session = g.navigator?.mediaSession;
    if (!session) return;
    const target = this.active;
    this.installHandlers(target);
    if (!target) {
      session.playbackState = 'none';
      session.metadata = null;
      return;
    }
    const status = target.status;
    const info = target.nowPlaying();
    const wanted = status.playWhenReady ? 'playing' : 'paused';
    session.playbackState = status.state === 'idle' ? 'none' : wanted;
    session.metadata = g.MediaMetadata
      ? new g.MediaMetadata({
          title: info.title ?? undefined,
          artist: info.artist ?? undefined,
          album: info.album ?? undefined,
          artwork: info.artwork ? [{ src: info.artwork }] : [],
        })
      : null;
    try {
      if (info.track) {
        // The song, not the stream: a progress bar the browser advances while playing.
        session.setPositionState?.({
          duration: info.track.duration,
          position: Math.min(info.track.elapsed, info.track.duration),
          playbackRate: status.state === 'playing' ? 1 : 0,
        });
      } else if (status.seekable && status.duration != null) {
        const progress = target.driver.progress();
        session.setPositionState?.({
          duration: status.duration,
          position: Math.min(progress.position, status.duration),
          playbackRate: status.rate,
        });
      } else {
        session.setPositionState?.();
      }
    } catch {
      // Older browsers reject a position state they cannot show; it is cosmetic.
    }
  }

  private installHandlers(target: WebPlayerController | null): void {
    const session = browser().navigator?.mediaSession;
    if (!session) return;
    const seekable = target?.status.seekable ?? false;
    const forwarded = new Set(
      FORWARDED.filter(([, command]) =>
        target?.options.remoteCommands.has(command)
      ).map(([action]) => action)
    );
    const key = `${target?.id ?? ''}|${seekable}|${[...forwarded].join(',')}`;
    if (key === this.handlers) return;
    this.handlers = key;
    const handlers = new Map<MediaSessionAction, ActionHandler>();
    if (target) {
      handlers.set('play', () => this.remote('play'));
      handlers.set('pause', () => this.remote('pause'));
      handlers.set('stop', () => this.remote('stop'));
    }
    if (seekable) {
      handlers.set('seekto', (d) => {
        if (d.seekTime != null) this.remote('seek', d.seekTime);
      });
    }
    for (const [action, command] of FORWARDED) {
      if (forwarded.has(action))
        handlers.set(action, () => this.remote(command));
    }
    for (const action of ACTIONS)
      setHandler(session, action, handlers.get(action) ?? null);
  }
}

type ActionHandler = (details: MediaSessionActionDetails) => void;

const ACTIONS: MediaSessionAction[] = [
  'play',
  'pause',
  'stop',
  'seekto',
  ...FORWARDED.map(([action]) => action),
];

function setHandler(
  session: MediaSessionLike,
  action: MediaSessionAction,
  handler: ActionHandler | null
): void {
  try {
    session.setActionHandler(action, handler);
  } catch {
    // An action this browser does not support.
  }
}
