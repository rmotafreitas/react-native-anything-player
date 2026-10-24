// What the browser itself knows about where an <audio> element plays: Safari's
// AirPlay (the `webkit…` target API) and Chrome's Remote Playback API. One per
// player; it follows the player's element, which the driver may replace.
//
// This is the *browser* casting the element (AirPlay, or Chrome's "Cast tab"
// style Remote Playback). Our own Google Cast sender is `CastDriver`; the two
// are independent routes.

import { PlayerError } from '../../errors';
import type { AudioRoute } from '../engine/types';
import {
  browser,
  type AbortControllerLike,
  type AudioElementLike,
  type RemotePlaybackLike,
} from './dom';

const LOCAL: AudioRoute = { kind: 'unknown', name: null };

function causeText(cause: unknown): string | undefined {
  if (typeof cause === 'string') return cause;
  if (cause instanceof Error) return String(cause);
  if (cause != null) return JSON.stringify(cause);
  return undefined;
}

function pickerUnavailable(message: string, cause?: unknown): PlayerError {
  return new PlayerError({
    code: 'ROUTE_PICKER_UNAVAILABLE',
    message,
    recoverable: false,
    platform: 'web',
    cause: causeText(cause),
  });
}

/** A rejected `remote.prompt()` that only means the user closed the picker. */
function dismissed(error: unknown): boolean {
  const { name, message } = error as { name?: string; message?: string };
  return (
    name === 'AbortError' ||
    (name === 'NotAllowedError' && /dismiss|cancel/i.test(message ?? ''))
  );
}

export class ElementRoute {
  private element: AudioElementLike | null = null;
  private listeners: AbortControllerLike | null = null;
  private airplayTargets = false;
  private remoteTargets = false;
  private watchId: Promise<number | null> | null = null;
  private watched: RemotePlaybackLike | null = null;

  /** `onChange` runs when the route or the availability may have changed. */
  constructor(private readonly onChange: () => void) {}

  /** Follows `element` (and stops following the previous one). */
  attach(element: AudioElementLike): void {
    this.detach();
    this.element = element;
    const listeners = new (browser().AbortController)();
    this.listeners = listeners;
    const on = (type: string, handler: (event: any) => void) =>
      element.addEventListener(type, handler, { signal: listeners.signal });
    on('webkitcurrentplaybacktargetiswirelesschanged', () => this.onChange());
    on('webkitplaybacktargetavailabilitychanged', (event) => {
      this.airplayTargets = event.availability === 'available';
      this.onChange();
    });
    const remote = element.remote;
    if (remote) {
      for (const type of ['connecting', 'connect', 'disconnect']) {
        remote.addEventListener(type, () => this.onChange(), {
          signal: listeners.signal,
        });
      }
      this.watched = remote;
      this.watchId = remote
        .watchAvailability((available) => {
          this.remoteTargets = available;
          this.onChange();
        })
        // Some browsers refuse to watch (disableRemotePlayback, no support).
        .catch(() => null);
    }
    this.onChange();
  }

  detach(): void {
    this.listeners?.abort();
    this.listeners = null;
    const watched = this.watched;
    const id = this.watchId;
    if (watched && id) {
      id.then((value) =>
        value == null ? undefined : watched.cancelWatchAvailability(value)
      ).catch(() => undefined);
    }
    this.watched = null;
    this.watchId = null;
    this.element = null;
    this.airplayTargets = false;
    this.remoteTargets = false;
  }

  /** Where the element plays now, as far as the browser tells. */
  get route(): AudioRoute {
    const element = this.element;
    if (element?.webkitCurrentPlaybackTargetIsWireless === true)
      return { kind: 'airplay', name: null };
    if (element?.remote?.state === 'connected')
      return { kind: 'cast', name: null };
    return LOCAL;
  }

  /**
   * Whether the browser has a receiver to offer. `streamed`: the item plays
   * from a `blob:` MediaSource. A Remote Playback receiver cannot fetch a
   * blob, so Chrome has nothing to offer for it (a stream read through MSE is
   * cast with Google Cast instead); Safari plays an alternative URL instead.
   */
  available(streamed: boolean): boolean {
    return this.airplayTargets || (this.remoteTargets && !streamed);
  }

  /**
   * Opens the browser's picker. Call it synchronously inside the user's
   * gesture: both APIs refuse otherwise.
   */
  showPicker(streamed: boolean): Promise<void> {
    const element = this.element;
    if (
      element &&
      typeof element.webkitShowPlaybackTargetPicker === 'function'
    ) {
      element.webkitShowPlaybackTargetPicker();
      return Promise.resolve();
    }
    const remote = element?.remote;
    if (!remote || typeof remote.prompt !== 'function') {
      return Promise.reject(
        pickerUnavailable('This browser has no output picker.')
      );
    }
    if (streamed) {
      return Promise.reject(
        pickerUnavailable(
          'Chrome cannot send a stream read through MSE to a receiver; use Google Cast.'
        )
      );
    }
    return remote.prompt().catch((error: unknown) => {
      if (dismissed(error)) return;
      throw pickerUnavailable('The browser could not open its picker.', error);
    });
  }
}
