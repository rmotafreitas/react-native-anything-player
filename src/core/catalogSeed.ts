import { host, installHost, type PlayerHost } from './host';
import { serializeCatalog } from './system';
import type { CatalogItem, CatalogOptions } from '../types';

/**
 * At build time there is no device and no player: only the schemes every
 * device plays, and no bundled assets (`require()` has no meaning in a JSON
 * file).
 */
const BUILD_HOST: PlayerHost = {
  module() {
    throw new Error('There is no player at build time.');
  },
  onForeground() {},
  isForeground: () => false,
  onForegroundChange: () => () => {},
  resolveAsset: () => {
    throw new TypeError(
      'Sources and artwork in a bundled catalog must be URLs: a JSON file has no require().'
    );
  },
};

/** A hash of `text`, as 8 hex digits: tells one bundled catalog from another. */
function contentId(text: string): string {
  // Polynomial, modulo the largest prime below 2^32 (exact in a double).
  const PRIME = 4_294_967_291;
  let hash = 0;
  for (let i = 0; i < text.length; i++)
    hash = (hash * 31 + text.charCodeAt(i)) % PRIME;
  return hash.toString(16).padStart(8, '0');
}

/** The catalog file's format version, as native writes it (`CatalogStore`). */
const CATALOG_FILE_VERSION = 1;

/**
 * The catalog an app bundles (the Expo plugin's `catalog` option): what
 * `setCatalog(items, options)` would store, in the format native stores it.
 * Voice requests and cars use it until the app sets a catalog of its own.
 * Runs at build time in Node: sources and artwork are URLs, never
 * `require()` assets.
 */
export function catalogSeed(
  input: {
    items: CatalogItem[];
  } & CatalogOptions
): Record<string, unknown> {
  if (input == null || typeof input !== 'object' || Array.isArray(input))
    throw new TypeError(
      'The catalog must be an object: { items, playerId?, playerOptions?, browse? }.'
    );
  try {
    host();
  } catch {
    installHost(BUILD_HOST);
  }
  const { items, options } = serializeCatalog(input.items, input);
  const content = {
    playerId: options.playerId,
    playerOptions: options.playerOptions ?? null,
    browse: options.browse ?? null,
    items,
  };
  return {
    version: CATALOG_FILE_VERSION,
    ...content,
    lastPlayedId: null,
    recentIds: [],
    // Native keeps it with the catalog while the bundled one is in use: an
    // app update that bundles another one replaces it (until setCatalog).
    seed: contentId(JSON.stringify(content)),
  };
}
