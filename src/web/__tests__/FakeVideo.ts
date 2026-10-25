/// <reference types="node" />
// A scripted <video> for the web video drivers' unit tests: the fake <audio>
// element with a picture, the styled boxes a stage is made of, and a driver
// observer that records what it is told. Built on the fake browser.

import type { DriverObserver } from '../platform/MediaElementDriver';
import { FakeAudio, FakeEvents, install, type FakeWorld } from './FakeBrowser';

/** A `<div>` / `<span>`: the video stage, the overlay and its cue lines. */
export class FakeBox extends FakeEvents {
  style: Record<string, string> = {};
  className = '';
  textContent: string | null = '';
  parentNode: FakeBox | null = null;
  children: unknown[] = [];
  attributes: Record<string, string> = {};

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  appendChild(child: unknown): unknown {
    this.children.push(child);
    (child as { parentNode?: FakeBox | null }).parentNode = this;
    return child;
  }

  removeChild(child: unknown): unknown {
    this.children = this.children.filter((c) => c !== child);
    (child as { parentNode?: FakeBox | null }).parentNode = null;
    return child;
  }

  replaceChildren(...children: unknown[]): void {
    this.children = [];
    children.forEach((c) => this.appendChild(c));
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }
}

/** A `TextTrack`: its cues come and go with `showCues`. */
export class FakeTextTrack extends FakeEvents {
  /** The list this track is in: it hears of a mode change as `change`. */
  list: FakeTrackList<FakeTextTrack> | null = null;
  private _mode = 'disabled';
  activeCues: {
    length: number;
    [index: number]: { startTime: number; endTime: number; text: string };
  } | null = null;

  constructor(
    readonly kind: string,
    readonly label: string,
    readonly language: string
  ) {
    super();
  }

  get mode(): string {
    return this._mode;
  }

  set mode(mode: string) {
    if (mode === this._mode) return;
    this._mode = mode;
    this.list?.dispatch('change');
  }

  showCues(cues: Array<{ startTime: number; endTime: number; text: string }>) {
    this.activeCues = Object.assign({ length: cues.length }, cues);
    this.dispatch('cuechange');
  }
}

/** A `TextTrackList` / `AudioTrackList`. */
export class FakeTrackList<T> extends FakeEvents {
  length = 0;
  [index: number]: T;

  add(track: T): void {
    this[this.length] = track;
    this.length += 1;
    this.dispatch('addtrack');
  }
}

export interface FakeAudioTrack {
  id: string;
  kind: string;
  label: string;
  language: string;
  enabled: boolean;
}

/** Which optional parts of a `<video>` the next ones have. */
export const videoFeatures = {
  fastSeek: false,
  frameCallback: false,
  /** MIME types `canPlayType` accepts (besides HLS, see `install({ nativeHls })`). */
  mimeTypes: [] as string[],
  /** The element takes Encrypted Media Extensions keys (`setMediaKeys`). */
  mediaKeys: false,
  /** Safari-like track lists: the audio tracks and the text tracks each new `<video>` has. */
  audioTracks: null as Array<Omit<FakeAudioTrack, 'enabled'>> | null,
  textTracks: null as Array<
    [kind: string, label: string, language: string]
  > | null,
};

export class FakeVideo extends FakeAudio {
  style: Record<string, string> = {};
  className = '';
  parentNode: FakeBox | null = null;

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  attributes: Record<string, string> = {};
  videoWidth = 0;
  videoHeight = 0;
  poster = '';
  loop = false;
  playsInline = false;
  controls = false;
  /** Positions `fastSeek` was asked for. */
  fastSeeks: number[] = [];
  /** Frame callbacks waiting for `drawFrame()`. */
  frameCallbacks: Array<() => void> = [];
  fastSeek?: (time: number) => void;
  requestVideoFrameCallback?: (callback: () => void) => number;
  audioTracks?: FakeTrackList<FakeAudioTrack>;
  textTracks?: FakeTrackList<FakeTextTrack>;
  /** The keys attached with `setMediaKeys`. */
  keys: unknown = null;
  setMediaKeys?: (keys: unknown) => Promise<void>;

  constructor() {
    super();
    if (videoFeatures.mediaKeys) {
      this.setMediaKeys = (keys) => {
        this.keys = keys;
        return Promise.resolve();
      };
    }
    if (videoFeatures.audioTracks) {
      this.audioTracks = new FakeTrackList();
      videoFeatures.audioTracks.forEach((t, i) =>
        this.audioTracks!.add({ ...t, enabled: i === 0 })
      );
    }
    if (videoFeatures.textTracks) {
      this.textTracks = new FakeTrackList();
      videoFeatures.textTracks.forEach(([kind, label, language]) => {
        const track = new FakeTextTrack(kind, label, language);
        track.list = this.textTracks!;
        this.textTracks!.add(track);
      });
    }
    if (videoFeatures.fastSeek)
      this.fastSeek = (time) => {
        this.fastSeeks.push(time);
        this.currentTime = time;
      };
    if (videoFeatures.frameCallback) {
      this.requestVideoFrameCallback = (callback) =>
        this.frameCallbacks.push(callback);
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  override canPlayType(type: string): string {
    return videoFeatures.mimeTypes.includes(type)
      ? 'probably'
      : super.canPlayType(type);
  }

  /** The picture is known: its size, as `loadedmetadata` would report it. */
  size(width: number, height: number): void {
    this.videoWidth = width;
    this.videoHeight = height;
  }

  /** The first frame is on screen (`requestVideoFrameCallback` fires). */
  drawFrame(): void {
    this.frameCallbacks.splice(0).forEach((callback) => callback());
  }
}

export interface FakeVideoWorld extends FakeWorld {
  /** The `<video>`s the page made, in order. */
  videos: FakeVideo[];
  /** The boxes (`div`, `span`) the page made, in order. */
  boxes: FakeBox[];
  video(): FakeVideo;
}

/** Installs the fake browser with `<video>` and boxes (`uninstall()` from FakeBrowser restores it). */
export function installVideo(
  options: Parameters<typeof install>[0] = {},
  features: Partial<typeof videoFeatures> = {}
): FakeVideoWorld {
  videoFeatures.fastSeek = features.fastSeek === true;
  videoFeatures.frameCallback = features.frameCallback === true;
  videoFeatures.mimeTypes = features.mimeTypes ?? [];
  videoFeatures.mediaKeys = features.mediaKeys === true;
  videoFeatures.audioTracks = features.audioTracks ?? null;
  videoFeatures.textTracks = features.textTracks ?? null;
  const world = install(options);
  const videos: FakeVideo[] = [];
  const boxes: FakeBox[] = [];
  const document = world.document as unknown as {
    createElement: (tag: string) => unknown;
  };
  const create = document.createElement;
  document.createElement = (tag: string) => {
    if (tag === 'video') {
      const video = new FakeVideo();
      videos.push(video);
      world.elements.push(video);
      return video;
    }
    if (tag === 'div' || tag === 'span') {
      const box = new FakeBox();
      boxes.push(box);
      return box;
    }
    return create(tag);
  };
  return { ...world, videos, boxes, video: () => videos[videos.length - 1]! };
}

export type Call = { name: string; args: unknown[] };

const REQUIRED = [
  'onReady',
  'onPlaying',
  'onBuffering',
  'onEnded',
  'onFailed',
  'onPausedExternally',
  'onStreamMetadata',
  'onDiscontinuity',
  'onNote',
  'onElementReplaced',
];

const OPTIONAL = [
  'onVideoInfo',
  'onFirstFrame',
  'onVariants',
  'onBandwidth',
  'onTracks',
  'onSourceCues',
  'onUserCommand',
  'onLicenseRequest',
  'onWarning',
];

/** A driver observer that records every call; `optional: false` has only the required ones. */
export function recorder(optional = true) {
  const calls: Call[] = [];
  const observer: Record<string, (...args: unknown[]) => void> = {};
  for (const name of optional ? [...REQUIRED, ...OPTIONAL] : REQUIRED)
    observer[name] = (...args) => calls.push({ name, args });
  return {
    observer: observer as unknown as DriverObserver,
    calls,
    /** The arguments of each call of `name`. */
    of: (name: string) =>
      calls.filter((c) => c.name === name).map((c) => c.args),
    names: () => calls.map((c) => c.name),
  };
}
