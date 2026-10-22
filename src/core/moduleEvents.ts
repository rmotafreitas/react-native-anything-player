// Events the engine module sends that belong to no player: Cast state,
// route-picker availability and voice search requests (see src/core/system.ts).

type ModuleListener = (event: Record<string, unknown>) => void;

const listeners = new Set<ModuleListener>();

/** Subscribes to app-global module events; returns the unsubscribe function. */
export function onModuleEvent(listener: ModuleListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** @internal Called for every module event without a `playerId`. */
export function dispatchModuleEvent(event: Record<string, unknown>): void {
  for (const listener of [...listeners]) listener(event);
}
