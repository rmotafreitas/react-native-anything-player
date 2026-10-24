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
//
// This module (and the ID3 reader it imports) loads on first use, with a
// dynamic `import` (see MediaElementDriver.startHls): a page that never plays
// HLS does not carry it. `hlsFormats.ts` holds what the eager code needs.

import type { PlayerError } from '../../errors';
import type {
  HlsConstructor,
  HlsErrorData,
  HlsLevel,
  HlsLevelDetails,
  HlsLike,
  HlsMediaTrack,
  HlsMetadataSample,
} from '../../core/hls';
import type { HlsTracks } from './MediaTracks';
import type { StreamMetadata } from '../engine/StreamMetadata';
import {
  engineError,
  type QualityConstraints,
  type ReadyInfo,
  type SourceDescriptor,
  type VideoVariant,
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
  /** Video: the variants, once the master playlist is parsed. */
  onVariants?(variants: VideoVariant[]): void;
  /** Video: the variant playing changed. */
  onVariantSwitched?(id: string): void;
  /** Video: hls.js's bandwidth estimate, bits per second. */
  onBandwidth?(bitsPerSecond: number): void;
  /** Video: the audio or subtitle renditions changed. */
  onTracks?(): void;
}

/** A variant's id in `status.video.qualities`. */
const variantId = (index: number) => `v${index}`;

/** An audio-only level: an audio codec and no picture. */
function isAudioOnly(level: HlsLevel): boolean {
  return !level.videoCodec && !!level.audioCodec && !level.height;
}

/** hls.js levels as qualities. */
export function variantsOf(levels: ReadonlyArray<HlsLevel>): VideoVariant[] {
  return levels.map((level, i) => ({
    id: variantId(i),
    height: level.height || null,
    bitrate: level.bitrate || null,
    audioOnly: isAudioOnly(level),
    label: level.name ?? null,
  }));
}

/** The highest level the caps allow (`-1`: none are needed). */
export function levelCap(
  levels: ReadonlyArray<HlsLevel>,
  c: QualityConstraints
): number {
  if (c.maxHeight == null && c.maxBitrate == null) return -1;
  let cap = -1;
  levels.forEach((level, i) => {
    const tall = c.maxHeight != null && (level.height ?? 0) > c.maxHeight;
    const heavy = c.maxBitrate != null && (level.bitrate ?? 0) > c.maxBitrate;
    if (!tall && !heavy && !isAudioOnly(level)) cap = i;
  });
  // Nothing fits: the lowest video level, rather than none at all.
  return cap >= 0 ? cap : levels.findIndex((l) => !isAudioOnly(l));
}

/** hls.js `ErrorDetails.MANIFEST_LOAD_ERROR`: the playlist itself could not be loaded. */
const MANIFEST_LOAD_ERROR = 'manifestLoadError';

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

export class HlsStream implements HlsTracks {
  private hls: HlsLike | null = null;
  private details: HlsLevelDetails | null = null;
  /** A fatal error was reported: later element errors are the same failure. */
  failed = false;
  private closed = false;
  private constraints: QualityConstraints | null = null;

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
    // Subtitles load into hidden text tracks: RNAP's overlay draws them.
    hls.subtitleDisplay = false;
    hls.on(Events.MANIFEST_PARSED, (_event, data) => {
      this.listener.onNote('hls manifest', {
        levels: `${data?.levels?.length ?? 0}`,
      });
      this.listener.onVariants?.(variantsOf(hls.levels ?? []));
      this.applyQuality();
      this.listener.onTracks?.();
    });
    for (const event of [
      Events.AUDIO_TRACKS_UPDATED,
      Events.SUBTITLE_TRACKS_UPDATED,
    ]) {
      if (event) hls.on(event, () => this.listener.onTracks?.());
    }
    if (Events.LEVEL_SWITCHED) {
      hls.on(Events.LEVEL_SWITCHED, (_event, data) => {
        if (typeof data?.level === 'number')
          this.listener.onVariantSwitched?.(variantId(data.level));
      });
    }
    if (Events.FRAG_LOADED) {
      hls.on(Events.FRAG_LOADED, () => {
        const bps = hls.bandwidthEstimate;
        if (bps != null && Number.isFinite(bps) && bps > 0)
          this.listener.onBandwidth?.(bps);
      });
    }
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

  // ── Video: the renditions (HlsTracks) ──

  get audioTracks(): ReadonlyArray<HlsMediaTrack> {
    return this.hls?.audioTracks ?? [];
  }

  get subtitleTracks(): ReadonlyArray<HlsMediaTrack> {
    return this.hls?.subtitleTracks ?? [];
  }

  selectAudio(index: number): void {
    const hls = this.hls;
    if (hls && hls.audioTrack !== index) hls.audioTrack = index;
  }

  selectSubtitles(index: number): void {
    const hls = this.hls;
    if (!hls) return;
    hls.subtitleDisplay = false;
    if (hls.subtitleTrack !== index) hls.subtitleTrack = index;
  }

  /** Video: what the variants must keep to (applied once the levels are known). */
  setQuality(constraints: QualityConstraints): void {
    this.constraints = constraints;
    this.applyQuality();
  }

  private applyQuality(): void {
    const hls = this.hls;
    const c = this.constraints;
    const levels = hls?.levels;
    if (hls == null || c == null || levels == null || levels.length === 0)
      return;
    hls.autoLevelCapping = levelCap(levels, c);
    hls.currentLevel = this.pinnedLevel(levels, c);
  }

  /** The level to hold (`-1`: automatic): the app's pick, or audio only. */
  private pinnedLevel(
    levels: ReadonlyArray<HlsLevel>,
    c: QualityConstraints
  ): number {
    if (c.audioOnly) {
      const audio = levels.findIndex(isAudioOnly);
      if (audio >= 0) return audio;
    }
    if (c.pinned == null) return -1;
    return levels.findIndex((_, i) => variantId(i) === c.pinned);
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
