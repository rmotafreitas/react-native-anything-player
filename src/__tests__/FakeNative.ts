/**
 * In-memory stand-in for the TurboModule: records calls, lets tests push
 * native events, and resolves commands with a status snapshot like native.
 */
type Listener = (event: object) => void;

export interface FakeStatus {
  seq: number;
  state: string;
  playWhenReady: boolean;
  [key: string]: unknown;
}

export const baseStatus = (
  overrides: Partial<FakeStatus> = {}
): FakeStatus => ({
  seq: 0,
  state: 'idle',
  playWhenReady: false,
  loadId: 0,
  isLive: false,
  duration: null,
  seekable: false,
  interruption: null,
  error: null,
  reconnect: null,
  network: 'online',
  volume: 1,
  muted: false,
  rate: 1,
  route: { kind: 'speaker', name: null },
  sleepAt: null,
  qualities: [],
  quality: null,
  selectedQuality: null,
  ...overrides,
});

export class FakeNative {
  listeners: Listener[] = [];
  subscribeCount = 0;
  calls: Array<[string, ...unknown[]]> = [];
  statuses = new Map<string, FakeStatus>();
  metadata = new Map<string, unknown>();
  nextId = 0;
  /** Set to make the next command reject with this native error shape. */
  rejectNext: { code: string; message: string; userInfo?: object } | null =
    null;

  onPlayerEvent = (listener: Listener) => {
    this.subscribeCount += 1;
    this.listeners.push(listener);
    return {
      remove: () =>
        (this.listeners = this.listeners.filter((l) => l !== listener)),
    };
  };

  emit(event: object) {
    this.listeners.forEach((l) => l(event));
  }

  /** Native-style status event (also updates the snapshot). */
  emitStatus(playerId: string, status: Partial<FakeStatus>) {
    const next = {
      ...(this.statuses.get(playerId) ?? baseStatus()),
      ...status,
    };
    this.statuses.set(playerId, next);
    this.emit({ ...next, playerId, type: 'status' });
  }

  private command(name: string, playerId: string, ...args: unknown[]) {
    this.calls.push([name, playerId, ...args]);
    if (this.rejectNext) {
      const error = Object.assign(
        new Error(this.rejectNext.message),
        this.rejectNext
      );
      this.rejectNext = null;
      return Promise.reject(error);
    }
    const current = this.statuses.get(playerId) ?? baseStatus();
    const next = { ...current, seq: current.seq + 1 };
    if (name === 'play')
      Object.assign(next, { playWhenReady: true, state: 'buffering' });
    if (name === 'pause')
      Object.assign(next, { playWhenReady: false, state: 'paused' });
    if (name === 'load')
      Object.assign(next, {
        state: 'paused',
        loadId: (current.loadId as number) + 1,
      });
    this.statuses.set(playerId, next);
    return Promise.resolve({ ...next });
  }

  createPlayer = (options: object) => {
    this.calls.push(['createPlayer', options]);
    const requested = (options as { id?: string }).id;
    // Like native: an id that already exists attaches to that player.
    if (requested != null && this.statuses.has(requested)) return requested;
    const id = requested ?? `p${++this.nextId}`;
    this.statuses.set(id, baseStatus());
    return id;
  };
  /** Like native: the id is free at once (the player goes later). */
  willReleasePlayer = (id: string) => {
    this.calls.push(['willReleasePlayer', id]);
    return this.statuses.delete(id);
  };
  releasePlayer = (id: string) => {
    this.calls.push(['releasePlayer', id]);
    return Promise.resolve();
  };
  load = (id: string, source: object, options: object) =>
    this.command('load', id, source, options);
  play = (id: string) => this.command('play', id);
  pause = (id: string) => this.command('pause', id);
  stop = (id: string) => this.command('stop', id);
  reset = (id: string) => this.command('reset', id);
  seekTo = (id: string, p: number) => this.command('seekTo', id, p);
  setVolume = (id: string, v: number) => this.command('setVolume', id, v);
  setMuted = (id: string, m: boolean) => this.command('setMuted', id, m);
  setRate = (id: string, r: number) => this.command('setRate', id, r);
  fadeTo = (id: string, v: number, s: number) =>
    this.command('fadeTo', id, v, s);
  sleep = (id: string, timer: object) => this.command('sleep', id, timer);
  setFade = (id: string, fade: object) => this.command('setFade', id, fade);
  updateNowPlaying = (id: string, m: object) => {
    this.calls.push(['updateNowPlaying', id, m]);
    if (this.rejectNext) {
      const error = Object.assign(
        new Error(this.rejectNext.message),
        this.rejectNext
      );
      this.rejectNext = null;
      return Promise.reject(error);
    }
    return Promise.resolve();
  };
  getStatus = (id: string) => ({ ...(this.statuses.get(id) ?? baseStatus()) });
  getProgress = (_id: string) => ({
    position: 12.5,
    duration: 100,
    buffered: 20,
    bufferedAhead: 7.5,
    liveOffset: null,
    timestamp: 1,
  });
  getMetadata = (id: string) => ({ metadata: this.metadata.get(id) ?? null });
  getDiagnostics = (_id: string) => [
    {
      time: 1,
      generation: 1,
      state: 'playing',
      event: 'transition',
      details: {},
    },
  ];
  setDiagnosticsEnabled = (id: string, enabled: boolean) => {
    this.calls.push(['setDiagnosticsEnabled', id, enabled]);
  };
  setAudioSampling = (id: string, enabled: boolean, points: number) => {
    this.calls.push(['setAudioSampling', id, enabled, points]);
    return true;
  };

  // ── App-global ──
  routePickerAvailable = true;
  castStatus: { state: string; device: string | null } = {
    state: 'notConnected',
    device: null,
  };
  catalogResults: object[] = [];
  playResult: object = { item: null };

  private global<T>(name: string, value: T, ...args: unknown[]): Promise<T> {
    this.calls.push([name, ...args]);
    if (this.rejectNext) {
      const error = Object.assign(
        new Error(this.rejectNext.message),
        this.rejectNext
      );
      this.rejectNext = null;
      return Promise.reject(error);
    }
    return Promise.resolve(value);
  }

  showRoutePicker = (playerId: string | null) =>
    this.global('showRoutePicker', undefined, playerId);
  isRoutePickerAvailable = () => this.routePickerAvailable;
  getCastState = () => ({ ...this.castStatus });
  configureCast = (options: object) =>
    this.global('configureCast', undefined, options);
  showCastPicker = () => this.global('showCastPicker', undefined);
  stopCasting = () => this.global('stopCasting', undefined);
  setCatalog = (items: object[], options: object) =>
    this.global('setCatalog', undefined, items, options);
  setFavorites = (ids: string[]) => this.global('setFavorites', undefined, ids);
  searchCatalog = (request: object) =>
    this.global('searchCatalog', this.catalogResults, request);
  playFromSearch = (request: object, playerId: string | null) =>
    this.global('playFromSearch', this.playResult, request, playerId);
  setSearchHandlerEnabled = (enabled: boolean) => {
    this.calls.push(['setSearchHandlerEnabled', enabled]);
  };
  resolveSearchRequest = (requestId: string, result: object) => {
    this.calls.push(['resolveSearchRequest', requestId, result]);
  };
}

export const fake = new FakeNative();
