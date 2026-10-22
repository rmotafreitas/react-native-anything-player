// The catalog `playFromSearch()` searches. On the web it lives in the page's
// memory: no assistant starts a page cold. Twin of the native catalog stores
// (`CatalogStore.kt`, `CatalogStore.swift`); the matcher is shared
// (src/core/catalog.ts).

import { searchCatalog, type CatalogQuery } from '../../core/catalog';
import { browser } from './dom';

/** A catalog item as JS serialized it (src/core/system.ts). */
export interface StoredItem {
  id: string;
  title: string;
  artist?: string;
  album?: string;
  genre?: string;
  group?: string;
  artwork?: string;
  keywords: string[];
  kind: string;
  source: Record<string, unknown>;
}

/** How long the app's search handler may take to answer. */
const HANDLER_TIMEOUT_MS = 5500;

export class WebCatalog {
  items: StoredItem[] = [];
  /** The player voice requests use when the page has none. */
  playerId = 'default';
  playerOptions: Record<string, unknown> = {};
  /** Whether the app answers what the catalog does not have. */
  handlerEnabled = false;
  /** The ids of the favorites (`browse.favorites`, `setFavorites`); the web has no browse surface, it only keeps them. */
  favoriteIds: string[] = [];
  private lastPlayedId: string | null = null;
  private readonly pending = new Map<
    string,
    (item: StoredItem | null) => void
  >();
  private counter = 0;

  set(items: object[], options: object): void {
    this.items = items as StoredItem[];
    const o = options as {
      playerId?: unknown;
      playerOptions?: unknown;
      browse?: { favorites?: unknown };
    };
    if (Array.isArray(o.browse?.favorites))
      this.favoriteIds = o.browse.favorites.filter(
        (id): id is string => typeof id === 'string'
      );
    this.playerId = typeof o.playerId === 'string' ? o.playerId : 'default';
    this.playerOptions =
      o.playerOptions && typeof o.playerOptions === 'object'
        ? { ...(o.playerOptions as Record<string, unknown>) }
        : {};
  }

  search(request: CatalogQuery): StoredItem[] {
    return searchCatalog(this.items, request).matches.map(
      (index) => this.items[index]!
    );
  }

  /** The best match; for a request with nothing in it, the last item played (else the first). */
  resolve(request: CatalogQuery): StoredItem | null {
    const outcome = searchCatalog(this.items, request);
    const best = outcome.matches[0];
    if (best != null) return this.items[best]!;
    if (!outcome.emptyQuery) return null;
    return (
      this.items.find((item) => item.id === this.lastPlayedId) ??
      this.items[0] ??
      null
    );
  }

  played(item: StoredItem): void {
    this.lastPlayedId = item.id;
  }

  /** Asks the app's search handler (a `searchRequest` event) and waits for its answer. */
  ask(
    request: Record<string, unknown>,
    emit: (event: object) => void
  ): Promise<StoredItem | null> {
    this.counter += 1;
    const requestId = `search-${this.counter}`;
    return new Promise((resolve) => {
      const timer = browser().setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, HANDLER_TIMEOUT_MS);
      this.pending.set(requestId, (item) => {
        browser().clearTimeout(timer);
        resolve(item);
      });
      emit({ type: 'searchRequest', requestId, request });
    });
  }

  answer(requestId: string, result: object): void {
    const settle = this.pending.get(requestId);
    if (!settle) return;
    this.pending.delete(requestId);
    const item = (result as { item?: StoredItem | null }).item ?? null;
    settle(item);
  }
}
