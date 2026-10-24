// A DASH source (`.mpd`) played by Shaka Player on a video player's
// `<video>`: no browser plays DASH itself. Shaka is optional: the app
// registers it with `configureShaka` (see src/core/shaka.ts).
//
// Shaka loads the manifest and the segments and feeds the element through
// Media Source Extensions; its ABR picks the variant under RNAP's caps.
// Everything above it stays RNAP's: a critical Shaka error is reported as a
// failure and the engine re-opens the item (a new Shaka player) under its own
// backoff. Its audio languages and text tracks are the source's tracks
// (`HlsTracks`, the same shape hls.js has), its text cues load into a hidden
// track that RNAP's overlay draws.
//
// This module loads on first use, with a dynamic `import` (see
// MediaElementDriver.startDash): a page that never plays DASH does not carry it.

import type { HlsMediaTrack } from '../../core/hls';
import type {
  ShakaError,
  ShakaLike,
  ShakaPlayerLike,
  ShakaTrack,
} from '../../core/shaka';
import type { PlayerError } from '../../errors';
import {
  engineError,
  type QualityConstraints,
  type ReadyInfo,
  type SourceDescriptor,
  type VideoVariant,
} from '../engine/types';
import type { AudioElementLike } from './dom';
import type { HlsTracks } from './MediaTracks';

export interface DashListener {
  /** Shaka gave up (a critical error). */
  onFailure(error: PlayerError): void;
  /** A diagnostics note. */
  onNote(event: string, details: Record<string, string>): void;
  /** The pictures to choose from, once the manifest is loaded. */
  onVariants?(variants: VideoVariant[]): void;
  /** The picture playing changed. */
  onVariantSwitched?(id: string): void;
  /** Shaka's bandwidth estimate, bits per second. */
  onBandwidth?(bitsPerSecond: number): void;
  /** The audio languages or text tracks changed. */
  onTracks?(): void;
  /** The manifest is loaded: the element can play. */
  onLoaded?(): void;
}

const DESCRIBES_VIDEO = 'public.accessibility.describes-video';
const CAPTIONS = 'public.accessibility.transcribes-spoken-dialog';

/** A picture's id in `status.video.qualities`. */
const pictureId = (videoId: number) => `v${videoId}`;

/** Shaka's error categories (`shaka.util.Error.Category`). */
const NETWORK = 1;
const MEDIA = 3;
const BAD_HTTP_STATUS = 1001;
const CRITICAL = 2;

let polyfilled = false;

/** The failure for a critical Shaka error. */
export function shakaFailure(error: ShakaError): PlayerError {
  const details = {
    platformDomain: 'shaka',
    platformCode: error.code,
    cause: `category ${error.category}, code ${error.code}`,
  };
  if (error.category === NETWORK) {
    const status =
      error.code === BAD_HTTP_STATUS && typeof error.data?.[1] === 'number'
        ? (error.data[1] as number)
        : null;
    if (status === 404 || status === 410)
      return engineError(
        'SOURCE_NOT_FOUND',
        `The server returned HTTP ${status}.`,
        false,
        {
          ...details,
          httpStatus: status,
        }
      );
    if (status != null)
      return engineError(
        'HTTP_ERROR',
        `The server returned HTTP ${status}.`,
        status >= 500 || status === 429,
        {
          ...details,
          httpStatus: status,
        }
      );
    return engineError(
      'NETWORK_ERROR',
      'A network error interrupted the DASH stream.',
      true,
      details
    );
  }
  if (error.category === MEDIA)
    return engineError(
      'DECODER_ERROR',
      'The DASH media could not be decoded.',
      true,
      details
    );
  return engineError(
    'UNSUPPORTED_FORMAT',
    'Shaka Player could not play the DASH stream.',
    false,
    details
  );
}

/** The pictures, one per `videoId` (variants that share it differ by their sound), lowest first. */
export function picturesOf(tracks: readonly ShakaTrack[]): VideoVariant[] {
  const pictures = new Map<number, ShakaTrack>();
  for (const t of tracks) {
    if (t.videoId == null) continue;
    const known = pictures.get(t.videoId);
    if (!known || (t.bandwidth ?? 0) < (known.bandwidth ?? 0))
      pictures.set(t.videoId, t);
  }
  return [...pictures.values()]
    .sort((a, b) => (a.height ?? 0) - (b.height ?? 0))
    .map((t) => ({
      id: pictureId(t.videoId!),
      height: t.height ?? null,
      bitrate: t.bandwidth ?? null,
      audioOnly: false,
      label: null,
    }));
}

export class DashStream implements HlsTracks {
  private player: ShakaPlayerLike | null = null;
  private constraints: QualityConstraints | null = null;
  private loaded = false;
  private closed = false;
  /** A critical error was reported: later element errors are the same failure. */
  failed = false;
  /** The sounds to choose from: one per language and role. */
  private sounds: Array<{
    language: string;
    role: string | undefined;
    track: HlsMediaTrack;
  }> = [];
  private texts: ShakaTrack[] = [];
  private lastPicture: string | null = null;

  constructor(
    private readonly element: AudioElementLike,
    private readonly source: SourceDescriptor,
    private readonly shaka: ShakaLike,
    private readonly listener: DashListener
  ) {}

  /** Attaches Shaka and loads the manifest (at `startTime` when given). */
  async start(startTime: number | null): Promise<void> {
    if (!polyfilled) {
      polyfilled = true;
      this.shaka.polyfill?.installAll();
    }
    const player = new this.shaka.Player();
    this.player = player;
    player.addEventListener('error', (event: { detail?: ShakaError }) => {
      const error = event?.detail;
      if (!error || error.severity !== CRITICAL) return;
      this.fail(shakaFailure(error));
    });
    player.addEventListener('trackschanged', () => this.tracksChanged());
    player.addEventListener('variantchanged', () => this.pictureChanged());
    player.addEventListener('adaptation', () => {
      this.pictureChanged();
      const bps = player.getStats().estimatedBandwidth;
      if (bps != null && Number.isFinite(bps) && bps > 0)
        this.listener.onBandwidth?.(bps);
    });
    // Text segments load while RNAP's overlay, not Shaka, shows them.
    player.configure({ streaming: { alwaysStreamText: true } });
    const headers = Object.entries(this.source.headers);
    if (headers.length > 0) {
      player.getNetworkingEngine()?.registerRequestFilter((_type, request) => {
        for (const [name, value] of headers) request.headers[name] = value;
      });
    }
    try {
      await player.attach(this.element);
      // Shaka 4: cues load hidden (Shaka 5 has no such switch: RNAP hides
      // the track it shows, see MediaTracks).
      player.setTextTrackVisibility?.(false);
      await player.load(this.source.uri, startTime);
    } catch (error) {
      if (this.closed) return;
      const shakaError = error as ShakaError;
      this.fail(
        typeof shakaError?.category === 'number'
          ? shakaFailure(shakaError)
          : engineError(
              'UNSUPPORTED_FORMAT',
              `Shaka Player could not load the stream (${String(error)}).`,
              false
            )
      );
      return;
    }
    if (this.closed) return;
    this.loaded = true;
    this.listener.onNote('dash manifest', {
      variants: `${player.getVariantTracks().length}`,
    });
    this.tracksChanged();
    this.applyQuality();
    this.listener.onLoaded?.();
  }

  private fail(error: PlayerError): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.listener.onFailure(error);
    // Nothing more is wanted from it; the engine opens the item anew.
    this.close();
  }

  /** Detaches from the element and frees Shaka. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const player = this.player;
    this.player = null;
    player?.destroy().catch(() => undefined);
  }

  // ── What the manifest offers ──

  private tracksChanged(): void {
    const player = this.player;
    if (!player || !this.loaded) return;
    const variants = player.getVariantTracks();
    this.listener.onVariants?.(picturesOf(variants));
    // Shaka 5 lists the sounds; Shaka 4's are the variants' languages and roles.
    const listed =
      player.getAudioTracks?.().map((a) => ({
        language: a.language,
        role: a.roles?.[0],
        label: a.label ?? null,
      })) ??
      variants.map((v) => ({
        language: v.language,
        role: v.audioRoles?.[0] ?? undefined,
        label: v.label ?? null,
      }));
    const sounds = new Map<string, DashStream['sounds'][number]>();
    for (const a of listed) {
      const key = `${a.language}|${a.role ?? ''}`;
      if (sounds.has(key)) continue;
      sounds.set(key, {
        language: a.language,
        role: a.role,
        track: {
          name: a.label ?? undefined,
          lang: a.language && a.language !== 'und' ? a.language : undefined,
          characteristics:
            a.role === 'description' ? DESCRIBES_VIDEO : undefined,
        },
      });
    }
    this.sounds = [...sounds.values()];
    this.texts = player.getTextTracks();
    this.listener.onTracks?.();
    this.pictureChanged();
  }

  private pictureChanged(): void {
    const active = this.player?.getVariantTracks().find((t) => t.active);
    if (active?.videoId == null) return;
    const id = pictureId(active.videoId);
    if (id === this.lastPicture) return;
    this.lastPicture = id;
    this.listener.onVariantSwitched?.(id);
  }

  // ── HlsTracks ──

  get audioTracks(): ReadonlyArray<HlsMediaTrack> {
    return this.sounds.map((s) => s.track);
  }

  get subtitleTracks(): ReadonlyArray<HlsMediaTrack> {
    return this.texts.map((t) => ({
      name: t.label ?? undefined,
      lang: t.language && t.language !== 'und' ? t.language : undefined,
      forced: t.forced === true,
      characteristics: t.kind === 'caption' ? CAPTIONS : undefined,
    }));
  }

  selectAudio(index: number): void {
    const sound = this.sounds[index];
    const player = this.player;
    if (!sound || !player) return;
    const audio = player.getAudioTracks?.();
    if (audio && player.selectAudioTrack) {
      const track = audio.find(
        (a) => a.language === sound.language && a.roles?.[0] === sound.role
      );
      if (track && !track.active) player.selectAudioTrack(track);
      return;
    }
    const active = player.getVariantTracks().find((t) => t.active);
    if (
      active?.language === sound.language &&
      (active.audioRoles?.[0] ?? undefined) === sound.role
    )
      return;
    player.selectAudioLanguage?.(sound.language, sound.role);
  }

  selectSubtitles(index: number): void {
    const player = this.player;
    if (!player) return;
    const track = this.texts[index];
    if (track) {
      if (!track.active) player.selectTextTrack(track);
      return;
    }
    // None: Shaka 5 unloads the text; Shaka 4 keeps it hidden.
    if (player.getAudioTracks && this.texts.some((t) => t.active))
      player.selectTextTrack(null);
  }

  // ── Quality ──

  /** What the pictures must keep to (applied once the manifest is loaded). */
  setQuality(constraints: QualityConstraints): void {
    this.constraints = constraints;
    this.applyQuality();
  }

  private applyQuality(): void {
    const player = this.player;
    const c = this.constraints;
    if (!player || !this.loaded || !c) return;
    player.configure({
      abr: {
        enabled: c.pinned == null,
        restrictions: {
          maxHeight: c.maxHeight ?? Infinity,
          maxBandwidth: c.maxBitrate ?? Infinity,
        },
      },
    });
    if (c.pinned == null) return;
    const active = player.getVariantTracks().find((t) => t.active);
    const pinned = player
      .getVariantTracks()
      .find(
        (t) =>
          t.videoId != null &&
          pictureId(t.videoId) === c.pinned &&
          t.language === active?.language
      );
    if (pinned && !pinned.active) player.selectVariantTrack(pinned, true);
  }

  /** Whether the manifest is live; `null` until it is loaded. */
  get live(): boolean | null {
    return this.loaded && this.player ? this.player.isLive() : null;
  }

  /** What the manifest says about the item, once loaded; `null` before. */
  readyInfo(): ReadyInfo | null {
    if (!this.loaded || !this.player) return null;
    if (this.player.isLive())
      return { duration: null, isLive: true, seekable: false };
    const duration = this.element.duration;
    return Number.isFinite(duration) && duration > 0
      ? { duration, isLive: false, seekable: true }
      : null;
  }
}
