// The optional Shaka Player dependency, for DASH (`.mpd`) on the web. RNAP
// does not bundle Shaka: the app imports it and hands it over, or loads it
// with a `<script>` (it then sits on `globalThis.shaka`). Only the slice of
// its API that RNAP uses is described here, so the declarations compile
// without Shaka installed (4.x and 5.x).

/** A variant (a picture and a sound together) or a text track, as Shaka lists them. */
export interface ShakaTrack {
  /** Shaka's id for the track. */
  readonly id: number;
  /** Whether it is the one playing (or shown). */
  readonly active: boolean;
  /** Bits per second (variants). */
  readonly bandwidth?: number;
  /** The picture's height, pixels; `null` for audio only. */
  readonly height?: number | null;
  /** The picture's id (variants sharing one differ by their sound). */
  readonly videoId?: number | null;
  /** The sound's language (variants), or the text's. */
  readonly language: string;
  /** The manifest's label, if it has one. */
  readonly label?: string | null;
  /** `subtitle` or `caption` (text tracks). */
  readonly kind?: string | null;
  /** The manifest's roles (`main`, `description`, …). */
  readonly roles?: readonly string[];
  /** A forced-narrative text track. */
  readonly forced?: boolean;
  /** `CHARACTERISTICS`-like accessibility roles of the sound (variants). */
  readonly audioRoles?: readonly string[] | null;
}

/** A sound to choose from (Shaka 5's `getAudioTracks`). */
export interface ShakaAudioTrack {
  /** Whether it is the one playing. */
  readonly active: boolean;
  /** Its language. */
  readonly language: string;
  /** The manifest's label, if it has one. */
  readonly label?: string | null;
  /** The manifest's roles (`main`, `description`, …). */
  readonly roles?: readonly string[];
}

/** An error Shaka reports (`severity` 2: it stopped playing). */
export interface ShakaError {
  /** 1: recoverable, 2: critical. */
  readonly severity: number;
  /** `shaka.util.Error.Category` (1: network, 3: media, …). */
  readonly category: number;
  /** `shaka.util.Error.Code`. */
  readonly code: number;
  /** The code's details (for a bad HTTP status, the status is the second). */
  readonly data?: readonly unknown[];
}

/** The slice of a `shaka.Player` that RNAP uses. */
export interface ShakaPlayerLike {
  /** Plays into `media`, the player's `<video>`. */
  attach(media: unknown): Promise<void>;
  /** Loads the manifest at `uri`, starting at `startTime` (seconds) when given. */
  load(uri: string, startTime?: number | null): Promise<void>;
  /** Stops loading and frees the instance. */
  destroy(): Promise<void>;
  /** Merges `config` into Shaka's configuration. */
  configure(config: object): boolean;
  /** The variants: a picture and a sound each. */
  getVariantTracks(): ShakaTrack[];
  /** The text tracks. */
  getTextTracks(): ShakaTrack[];
  /** Plays this variant (`clearBuffer`: soon, keeping `safeMargin` seconds of what is buffered). */
  selectVariantTrack(
    track: ShakaTrack,
    clearBuffer?: boolean,
    safeMargin?: number
  ): void;
  /** Shaka 5: the sounds to choose from. */
  getAudioTracks?(): ShakaAudioTrack[];
  /** Shaka 5: plays this sound. */
  selectAudioTrack?(track: ShakaAudioTrack): void;
  /** Shaka 4: plays the sound in this language (and role). */
  selectAudioLanguage?(language: string, role?: string): void;
  /** Shows this text track; Shaka 5 takes `null` for none. */
  selectTextTrack(track: ShakaTrack | null): void;
  /** Shaka 4: `false` loads cues into a hidden text track (RNAP's overlay draws them). */
  setTextTrackVisibility?(visible: boolean): unknown;
  /** Whether the manifest is live. */
  isLive(): boolean;
  /** Playback statistics. */
  getStats(): {
    /** Bits per second, Shaka's estimate. */
    estimatedBandwidth?: number;
  };
  /** Listens to Shaka's events (`error`, `trackschanged`, `variantchanged`, `adaptation`). */
  addEventListener(type: string, listener: (event: any) => void): void;
  /** Where request headers are added. */
  getNetworkingEngine(): {
    /** Runs `filter` on every request before it is sent. */
    registerRequestFilter(
      filter: (
        type: unknown,
        request: { headers: Record<string, string> }
      ) => void
    ): void;
  } | null;
}

/** The slice of the `shaka` namespace RNAP uses: `import shaka from 'shaka-player'`. */
export interface ShakaLike {
  /** `shaka.Player`. */
  Player: {
    /** A player, not attached yet. */
    new (): ShakaPlayerLike;
    /** Whether this browser can run Shaka (Media Source Extensions). */
    isBrowserSupported(): boolean;
  };
  /** Shaka's polyfills, installed once before the first player. */
  polyfill?: {
    /** Installs them all. */
    installAll(): void;
  };
  /** Shaka's networking: RNAP registers its `rnap-license:` scheme there (the app's `drm.getLicense`). */
  net?: {
    /** `shaka.net.NetworkingEngine`. */
    NetworkingEngine: {
      /** Serves the requests to `scheme:` URIs. */
      registerScheme(
        scheme: string,
        plugin: (
          uri: string,
          request: { body?: ArrayBuffer | ArrayBufferView | null }
        ) => unknown
      ): void;
    };
  };
  /** Shaka's utilities. */
  util?: {
    /** `shaka.util.AbortableOperation`. */
    AbortableOperation: {
      /** An operation that cannot be aborted, from a promise. */
      notAbortable(promise: Promise<unknown>): unknown;
    };
  };
}

let registered: ShakaLike | null = null;

/**
 * Web: registers Shaka Player, which plays DASH (`.mpd`) in browsers (none
 * plays it natively). Call it once at startup:
 *
 * ```ts
 * import shaka from 'shaka-player';
 * configureShaka(shaka);
 * ```
 *
 * Without it RNAP uses a global `shaka` (Shaka loaded by a `<script>`), and
 * DASH fails with `UNSUPPORTED_FORMAT` where there is none. Pass `null` to
 * unregister. iOS and Android play DASH natively: a no-op there.
 */
export function configureShaka(shaka: ShakaLike | null): void {
  registered = shaka;
}

/** The registered Shaka, else a global one, else `null`. */
export function shakaNamespace(): ShakaLike | null {
  if (registered) return registered;
  const global = (globalThis as { shaka?: ShakaLike }).shaka;
  return global && typeof global.Player === 'function' ? global : null;
}

/** A DASH manifest, by its extension. */
export function isDashUri(uri: string): boolean {
  return /\.mpd$/i.test(uri.split(/[?#]/)[0] ?? '');
}
