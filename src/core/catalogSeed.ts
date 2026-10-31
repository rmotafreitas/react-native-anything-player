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
  resolveAsset: () => null,
};

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
  return {
    version: CATALOG_FILE_VERSION,
    playerId: options.playerId,
    playerOptions: options.playerOptions ?? null,
    lastPlayedId: null,
    browse: options.browse ?? null,
    recentIds: [],
    items,
  };
}
