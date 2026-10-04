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
    const id = `p${++this.nextId}`;
    this.calls.push(['createPlayer', options]);
    this.statuses.set(id, baseStatus());
    return id;
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
}

export const fake = new FakeNative();
