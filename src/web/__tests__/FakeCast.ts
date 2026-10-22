/// <reference types="node" />
// A scripted Google Cast Web Sender SDK (`cast.framework`, `chrome.cast`) and
// the receiver behind it. The real-browser counterpart is the Playwright
// suite, which injects a fake receiver that streams from the test radio.

type Listener = (event: any) => void;

export interface FakeLoad {
  contentId: string;
  contentType: string;
  streamType: string;
  metadata: {
    title?: string;
    artist?: string;
    albumName?: string;
    images?: Array<{ url: string }>;
  };
  autoplay: boolean;
  currentTime?: number;
}

export interface FakeDevice {
  friendlyName: string;
  label?: string;
  deviceId?: string;
}

class Emitter {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== listener)
    );
  }

  protected emit(type: string, event: object = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  count(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

export class FakeCast {
  // ── The receiver ──
  castState = 'NO_DEVICES_AVAILABLE';
  device: FakeDevice | null = null;
  inSession = false;
  /** Everything the receiver was asked to load. */
  loads: FakeLoad[] = [];
  /** What `loadMedia` does: succeed, fail with a code (resolved or rejected), or hang. */
  loadBehavior: 'accept' | 'resolveError' | 'reject' | 'hang' = 'accept';
  hung: Array<() => void> = [];
  playerState = 'IDLE';
  idleReason: string | null = null;
  isMediaLoaded = false;
  isPaused = false;
  canSeek = true;
  duration = 0;
  currentTime = 0;
  /** What `requestSession` resolves with, and whether it opens a session. */
  requestResult: string | undefined = undefined;
  requests = 0;
  ended = 0;
  options: Record<string, unknown> = {};
  supportsStreamVolume = true;
  volumes: number[] = [];
  playOrPauses = 0;
  stops = 0;
  seeks: number[] = [];
  context: FakeContext | null = null;
  readonly controllers: FakeController[] = [];

  /** The namespaces the SDK adds to `window`. */
  get namespaces(): { cast: object; chrome: object } {
    return namespacesOf(this);
  }

  /** Puts the SDK on `globalThis`, as `cast_sender.js` does. */
  install(): void {
    const { cast, chrome } = this.namespaces;
    const g = globalThis as Record<string, unknown>;
    g.cast = cast;
    g.chrome = chrome;
  }

  // ── Scripting ──

  /** Receivers appear (or all go away). */
  setDevicesAvailable(available: boolean): void {
    this.castState = available ? 'NOT_CONNECTED' : 'NO_DEVICES_AVAILABLE';
    this.context?.fireCastState();
  }

  /** The user picked a receiver: connecting, then started. */
  connect(
    device: FakeDevice = { friendlyName: 'Living Room', deviceId: 'tv1' }
  ): void {
    this.device = device;
    this.castState = 'CONNECTING';
    this.context?.fireCastState();
    this.inSession = true;
    this.castState = 'CONNECTED';
    this.context?.fireSession('SESSION_STARTED');
    this.context?.fireCastState();
  }

  /** A session found again after a page load. */
  resume(
    device: FakeDevice = { friendlyName: 'Living Room', deviceId: 'tv1' }
  ): void {
    this.device = device;
    this.inSession = true;
    this.castState = 'CONNECTED';
    this.context?.fireSession('SESSION_RESUMED');
    this.context?.fireCastState();
  }

  /** The session ends (the user, the receiver or the network). */
  end(): void {
    this.inSession = false;
    this.isMediaLoaded = false;
    this.device = null;
    this.castState = 'NOT_CONNECTED';
    this.ended += 1;
    this.context?.fireSession('SESSION_ENDED');
    this.context?.fireCastState();
  }

  setPlayerState(state: string, reason: string | null = null): void {
    this.playerState = state;
    this.idleReason = state === 'IDLE' ? reason : null;
    this.isPaused = state === 'PAUSED';
    this.controllers.forEach((c) => c.change());
  }

  /** The receiver's media position moved. */
  tick(seconds: number): void {
    this.currentTime = seconds;
    this.controllers.forEach((c) => c.change());
  }

  /** Lets hung `loadMedia` calls succeed. */
  release(): void {
    this.hung.splice(0).forEach((resolve) => resolve());
  }

  finishLoad(request: FakeLoad): void {
    this.isMediaLoaded = true;
    this.isPaused = !request.autoplay;
    this.currentTime = request.currentTime ?? 0;
    this.setPlayerState(request.autoplay ? 'PLAYING' : 'PAUSED');
  }

  get currentSession(): object | null {
    if (!this.inSession) return null;
    return {
      getCastDevice: () => this.device,
      getMediaSession: () =>
        this.isMediaLoaded
          ? {
              idleReason: this.idleReason,
              supportsCommand: (command: string) =>
                this.supportsStreamVolume && command === 'STREAM_VOLUME',
              setVolume: (request: { volume: { level: number | null } }) => {
                this.volumes.push(request.volume.level ?? -1);
              },
            }
          : null,
      loadMedia: (request: {
        media: {
          contentId: string;
          contentType: string;
          streamType: string;
          metadata: FakeLoad['metadata'];
        };
        autoplay: boolean;
        currentTime?: number;
      }) => {
        const load: FakeLoad = {
          contentId: request.media.contentId,
          contentType: request.media.contentType,
          streamType: request.media.streamType,
          metadata: request.media.metadata,
          autoplay: request.autoplay,
          currentTime: request.currentTime,
        };
        this.loads.push(load);
        switch (this.loadBehavior) {
          case 'resolveError':
            return Promise.resolve('load_media_failed');
          case 'reject':
            return Promise.reject('load_media_failed');
          case 'hang':
            return new Promise<undefined>((resolve) =>
              this.hung.push(() => {
                this.finishLoad(load);
                resolve(undefined);
              })
            );
          default:
            this.finishLoad(load);
            return Promise.resolve(undefined);
        }
      },
    };
  }
}

class FakeContext extends Emitter {
  constructor(private readonly fake: FakeCast) {
    super();
  }

  setOptions(options: Record<string, unknown>): void {
    this.fake.options = options;
  }

  getCastState(): string {
    return this.fake.castState;
  }

  getCurrentSession(): object | null {
    return this.fake.currentSession;
  }

  requestSession(): Promise<string | undefined> {
    this.fake.requests += 1;
    return Promise.resolve(this.fake.requestResult);
  }

  endCurrentSession(): void {
    this.fake.end();
  }

  fireCastState(): void {
    this.emit('caststatechanged', { castState: this.fake.castState });
  }

  fireSession(sessionState: string): void {
    this.emit('sessionstatechanged', { sessionState });
  }
}

interface FakeController {
  change(): void;
}

function namespacesOf(fake: FakeCast): { cast: object; chrome: object } {
  class RemotePlayer {
    get isConnected() {
      return fake.inSession;
    }
    get isMediaLoaded() {
      return fake.isMediaLoaded;
    }
    get isPaused() {
      return fake.isPaused;
    }
    get canSeek() {
      return fake.canSeek;
    }
    get playerState() {
      return fake.playerState;
    }
    get duration() {
      return fake.duration;
    }
    set duration(value: number) {
      fake.duration = value;
    }
    get currentTime() {
      return fake.currentTime;
    }
    set currentTime(value: number) {
      fake.currentTime = value;
    }
  }
  class RemotePlayerController extends Emitter {
    constructor(readonly player: RemotePlayer) {
      super();
      fake.controllers.push(this as unknown as FakeController);
    }
    playOrPause() {
      fake.playOrPauses += 1;
      fake.isPaused = !fake.isPaused;
      fake.setPlayerState(fake.isPaused ? 'PAUSED' : 'PLAYING');
    }
    stop() {
      fake.stops += 1;
      fake.isMediaLoaded = false;
      fake.idleReason = 'CANCELLED';
      fake.setPlayerState('IDLE');
    }
    seek() {
      fake.seeks.push(fake.currentTime);
    }
    // Test hook.
    change() {
      this.emit('anyChanged');
    }
  }
  const context = (fake.context ??= new FakeContext(fake));
  return {
    cast: {
      framework: {
        CastContext: { getInstance: () => context },
        CastContextEventType: {
          CAST_STATE_CHANGED: 'caststatechanged',
          SESSION_STATE_CHANGED: 'sessionstatechanged',
        },
        SessionState: {
          SESSION_STARTED: 'SESSION_STARTED',
          SESSION_RESUMED: 'SESSION_RESUMED',
          SESSION_ENDED: 'SESSION_ENDED',
        },
        RemotePlayerEventType: { ANY_CHANGE: 'anyChanged' },
        RemotePlayer,
        RemotePlayerController,
      },
    },
    chrome: {
      cast: {
        AutoJoinPolicy: { ORIGIN_SCOPED: 'origin_scoped' },
        Image: class {
          constructor(readonly url: string) {}
        },
        Volume: class {
          constructor(readonly level: number | null) {}
        },
        media: {
          DEFAULT_MEDIA_RECEIVER_APP_ID: 'CC1AD845',
          StreamType: { LIVE: 'LIVE', BUFFERED: 'BUFFERED' },
          MediaCommand: { STREAM_VOLUME: 'STREAM_VOLUME' },
          MediaInfo: class {
            streamType = 'BUFFERED';
            metadata: unknown = null;
            constructor(
              readonly contentId: string,
              readonly contentType: string
            ) {}
          },
          MusicTrackMediaMetadata: class {},
          LoadRequest: class {
            autoplay = true;
            currentTime: number | undefined;
            constructor(readonly media: object) {}
          },
          VolumeRequest: class {
            constructor(readonly volume: { level: number | null }) {}
          },
        },
      },
    },
  };
}
