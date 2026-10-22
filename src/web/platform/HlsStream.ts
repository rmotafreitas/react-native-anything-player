// An HLS source played by hls.js on the player's <audio> element, for browsers
// that cannot play it natively (everything but Safari). hls.js is optional:
// the app registers it with `configureHls` (see src/core/hls.ts).
//
// hls.js loads playlists and segments and feeds the element through Media
// Source Extensions. Everything above it stays RNAP's: the engine decides when
// to recover, so a fatal hls.js error is reported as a recoverable failure and
// the engine re-opens the item (a new hls.js instance) under its own backoff,
// instead of hls.js retrying on its own. Fragment retries inside a playlist
// stay hls.js's.

import type { PlayerError } from '../../errors';
import type {
  HlsConstructor,
  HlsErrorData,
  HlsLevelDetails,
  HlsLike,
  HlsMetadataSample,
} from '../../core/hls';
import type { StreamMetadata } from '../engine/StreamMetadata';
import {
  engineError,
  type ReadyInfo,
  type SourceDescriptor,
} from '../engine/types';
import { browser, type AudioElementLike } from './dom';
import { id3Metadata } from './Id3';

export interface HlsListener {
  /** An ID3 tag from the stream, with the media time it applies from. */
  onMetadata(metadata: StreamMetadata, mediaTime: number): void;
  /** hls.js gave up (a fatal error). */
  onFailure(error: PlayerError): void;
  /** A diagnostics note. */
  onNote(event: string, details: Record<string, string>): void;
}

/** hls.js `ErrorDetails.MANIFEST_LOAD_ERROR`: the playlist itself could not be loaded. */
const MANIFEST_LOAD_ERROR = 'manifestLoadError';

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

/** The failure for a fatal hls.js error. */
export function hlsFailure(
  data: HlsErrorData,
  ctor: Pick<HlsConstructor, 'ErrorTypes'>
): PlayerError {
  const cause = [data.type, data.details].filter(Boolean).join(': ');
  const status = data.response?.code;
  const details = {
    platformDomain: 'hls.js',
    cause,
    ...(status ? { httpStatus: status } : {}),
  };
  const navigator = browser().navigator;
  if (data.type === ctor.ErrorTypes.NETWORK_ERROR) {
    if (navigator && !navigator.onLine) {
      return engineError(
        'NETWORK_UNAVAILABLE',
        'The device is offline.',
        true,
        details
      );
    }
    if (
      data.details === MANIFEST_LOAD_ERROR &&
      (status === 404 || status === 410)
    ) {
      return engineError(
        'SOURCE_NOT_FOUND',
        `The server returned HTTP ${status}.`,
        false,
        details
      );
    }
    return engineError(
      'NETWORK_ERROR',
      'A network error interrupted the HLS stream.',
      true,
      details
    );
  }
  if (data.type === ctor.ErrorTypes.MEDIA_ERROR) {
    return engineError(
      'DECODER_ERROR',
      'The HLS audio could not be decoded.',
      true,
      details
    );
  }
  return engineError(
    'UNSUPPORTED_FORMAT',
    'hls.js could not play the stream.',
    false,
    details
  );
}

export class HlsStream {
  private hls: HlsLike | null = null;
  private details: HlsLevelDetails | null = null;
  /** A fatal error was reported: later element errors are the same failure. */
  failed = false;
  private closed = false;

  constructor(
    private readonly element: AudioElementLike,
    private readonly source: SourceDescriptor,
    private readonly ctor: HlsConstructor,
    private readonly listener: HlsListener
  ) {}

  start(): void {
    const { Events } = this.ctor;
    const hls = new this.ctor(this.config());
    this.hls = hls;
    hls.on(Events.MANIFEST_PARSED, (_event, data) => {
      this.listener.onNote('hls manifest', {
        levels: `${data?.levels?.length ?? 0}`,
      });
    });
    hls.on(Events.LEVEL_LOADED, (_event, data) => {
      this.details = (data?.details as HlsLevelDetails | undefined) ?? null;
    });
    hls.on(Events.FRAG_PARSING_METADATA, (_event, data) => {
      this.timedMetadata((data?.samples as HlsMetadataSample[]) ?? []);
    });
    hls.on(Events.ERROR, (_event, data: HlsErrorData) => {
      if (!data?.fatal || this.closed || this.failed) return;
      this.failed = true;
      this.listener.onFailure(hlsFailure(data, this.ctor));
      // Nothing more is wanted from it; the engine opens the item anew.
      this.close();
    });
    hls.loadSource(this.source.uri);
    hls.attachMedia(this.element);
  }

  /** Detaches from the element and frees hls.js. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const hls = this.hls;
    this.hls = null;
    try {
      hls?.destroy();
    } catch {
      // A failing destroy leaves nothing to free that RNAP can reach.
    }
  }

  /** Whether the playlist is live; `null` until it is known. */
  get live(): boolean | null {
    return this.details ? this.details.live : null;
  }

  /** Seconds behind the live edge, when hls.js knows. */
  get liveOffset(): number | null {
    const latency = this.hls?.latency;
    return latency !== undefined && Number.isFinite(latency)
      ? Math.max(0, latency)
      : null;
  }

  /** What the playlist says about the item, once loaded; `null` before. */
  readyInfo(): ReadyInfo | null {
    const details = this.details;
    if (!details) return null;
    if (details.live) return { duration: null, isLive: true, seekable: false };
    const duration = details.totalduration;
    return Number.isFinite(duration) && duration > 0
      ? { duration, isLive: false, seekable: true }
      : null;
  }

  private timedMetadata(samples: HlsMetadataSample[]): void {
    for (const sample of samples) {
      const metadata = sample.data ? id3Metadata(sample.data) : null;
      if (metadata) this.listener.onMetadata(metadata, sample.pts);
    }
  }

  /** hls.js's configuration: the source's headers, and a live duration of Infinity as natively. */
  private config(): Record<string, unknown> {
    const config: Record<string, unknown> = { liveDurationInfinity: true };
    const headers = Object.entries(this.source.headers);
    if (headers.length === 0) return config;
    config.xhrSetup = (xhr: {
      setRequestHeader(name: string, value: string): void;
    }) => {
      for (const [name, value] of headers) xhr.setRequestHeader(name, value);
    };
    config.fetchSetup = (
      context: { url: string },
      init: { headers: { set(name: string, value: string): void } }
    ) => {
      for (const [name, value] of headers) init.headers.set(name, value);
      const Request = browser().Request!;
      return new Request(context.url, init);
    };
    return config;
  }
}
