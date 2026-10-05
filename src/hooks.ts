import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { AppState } from 'react-native';
import type { Player } from './Player';
import type {
  MediaMetadata,
  PlaybackState,
  PlayerEvent,
  PlayerEventMap,
  PlayerStatus,
  Progress,
} from './types';

/** The player's status; re-renders on every change. */
export function usePlayerStatus(player: Player): PlayerStatus {
  const subscribe = useCallback(
    (onChange: () => void) => player.on('status', onChange),
    [player]
  );
  return useSyncExternalStore(subscribe, () => player.status);
}

/** Just the playback state (re-renders only when it changes). */
export function usePlaybackState(player: Player): PlaybackState {
  const subscribe = useCallback(
    (onChange: () => void) => player.on('stateChange', onChange),
    [player]
  );
  return useSyncExternalStore(subscribe, () => player.state);
}

/** The latest stream metadata (ICY / ID3 / timed metadata). */
export function useStreamMetadata(player: Player): MediaMetadata | null {
  const subscribe = useCallback(
    (onChange: () => void) => player.on('metadata', onChange),
    [player]
  );
  return useSyncExternalStore(subscribe, () => player.metadata);
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
    if (AppState.currentState !== 'background') start();
    const appState = AppState.addEventListener('change', (state) =>
      state === 'active' ? start() : stop()
    );
    const seek = player.on('status', tick);
    return () => {
      stop();
      appState.remove();
      seek();
    };
  }, [player, intervalMs]);
  return progress;
}

/** Subscribes to a player event for the component's lifetime. */
export function usePlayerEvent<E extends PlayerEvent>(
  player: Player,
  event: E,
  handler: PlayerEventMap[E]
): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(
    () =>
      player.on(event, ((...args: unknown[]) =>
        (ref.current as (...a: unknown[]) => void)(
          ...args
        )) as PlayerEventMap[E]),
    [player, event]
  );
}
