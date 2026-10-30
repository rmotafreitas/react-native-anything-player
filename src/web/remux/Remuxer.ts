// Matroska / WebM / MPEG-TS → fragmented MP4, as bytes arrive. The demuxer
// finds the tracks and frames; the remuxer waits until every track's
// configuration is known (some need a frame: the parameter sets of a TS
// stream, AC-3's header, VP9's keyframe), picks the tracks to mux, and turns
// frames into fragments:
//
// - it starts at a video keyframe; audio before it is dropped, so picture
//   and sound start together;
// - a TS stream's times move to zero at that keyframe;
// - video decode times are the fragment's presentation times in order (the
//   decode order is the file's; B-frames get signed composition offsets);
// - audio is timed frame after frame, re-anchored only past half a frame of
//   drift (a gap), overlapping frames dropped;
// - a fragment ends at each video keyframe (each second of audio without
//   video), so a seek or a reconnect has one to start from;
// - a configuration that changes (a new SPS) closes the fragment and sends a
//   new init segment.
//
// The Swift twin (ios/Core/Remux/Remuxer.swift) makes the same bytes from the
// same input: conformance/remux/.

import { equalBytes, rescale } from './bytes';
import { ac3Header, flacSamples, mpegAudioHeader, opusSamples } from './codecs';
import { MatroskaDemuxer, type DemuxSink } from './Matroska';
import { TsDemuxer } from './MpegTs';
import { fragment, initSegment } from './Mp4Writer';
import type { DemuxFrame, RemuxCue, RemuxSample, RemuxTrack } from './types';

export type RemuxFormat = 'matroska' | 'mpegts';

export interface TrackChoice {
  video: number | null;
  audio: number | null;
}

export interface RemuxOptions {
  /** Picks the tracks to mux once they are known (default: `defaultChoice`). */
  choose?(tracks: readonly RemuxTrack[]): TrackChoice;
  /** A TS file's time base (clock units), when this part is read on its own (a segment from the middle). */
  timeBase?: number;
}

export interface RemuxOutput {
  /** Init and media segments, in order: an init segment comes first, and again when a configuration changes. */
  segments: Uint8Array[];
  cues: RemuxCue[];
}

/** Without every track's configuration this long into the file, the tracks still waiting are left out. */
const READY_AFTER_MS = 3000;
/** Audio frames kept while waiting for the first video keyframe. */
const MAX_EARLY = 2000;
/** Audio without video is cut on a grid of whole seconds (the same cuts from wherever it is read). */
const AUDIO_FRAGMENT_S = 1;

/** `rescale` for a value that may be negative (symmetric rounding). */
function signedRescale(value: number, num: number, den: number): number {
  return value < 0 ? -rescale(-value, num, den) : rescale(value, num, den);
}

/** Whether a track can be muxed. */
export function playable(track: RemuxTrack): boolean {
  return (
    track.unsupported == null && track.codec != null && track.kind !== 'text'
  );
}

/** The first video track, and the default (else the first) audio track. */
export function defaultChoice(tracks: readonly RemuxTrack[]): TrackChoice {
  const video = tracks.find((t) => t.kind === 'video' && playable(t));
  const audio = tracks.filter((t) => t.kind === 'audio' && playable(t));
  return {
    video: video?.id ?? null,
    audio: (audio.find((t) => t.default) ?? audio[0])?.id ?? null,
  };
}

/** Samples an audio frame lasts, in its track's timescale. */
export function audioFrameSamples(track: RemuxTrack, data: Uint8Array): number {
  switch (track.entry) {
    case 'mp4a':
      return track.objectType === 0x6b
        ? (mpegAudioHeader(data, 0)?.samples ?? 1152)
        : 1024;
    case 'ac-3':
      return 1536;
    case 'ec-3':
      return ac3Header(data, 0)?.samples ?? 1536;
    case 'Opus':
      return opusSamples(data) || 960;
    case 'fLaC':
      return flacSamples(data) ?? 4096;
    default:
      return 1024;
  }
}

interface VideoFrame {
  pts: number;
  key: boolean;
  data: Uint8Array;
}

export class Remuxer {
  readonly demuxer: MatroskaDemuxer | TsDemuxer;
  /** The tracks muxed, in the init segment's order; `null` until the tracks are known. */
  muxed: RemuxTrack[] | null = null;
  /** The current init segment. */
  init: Uint8Array | null = null;
  /** Why nothing can be muxed (no playable track), once that is known. */
  failure: string | null = null;

  private configs: Array<Uint8Array | null> = [];
  private pending: DemuxFrame[] = [];
  private span: { min: number; max: number } | null = null;
  /** Clock units subtracted from every time (a TS stream starts at zero). */
  private base: number | null;
  /** Where muxing starts (after `base`): the first keyframe's time. */
  private start: number | null = null;
  private early: DemuxFrame[] = [];
  private video: VideoFrame[] = [];
  private audio: RemuxSample[] = [];
  private nextAudio: number | null = null;
  /** The latest video time muxed (after `base`), for a TS stream's jumps. */
  private lastVideo: number | null = null;
  private sequence = 0;
  private out: RemuxOutput = { segments: [], cues: [] };
  private readonly sink: DemuxSink = {
    frame: (frame) => this.frame(frame),
    cue: (cue) => this.out.cues.push(cue),
  };

  constructor(
    readonly format: RemuxFormat,
    private readonly options: RemuxOptions = {}
  ) {
    this.demuxer =
      format === 'matroska' ? new MatroskaDemuxer() : new TsDemuxer();
    this.base = format === 'matroska' ? 0 : (options.timeBase ?? null);
  }

  /** Every track found, muxed or not. */
  get tracks(): readonly RemuxTrack[] {
    return this.demuxer.tracks;
  }

  /** Clock units per second of the container's times. */
  get clock(): number {
    return this.demuxer.clock;
  }

  /** The time subtracted from the stream's (TS), clock units; `null` until known. */
  get timeBase(): number | null {
    return this.base;
  }

  /** Remuxes a chunk of the file. */
  push(chunk: Uint8Array): RemuxOutput {
    this.demuxer.push(chunk, this.sink);
    return this.take();
  }

  /** The file ended: what is left goes out. */
  end(): RemuxOutput {
    this.demuxer.end(this.sink);
    if (this.muxed == null && this.demuxer.tracksKnown) this.ready();
    this.flush(null);
    return this.take();
  }

  /**
   * The next bytes pushed come from elsewhere in the file: a Matroska
   * cluster at `offset`, any TS packet. What was buffered is dropped, and
   * muxing starts again at a keyframe.
   */
  seek(offset = 0): void {
    if (this.demuxer instanceof MatroskaDemuxer) this.demuxer.seek(offset);
    else this.demuxer.seek();
    this.video = [];
    this.audio = [];
    this.early = [];
    this.nextAudio = null;
    this.lastVideo = null;
    this.start = null;
    if (this.muxed == null) this.pending = [];
  }

  /**
   * A live stream's new connection: the demuxer drops what it held of the
   * old one (a cut packet, a PES) and starts over; the timeline goes on
   * (a jump in the stream's timestamps is carried over at its next keyframe).
   */
  reconnected(): void {
    if (this.demuxer instanceof MatroskaDemuxer) this.demuxer.restart();
    else this.demuxer.seek();
  }

  /**
   * Muxes other tracks from now on (another audio track): a new init
   * segment goes out with the next output. Call `seek` next, to read from
   * where the switch should start.
   */
  reselect(choice: TrackChoice): void {
    if (this.muxed == null) return;
    const pick = (id: number | null, kind: 'video' | 'audio') =>
      this.tracks.find((t) => t.id === id && t.kind === kind && playable(t));
    const tracks = [pick(choice.video, 'video'), pick(choice.audio, 'audio')];
    const muxed = tracks.filter((t): t is RemuxTrack => t != null);
    if (muxed.length === 0) return;
    this.muxed = muxed;
    this.writeInit();
  }

  private take(): RemuxOutput {
    const out = this.out;
    this.out = { segments: [], cues: [] };
    return out;
  }

  // ── Readiness ──

  private frame(frame: DemuxFrame): void {
    if (this.muxed != null) {
      this.mux(frame);
      return;
    }
    this.pending.push(frame);
    if (frame.pts != null) {
      const ms = rescale(frame.pts, 1000, this.clock);
      this.span = this.span
        ? { min: Math.min(this.span.min, ms), max: Math.max(this.span.max, ms) }
        : { min: ms, max: ms };
    }
    if (!this.demuxer.tracksKnown) return;
    const waiting = this.tracks.some(
      (t) => t.kind !== 'text' && t.unsupported == null && t.codec == null
    );
    const long =
      this.span != null && this.span.max - this.span.min >= READY_AFTER_MS;
    if (!waiting || long) this.ready();
  }

  private ready(): void {
    for (const t of this.tracks)
      if (t.kind !== 'text' && t.unsupported == null && t.codec == null)
        t.unsupported = 'no data';
    const choice = (this.options.choose ?? defaultChoice)(this.tracks);
    const pick = (id: number | null, kind: 'video' | 'audio') =>
      this.tracks.find((t) => t.id === id && t.kind === kind && playable(t));
    const video = pick(choice.video, 'video');
    const audio = pick(choice.audio, 'audio');
    this.muxed = [video, audio].filter((t): t is RemuxTrack => t != null);
    if (this.muxed.length === 0) {
      this.failure = this.describeFailure();
      this.pending = [];
      return;
    }
    this.writeInit();
    const frames = this.pending;
    this.pending = [];
    for (const frame of frames) this.mux(frame);
  }

  private describeFailure(): string {
    const parts = this.tracks
      .filter((t) => t.kind !== 'text')
      .map((t) => `${t.kind} ${t.unsupported ?? t.codec ?? '?'}`);
    return parts.length > 0
      ? `no playable track (${parts.join(', ')})`
      : 'no audio or video track';
  }

  private writeInit(): void {
    const tracks = this.muxed!;
    this.init = initSegment(tracks);
    this.configs = tracks.map((t) => t.config);
    this.out.segments.push(this.init);
  }

  // ── Muxing ──

  private mux(frame: DemuxFrame): void {
    const tracks = this.muxed!;
    const index = tracks.findIndex((t) => t.id === frame.track);
    if (index < 0) return;
    const track = tracks[index]!;
    if (!equalBytes(track.config, this.configs[index]!)) {
      // A new configuration (a new SPS, a new sample rate): the frames
      // before it go out with the old init segment.
      if (track.kind === 'video' && !frame.key) return;
      this.flush(
        track.kind === 'video' && frame.pts != null
          ? frame.pts - (this.base ?? 0)
          : null
      );
      this.writeInit();
    }
    if (track.kind === 'video') this.muxVideo(frame);
    else this.muxAudio(track, frame);
  }

  private muxVideo(frame: DemuxFrame): void {
    if (frame.pts == null) return;
    if (this.start == null) {
      if (!frame.key) return;
      this.base ??= frame.pts;
      this.start = frame.pts - this.base;
      const early = this.early;
      this.early = [];
      const audio = this.muxed!.find((t) => t.kind === 'audio');
      if (audio) for (const f of early) this.muxAudio(audio, f);
    }
    let pts = frame.pts - this.base!;
    const last = this.lastVideo;
    if (frame.key && last != null && this.jumped(pts, last)) {
      // The stream's timestamps jumped (an encoder restart, a new program,
      // a loop): the timeline goes on from where it was.
      const video = this.muxed!.find((t) => t.kind === 'video')!;
      const shift = pts - (last + this.frameDuration(video));
      this.base! += shift;
      pts -= shift;
      this.nextAudio = null;
    }
    if (pts < this.start) return; // a leading picture of the first keyframe
    if (frame.key && this.video.length > 0) this.flush(pts);
    this.video.push({ pts, key: frame.key, data: frame.data });
    if (last == null || pts > last) this.lastVideo = pts;
  }

  /** A TS time this far from the last (back a second, on ten): a discontinuity. */
  private jumped(time: number, last: number): boolean {
    if (this.format !== 'mpegts') return false;
    return time < last - this.clock || time > last + 10 * this.clock;
  }

  private muxAudio(track: RemuxTrack, frame: DemuxFrame): void {
    const hasVideo = this.muxed!.some((t) => t.kind === 'video');
    if (hasVideo && this.start == null) {
      this.early.push(frame);
      // A stream whose video never reaches a keyframe keeps the last few seconds.
      if (this.early.length > MAX_EARLY) this.early.shift();
      return;
    }
    if (this.base == null) {
      if (frame.pts == null) return;
      this.base = frame.pts;
    }
    this.start ??= 0;
    const duration = audioFrameSamples(track, frame.data);
    if (!hasVideo) this.rebaseAudio(track, frame);
    const time = this.audioTime(track, frame, duration);
    if (time == null) return;
    // The timeline moves on through frames dropped before the start: the
    // frames after them in the same PES or block carry no time of their own.
    this.nextAudio = time + duration;
    if (time < rescale(this.start, track.timescale, this.clock)) return;
    if (!hasVideo) this.cutAudio(time, track.timescale);
    this.audio.push({
      dts: time,
      pts: time,
      duration,
      key: true,
      data: frame.data,
    });
  }

  /** Audio alone whose timestamps jumped: the timeline goes on from where it was. */
  private rebaseAudio(track: RemuxTrack, frame: DemuxFrame): void {
    if (frame.pts == null || this.nextAudio == null) return;
    const expected = rescale(this.nextAudio, this.clock, track.timescale);
    if (this.jumped(frame.pts - this.base!, expected))
      this.base = frame.pts - expected;
  }

  /**
   * A frame's time (track timescale): right after the previous one within
   * half a frame, else its own; `null` to drop it (it overlaps what was
   * muxed, or nothing gives it a time).
   */
  private audioTime(
    track: RemuxTrack,
    frame: DemuxFrame,
    duration: number
  ): number | null {
    const next = this.nextAudio;
    if (frame.pts == null) return next;
    const time = signedRescale(
      frame.pts - this.base!,
      track.timescale,
      this.clock
    );
    if (next == null) return time;
    if (2 * Math.abs(time - next) <= duration) return next;
    return time < next ? null : time;
  }

  /** Audio alone is cut on a grid of whole seconds. */
  private cutAudio(time: number, timescale: number): void {
    const grid = AUDIO_FRAGMENT_S * timescale;
    const first = this.audio[0];
    if (first && Math.floor(time / grid) > Math.floor(first.dts / grid))
      this.flush(null);
  }

  /** Writes the fragment collected; `nextKey`: the time of the keyframe after it. */
  private flush(nextKey: number | null): void {
    const tracks = this.muxed;
    if (!tracks) return;
    const video = this.videoSamples(nextKey);
    if (video.length === 0 && this.audio.length === 0) return;
    this.sequence += 1;
    const samples = tracks.map((t) =>
      t.kind === 'video' ? video : this.audio
    );
    this.out.segments.push(fragment(this.sequence, tracks, samples));
    this.video = [];
    this.audio = [];
  }

  private videoSamples(nextKey: number | null): RemuxSample[] {
    const frames = this.video;
    const n = frames.length;
    if (n === 0) return [];
    const times = frames.map((f) => f.pts).sort((a, b) => a - b);
    const track = this.muxed!.find((t) => t.kind === 'video')!;
    const last = times[n - 1]!;
    let lastDuration: number;
    if (nextKey != null && nextKey > last) lastDuration = nextKey - last;
    else if (n > 1) lastDuration = last - times[n - 2]!;
    else lastDuration = this.frameDuration(track);
    return frames.map((f, i) => ({
      dts: times[i]!,
      pts: f.pts,
      duration: i < n - 1 ? times[i + 1]! - times[i]! : lastDuration,
      key: f.key,
      data: f.data,
    }));
  }

  private frameDuration(track: RemuxTrack): number {
    const known =
      this.demuxer instanceof MatroskaDemuxer
        ? this.demuxer.frameDuration(track.id)
        : null;
    return known ?? Math.round(this.clock / 25);
  }
}
