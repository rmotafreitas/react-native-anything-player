// App-global features: the output picker, Google Cast and the voice catalog.
// They belong to the app, not to one player (iOS has one audio session, one
// Cast session, one Siri). Every platform implements them, the web included;
// see the Casting and AirPlay and the Voice assistants guides.

import { PlayerError, toPlayerError } from '../errors';
import { host } from './host';
import { onModuleEvent } from './moduleEvents';
import {
  ensureSubscription,
  normalizeNowPlaying,
  normalizeSource,
  type Player,
} from './Player';
import type {
  CastState,
  CatalogItem,
  CatalogOptions,
  SearchRequest,
  Source,
} from '../types';

const native = () => host().module();
const ignore = () => undefined;

async function run<T>(command: () => Promise<T>): Promise<T> {
  try {
    return await command();
  } catch (error) {
    throw toPlayerError(error);
  }
}

function invalid(message: string): PlayerError {
  return new PlayerError({
    code: 'INVALID_ARGUMENT',
    message,
    recoverable: false,
  });
}

// ── Output picker ──

/**
 * Opens the system's output picker: AirPlay and Bluetooth on iOS, the Output
 * Switcher on Android, AirPlay in Safari, Remote Playback in Chrome. `player`
 * (default: the one on the lock screen) is the one whose output changes on
 * the web. Rejects with `ROUTE_PICKER_UNAVAILABLE` where there is none.
 */
export function showRoutePicker(player?: Player): Promise<void> {
  return run(() => native().showRoutePicker(player?.id ?? null));
}

/** Whether {@link showRoutePicker} can open something here. */
export function isRoutePickerAvailable(): boolean {
  try {
    return native().isRoutePickerAvailable();
  } catch {
    return false;
  }
}

/**
 * Calls `listener` when {@link isRoutePickerAvailable} changes (Safari finds
 * or loses AirPlay receivers). Returns the unsubscribe function.
 */
export function addRoutePickerAvailabilityListener(
  listener: (available: boolean) => void
): () => void {
  ensureSubscription();
  return onModuleEvent((event) => {
    if (event.type === 'routePickerAvailability')
      listener(event.available === true);
  });
}

// ── Google Cast ──

/** The Cast state and the receiver in use. */
export interface CastStatus {
  /** See {@link CastState}. */
  state: CastState;
  /** The receiver's name while `connecting` or `connected`, else `null`. */
  device: string | null;
}

/** The current Cast state (`unavailable` where Cast is not built in or supported). */
export function getCastStatus(): CastStatus {
  try {
    const status = native().getCastState() as Partial<CastStatus>;
    return {
      state: status.state ?? 'unavailable',
      device: status.device ?? null,
    };
  } catch {
    return { state: 'unavailable', device: null };
  }
}

/** Calls `listener` on every Cast state change. Returns the unsubscribe function. */
export function addCastStateListener(
  listener: (status: CastStatus) => void
): () => void {
  ensureSubscription();
  return onModuleEvent((event) => {
    if (event.type !== 'castState') return;
    listener({
      state: event.state as CastState,
      device: (event.device as string | null | undefined) ?? null,
    });
  });
}

/** Options for {@link configureCast}. */
export interface CastConfiguration {
  /** Your Cast receiver's application id. Default: Google's Default Media Receiver. */
  receiverApplicationId?: string;
}

/**
 * Web: loads the Cast SDK (Chrome only) and resolves when it is ready; call it
 * early, before the user taps a Cast button. Native: resolves at once — the
 * receiver id is set at build time (the Expo plugin's `cast` option).
 */
export function configureCast(options: CastConfiguration = {}): Promise<void> {
  return run(() => native().configureCast({ ...options }));
}

/**
 * Opens the Cast device chooser (or, while casting, the dialog to stop).
 * Rejects with `CAST_UNAVAILABLE` where Cast is not available. On the web,
 * call it from a click.
 */
export function showCastPicker(): Promise<void> {
  return run(() => native().showCastPicker());
}

/** Ends the Cast session; the player returns to this device, paused. */
export function stopCasting(): Promise<void> {
  return run(() => native().stopCasting());
}

// ── Catalog & voice ──

/** What native stores for a catalog item: resolved artwork, normalized source. */
function serializeItem(item: CatalogItem): Record<string, unknown> {
  if (!item || typeof item.id !== 'string' || item.id.trim() === '')
    throw invalid('A catalog item needs a non-empty `id`.');
  if (typeof item.title !== 'string' || item.title.trim() === '')
    throw invalid(`Catalog item "${item.id}" needs a non-empty \`title\`.`);
  const source = normalizeSource(item.source);
  const shown = normalizeNowPlaying({
    title: item.title,
    artist: item.artist,
    album: item.album,
    artwork: item.artwork,
  });
  // The lock screen shows the item unless the source says otherwise.
  source.metadata = { ...shown, ...(source.metadata as object | undefined) };
  const out: Record<string, unknown> = {
    id: item.id,
    title: item.title,
    source,
    keywords: (item.keywords ?? []).filter((k) => typeof k === 'string'),
    kind: item.kind ?? 'station',
  };
  if (item.artist != null) out.artist = String(item.artist);
  if (item.album != null) out.album = String(item.album);
  if (item.genre != null) out.genre = String(item.genre);
  if (shown.artwork != null) out.artwork = shown.artwork;
  return out;
}

function deserializeItem(raw: unknown): CatalogItem {
  const item = raw as Record<string, unknown>;
  const out: CatalogItem = {
    id: item.id as string,
    title: item.title as string,
    source: item.source as Source,
    keywords: (item.keywords as string[] | undefined) ?? [],
    kind: (item.kind as CatalogItem['kind']) ?? 'station',
  };
  if (typeof item.artist === 'string') out.artist = item.artist;
  if (typeof item.album === 'string') out.album = item.album;
  if (typeof item.genre === 'string') out.genre = item.genre;
  if (typeof item.artwork === 'string') out.artwork = item.artwork;
  return out;
}

/** A search: what the user said, or a request with structured fields. */
export type SearchInput = string | Omit<SearchRequest, 'origin'>;

function serializeRequest(input: SearchInput): Record<string, unknown> {
  const request = typeof input === 'string' ? { query: input } : input;
  if (!request || typeof request.query !== 'string')
    throw invalid('A search request needs a `query` string (it may be empty).');
  const out: Record<string, unknown> = { query: request.query };
  for (const key of ['title', 'artist', 'album', 'genre', 'focus'] as const) {
    const value = request[key];
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

/**
 * Tells voice assistants (and {@link playFromSearch}) what the app can play.
 * Stored on the device, so Siri and Google Assistant find it even when the
 * app is not running; call it again whenever the list changes. Replaces the
 * previous catalog; `[]` clears it.
 */
export async function setCatalog(
  items: CatalogItem[],
  options: CatalogOptions = {}
): Promise<void> {
  if (!Array.isArray(items)) throw invalid('setCatalog expects an array.');
  const serialized = items.map(serializeItem);
  const ids = new Set(serialized.map((i) => i.id));
  if (ids.size !== serialized.length)
    throw invalid('Catalog item ids must be unique.');
  const nativeOptions: Record<string, unknown> = {
    playerId: options.playerId ?? 'default',
  };
  if (options.playerOptions)
    nativeOptions.playerOptions = options.playerOptions;
  await run(() => native().setCatalog(serialized, nativeOptions));
}

/** Searches the catalog as a voice request would; best match first. */
export async function searchCatalog(
  request: SearchInput
): Promise<CatalogItem[]> {
  const serialized = serializeRequest(request);
  const results = await run(() => native().searchCatalog(serialized));
  return results.map(deserializeItem);
}

/**
 * Searches and plays the best match, exactly as a voice request does: on
 * `player`, else the player on the lock screen, else the catalog's player
 * (created if needed). With nothing in the catalog matching, asks the
 * {@link setSearchHandler} handler. Resolves with what plays, or `null`.
 */
export async function playFromSearch(
  request: SearchInput,
  player?: Player
): Promise<CatalogItem | null> {
  const serialized = serializeRequest(request);
  const result = (await run(() =>
    native().playFromSearch(serialized, player?.id ?? null)
  )) as { item?: unknown };
  return result.item ? deserializeItem(result.item) : null;
}

/** Answers what the catalog does not have. */
export type SearchHandler = (
  request: SearchRequest
) => Promise<CatalogItem | null> | CatalogItem | null;

let searchHandler: SearchHandler | null = null;
let unsubscribeSearch: (() => void) | null = null;
/** How long native waits for the handler before giving up. */
const SEARCH_HANDLER_TIMEOUT_MS = 5000;

async function answer(
  requestId: string,
  request: SearchRequest
): Promise<void> {
  let item: Record<string, unknown> | null = null;
  try {
    const found = searchHandler
      ? await Promise.race([
          Promise.resolve(searchHandler(request)),
          new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), SEARCH_HANDLER_TIMEOUT_MS)
          ),
        ])
      : null;
    item = found ? serializeItem(found) : null;
  } catch (error) {
    // A failing handler answers "nothing found"; the error is still reported.
    setTimeout(() => {
      throw error;
    }, 0);
  }
  native().resolveSearchRequest(requestId, { item });
}

/**
 * Called when a voice request (or {@link playFromSearch}) finds nothing in the
 * catalog while the app is running: return an item to play, or `null`. Answer
 * within 5 s. Pass `null` to remove it.
 */
export function setSearchHandler(handler: SearchHandler | null): void {
  searchHandler = handler;
  if (handler && !unsubscribeSearch) {
    ensureSubscription();
    unsubscribeSearch = onModuleEvent((event) => {
      if (event.type === 'searchRequest')
        answer(event.requestId as string, event.request as SearchRequest).catch(
          ignore
        );
    });
  } else if (!handler && unsubscribeSearch) {
    unsubscribeSearch();
    unsubscribeSearch = null;
  } else {
    // Replacing one handler with another keeps the subscription.
  }
  native().setSearchHandlerEnabled(handler != null);
}
