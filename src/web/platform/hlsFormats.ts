// The HLS checks and messages the eager code needs. The hls.js glue itself
// (`HlsStream`, which pulls in the ID3 reader) loads on first use; the element
// driver and the MSE fallback only need to recognise an HLS source.

import type { AudioElementLike, VideoElementLike } from './dom';

/** What `canPlayType` answers for HLS in browsers that play it natively (Safari, Android). */
const HLS_MIME = 'application/vnd.apple.mpegurl';

/**
 * Whether hls.js has to play an HLS source on `element`: the element has no
 * HLS of its own, or its own failed on this source. A video's native HLS
 * without track lists (Chromium's) has no qualities, caps, audio groups or
 * subtitles to pick from: hls.js plays it too, where it runs (`hlsJs`).
 * Safari's own HLS lists its tracks: it stays.
 */
export function needsHlsJs(
  element: AudioElementLike,
  video: boolean,
  nativeFailed: boolean,
  hlsJs: boolean
): boolean {
  if (nativeFailed || element.canPlayType(HLS_MIME) === '') return true;
  return (
    video && (element as VideoElementLike).audioTracks === undefined && hlsJs
  );
}

/** Whether a Content-Type or MIME type names an HLS playlist. */
export function isHlsType(contentType: string | null | undefined): boolean {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return (
    base === 'application/vnd.apple.mpegurl' || base === 'application/x-mpegurl'
  );
}

/** Whether the URL path is an HLS playlist. */
export function isHlsUri(uri: string): boolean {
  return /\.m3u8(\?|#|$)/i.test(uri);
}

/** The message that tells an app how to get HLS where the browser has none. */
export const HLS_MISSING =
  'This browser cannot play HLS natively. Install hls.js (`npm install hls.js`) and register it at startup: `import Hls from "hls.js"; configureHls(Hls);`';

/** Added to a failed native HLS playlist: it may be a stream the browser's own HLS cannot play. */
export const HLS_HINT =
  ' If this is an HLS playlist the browser cannot play, install hls.js (`npm install hls.js`) and register it at startup: `import Hls from "hls.js"; configureHls(Hls);`';
