// React hooks over `Player` and the app-global state. React only: no React
// Native import, so the React Native entry (src/hooks.ts) and the React DOM
// entry (src/react) share them. Foreground state comes from the platform
// host (AppState on React Native, page visibility on the web).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { host } from './host';
import type { Player } from './Player';
import {
  addCastStateListener,
  addRoutePickerAvailabilityListener,
  getCastStatus,
  isRoutePickerAvailable,
  type CastStatus,
} from './system';
import type {
  MediaMetadata,
  PlaybackState,
  PlayerEvent,
  PlayerEventMap,
  PlayerStatus,
  Progress,
  AudioRouteKind,
} from '../types';

/** The player's status; re-renders on every change. */
export function usePlayerStatus(player: Player): PlayerStatus {
  const subscribe = useCallback(
    (onChange: () => void) => player.on('status', onChange),
    [player]
  );
  const read = () => player.status;
  return useSyncExternalStore(subscribe, read, read);
}

/** Just the playback state (re-renders only when it changes). */
export function usePlaybackState(player: Player): PlaybackState {
  const subscribe = useCallback(
    (onChange: () => void) => player.on('stateChange', onChange),
    [player]
  );
  const read = () => player.state;
  return useSyncExternalStore(subscribe, read, read);
}

/** The latest stream metadata (ICY / ID3 / timed metadata). */
export function useStreamMetadata(player: Player): MediaMetadata | null {
  const subscribe = useCallback(
    (onChange: () => void) => player.on('metadata', onChange),
    [player]
  );
  const read = () => player.metadata;
  return useSyncExternalStore(subscribe, read, read);
}

const EMPTY_PROGRESS: Progress = {
  position: 0,
  duration: null,
  buffered: 0,
  bufferedAhead: 0,
  liveOffset: null,
  timestamp: 0,
};

/**
 * Position/duration/buffer, polled from native every `intervalMs` while the
 * app is in the foreground. No progress events are needed: the reading
 * is a synchronous JSI call against a native clock, so it is correct even
 * right after JS was frozen in the background.
 */
export function useProgress(player: Player, intervalMs = 1000): Progress {
  const [progress, setProgress] = useState<Progress>(() =>
    player.isReleased ? EMPTY_PROGRESS : player.getProgress()
  );
  // The timer is allocated by start() and cleared by stop() and the effect
  // cleanup; the analyzer cannot follow this foreground/background ownership.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (player.isReleased) return undefined;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => {
      if (!player.isReleased) setProgress(player.getProgress());
    };
    const start = () => {
      if (timer == null) {
        tick();
        timer = setInterval(tick, Math.max(16, intervalMs));
      }
    };
    const stop = () => {
      if (timer != null) clearInterval(timer);
      timer = null;
    };
    if (host().isForeground()) start();
    const foreground = host().onForegroundChange((active) =>
      active ? start() : stop()
    );
    const seek = player.on('status', tick);
    return () => {
      if (timer != null) clearInterval(timer);
      foreground();
      seek();
    };
  }, [player, intervalMs]);
  return progress;
}

/** What {@link useSleepTimer} returns. */
export interface SleepTimerState {
  /** Epoch ms when the timer pauses the player (`status.sleepAt`), or `null`. */
  sleepAt: number | null;
  /** Whole seconds left, counted down while the app is in the foreground; `null` without a timer. */
  remaining: number | null;
}

/**
 * The sleep timer (`Player.sleep`) and the seconds left on it, updated every
 * second while a timer is set and the app is in the foreground. The timer
 * itself runs natively; this only shows it.
 */
export function useSleepTimer(player: Player): SleepTimerState {
  const subscribe = useCallback(
    (onChange: () => void) => player.on('status', onChange),
    [player]
  );
  const read = () => player.status.sleepAt ?? null;
  const sleepAt = useSyncExternalStore(subscribe, read, read);
  const [now, setNow] = useState(() => Date.now());
  // The timer is allocated by start() and cleared by stop() and the effect
  // cleanup, as in useProgress.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (sleepAt == null) return undefined;
    let timer: ReturnType<typeof setInterval> | null = null;
    const tick = () => setNow(Date.now());
    const start = () => {
      if (timer != null) return;
      tick();
      timer = setInterval(tick, 1000);
    };
    const stop = () => {
      if (timer != null) clearInterval(timer);
      timer = null;
    };
    if (host().isForeground()) start();
    const foreground = host().onForegroundChange((active) =>
      active ? start() : stop()
    );
    return () => {
      stop();
      foreground();
    };
  }, [sleepAt]);
  const remaining =
    sleepAt == null ? null : Math.max(0, Math.ceil((sleepAt - now) / 1000));
  return { sleepAt, remaining };
}

/** Subscribes to a player event for the component's lifetime. */
export function usePlayerEvent<E extends PlayerEvent>(
  player: Player,
  event: E,
  handler: PlayerEventMap[E]
): void {
  const ref = useRef(handler);
  useLayoutEffect(() => {
    ref.current = handler;
  }, [handler]);
  useEffect(() => {
    const unsubscribe = player.on(event, ((...args: unknown[]) =>
      (ref.current as (...a: unknown[]) => void)(
        ...args
      )) as PlayerEventMap[E]);
    return () => unsubscribe();
  }, [player, event]);
}

/** The latest Cast snapshot (stable identity while nothing changes). */
let castSnapshot: CastStatus | null = null;

function currentCastStatus(): CastStatus {
  const next = getCastStatus();
  if (castSnapshot?.state !== next.state || castSnapshot.device !== next.device)
    castSnapshot = next;
  return castSnapshot;
}

const SERVER_CAST: CastStatus = { state: 'unavailable', device: null };
const serverCast = () => SERVER_CAST;

const subscribeCast = (onChange: () => void) =>
  addCastStateListener(() => onChange());

/** The Google Cast state and receiver; re-renders on every change. */
export function useCastStatus(): CastStatus {
  return useSyncExternalStore(subscribeCast, currentCastStatus, serverCast);
}

const subscribeRoutePicker = (onChange: () => void) =>
  addRoutePickerAvailabilityListener(() => onChange());

/** Whether the system output picker can be opened here (see `showRoutePicker`). */
export function useRoutePickerAvailable(): boolean {
  return useSyncExternalStore(
    subscribeRoutePicker,
    isRoutePickerAvailable,
    () => false
  );
}

const REMOTE: ReadonlySet<AudioRouteKind> = new Set<AudioRouteKind>([
  'airplay',
  'bluetooth',
  'cast',
  'car',
]);

/** @internal Whether `player` plays on another device (`false` without one). */
export function usePlaysElsewhere(player: Player | undefined): boolean {
  const subscribe = useCallback(
    (onChange: () => void) =>
      player ? player.on('routeChange', onChange) : () => undefined,
    [player]
  );
  const read = () => player?.status.route.kind ?? null;
  const kind = useSyncExternalStore(subscribe, read, read);
  return kind != null && REMOTE.has(kind);
}
