// The parts of the web player that load on first use, with a dynamic
// `import` (a page that never plays DASH or Matroska does not carry them),
// and what decides that a source needs them.

import type { RemuxFormat } from '../remux/Remuxer';
import type { AudioElementLike } from './dom';

export type DashParts = typeof import('./DashStream');
export type RemuxParts = typeof import('./RemuxStream');

/** The remuxer, once loaded (only Matroska, WebM and MPEG-TS files need it). */
let remuxLoading: Promise<RemuxParts | null> | null = null;

/** Loads the remuxer once; a failed load is tried again next time. */
export function loadRemuxParts(): Promise<RemuxParts | null> {
  remuxLoading ??= import('./RemuxStream').then(
    (parts) => parts,
    () => {
      remuxLoading = null;
      return null;
    }
  );
  return remuxLoading;
}

/**
 * The container RNAP remuxes for a source, by its extension; `null`: the
 * element plays it. Matroska always is (the element would hide its tracks
 * and subtitles, where it plays it at all); WebM and MPEG-TS only where the
 * browser does not play them.
 */
export function remuxFormatOf(
  uri: string,
  element: AudioElementLike
): RemuxFormat | null {
  const path = (uri.split(/[?#]/)[0] ?? '').toLowerCase();
  if (/\.(mkv|mk3d|mka)$/.test(path)) return 'matroska';
  if (/\.webm$/.test(path))
    return element.canPlayType('video/webm') === '' ? 'matroska' : null;
  if (/\.(ts|m2ts|mts|m2t|tsv|mpegts)$/.test(path))
    return element.canPlayType('video/mp2t') === '' ? 'mpegts' : null;
  return null;
}

/** The Shaka glue, once loaded (it is only needed for DASH). */
let dashLoading: Promise<DashParts | null> | null = null;

/** Loads the Shaka glue once; a failed load is tried again next time. */
export function loadDashParts(): Promise<DashParts | null> {
  dashLoading ??= import('./DashStream').then(
    (parts) => parts,
    () => {
      dashLoading = null;
      return null;
    }
  );
  return dashLoading;
}

export const DASH_MISSING =
  'DASH needs Shaka Player on the web: `import shaka from "shaka-player"` and `configureShaka(shaka)` (or load it with a <script>).';

/** Extensions of what the element plays (or hls.js, Shaka): a failure there is not a container to sniff. */
const ELEMENT_FORMATS =
  /\.(mp3|aac|m4a|mp4|m4v|mov|flac|ogg|oga|opus|wav|weba|webm|m3u8|mpd|mkv|mk3d|mka|ts|m2ts|mts)$/i;

/**
 * Whether a source the element could not open may be Matroska or MPEG-TS
 * behind a URL that does not say (an IPTV channel's path, a picked file's
 * `blob:` URL): worth sniffing its first bytes.
 */
export function maySniff(uri: string): boolean {
  return !ELEMENT_FORMATS.test(uri.split(/[?#]/)[0] ?? '');
}
