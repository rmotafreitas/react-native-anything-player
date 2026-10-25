/// <reference types="node" />
// Scripted stream engines for the video driver's unit tests: hls.js with
// levels and renditions, stand-ins for the remuxer and Shaka (their own
// suites test the real ones), and Encrypted Media Extensions.

import type { HlsLevel, HlsMediaTrack, HlsConstructor } from '../../core/hls';
import type { ShakaLike } from '../../core/shaka';
import type { PlayerError } from '../../errors';
import type {
  QualityConstraints,
  ReadyInfo,
  SourceDescriptor,
  VideoVariant,
} from '../engine/types';
import { FakeEvents } from './FakeBrowser';
import { FakeHls } from './FakeHls';

/** hls.js with the video parts: levels, audio and subtitle renditions, caps. */
export class RichHls extends FakeHls {
  static Events = {
    ...FakeHls.Events,
    LEVEL_SWITCHED: 'hlsLevelSwitched',
    FRAG_LOADED: 'hlsFragLoaded',
    AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated',
    SUBTITLE_TRACKS_UPDATED: 'hlsSubtitleTracksUpdated',
  };

  levels: HlsLevel[] = [];
  audioTracks: HlsMediaTrack[] = [];
  subtitleTracks: HlsMediaTrack[] = [];
  currentLevel?: number;
  autoLevelCapping?: number;
  bandwidthEstimate?: number;
  audioTrack?: number;
  subtitleTrack?: number;
  subtitleDisplay?: boolean;

  static override last(): RichHls {
    return FakeHls.last() as RichHls;
  }

  /** The master playlist was parsed with these levels. */
  parse(levels: HlsLevel[]): void {
    this.levels = levels;
    this.emit(RichHls.Events.MANIFEST_PARSED, { levels });
  }

  switched(level: unknown): void {
    this.emit(RichHls.Events.LEVEL_SWITCHED, { level });
  }

  fragment(bandwidth: number | undefined): void {
    this.bandwidthEstimate = bandwidth;
    this.emit(RichHls.Events.FRAG_LOADED, {});
  }

  renditions(audio: HlsMediaTrack[], subtitles: HlsMediaTrack[]): void {
    this.audioTracks = audio;
    this.subtitleTracks = subtitles;
    this.emit(RichHls.Events.AUDIO_TRACKS_UPDATED, {});
    this.emit(RichHls.Events.SUBTITLE_TRACKS_UPDATED, {});
  }

  /** A non-fatal error, as hls.js reports a retried fragment. */
  hiccup(): void {
    this.emit(RichHls.Events.ERROR, {
      type: RichHls.ErrorTypes.NETWORK_ERROR,
      details: 'fragLoadError',
      fatal: false,
    });
  }
}

export const asHls = (ctor: unknown) => ctor as HlsConstructor;

/** An hls.js whose constructor throws (an extension of hls.js that fails). */
export class BrokenHls extends FakeHls {
  constructor() {
    super();
    throw new Error('worker blocked');
  }
}

// ── The remuxer and Shaka, as the driver sees them ──

export interface RemuxCallbacks {
  onFailure(error: PlayerError): void;
  onFallback(reason: string): void;
  onNote(event: string, details: Record<string, string>): void;
  onTracks?(): void;
  onWarning?(error: PlayerError): void;
}

/** What `RemuxStream` is for the driver. */
export class FakeRemuxStream {
  static instances: FakeRemuxStream[] = [];
  static last(): FakeRemuxStream {
    return FakeRemuxStream.instances[FakeRemuxStream.instances.length - 1]!;
  }

  started = false;
  closed = false;
  failed = false;
  live: boolean | null = null;
  info: ReadyInfo | null = null;
  audioTracks: HlsMediaTrack[] = [];
  subtitleTracks: HlsMediaTrack[] = [];

  constructor(
    readonly element: unknown,
    readonly source: SourceDescriptor,
    readonly media: unknown,
    readonly format: string | null,
    readonly withVideo: boolean,
    readonly listener: RemuxCallbacks
  ) {
    FakeRemuxStream.instances.push(this);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  readyInfo(): ReadyInfo | null {
    return this.info;
  }

  selectAudio(): void {}

  selectSubtitles(): void {}
}

export interface DashCallbacks {
  onFailure(error: PlayerError): void;
  onNote(event: string, details: Record<string, string>): void;
  onVariants?(variants: VideoVariant[]): void;
  onVariantSwitched?(id: string): void;
  onBandwidth?(bitsPerSecond: number): void;
  onTracks?(): void;
  onLoaded?(): void;
  requestLicense?(request: {
    keySystem: 'fairplay' | 'widevine' | 'playready' | 'clearkey';
    challenge: Uint8Array;
    contentId: string | null;
    licenseUrl: string | null;
    headers: Record<string, string>;
  }): Promise<Uint8Array>;
}

/** What `DashStream` is for the driver. */
export class FakeDashStream {
  static instances: FakeDashStream[] = [];
  static last(): FakeDashStream {
    return FakeDashStream.instances[FakeDashStream.instances.length - 1]!;
  }

  starts: Array<number | null> = [];
  closed = false;
  failed = false;
  live: boolean | null = null;
  info: ReadyInfo | null = null;
  qualities: QualityConstraints[] = [];
  audioTracks: HlsMediaTrack[] = [];
  subtitleTracks: HlsMediaTrack[] = [];

  constructor(
    readonly element: unknown,
    readonly source: SourceDescriptor,
    readonly shaka: ShakaLike,
    readonly listener: DashCallbacks
  ) {
    FakeDashStream.instances.push(this);
  }

  start(startTime: number | null): Promise<void> {
    this.starts.push(startTime);
    return Promise.resolve();
  }

  setQuality(constraints: QualityConstraints): void {
    this.qualities.push(constraints);
  }

  close(): void {
    this.closed = true;
  }

  readyInfo(): ReadyInfo | null {
    return this.info;
  }

  selectAudio(): void {}

  selectSubtitles(): void {}
}

/** The `shaka` namespace RNAP is handed. */
export function fakeShaka(supported = true): ShakaLike {
  return {
    Player: Object.assign(function Player() {}, {
      isBrowserSupported: () => supported,
    }) as unknown as ShakaLike['Player'],
  };
}

// ── Encrypted Media Extensions ──

/** A `MediaKeySession`: it asks for a license on `generateRequest`, takes it with `update`. */
export class FakeKeySession extends FakeEvents {
  requests: Array<{ type: string; data: Uint8Array }> = [];
  licenses: Uint8Array[] = [];
  closed = false;

  generateRequest(type: string, data: Uint8Array): Promise<void> {
    this.requests.push({ type, data });
    return Promise.resolve();
  }

  update(license: Uint8Array): Promise<void> {
    this.licenses.push(license);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** The CDM's license challenge. */
  challenge(bytes: Uint8Array): void {
    this.dispatch('message', {
      message: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ),
    });
  }
}

/** The key systems a browser grants, and the sessions it made. */
export class FakeEme {
  sessions: FakeKeySession[] = [];
  requested: string[] = [];
  keys = {
    createSession: () => {
      const session = new FakeKeySession();
      this.sessions.push(session);
      return session;
    },
    setServerCertificate: () => Promise.resolve(true),
  };

  constructor(readonly granted: string[]) {}

  requestMediaKeySystemAccess = (id: string) => {
    this.requested.push(id);
    if (!this.granted.includes(id)) return Promise.reject(new Error('no'));
    return Promise.resolve({
      keySystem: id,
      createMediaKeys: () => Promise.resolve(this.keys),
    });
  };
}
