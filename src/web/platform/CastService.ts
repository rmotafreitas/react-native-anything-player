// Google Cast on the web: loads the Cast Web Sender SDK on demand and exposes
// its state. Chrome (desktop and Android) only, over HTTPS or localhost — the
// SDK does not exist anywhere else, and `configureCast` then settles with the
// state `unavailable` instead of failing. Sessions are handed to the players by
// `WebOutputs`; the playback itself is `CastDriver`.

import { PlayerError, toPlayerError } from '../../errors';
import type { CastState } from '../../types';
import {
  browser,
  type CastContextLike,
  type CastFrameworkLike,
  type CastSessionLike,
  type ChromeCastLike,
} from './dom';

const SDK_URL =
  'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
/** The SDK neither loaded nor failed after this long: Cast is not coming. */
const LOAD_TIMEOUT_MS = 15_000;
/** `endCurrentSession` settles with the SDK's session-ended event, within this. */
const END_TIMEOUT_MS = 3_000;

/** `cast.framework.CastState` → ours. */
const STATES: Record<string, CastState> = {
  NO_DEVICES_AVAILABLE: 'noDevices',
  NOT_CONNECTED: 'notConnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
};

/** A Cast receiver. */
export interface CastDevice {
  /** Stable per device: names the output (`cast:<id>`). */
  id: string;
  /** What the user sees ("Living Room TV"). */
  name: string;
}

/** What `CastService` tells `WebOutputs`. */
export interface CastServiceDelegate {
  /** The state or the device changed. */
  castStateChanged(): void;
  /** A session started, or was resumed after a page load. */
  castSessionStarted(device: CastDevice): void;
  /** The session ended, for whatever reason. */
  castSessionEnded(): void;
}

export interface CastSdk {
  framework: CastFrameworkLike;
  chrome: ChromeCastLike;
}

function unavailable(message: string): PlayerError {
  return new PlayerError({
    code: 'CAST_UNAVAILABLE',
    message,
    recoverable: false,
    platform: 'web',
  });
}

/** The receiver of a session, named by the SDK's own identifiers. */
export function deviceOf(session: CastSessionLike | null): CastDevice | null {
  const receiver = session?.getCastDevice();
  if (!receiver) return null;
  return {
    id: receiver.deviceId ?? receiver.label ?? receiver.friendlyName,
    name: receiver.friendlyName,
  };
}

/** Whether this browser can load the Cast SDK at all (it is Chrome's). */
function canLoadSdk(): boolean {
  const g = browser();
  if (!g.document?.head || g.isSecureContext === false) return false;
  const agent = g.navigator?.userAgent ?? '';
  return /Chrome\/|Chromium\/|Edg\//.test(agent) && !/CriOS|FxiOS/.test(agent);
}

export class CastService {
  delegate: CastServiceDelegate | null = null;
  state: CastState = 'unavailable';
  device: CastDevice | null = null;
  private starting: Promise<void> | null = null;
  private context: CastContextLike | null = null;
  private receiver: string | undefined;
  private readonly endWaiters = new Set<() => void>();

  /** Whether the SDK is loaded and Cast works (`showCastPicker` may be called). */
  get ready(): boolean {
    return this.context != null;
  }

  /** The loaded SDK's namespaces, if any. */
  sdk(): CastSdk | null {
    const g = browser();
    const framework = g.cast?.framework;
    const chrome = g.chrome?.cast;
    return framework && chrome ? { framework, chrome } : null;
  }

  /** The Cast session in progress, if any. */
  session(): CastSessionLike | null {
    return this.context?.getCurrentSession() ?? null;
  }

  /**
   * Loads the SDK (once) and resolves when Cast is usable, or settled as
   * `unavailable`. Never rejects.
   */
  configure(receiverApplicationId?: string): Promise<void> {
    if (receiverApplicationId) this.receiver = receiverApplicationId;
    if (this.starting) {
      if (this.context) this.applyOptions(this.context);
      return this.starting;
    }
    this.setState('initializing', null);
    this.starting = this.load().then((loaded) => {
      if (loaded && this.sdk()) this.initialize();
      else this.setState('unavailable', null);
    });
    return this.starting;
  }

  /** Opens the SDK's device chooser. Call it synchronously inside a click. */
  requestSession(): Promise<void> {
    const context = this.context;
    if (!context) {
      return Promise.reject(
        unavailable(
          'Google Cast is not ready: call configureCast() and wait for it, in Chrome over HTTPS.'
        )
      );
    }
    return context.requestSession().then(settle, (error: unknown) => {
      if (typeof error !== 'string') throw toPlayerError(error);
      settle(error);
    });
  }

  /** Ends the session and stops the receiver; resolves once it ended. */
  endSession(): Promise<void> {
    const context = this.context;
    if (!context?.getCurrentSession()) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = 0;
      const done = () => {
        browser().clearTimeout(timer);
        this.endWaiters.delete(done);
        resolve();
      };
      timer = browser().setTimeout(done, END_TIMEOUT_MS);
      this.endWaiters.add(done);
      context.endCurrentSession(true);
    });
  }

  // ── Loading ──

  private load(): Promise<boolean> {
    if (this.sdk()) return Promise.resolve(true);
    if (!canLoadSdk()) return Promise.resolve(false);
    const g = browser();
    return new Promise((resolve) => {
      const timer = g.setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
      const finish = (loaded: boolean) => {
        g.clearTimeout(timer);
        resolve(loaded);
      };
      g.__onGCastApiAvailable = finish;
      const script = g.document!.createElement('script');
      script.async = true;
      script.onerror = () => finish(false);
      script.src = SDK_URL;
      g.document!.head!.appendChild(script);
    });
  }

  private initialize(): void {
    const { framework } = this.sdk()!;
    const context = framework.CastContext.getInstance();
    this.applyOptions(context);
    context.addEventListener(
      framework.CastContextEventType.CAST_STATE_CHANGED,
      () => this.refresh()
    );
    context.addEventListener(
      framework.CastContextEventType.SESSION_STATE_CHANGED,
      (event: { sessionState: string }) => this.sessionChanged(event)
    );
    this.context = context;
    this.refresh();
    // A session joined from a previous page load, before we listened.
    const device = deviceOf(context.getCurrentSession());
    if (device) this.delegate?.castSessionStarted(device);
  }

  private applyOptions(context: CastContextLike): void {
    const { chrome } = this.sdk()!;
    context.setOptions({
      receiverApplicationId:
        this.receiver ?? chrome.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      // A page reload rejoins the session instead of dropping it.
      autoJoinPolicy: chrome.AutoJoinPolicy.ORIGIN_SCOPED,
    });
  }

  // ── State ──

  private sessionChanged(event: { sessionState: string }): void {
    this.refresh();
    const states = this.sdk()!.framework.SessionState;
    if (
      event.sessionState === states.SESSION_STARTED ||
      event.sessionState === states.SESSION_RESUMED
    ) {
      const device = deviceOf(this.session());
      if (device) this.delegate?.castSessionStarted(device);
    } else if (event.sessionState === states.SESSION_ENDED) {
      this.delegate?.castSessionEnded();
      [...this.endWaiters].forEach((done) => done());
    } else {
      // Starting, ending, failed to start: the state change says it all.
    }
  }

  /** Reads the SDK's state and the receiver of its session. */
  private refresh(): void {
    const context = this.context!;
    const state = STATES[context.getCastState()] ?? 'notConnected';
    const active = state === 'connecting' || state === 'connected';
    this.setState(state, active ? deviceOf(context.getCurrentSession()) : null);
  }

  private setState(state: CastState, device: CastDevice | null): void {
    const changed =
      state !== this.state ||
      device?.id !== this.device?.id ||
      device?.name !== this.device?.name;
    this.state = state;
    this.device = device;
    if (changed) this.delegate?.castStateChanged();
  }
}

/** A `requestSession` outcome: dismissing the chooser is not an error. */
function settle(code: string | undefined): void {
  if (code && code !== 'cancel')
    throw unavailable(`The Cast session could not start (${code}).`);
}
