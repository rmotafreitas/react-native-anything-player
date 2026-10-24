// A Matroska / WebM / MPEG-TS file or stream the browser cannot play itself,
// remuxed to fragmented MP4 in the page (src/web/remux/) and fed to the
// element through Media Source Extensions. Nothing is decoded: the frames
// are only given another container, so the browser decodes what it would
// decode in an MP4.
//
// - The file is read with range requests: a seek in a Matroska file starts
//   at the cluster its Cues name, one in a TS file at the byte its bitrate
//   suggests (corrected after the landing), and a TS file's duration is read
//   from its last timestamps. A server without ranges is read from the start.
// - A source without a length (an IPTV channel, a live WebM) is live.
// - The file's audio tracks are the source's tracks: picking another one
//   muxes it from where the picture is. Its subtitle tracks (SubRip, ASS,
//   WebVTT) load into hidden text tracks that RNAP's overlay draws.
// - What RNAP cannot do here falls back: a fetch the server's CORS refuses
//   goes to the element as it is (`onFallback`); a codec the browser lacks
//   fails with UNSUPPORTED_FORMAT, naming it.
//
// This module and the remuxer load on first use, with a dynamic `import`: a
// page that never plays these files does not carry them.

import type { HlsMediaTrack } from '../../core/hls';
import {
  assEventCue,
  parseAssHeader,
  type AssScript,
} from '../../core/subtitles/ass';
import { srtTextCue } from '../../core/subtitles/srt';
import type { SubtitleCue } from '../../core/subtitles/types';
import { vttCue, vttCueText } from '../../core/subtitles/vtt';
import type { PlayerError } from '../../errors';
import {
  engineError,
  type ReadyInfo,
  type SourceDescriptor,
} from '../engine/types';
import { readUint } from '../remux/bytes';
import { MatroskaDemuxer } from '../remux/Matroska';
import { lastTimestamp } from '../remux/MpegTs';
import {
  Remuxer,
  playable,
  type RemuxFormat,
  type TrackChoice,
} from '../remux/Remuxer';
import type { RemuxCue, RemuxTrack } from '../remux/types';
import {
  browser,
  type AudioElementLike,
  type MediaSourceLike,
  type ReaderLike,
  type ResponseLike,
  type SourceBufferLike,
  type VideoElementLike,
  type WritableTextTrackLike,
  type WritableVttCue,
} from './dom';
import type { HlsTracks } from './MediaTracks';
import { discard, httpError, type MediaSourceSupport } from './MseStream';

export interface RemuxListener {
  /** It cannot go on (reported once). */
  onFailure(error: PlayerError): void;
  /** Remuxing is not possible here (the server's CORS): play on the element as it is. */
  onFallback(reason: string): void;
  /** A diagnostics note. */
  onNote(event: string, details: Record<string, string>): void;
  /** The audio or text tracks are known. */
  onTracks?(): void;
}

/** Reading pauses while this much is buffered ahead of the playhead. */
const MAX_AHEAD_S = 30;
/** What is behind the playhead is evicted past this. */
const KEEP_BEHIND_S = 30;
/** The tail read for a TS file's last timestamp (its duration). */
const TAIL_BYTES = 512 * 1024;
/** At most this much of a Matroska file is read for its Cues. */
const MAX_CUES_BYTES = 8 * 1024 * 1024;
/** Sniffing the container needs three TS packets. */
const SNIFF_BYTES = 3 * 192 + 4;
/** A seek that lands this far past its target is tried again from earlier. */
const OVERSHOOT_S = 1;
/** A seek that lands this far before its target is tried again from later. */
const UNDERSHOOT_S = 30;
const MAX_SEEK_TRIES = 3;
/** A cue without a duration (rare) stays this long. */
const DEFAULT_CUE_MS = 4000;
const TS_CLOCK = 90000;
const PTS_WRAP = 2 ** 33;
const MATROSKA_MAGIC = 0x1a45dfa3;

const ignore = () => undefined;

/** The container in the first bytes: Matroska's EBML magic, or TS sync bytes. */
export function sniffContainer(bytes: Uint8Array): RemuxFormat | null {
  if (bytes.length >= 4 && readUint(bytes, 0, 4) === MATROSKA_MAGIC)
    return 'matroska';
  for (const size of [188, 192]) {
    const lead = size - 188;
    for (let i = 0; i + lead + 2 * size < bytes.length && i < size; i++) {
      const p = i + lead;
      if (
        bytes[p] === 0x47 &&
        bytes[p + size] === 0x47 &&
        bytes[p + 2 * size] === 0x47
      )
        return 'mpegts';
    }
  }
  return null;
}

/** The start time (s) of a fragment the remuxer wrote: its first `tfdt`; `null` for an init segment. */
export function fragmentStart(
  segment: Uint8Array,
  timescales: readonly number[]
): number | null {
  // moof(8) mfhd(16) traf(8) tfhd(16: track id at +12) tfdt v1(20: time at +12)
  if (segment.length < 68 || readUint(segment, 4, 4) !== 0x6d6f6f66)
    return null;
  const track = readUint(segment, 44, 4);
  const timescale = timescales[track - 1];
  return timescale ? readUint(segment, 60, 8) / timescale : null;
}

/** Places a `VTTCue` as the cue's alignment and position say. */
function place(vtt: WritableVttCue, cue: SubtitleCue): void {
  vtt.align = cue.align;
  if (cue.x != null) vtt.position = cue.x * 100;
  if (cue.y != null) {
    vtt.snapToLines = false;
    vtt.line = cue.y * 100;
    vtt.lineAlign = { top: 'start', middle: 'center', bottom: 'end' }[
      cue.vertical
    ];
    return;
  }
  if (cue.vertical === 'top') {
    vtt.line = 0;
    return;
  }
  if (cue.vertical === 'middle') {
    vtt.snapToLines = false;
    vtt.line = 50;
    vtt.lineAlign = 'center';
  }
}

export class RemuxStream implements HlsTracks {
  /** A failure was reported: later element errors are the same one. */
  failed = false;
  private mediaSource: MediaSourceLike | null = null;
  private buffer: SourceBufferLike | null = null;
  private objectUrl: string | null = null;
  private closed = false;
  private remuxer: Remuxer | null = null;
  private sniffed: Uint8Array | null = null;
  /** The file's length; `null`: a live stream. */
  private size: number | null = null;
  /** The server answers range requests. */
  private ranges = false;
  private duration: number | null = null;
  private durationReady: Promise<void> | null = null;
  private announced = false;
  /** Each read (the first, a seek's) has its own; an older one stops. */
  private reading = 0;
  private abortRead: (() => void) | null = null;
  private seekTarget: number | null = null;
  private seekTries = 0;
  private seekOffset = 0;
  /** After the landing fragment goes in, the element moves to it (past a keyframe gap). */
  private jumpTo: number | null = null;
  /** The read after a seek lands where the element is (not a continuation ahead of it). */
  private seekJumps = true;
  /** The start (s) of the last fragment appended: where the reader is. */
  private readTime: number | null = null;
  private audioId: number | null = null;
  private mime: string | null = null;
  private unsupportedVideo: string | null = null;
  private readonly codecs = new Map<RemuxTrack, string | null>();
  private readonly texts = new Map<number, WritableTextTrackLike>();
  private readonly scripts = new Map<number, AssScript>();
  private readonly seenCues = new Set<string>();
  private readonly unlisten: Array<() => void> = [];

  constructor(
    private readonly element: AudioElementLike,
    private readonly source: SourceDescriptor,
    private readonly media: MediaSourceSupport,
    /** `null`: sniffed from the first bytes. */
    private format: RemuxFormat | null,
    /** Mux the picture (a video player). */
    private readonly withVideo: boolean,
    private readonly listener: RemuxListener
  ) {}

  /** Whether it is a live stream; `null` until known. */
  get live(): boolean | null {
    return this.remuxer?.muxed ? this.size == null : null;
  }

  start(): void {
    const g = browser();
    const mediaSource = new this.media.ctor();
    this.mediaSource = mediaSource;
    this.objectUrl = g.URL.createObjectURL(mediaSource);
    const onOpen = () => {
      mediaSource.removeEventListener('sourceopen', onOpen);
      if (!this.closed) this.read(0, true);
    };
    mediaSource.addEventListener('sourceopen', onOpen);
    // A managed media source (iOS Safari) plays with AirPlay off.
    if (this.media.managed) this.element.disableRemotePlayback = true;
    this.element.src = this.objectUrl;
    const onSeeking = () => this.seeking();
    const onTime = () => this.continuity();
    this.element.addEventListener('seeking', onSeeking);
    this.element.addEventListener('timeupdate', onTime);
    this.unlisten.push(() => {
      this.element.removeEventListener('seeking', onSeeking);
      this.element.removeEventListener('timeupdate', onTime);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abortRead?.();
    this.abortRead = null;
    this.unlisten.splice(0).forEach((off) => off());
    for (const track of this.texts.values()) track.mode = 'disabled';
    if (this.objectUrl) browser().URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }

  /** What the file says about itself, once its tracks are muxed; `null` before. */
  readyInfo(): ReadyInfo | null {
    if (!this.remuxer?.muxed) return null;
    if (this.size == null)
      return { duration: null, isLive: true, seekable: false };
    return { duration: this.duration, isLive: false, seekable: true };
  }

  private fail(error: PlayerError): void {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.abortRead?.();
    this.listener.onFailure(error);
  }

  private current(token: number): boolean {
    return !this.closed && !this.failed && token === this.reading;
  }

  // ── Reading ──

  /** Reads the file from `offset` and feeds the buffer; a newer read stops this one. */
  private read(offset: number, first: boolean): void {
    this.abortRead?.();
    this.reading += 1;
    const token = this.reading;
    this.run(offset, first, token).catch((error: unknown) => {
      if (!this.current(token)) return;
      this.fail(
        engineError('DECODER_ERROR', 'The file could not be remuxed.', false, {
          cause: String(error),
        })
      );
    });
  }

  private async run(offset: number, first: boolean, token: number) {
    const response = await this.request(offset, first, token);
    if (!response) return;
    if (!(await this.pump(response.body!.getReader(), token))) return;
    if (this.size == null) {
      this.fail(engineError('STREAM_ENDED', 'The stream ended.', true));
      return;
    }
    if (this.sniffed) await this.feed(new Uint8Array(0), token, true);
    if (!this.remuxer || !this.current(token)) return;
    if (!(await this.deliver(this.remuxer.end(), token))) return;
    await this.idle();
    if (this.current(token) && this.mediaSource?.readyState === 'open')
      this.mediaSource.endOfStream();
  }

  /** Feeds the body until it ends (`true`), or stops reading (`false`: a failure, a newer read). */
  private async pump(reader: ReaderLike, token: number): Promise<boolean> {
    for (;;) {
      let chunk: { done: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch (error) {
        if (this.current(token))
          this.fail(
            engineError('NETWORK_ERROR', 'The connection dropped.', true, {
              cause: String(error),
            })
          );
        return false;
      }
      if (chunk.done || !chunk.value) return this.current(token);
      const fed = this.current(token) && (await this.feed(chunk.value, token));
      if (!fed) {
        reader.cancel().catch(ignore);
        return false;
      }
    }
  }

  /** The response for the bytes from `offset`; `null` when it failed (reported) or was replaced. */
  private async request(
    offset: number,
    first: boolean,
    token: number
  ): Promise<ResponseLike | null> {
    const g = browser();
    const controller = new g.AbortController();
    this.abortRead = () => controller.abort();
    const ranged = first || this.ranges;
    const headers: Record<string, string> = { ...this.source.headers };
    if (ranged) headers.Range = `bytes=${offset}-`;
    let response: ResponseLike;
    try {
      response = await g.fetch(this.source.uri, {
        headers,
        signal: controller.signal,
        cache: 'no-store',
        mode: 'cors',
      });
    } catch (error) {
      if (!this.current(token)) return null;
      if (first) {
        // A CORS refusal and a network error look the same here; the
        // element reports the real network error if there is one.
        this.listener.onFallback(
          `fetch failed (CORS or network): ${String(error)}`
        );
      } else {
        this.fail(
          engineError('NETWORK_ERROR', 'The file could not be reached.', true, {
            cause: String(error),
          })
        );
      }
      return null;
    }
    if (!this.current(token)) {
      discard(response);
      return null;
    }
    if (!response.ok || !response.body) {
      discard(response);
      this.fail(
        response.ok
          ? engineError(
              'UNSUPPORTED_FORMAT',
              'The response had no body.',
              false
            )
          : httpError(response.status)
      );
      return null;
    }
    if (first) this.learnSize(response);
    return response;
  }

  private learnSize(response: ResponseLike): void {
    const length = Number.parseInt(
      response.headers.get('content-length') ?? '',
      10
    );
    this.ranges = response.status === 206;
    this.size = Number.isFinite(length) && length > 0 ? length : null;
    if (this.source.liveHint === true) this.size = null;
  }

  /** Bytes of the file from `from` to `to` (inclusive); `null` when they could not be read. */
  private async bytes(from: number, to: number): Promise<Uint8Array | null> {
    try {
      const response = await browser().fetch(this.source.uri, {
        headers: { ...this.source.headers, Range: `bytes=${from}-${to}` },
        cache: 'no-store',
        mode: 'cors',
      });
      if (response.status !== 206 || !response.arrayBuffer) {
        discard(response);
        return null;
      }
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      return null;
    }
  }

  /** Remuxes a chunk and appends what comes out; `false` once this read is over. */
  private async feed(chunk: Uint8Array, token: number, last = false) {
    const bytes = this.sniff(chunk, last);
    if (bytes === 'fallback') return false;
    if (!bytes) return true;
    const remuxer = this.remuxer!;
    const out = remuxer.push(bytes);
    if (remuxer.muxed && !this.announced) this.announce();
    if (remuxer.failure || this.unsupportedVideo) {
      const what = this.unsupportedVideo
        ? `the picture (${this.unsupportedVideo})`
        : remuxer.failure!;
      this.fail(
        engineError(
          'UNSUPPORTED_FORMAT',
          `This browser cannot play ${what}.`,
          false
        )
      );
      return false;
    }
    return this.deliver(out, token);
  }

  /**
   * The remuxer for the container the first bytes show; the bytes to push
   * (`null` while sniffing, `fallback` when it is neither).
   */
  private sniff(
    chunk: Uint8Array,
    last: boolean
  ): Uint8Array | null | 'fallback' {
    if (this.remuxer) return chunk;
    const joined = this.sniffed
      ? new Uint8Array([...this.sniffed, ...chunk])
      : chunk;
    this.sniffed = joined;
    if (!this.format && joined.length < SNIFF_BYTES && !last) return null;
    this.format ??= sniffContainer(joined);
    this.sniffed = null;
    if (!this.format) {
      this.listener.onFallback('neither Matroska nor MPEG-TS');
      return 'fallback';
    }
    this.remuxer = new Remuxer(this.format, {
      choose: (tracks) => this.choose(tracks),
    });
    this.listener.onNote('remux', { from: this.format });
    return joined;
  }

  // ── Tracks ──

  /** The MSE codec of a track: MP3 has three names, one of which the browser takes. */
  private codecOf(track: RemuxTrack): string | null {
    if (this.codecs.has(track)) return this.codecs.get(track)!;
    const kind = track.kind === 'video' ? 'video' : 'audio';
    const names =
      track.codec === 'mp4a.6B'
        ? ['mp4a.6B', 'mp3', 'mp4a.69']
        : [track.codec!];
    const found =
      names.find((c) =>
        this.media.ctor.isTypeSupported(`${kind}/mp4; codecs="${c}"`)
      ) ?? null;
    this.codecs.set(track, found);
    return found;
  }

  private choose(tracks: readonly RemuxTrack[]): TrackChoice {
    const videos = tracks.filter((t) => t.kind === 'video' && playable(t));
    let video: RemuxTrack | null = null;
    if (this.withVideo) {
      video = videos.find((t) => this.codecOf(t) != null) ?? null;
      if (!video && videos.length > 0) this.unsupportedVideo = videos[0]!.codec;
    }
    const audios = this.audioOptions(tracks);
    const audio =
      audios.find((t) => t.id === this.audioId) ??
      audios.find((t) => t.default) ??
      audios[0];
    this.audioId = audio?.id ?? null;
    return { video: video?.id ?? null, audio: this.audioId };
  }

  private audioOptions(
    tracks: readonly RemuxTrack[] = this.remuxer?.tracks ?? []
  ) {
    return tracks.filter(
      (t) => t.kind === 'audio' && playable(t) && this.codecOf(t) != null
    );
  }

  private textOptions(): RemuxTrack[] {
    return (this.remuxer?.tracks ?? []).filter((t) => this.texts.has(t.id));
  }

  /** The tracks are known: subtitle tracks, the Cues, the duration. */
  private announce(): void {
    this.announced = true;
    const remuxer = this.remuxer!;
    const video = this.element as VideoElementLike;
    if (video.addTextTrack) {
      for (const t of remuxer.tracks) {
        if (t.kind !== 'text' || t.unsupported != null) continue;
        const track = video.addTextTrack(
          'subtitles',
          t.name ?? '',
          t.language ?? ''
        );
        track.mode = 'disabled';
        this.texts.set(t.id, track);
        if (t.codec === 'ass')
          this.scripts.set(t.id, parseAssHeader(t.header ?? ''));
      }
    }
    this.durationReady = this.findDuration();
    this.findCues();
    this.listener.onTracks?.();
  }

  get audioTracks(): ReadonlyArray<HlsMediaTrack> {
    return this.audioOptions().map((t) => ({
      name: t.name ?? undefined,
      lang: t.language ?? undefined,
      default: t.default,
    }));
  }

  get subtitleTracks(): ReadonlyArray<HlsMediaTrack> {
    return this.textOptions().map((t) => ({
      name: t.name ?? undefined,
      lang: t.language ?? undefined,
      default: t.default,
      forced: t.forced,
    }));
  }

  selectAudio(index: number): void {
    const track = this.audioOptions()[index];
    if (!track || track.id === this.audioId) return;
    this.audioId = track.id;
    this.switchAudio().catch(ignore);
  }

  selectSubtitles(index: number): void {
    const chosen = this.textOptions()[index]?.id ?? null;
    for (const [id, track] of this.texts) {
      const mode = id === chosen ? 'hidden' : 'disabled';
      if (track.mode !== mode) track.mode = mode;
    }
  }

  /** Muxes the picked audio track from where the picture is. */
  private async switchAudio(): Promise<void> {
    const { remuxer, buffer } = this;
    if (!remuxer?.muxed || !buffer) return;
    const video = remuxer.muxed.find((t) => t.kind === 'video')?.id ?? null;
    const choice = { video, audio: this.audioId };
    const tracks = [video, this.audioId]
      .map((id) => remuxer.tracks.find((t) => t.id === id))
      .filter((t): t is RemuxTrack => t != null);
    const mime = this.mimeOf(tracks);
    if (mime !== this.mime && !buffer.changeType) {
      this.listener.onNote('audio switch skipped', {
        reason: 'no SourceBuffer.changeType',
      });
      return;
    }
    // Stop reading, drop what is buffered (it holds the other sound).
    this.reading += 1;
    this.abortRead?.();
    await this.idle();
    if (this.closed) return;
    buffer.abort();
    buffer.remove(0, Number.POSITIVE_INFINITY);
    await this.idle();
    if (this.closed) return;
    if (mime !== this.mime) buffer.changeType!(mime);
    this.mime = mime;
    remuxer.reselect(choice);
    this.listener.onNote('audio switch', { track: `${this.audioId}` });
    this.seekTarget = this.element.currentTime;
    this.seekTries = 0;
    this.seekJumps = true;
    this.restartAt(this.element.currentTime);
  }

  private mimeOf(tracks: readonly RemuxTrack[]): string {
    const kind = tracks.some((t) => t.kind === 'video') ? 'video' : 'audio';
    return `${kind}/mp4; codecs="${tracks.map((t) => this.codecOf(t)).join(',')}"`;
  }

  // ── Subtitles ──

  private addCues(cues: readonly RemuxCue[]): void {
    const VTTCue = browser().VTTCue;
    if (!VTTCue) return;
    for (const c of cues) {
      const track = this.texts.get(c.track);
      const key = `${c.track}|${c.start}|${c.text}`;
      // A cue read again after a seek is there already.
      const cue = track && !this.seenCues.has(key) ? this.cueOf(c) : null;
      this.seenCues.add(key);
      if (!track || !cue) continue;
      const vtt = new VTTCue(cue.start, cue.end, vttCueText(cue));
      place(vtt, cue);
      track.addCue(vtt);
    }
  }

  private cueOf(c: RemuxCue): SubtitleCue | null {
    const end = c.end ?? c.start + DEFAULT_CUE_MS;
    const codec = this.remuxer?.tracks.find((t) => t.id === c.track)?.codec;
    if (codec === 'ass') {
      // ReadOrder, Layer, Style, Name, MarginL, MarginR, MarginV, Effect, Text
      const fields = c.text.split(',');
      const text = fields.slice(8).join(',');
      return assEventCue(
        this.scripts.get(c.track)!,
        fields[2] ?? 'Default',
        text,
        c.start,
        end
      );
    }
    if (codec === 'vtt') return vttCue(c.start, end, '', c.text);
    return srtTextCue(c.text, c.start, end);
  }

  // ── The buffer ──

  private async deliver(
    out: { segments: Uint8Array[]; cues: RemuxCue[] },
    token: number
  ): Promise<boolean> {
    this.addCues(out.cues);
    for (const segment of out.segments)
      if (!(await this.deliverSegment(segment, token))) return false;
    return this.current(token);
  }

  /** One init or media segment into the buffer; `false` once this read is over. */
  private async deliverSegment(
    segment: Uint8Array,
    token: number
  ): Promise<boolean> {
    if (!this.current(token)) return false;
    if (!this.buffer && !(await this.createBuffer())) return false;
    if (!this.current(token)) return false;
    if (this.seekTarget != null && !this.landed(segment)) return false;
    if (!(await this.append(segment, token))) return false;
    const timescales = this.remuxer!.muxed!.map((t) => t.timescale);
    const start = fragmentStart(segment, timescales);
    if (start != null) this.readTime = start;
    if (this.jumpTo != null) {
      // Buffered now: the seek this causes needs no read.
      this.element.currentTime = this.jumpTo;
      this.jumpTo = null;
    }
    return true;
  }

  private async createBuffer(): Promise<boolean> {
    const muxed = this.remuxer!.muxed!;
    const mime = this.mimeOf(muxed);
    const mediaSource = this.mediaSource!;
    try {
      this.buffer = mediaSource.addSourceBuffer(mime);
      this.mime = mime;
    } catch (error) {
      this.fail(
        engineError(
          'UNSUPPORTED_FORMAT',
          `This browser cannot play ${mime}.`,
          false,
          {
            cause: String(error),
          }
        )
      );
      return false;
    }
    this.listener.onNote('remux tracks', { mime });
    // The duration goes in before the first segment: the element reads it
    // with the metadata.
    await this.durationReady;
    if (this.closed || mediaSource.readyState !== 'open') return !this.closed;
    const duration =
      this.size == null ? Number.POSITIVE_INFINITY : this.duration;
    if (duration != null) mediaSource.duration = duration;
    return true;
  }

  /** Appends once there is room; `false` when this read is over. */
  private async append(data: Uint8Array, token: number): Promise<boolean> {
    while (this.current(token) && this.bufferedAhead() > MAX_AHEAD_S)
      await this.sleep(500);
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.idle();
      if (!this.current(token)) return false;
      this.evict();
      await this.idle();
      if (!this.current(token)) return false;
      try {
        this.buffer!.appendBuffer(data);
      } catch (error) {
        if ((error as { name?: string }).name !== 'QuotaExceededError') {
          this.fail(
            engineError(
              'DECODER_ERROR',
              'The remuxed media could not be played.',
              false,
              {
                cause: String(error),
              }
            )
          );
          return false;
        }
        await this.sleep(1000);
        continue;
      }
      await this.idle();
      return this.current(token);
    }
    if (this.current(token))
      this.fail(engineError('NETWORK_ERROR', 'The buffer stayed full.', true));
    return false;
  }

  private bufferedAhead(): number {
    const ranges = this.buffer?.buffered;
    const time = this.element.currentTime;
    for (let i = 0; i < (ranges?.length ?? 0); i++)
      if (ranges!.start(i) <= time + 0.5 && time < ranges!.end(i))
        return ranges!.end(i) - time;
    return 0;
  }

  private isBuffered(time: number): boolean {
    const ranges = this.element.buffered;
    for (let i = 0; i < ranges.length; i++)
      if (ranges.start(i) <= time + 0.1 && time < ranges.end(i) - 0.1)
        return true;
    return false;
  }

  private evict(): void {
    const buffer = this.buffer!;
    const ranges = buffer.buffered;
    if (ranges.length === 0) return;
    const behind = this.element.currentTime - KEEP_BEHIND_S;
    if (behind - ranges.start(0) > 10) buffer.remove(ranges.start(0), behind);
  }

  private idle(): Promise<void> {
    const buffer = this.buffer;
    if (this.closed || !buffer?.updating) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        buffer.removeEventListener('updateend', done);
        resolve();
      };
      buffer.addEventListener('updateend', done);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => browser().setTimeout(resolve, ms));
  }

  // ── Duration, Cues ──

  private async findDuration(): Promise<void> {
    const remuxer = this.remuxer!;
    if (remuxer.demuxer instanceof MatroskaDemuxer) {
      const ms = remuxer.demuxer.duration;
      this.duration = ms != null ? ms / 1000 : null;
      return;
    }
    const size = this.size;
    const base = remuxer.timeBase;
    if (size == null || !this.ranges || base == null) return;
    const tail = await this.bytes(Math.max(0, size - TAIL_BYTES), size - 1);
    if (!tail) return;
    const pid = remuxer.muxed?.[0]?.id ?? null;
    let last = lastTimestamp(tail, pid);
    if (last == null) return;
    while (last < base) last += PTS_WRAP;
    this.duration = (last - base) / TS_CLOCK;
  }

  /** A Matroska file's Cues, when they are not before its clusters. */
  private findCues(): void {
    const demuxer = this.remuxer?.demuxer;
    if (!(demuxer instanceof MatroskaDemuxer)) return;
    const offset = demuxer.cuesOffset;
    if (
      demuxer.cues.length > 0 ||
      offset == null ||
      !this.ranges ||
      this.size == null
    )
      return;
    const end = Math.min(this.size, offset + MAX_CUES_BYTES) - 1;
    this.bytes(offset, end)
      .then((bytes) => {
        if (!bytes || this.closed) return;
        if (demuxer.readCuesElement(bytes))
          this.listener.onNote('remux cues', {
            points: `${demuxer.cues.length}`,
          });
      })
      .catch(ignore);
  }

  // ── Seeking ──

  private seeking(): void {
    if (this.closed || this.failed || this.size == null) return;
    if (!this.remuxer?.muxed || !this.buffer) return;
    const target = this.element.currentTime;
    if (this.isBuffered(target)) return;
    this.seekTarget = target;
    this.seekTries = 0;
    this.seekJumps = true;
    this.restartAt(target);
  }

  /** Reads again from where `target` is in the file. */
  private restartAt(target: number, landing: number | null = null): void {
    const remuxer = this.remuxer!;
    const offset = this.offsetFor(target, landing);
    this.seekOffset = offset;
    remuxer.seek(offset);
    this.read(offset, false);
  }

  /** The byte to read from for `target`: a Cues entry, else the bitrate's guess (corrected by where the last guess landed). */
  private offsetFor(target: number, landing: number | null): number {
    if (!this.ranges || this.size == null) return 0;
    const remuxer = this.remuxer!;
    const demuxer = remuxer.demuxer;
    if (demuxer instanceof MatroskaDemuxer && demuxer.cues.length > 0) {
      let offset = demuxer.cues[0]!.offset;
      for (const cue of demuxer.cues)
        if (cue.time <= target * 1000) offset = cue.offset;
      return offset;
    }
    const duration = this.duration;
    if (!duration) return 0;
    const perSecond = this.size / duration;
    const offset =
      landing == null
        ? (target - 2) * perSecond
        : this.seekOffset +
          (target - landing - 2 * (this.seekTries + 1)) * perSecond;
    const floor =
      demuxer instanceof MatroskaDemuxer ? (demuxer.firstCluster ?? 0) : 0;
    return Math.max(
      floor,
      Math.min(this.size - 1, Math.floor(offset / 188) * 188)
    );
  }

  /**
   * After a seek: whether this segment may go in. A first fragment past the
   * target (or far before it) means the guess missed: the read starts again
   * from a better one. One a little past it (the next keyframe) is played
   * from: the element jumps the gap.
   */
  private landed(segment: Uint8Array): boolean {
    const target = this.seekTarget!;
    const timescales = this.remuxer!.muxed!.map((t) => t.timescale);
    const start = fragmentStart(segment, timescales);
    if (start == null) return true;
    const guessed = !(
      this.remuxer!.demuxer instanceof MatroskaDemuxer &&
      this.remuxer!.demuxer.cues.length > 0
    );
    const missed =
      start > target + OVERSHOOT_S || start < target - UNDERSHOOT_S;
    if (guessed && missed && this.seekTries < MAX_SEEK_TRIES && this.ranges) {
      this.seekTries += 1;
      this.listener.onNote('remux seek', {
        target: target.toFixed(1),
        landed: start.toFixed(1),
      });
      this.restartAt(target, start);
      return false;
    }
    this.seekTarget = null;
    if (this.seekJumps && start > target + 0.05) this.jumpTo = start;
    return true;
  }

  /**
   * While playing a buffered range the reader is not filling (it was moved
   * by a seek elsewhere), reading resumes at the range's end before the
   * element gets there.
   */
  private continuity(): void {
    if (
      this.closed ||
      this.failed ||
      this.size == null ||
      this.seekTarget != null
    )
      return;
    const read = this.readTime;
    const ranges = this.buffer?.buffered;
    if (read == null || !ranges) return;
    const now = this.element.currentTime;
    for (let i = 0; i < ranges.length; i++) {
      const start = ranges.start(i);
      const end = ranges.end(i);
      if (now < start - 0.1 || now >= end) continue;
      if (read >= start - 1 && read <= end + 1) return; // the reader fills this range
      if (end - now > MAX_AHEAD_S / 3) return;
      this.listener.onNote('remux continue', { at: end.toFixed(1) });
      this.seekTarget = end;
      this.seekTries = 0;
      this.seekJumps = false;
      this.restartAt(end);
      return;
    }
  }
}
