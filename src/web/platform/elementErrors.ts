// The element's MediaError, as RNAP's failure: what the browser's code means
// for this source, and what to tell the app.

import type { PlayerError } from '../../errors';
import { engineError } from '../engine/types';
import { HLS_HINT } from './hlsFormats';

// MediaError codes.
const MEDIA_ERR_NETWORK = 2;
const MEDIA_ERR_DECODE = 3;

/** What the driver knows about the item that failed. */
export interface ElementErrorContext {
  offline: boolean;
  /** Audio flowed: a decode error mid-way is worth a retry. */
  flowed: boolean;
  /** The source played before (a server that stopped serving it). */
  sourcePlayed: boolean;
  /** The browser's own HLS had it. */
  nativeHls: boolean;
  /** Why remuxing it fell back to the element, if it did. */
  remuxFallback: string | null;
  /**
   * hls.js, Shaka, the remuxer or an MSE stream feeds the element, and its
   * metadata loaded: the browser took the container and the codecs.
   */
  mseOpened: boolean;
}

export function elementError(
  code: number,
  message: string,
  context: ElementErrorContext
): PlayerError {
  // A remux that fell back (the server's CORS) is part of why.
  const fallback = context.remuxFallback?.startsWith('fetch failed')
    ? `; remuxing it failed: ${context.remuxFallback}`
    : '';
  const details = {
    platformDomain: 'MediaError',
    platformCode: code,
    cause: message || fallback ? `${message}${fallback}` : undefined,
  };
  if (context.offline)
    return engineError(
      'NETWORK_UNAVAILABLE',
      'The device is offline.',
      true,
      details
    );
  if (code === MEDIA_ERR_NETWORK)
    return engineError(
      'NETWORK_ERROR',
      'A network error interrupted the download.',
      true,
      details
    );
  if (code === MEDIA_ERR_DECODE)
    return engineError(
      'DECODER_ERROR',
      'The audio could not be decoded.',
      context.flowed,
      details
    );
  // MEDIA_ERR_SRC_NOT_SUPPORTED: browsers also report a refused or missing
  // resource this way. A source that played before is a server failing.
  if (context.sourcePlayed)
    return engineError(
      'NETWORK_ERROR',
      'The server stopped serving the source.',
      true,
      details
    );
  // A code 4 now is the media pipeline failing (WebKitGTK's "Failed to push
  // buffer" on a flush during the first appends): a re-open fixes it.
  if (context.mseOpened)
    return engineError(
      'DECODER_ERROR',
      'The media pipeline failed while buffering.',
      true,
      details
    );
  const remuxHint = fallback
    ? ' RNAP could not remux it either: on the web, Matroska and MPEG-TS are read with fetch(), so the server must allow cross-origin requests (CORS).'
    : '';
  return engineError(
    'UNSUPPORTED_FORMAT',
    'The browser could not open the source (unsupported format, or the server refused it).' +
      (context.nativeHls ? HLS_HINT : '') +
      remuxHint,
    false,
    details
  );
}
