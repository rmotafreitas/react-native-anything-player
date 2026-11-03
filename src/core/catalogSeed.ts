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

/**
 * cyrb53 of `text` (a well-distributed 53-bit hash), as 14 hex digits: tells
 * one bundled catalog from another.
 */
function contentId(text: string): string {
  /* eslint-disable no-bitwise -- a hash is bitwise by nature */
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  /* eslint-enable no-bitwise */
  return hash.toString(16).padStart(14, '0');
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
