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
  // A snapshot: a listener that re-subscribes during dispatch must not run again in this pass.
  const snapshot = [...listeners];
  for (const listener of snapshot) listener(event);
}
