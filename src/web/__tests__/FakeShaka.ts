// A scripted Shaka Player: the namespace RNAP is given with `configureShaka`,
// with the parts of the real classes DashStream uses. Tests emit its events
// and call the plugin the `rnap-license:` scheme registered.

import type {
  ShakaAudioTrack,
  ShakaLike,
  ShakaPlayerLike,
  ShakaTrack,
} from '../../core/shaka';

type Listener = (event: any) => void;
type RequestFilter = (
  type: unknown,
  request: { headers: Record<string, string> }
) => void;
type SchemePlugin = (
  uri: string,
  request: { body?: ArrayBuffer | ArrayBufferView | null }
) => unknown;

export interface FakeShakaOptions {
  /** Shaka 5: `getAudioTracks` and `selectAudioTrack`. */
  audioTracks?: boolean;
  /** Shaka 4: `setTextTrackVisibility`. */
  textVisibility?: boolean;
  /** A namespace without `net` and `util`. */
  noNetworking?: boolean;
  /** A namespace without `polyfill`. */
  noPolyfill?: boolean;
  /** What every player's `attach` / `load` rejects with. */
  attachError?: unknown;
  loadError?: unknown;
  /** The variants every player lists from the start. */
  variants?: ShakaTrack[];
}

export function track(overrides: Partial<ShakaTrack> = {}): ShakaTrack {
  return {
    id: 1,
    active: false,
    bandwidth: 1_000_000,
    height: 720,
    videoId: 1,
    language: 'en',
    ...overrides,
  };
}

export class FakeShakaPlayer implements ShakaPlayerLike {
  attached: unknown = null;
  loaded: { uri: string; startTime: number | null | undefined } | null = null;
  destroyed = false;
  /** Rejects `attach`/`load`/`destroy` with this. */
  attachError: unknown = null;
  loadError: unknown = null;
  destroyError: unknown = null;
  configs: Array<Record<string, any>> = [];
  variants: ShakaTrack[] = [];
  texts: ShakaTrack[] = [];
  audios: ShakaAudioTrack[] = [];
  live = false;
  bandwidth: number | undefined = undefined;
  textVisibility: boolean[] = [];
  selectedVariants: Array<{
    track: ShakaTrack;
    clearBuffer?: boolean;
    safeMargin?: number;
  }> = [];
  selectedAudio: ShakaAudioTrack[] = [];
  selectedLanguages: Array<{ language: string; role?: string }> = [];
  selectedText: Array<ShakaTrack | null> = [];
  filters: RequestFilter[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(options: FakeShakaOptions = {}) {
    this.variants = options.variants ?? [];
    this.attachError = options.attachError ?? null;
    this.loadError = options.loadError ?? null;
    if (options.audioTracks) {
      this.getAudioTracks = () => this.audios;
      this.selectAudioTrack = (t) => this.selectedAudio.push(t);
    } else {
      this.selectAudioLanguage = (language, role) =>
        this.selectedLanguages.push({ language, role });
    }
    if (options.textVisibility)
      this.setTextTrackVisibility = (visible) =>
        this.textVisibility.push(visible);
  }

  getAudioTracks?: () => ShakaAudioTrack[];
  selectAudioTrack?: (track: ShakaAudioTrack) => void;
  selectAudioLanguage?: (language: string, role?: string) => void;
  setTextTrackVisibility?: (visible: boolean) => unknown;

  attach(media: unknown): Promise<void> {
    if (this.attachError) return Promise.reject(this.attachError);
    this.attached = media;
    return Promise.resolve();
  }

  load(uri: string, startTime?: number | null): Promise<void> {
    if (this.loadError) return Promise.reject(this.loadError);
    this.loaded = { uri, startTime };
    return Promise.resolve();
  }

  destroy(): Promise<void> {
    this.destroyed = true;
    if (this.destroyError) return Promise.reject(this.destroyError);
    return Promise.resolve();
  }

  configure(config: object): boolean {
    this.configs.push(config as Record<string, any>);
    return true;
  }

  getVariantTracks(): ShakaTrack[] {
    return this.variants;
  }

  getTextTracks(): ShakaTrack[] {
    return this.texts;
  }

  selectVariantTrack(
    t: ShakaTrack,
    clearBuffer?: boolean,
    safeMargin?: number
  ): void {
    this.selectedVariants.push({ track: t, clearBuffer, safeMargin });
  }

  selectTextTrack(t: ShakaTrack | null): void {
    this.selectedText.push(t);
  }

  isLive(): boolean {
    return this.live;
  }

  getStats() {
    return { estimatedBandwidth: this.bandwidth };
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  getNetworkingEngine() {
    return {
      registerRequestFilter: (filter: RequestFilter) => {
        this.filters.push(filter);
      },
    };
  }

  // ── Test controls ──

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** The last configuration that set `key`. */
  config(key: string): any {
    return [...this.configs].reverse().find((c) => key in c)?.[key];
  }

  /** What every request filter does to a request of `type`. */
  filtered(type: unknown): Record<string, string> {
    const request = { headers: {} as Record<string, string> };
    for (const filter of this.filters) filter(type, request);
    return request.headers;
  }
}

/** What `notAbortable` was given, as the plugin returns it. */
export interface NotAbortable {
  notAbortable: true;
  promise: Promise<any>;
}

export class FakeShaka {
  players: FakeShakaPlayer[] = [];
  polyfills = 0;
  schemes = new Map<string, SchemePlugin>();
  readonly namespace: ShakaLike;

  constructor(options: FakeShakaOptions = {}) {
    const { players, schemes } = this;
    const polyfilled = () => {
      this.polyfills += 1;
    };
    class Player extends FakeShakaPlayer {
      static isBrowserSupported() {
        return true;
      }

      constructor() {
        super(options);
        players.push(this);
      }
    }
    // A class per namespace: DashStream registers its scheme once per class.
    class NetworkingEngine {
      static registerScheme(scheme: string, plugin: SchemePlugin) {
        schemes.set(scheme, plugin);
      }
    }
    this.namespace = {
      Player,
      ...(options.noPolyfill
        ? {}
        : {
            polyfill: {
              installAll: polyfilled,
            },
          }),
      ...(options.noNetworking
        ? {}
        : {
            net: { NetworkingEngine },
            util: {
              AbortableOperation: {
                notAbortable: (promise: Promise<unknown>) => ({
                  notAbortable: true,
                  promise,
                }),
              },
            },
          }),
    };
  }

  last(): FakeShakaPlayer {
    return this.players[this.players.length - 1]!;
  }

  /** Shaka asking the scheme's plugin for `uri` with `body`. */
  request(
    uri: string,
    body: ArrayBuffer | ArrayBufferView | null
  ): NotAbortable {
    const scheme = uri.slice(0, uri.indexOf(':'));
    const plugin = this.schemes.get(scheme)!;
    return plugin(uri, { body }) as NotAbortable;
  }
}
