// A scripted page for the video stage's tests: boxes that nest and detach,
// a <video> with its tracks, fullscreen / Picture in Picture state, the
// observers a test fires by hand, and the screen wake lock.

import { FakeEvents } from './FakeBrowser';
import type {
  ObserverLike,
  TextTrackLike,
  VttCueLike,
  WakeLockSentinelLike,
} from '../platform/dom';

export class FakeNode extends FakeEvents {
  style: Record<string, string> = {};
  className = '';
  private text: string | null = null;
  parentNode: FakeNode | null = null;
  children: FakeNode[] = [];
  attributes: Record<string, string> = {};
  requestFullscreen?: () => Promise<void>;
  webkitRequestFullscreen?: () => void;
  replaceChildren?: (...children: FakeNode[]) => void = (...children) => {
    this.children.forEach((c) => (c.parentNode = null));
    this.children = [];
    children.forEach((c) => this.appendChild(c));
  };

  get textContent(): string | null {
    return this.text;
  }

  /** Like the DOM: setting the text drops the children. */
  set textContent(value: string | null) {
    this.text = value;
    this.children.forEach((c) => (c.parentNode = null));
    this.children = [];
  }

  appendChild(child: FakeNode): FakeNode {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove(): void {
    const parent = this.parentNode;
    if (parent) parent.children = parent.children.filter((c) => c !== this);
    this.parentNode = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  /** The text of the children, one line each. */
  get lines(): string[] {
    return this.children.map((c) =>
      c.children.map((s) => s.textContent).join('')
    );
  }
}

/** A `<video>` as far as the stage and the tracks see it. */
export class FakeVideo extends FakeNode {
  src = '';
  poster = '';
  controls = false;
  currentTime = 0;
  paused = true;
  playbackRate = 1;
  webkitPresentationMode?: string;
  requestPictureInPicture?: () => Promise<unknown>;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
}

export class FakeTrackList<T> extends FakeEvents {
  items: T[] = [];

  get length(): number {
    return this.items.length;
  }

  add(item: T): void {
    this.items.push(item);
    this.dispatch('addtrack');
  }

  remove(item: T): void {
    this.items = this.items.filter((i) => i !== item);
    this.dispatch('removetrack');
  }

  /** A list indexable like a DOM one. */
  asList(): FakeTrackList<T> & Record<number, T> {
    return new Proxy(this, {
      get: (target, key) =>
        typeof key === 'string' && /^\d+$/.test(key)
          ? target.items[Number(key)]
          : Reflect.get(target, key),
    }) as FakeTrackList<T> & Record<number, T>;
  }
}

export class FakeTextTrack extends FakeEvents implements TextTrackLike {
  mode = 'disabled';
  cues: VttCueLike[] = [];

  constructor(
    readonly kind = 'subtitles',
    readonly label = '',
    readonly language = ''
  ) {
    super();
  }

  get activeCues(): TextTrackLike['activeCues'] {
    return this.cues.length > 0 ? (this.cues as never) : null;
  }

  /** The cues on screen now change. */
  showCues(...cues: VttCueLike[]): void {
    this.cues = cues;
    this.dispatch('cuechange');
  }
}

export class FakeAudioTrack {
  constructor(
    readonly id: string,
    readonly kind = '',
    readonly label = '',
    readonly language = '',
    public enabled = false
  ) {}
}

export class FakeObserver implements ObserverLike {
  static all: FakeObserver[] = [];
  observed: unknown[] = [];
  disconnected = false;

  constructor(readonly callback: (entries: never[]) => void) {
    FakeObserver.all.push(this);
  }

  observe(target: unknown): void {
    this.observed.push(target);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  fire(entry: unknown): void {
    this.callback([entry as never]);
  }
}

export class FakeIntersectionObserver extends FakeObserver {}
export class FakeResizeObserver extends FakeObserver {}

export const observers = (kind: typeof FakeObserver) =>
  FakeObserver.all.filter((o) => o instanceof kind);

export interface FakePage {
  document: FakeNode & {
    visibilityState: string;
    fullscreenElement?: unknown;
    webkitFullscreenElement?: unknown;
    pictureInPictureElement?: unknown;
    exitFullscreen?: () => Promise<void>;
    webkitExitFullscreen?: () => void;
    exitPictureInPicture?: () => Promise<void>;
    createElement(tag: string): FakeNode;
  };
  locks: Array<{ released: boolean }>;
  /** Makes the next wake lock requests fail. */
  denyWakeLock(): void;
  orientation: { lock: jest.Mock; unlock: jest.Mock };
}

const KEYS = [
  'document',
  'navigator',
  'screen',
  'devicePixelRatio',
  'IntersectionObserver',
  'ResizeObserver',
] as const;

let saved: Partial<Record<(typeof KEYS)[number], PropertyDescriptor>> = {};

/** Puts the fake page on `globalThis` (undo with `uninstallPage`). */
export function installPage(
  options: { wakeLock?: boolean; observers?: boolean } = {}
): FakePage {
  const g = globalThis as Record<string, unknown>;
  saved = {};
  for (const k of KEYS) saved[k] = Object.getOwnPropertyDescriptor(g, k);
  FakeObserver.all = [];

  const document = Object.assign(new FakeNode(), {
    visibilityState: 'visible',
    createElement: (_tag: string) => new FakeNode(),
  }) as unknown as FakePage['document'];

  const locks: FakePage['locks'] = [];
  let denied = false;
  const wakeLock = {
    request: async (): Promise<WakeLockSentinelLike> => {
      if (denied) throw new Error('NotAllowedError');
      const lock = { released: false };
      locks.push(lock);
      return {
        release: async () => {
          lock.released = true;
        },
      };
    },
  };
  const orientation = { lock: jest.fn(async () => {}), unlock: jest.fn() };

  const define = (key: string, value: unknown) =>
    Object.defineProperty(g, key, {
      value,
      configurable: true,
      writable: true,
    });
  define('document', document);
  define('navigator', {
    onLine: true,
    ...(options.wakeLock === false ? {} : { wakeLock }),
  });
  define('screen', { orientation });
  define('devicePixelRatio', 2);
  if (options.observers !== false) {
    define('IntersectionObserver', FakeIntersectionObserver);
    define('ResizeObserver', FakeResizeObserver);
  } else {
    define('IntersectionObserver', undefined);
    define('ResizeObserver', undefined);
  }
  return {
    document,
    locks,
    denyWakeLock: () => {
      denied = true;
    },
    orientation,
  };
}

export function uninstallPage(): void {
  const g = globalThis as Record<string, unknown>;
  for (const k of KEYS) {
    const d = saved[k];
    if (d) Object.defineProperty(g, k, d);
    else delete g[k];
  }
  saved = {};
}
