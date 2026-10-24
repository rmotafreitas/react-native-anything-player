// The optional hls.js dependency, on the web. RNAP does not bundle hls.js: the
// app imports it and hands the constructor over, or loads it with a `<script>`
// (it then sits on `globalThis.Hls`). Only the slice of its API that RNAP
// uses is described here, so the declarations compile without hls.js installed
// and with any 1.x version.

/** The parts of an hls.js error event that RNAP reads. */
export interface HlsErrorData {
  /** `Hls.ErrorTypes.*`. */
  type: string;
  details?: string;
  fatal: boolean;
  response?: { code?: number };
}

/** A level's playlist, as hls.js reports it once loaded. */
export interface HlsLevelDetails {
  /** No `#EXT-X-ENDLIST`: a live stream. */
  live: boolean;
  /** Seconds of the playlist (a VOD's duration). */
  totalduration: number;
}

/** One timed metadata sample hls.js demuxed (`data` is an ID3 tag for ID3). */
export interface HlsMetadataSample {
  /** Seconds on the media timeline. */
  pts: number;
  data: Uint8Array;
  type?: string;
}

/** The slice of an hls.js instance that RNAP uses. */
export interface HlsLike {
  /** Starts loading the playlist at `url`. */
  loadSource(url: string): void;
  /** Plays into `media`, the player's audio element. */
  attachMedia(media: unknown): void;
  /** Stops loading and frees the instance. */
  destroy(): void;
  /** Listens to an `Hls.Events` event. */
  on(event: string, listener: (event: string, data: any) => void): void;
  /** Seconds behind the live edge (hls.js 1.x), when it knows. */
  readonly latency?: number;
  /** The variants (video): height, bitrate, codecs. */
  readonly levels?: ReadonlyArray<HlsLevel>;
  /** The variant playing, or `-1` for automatic; setting it switches now. */
  currentLevel?: number;
  /** The highest variant automatic switching may pick (`-1`: no cap). */
  autoLevelCapping?: number;
  /** Bits per second, hls.js's estimate. */
  readonly bandwidthEstimate?: number;
}

/** A variant, as hls.js describes it. */
export interface HlsLevel {
  readonly height?: number;
  readonly width?: number;
  readonly bitrate?: number;
  readonly name?: string;
  readonly videoCodec?: string;
  readonly audioCodec?: string;
}

/** The slice of the hls.js class that RNAP uses: `import Hls from 'hls.js'`. */
export interface HlsConstructor {
  /** Creates an instance; RNAP passes its configuration (headers, live duration). */
  new (config?: any): HlsLike;
  /** Whether this browser can run hls.js (it needs Media Source Extensions). */
  isSupported(): boolean;
  /** The names of hls.js's events. */
  readonly Events: {
    /** The master playlist was parsed. */
    readonly MANIFEST_PARSED: string;
    /** A level's playlist was loaded: live or not, its length. */
    readonly LEVEL_LOADED: string;
    /** Timed metadata (ID3) was demuxed from a fragment. */
    readonly FRAG_PARSING_METADATA: string;
    /** An error, fatal or not. */
    readonly ERROR: string;
    /** The variant playing changed (video). */
    readonly LEVEL_SWITCHED?: string;
    /** A fragment arrived: a fresh bandwidth estimate (video). */
    readonly FRAG_LOADED?: string;
  };
  /** The values of an error's `type`. */
  readonly ErrorTypes: {
    /** A playlist or fragment could not be loaded. */
    readonly NETWORK_ERROR: string;
    /** The media could not be decoded or appended. */
    readonly MEDIA_ERROR: string;
  };
}

let registered: HlsConstructor | null = null;
const configuredListeners = new Set<() => void>();

/**
 * Web: registers hls.js, which plays HLS (`.m3u8`) in browsers that cannot
 * natively (everything but Safari). Call it once at startup:
 *
 * ```ts
 * import Hls from 'hls.js';
 * configureHls(Hls);
 * ```
 *
 * Without it RNAP uses a global `Hls` (hls.js loaded by a `<script>`), and
 * HLS fails with `UNSUPPORTED_FORMAT` where there is none. Pass `null` to
 * unregister. iOS and Android play HLS natively: a no-op there.
 */
export function configureHls(hls: HlsConstructor | null): void {
  registered = hls;
  if (hls) configuredListeners.forEach((listener) => listener());
}

/**
 * Calls `listener` whenever an hls.js constructor is registered (now, if one
 * already is). The web engine loads its hls.js glue then, ahead of any
 * playback, so an HLS source starts within the play() that asked for it.
 * @internal
 */
export function onHlsConfigured(listener: () => void): void {
  configuredListeners.add(listener);
  if (registered) listener();
}

/** The registered hls.js, else a global one, else `null`. */
export function hlsConstructor(): HlsConstructor | null {
  if (registered) return registered;
  const global = (globalThis as { Hls?: HlsConstructor }).Hls;
  return typeof global === 'function' ? global : null;
}
