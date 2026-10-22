// The HLS checks and messages the eager code needs. The hls.js glue itself
// (`HlsStream`, which pulls in the ID3 reader) loads on first use; the element
// driver and the MSE fallback only need to recognise an HLS source.

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
