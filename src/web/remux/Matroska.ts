/* eslint-disable no-bitwise -- EBML variable-length integers are bit fields. */
// A streaming Matroska / WebM demuxer: bytes in, in chunks of any size;
// tracks, frames and subtitle cues out. It reads what the remuxer needs and
// skips the rest (attachments, tags, chapters) without buffering it. A live
// WebM (a segment and clusters of unknown size) streams the same way. After
// corrupt bytes it resynchronises on the next cluster.
//
// The Swift twin is ios/Core/Remux/Matroska.swift.

import { readUint, rescale } from './bytes';
import {
  avcCodec,
  avcConfigInfo,
  av1Codec,
  flacConfig,
  hevcCodec,
  hevcConfigInfo,
  makeAsc,
  opusConfig,
  parseAsc,
  parseAvcSps,
  parseHevcSps,
  ac3Header,
  vp9CodecFeatures,
  vp9Keyframe,
  vp9Level,
  vpcConfig,
  vpxCodec,
} from './codecs';
import {
  emptyTrack,
  type CuePoint,
  type DemuxFrame,
  type RemuxCue,
  type RemuxTrack,
} from './types';

/** Where a demuxer's frames and cues go. */
export interface DemuxSink {
  frame(frame: DemuxFrame): void;
  cue(cue: RemuxCue): void;
}

const ID = {
  EBML: 0x1a45dfa3,
  DocType: 0x4282,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  FlagEnabled: 0xb9,
  FlagDefault: 0x88,
  FlagForced: 0x55aa,
  DefaultDuration: 0x23e383,
  Name: 0x536e,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  DisplayWidth: 0x54b0,
  DisplayHeight: 0x54ba,
  DisplayUnit: 0x54b2,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  Channels: 0x9f,
  ContentEncodings: 0x6d80,
  ContentEncoding: 0x6240,
  ContentCompression: 0x5034,
  ContentCompAlgo: 0x4254,
  ContentCompSettings: 0x4255,
  ContentEncryption: 0x5035,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Tags: 0x1254c367,
  Chapters: 0x1043a770,
  Attachments: 0x1941a469,
} as const;

/** Matroska's TrackType → RNAP's kind (others are skipped). */
const TRACK_KINDS: Record<number, RemuxTrack['kind']> = {
  1: 'video',
  2: 'audio',
  17: 'text',
};

/** Level-1 elements: one of them ends a cluster of unknown size. */
const TOP_LEVEL = new Set<number>([
  ID.Cluster,
  ID.Cues,
  ID.Tags,
  ID.Chapters,
  ID.Attachments,
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
]);

/** Read whole (they are small, or needed whole). */
const WHOLE = new Set<number>([
  ID.EBML,
  ID.SeekHead,
  ID.Info,
  ID.Tracks,
  ID.Cues,
  ID.SimpleBlock,
  ID.Block,
  ID.Timestamp,
  ID.BlockDuration,
  ID.ReferenceBlock,
]);

/** An element read whole is refused past this (a broken size). */
const MAX_WHOLE = 64 * 1024 * 1024;
const NS_PER_SECOND = 1_000_000_000;

interface Header {
  id: number;
  /** `null`: unknown size (live). */
  size: number | null;
  length: number;
}

interface Element {
  id: number;
  start: number;
  size: number;
}

/** The variable-length integer at `at`: its value and length; `null` when cut or invalid. */
function vint(
  data: Uint8Array,
  at: number,
  keepMarker: boolean
): { value: number; length: number; unknown: boolean } | null {
  if (at >= data.length) return null;
  const first = data[at]!;
  if (first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length += 1;
  if (at + length > data.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let ones = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + data[at + i]!;
    if (data[at + i] !== 0xff) ones = false;
  }
  return { value, length, unknown: !keepMarker && ones };
}

function header(data: Uint8Array, at: number): Header | 'invalid' | null {
  if (at >= data.length) return null;
  if (data[at] === 0 || data[at]! < 0x10) return 'invalid'; // IDs are 1–4 bytes
  const id = vint(data, at, true);
  if (!id) return null;
  const size = vint(data, at + id.length, false);
  if (!size) return at + id.length + 8 <= data.length ? 'invalid' : null;
  return {
    id: id.value,
    size: size.unknown ? null : size.value,
    length: id.length + size.length,
  };
}

/** The child element at `at`, when it is whole before `end`. */
function childAt(data: Uint8Array, at: number, end: number): Element | null {
  if (at >= end) return null;
  const h = header(data, at);
  if (!h || h === 'invalid' || h.size == null) return null;
  const begin = at + h.length;
  return begin + h.size > end ? null : { id: h.id, start: begin, size: h.size };
}

/** The child elements of `data[start, end)` (a master read whole). */
function children(data: Uint8Array, start: number, end: number): Element[] {
  const out: Element[] = [];
  let child = childAt(data, start, end);
  while (child) {
    out.push(child);
    child = childAt(data, child.start + child.size, end);
  }
  return out;
}

/** The children of `e` by id (the last of each, as reading them in turn would leave it). */
function fieldsOf(data: Uint8Array, e: Element): Map<number, Element> {
  const fields = new Map<number, Element>();
  for (const c of children(data, e.start, e.start + e.size))
    fields.set(c.id, c);
  return fields;
}

function uint(data: Uint8Array, e: Element): number {
  return readUint(data, e.start, Math.min(e.size, 7));
}

function float(data: Uint8Array, e: Element): number {
  const view = new DataView(data.buffer, data.byteOffset + e.start, e.size);
  if (e.size === 4) return view.getFloat32(0);
  if (e.size === 8) return view.getFloat64(0);
  return 0;
}

type Decoder = { decode(bytes: Uint8Array): string };
let decoder: Decoder | null = null;

function text(data: Uint8Array, e: Element): string {
  return utf8(data.subarray(e.start, e.start + e.size));
}

/** UTF-8 text without trailing NULs. */
export function utf8(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end -= 1;
  // The browser's (and Node's); the library's types have no DOM.
  decoder ??= new (
    globalThis as unknown as { TextDecoder: new (label: string) => Decoder }
  ).TextDecoder('utf-8');
  return decoder.decode(bytes.subarray(0, end));
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** What a track needs that the generic model does not hold. */
interface TrackState {
  track: RemuxTrack;
  /** Bytes header stripping removed from every frame. */
  prefix: Uint8Array | null;
  /** Clock units between laced frames (video), from DefaultDuration. */
  frameDuration: number | null;
  /** VP9's CodecPrivate features (profile, level, bit depth, chroma). */
  features: Record<number, number> | null;
}

export class MatroskaDemuxer {
  /** Clock units per second of the frames' `pts`. */
  clock = 1000;
  /** One clock unit is `unit` TimestampScale units… */
  private unit = 1;
  private scale = 1_000_000;
  readonly tracks: RemuxTrack[] = [];
  /** The track list is complete (the Tracks element was read). */
  tracksKnown = false;
  /** Milliseconds, from the Info element. */
  duration: number | null = null;
  docType = '';
  /** Where the segment's data starts (positions are relative to it). */
  segmentStart: number | null = null;
  /** Byte offset of the Cues element, from the SeekHead. */
  cuesOffset: number | null = null;
  /** Byte offset of the first cluster read. */
  firstCluster: number | null = null;
  cues: CuePoint[] = [];

  private readonly states = new Map<number, TrackState>();
  private buf = new Uint8Array(0);
  /** File offset of `buf[0]`. */
  private bufStart = 0;
  /** File offset of the next byte to parse. */
  private pos = 0;
  private stack: Array<{ id: number; end: number | null }> = [];
  private skip = 0;
  private clusterTime = 0;
  private group: {
    block: Uint8Array | null;
    duration: number | null;
    reference: boolean;
  } | null = null;
  /** The segment's end, kept for seeks. */
  private segmentEnd: number | null = null;

  /** Clock units between a video track's frames (its DefaultDuration); `null` when the file does not say. */
  frameDuration(track: number): number | null {
    return this.states.get(track)?.frameDuration ?? null;
  }

  push(chunk: Uint8Array, sink: DemuxSink): void {
    const keep = this.buf.subarray(this.pos - this.bufStart);
    const joined = new Uint8Array(keep.length + chunk.length);
    joined.set(keep);
    joined.set(chunk, keep.length);
    this.buf = joined;
    this.bufStart = this.pos;
    this.parse(sink);
  }

  /** The stream ended: closes what is open. */
  end(sink: DemuxSink): void {
    while (this.stack.length > 0) this.close(this.stack.pop()!, sink);
  }

  /**
   * Reads the Cues element at the start of `bytes` (fetched on its own from
   * `cuesOffset`); `false` when they do not hold it whole.
   */
  readCuesElement(bytes: Uint8Array): boolean {
    const h = header(bytes, 0);
    if (!h || h === 'invalid' || h.id !== ID.Cues || h.size == null)
      return false;
    if (h.length + h.size > bytes.length) return false;
    this.readCues(bytes, { id: ID.Cues, start: h.length, size: h.size });
    return true;
  }

  /** The next bytes pushed start at `offset`, a cluster's (from the Cues). */
  seek(offset: number): void {
    this.buf = new Uint8Array(0);
    this.bufStart = offset;
    this.pos = offset;
    this.skip = 0;
    this.group = null;
    this.clusterTime = 0;
    this.stack =
      this.segmentStart == null
        ? []
        : [{ id: ID.Segment, end: this.segmentEnd }];
  }

  private parse(sink: DemuxSink): void {
    while (this.step(sink));
  }

  /** One step: a master closed, bytes skipped, an element read; `false` while more bytes are needed. */
  private step(sink: DemuxSink): boolean {
    const top = this.stack[this.stack.length - 1];
    if (top && top.end != null && this.pos >= top.end) {
      this.close(this.stack.pop()!, sink);
      return true;
    }
    if (this.skip > 0) return this.skipBytes();
    const at = this.pos - this.bufStart;
    const h = header(this.buf, at);
    if (h == null) return false;
    if (h === 'invalid') return this.resync();
    if (top?.id === ID.Cluster && top.end == null && TOP_LEVEL.has(h.id)) {
      this.close(this.stack.pop()!, sink);
      return true;
    }
    return this.element(h, at, sink);
  }

  /** Skips what is buffered of the element being skipped; `true` once it is all behind. */
  private skipBytes(): boolean {
    const available = this.bufStart + this.buf.length - this.pos;
    const n = Math.min(this.skip, available);
    this.pos += n;
    this.skip -= n;
    return this.skip === 0;
  }

  /** Handles the element at `at`; `false` while more bytes are needed. */
  private element(h: Header, at: number, sink: DemuxSink): boolean {
    const dataStart = this.pos + h.length;
    const end = h.size == null ? null : dataStart + h.size;
    if (h.id === ID.Segment || h.id === ID.Cluster || h.id === ID.BlockGroup) {
      if (h.id === ID.Segment) {
        this.segmentStart = dataStart;
        this.segmentEnd = end;
      } else if (h.id === ID.Cluster) {
        this.clusterTime = 0;
        this.firstCluster ??= this.pos;
      } else {
        this.group = { block: null, duration: null, reference: false };
      }
      this.stack.push({ id: h.id, end });
      this.pos = dataStart;
      return true;
    }
    if (WHOLE.has(h.id)) {
      // A whole element of unknown or absurd size: corrupt.
      if (h.size == null || h.size > MAX_WHOLE) return this.resync();
      if (at + h.length + h.size > this.buf.length) return false;
      this.whole(h.id, this.buf, at + h.length, h.size, sink);
      this.pos = dataStart + h.size;
      return true;
    }
    if (h.size == null) return this.resync();
    this.pos = dataStart;
    this.skip = h.size;
    return true;
  }

  /** Moves to the next cluster in the buffer; `false` when there is none yet. */
  private resync(): boolean {
    const from = this.pos - this.bufStart + 1;
    for (let i = from; i + 4 <= this.buf.length; i++) {
      if (readUint(this.buf, i, 4) === ID.Cluster) {
        this.pos = this.bufStart + i;
        this.group = null;
        while (
          this.stack.length > 0 &&
          this.stack[this.stack.length - 1]!.id !== ID.Segment
        )
          this.stack.pop();
        return true;
      }
    }
    // Keep the last 3 bytes: the ID may continue in the next chunk.
    this.pos = Math.max(this.pos, this.bufStart + this.buf.length - 3);
    return false;
  }

  private close(
    master: { id: number; end: number | null },
    sink: DemuxSink
  ): void {
    if (master.id !== ID.BlockGroup) return;
    const group = this.group;
    this.group = null;
    if (group?.block)
      this.block(group.block, !group.reference, group.duration, sink);
  }

  private whole(
    id: number,
    data: Uint8Array,
    start: number,
    size: number,
    sink: DemuxSink
  ): void {
    const e: Element = { id, start, size };
    switch (id) {
      case ID.EBML:
        for (const c of children(data, start, start + size))
          if (c.id === ID.DocType) this.docType = text(data, c);
        break;
      case ID.Info:
        this.info(data, e);
        break;
      case ID.SeekHead:
        this.seekHead(data, e);
        break;
      case ID.Tracks:
        this.readTracks(data, e);
        break;
      case ID.Cues:
        this.readCues(data, e);
        break;
      case ID.Timestamp:
        this.clusterTime = uint(data, e);
        break;
      case ID.BlockDuration:
        if (this.group) this.group.duration = uint(data, e);
        break;
      case ID.ReferenceBlock:
        if (this.group) this.group.reference = true;
        break;
      case ID.Block:
        if (this.group) this.group.block = data.slice(start, start + size);
        break;
      case ID.SimpleBlock: {
        const block = data.subarray(start, start + size);
        const flags = block[(vint(block, 0, false)?.length ?? 1) + 2] ?? 0;
        this.block(block, (flags & 0x80) !== 0, null, sink);
        break;
      }
    }
  }

  private info(data: Uint8Array, e: Element): void {
    const f = fieldsOf(data, e);
    const scale = f.get(ID.TimestampScale);
    if (scale) this.scale = uint(data, scale) || 1_000_000;
    const durationField = f.get(ID.Duration);
    const duration = durationField ? float(data, durationField) : null;
    const g = gcd(NS_PER_SECOND, this.scale);
    this.clock = NS_PER_SECOND / g;
    this.unit = this.scale / g;
    if (duration != null && Number.isFinite(duration) && duration > 0)
      this.duration = Math.round((duration * this.scale) / 1_000_000);
  }

  private seekHead(data: Uint8Array, e: Element): void {
    const seeks = children(data, e.start, e.start + e.size).filter(
      (c) => c.id === ID.Seek
    );
    for (const seek of seeks) {
      const f = fieldsOf(data, seek);
      const id = f.get(ID.SeekID);
      const position = f.get(ID.SeekPosition);
      const target = id ? uint(data, id) : 0;
      if (target === ID.Cues && position && this.segmentStart != null)
        this.cuesOffset = this.segmentStart + uint(data, position);
    }
  }

  /** Milliseconds of a time in TimestampScale units. */
  private ms(time: number): number {
    return rescale(Math.max(0, time) * this.unit, 1000, this.clock);
  }

  private readCues(data: Uint8Array, e: Element): void {
    if (this.segmentStart == null) return;
    const video = this.tracks.find((t) => t.kind === 'video')?.id ?? null;
    const points: CuePoint[] = [];
    for (const point of children(data, e.start, e.start + e.size)) {
      if (point.id !== ID.CuePoint) continue;
      const time = fieldsOf(data, point).get(ID.CueTime);
      const offset = this.cueOffset(data, point, video);
      if (offset != null)
        points.push({ time: this.ms(time ? uint(data, time) : 0), offset });
    }
    points.sort((a, b) => a.time - b.time || a.offset - b.offset);
    this.cues = points.filter(
      (p, i) => i === 0 || p.offset !== points[i - 1]!.offset
    );
  }

  /** A cue point's cluster (the video track's, when the file has one). */
  private cueOffset(
    data: Uint8Array,
    point: Element,
    video: number | null
  ): number | null {
    for (const c of children(data, point.start, point.start + point.size)) {
      if (c.id !== ID.CueTrackPositions) continue;
      const f = fieldsOf(data, c);
      const track = f.get(ID.CueTrack);
      const position = f.get(ID.CueClusterPosition);
      const ours = video == null || (track ? uint(data, track) : 0) === video;
      if (position && ours) return this.segmentStart! + uint(data, position);
    }
    return null;
  }

  // ── Tracks ──

  private readTracks(data: Uint8Array, e: Element): void {
    if (this.tracksKnown) return;
    const entries = children(data, e.start, e.start + e.size).filter(
      (c) => c.id === ID.TrackEntry
    );
    for (const entry of entries) {
      const state = this.trackEntry(data, entry);
      if (!state) continue;
      this.tracks.push(state.track);
      this.states.set(state.track.id, state);
    }
    this.tracksKnown = true;
  }

  private trackEntry(data: Uint8Array, entry: Element): TrackState | null {
    const fields = new Map<number, Element>();
    for (const c of children(data, entry.start, entry.start + entry.size))
      if (!fields.has(c.id)) fields.set(c.id, c);
    const get = (id: number) => fields.get(id);
    const num = (id: number, fallback: number) => {
      const f = get(id);
      return f ? uint(data, f) : fallback;
    };
    const number = num(ID.TrackNumber, 0);
    const kind = TRACK_KINDS[num(ID.TrackType, 0)];
    if (number === 0 || kind == null) return null;
    const track = emptyTrack(number, kind);
    const str = (id: number) => {
      const f = get(id);
      return f ? text(data, f) : null;
    };
    track.name = str(ID.Name);
    track.language = str(ID.LanguageBCP47) ?? str(ID.Language) ?? 'eng';
    track.default = num(ID.FlagDefault, 1) === 1;
    track.forced = num(ID.FlagForced, 0) === 1;
    const codecId = str(ID.CodecID) ?? '';
    const privateField = get(ID.CodecPrivate);
    const codecPrivate = privateField
      ? data.slice(privateField.start, privateField.start + privateField.size)
      : null;
    const state: TrackState = {
      track,
      prefix: null,
      frameDuration: null,
      features: null,
    };
    const defaultDuration = num(ID.DefaultDuration, 0);
    if (defaultDuration > 0)
      state.frameDuration = rescale(defaultDuration, this.clock, NS_PER_SECOND);
    if (num(ID.FlagEnabled, 1) === 0) track.unsupported = 'disabled';
    const encodings = get(ID.ContentEncodings);
    if (encodings) this.encodings(data, encodings, state);
    if (kind === 'video') {
      track.timescale = this.clock;
      this.videoTrack(data, get(ID.Video), state);
    }
    if (kind === 'audio') this.audioTrack(data, get(ID.Audio), state);
    if (track.unsupported == null) this.configure(state, codecId, codecPrivate);
    return state;
  }

  private encodings(data: Uint8Array, e: Element, state: TrackState): void {
    const list = children(data, e.start, e.start + e.size).filter(
      (c) => c.id === ID.ContentEncoding
    );
    for (const encoding of list) {
      for (const c of children(
        data,
        encoding.start,
        encoding.start + encoding.size
      )) {
        if (c.id === ID.ContentEncryption)
          state.track.unsupported = 'encrypted';
        if (c.id === ID.ContentCompression) this.compression(data, c, state);
      }
    }
  }

  /** Header stripping (algorithm 3) puts bytes back in front of each frame; zlib and the rest are not supported. */
  private compression(data: Uint8Array, c: Element, state: TrackState): void {
    const f = fieldsOf(data, c);
    const algo = f.get(ID.ContentCompAlgo);
    const settings = f.get(ID.ContentCompSettings);
    if ((algo ? uint(data, algo) : 0) !== 3) {
      state.track.unsupported = 'compressed';
      return;
    }
    state.prefix = settings
      ? data.slice(settings.start, settings.start + settings.size)
      : null;
  }

  private videoTrack(
    data: Uint8Array,
    video: Element | undefined,
    state: TrackState
  ): void {
    if (!video) return;
    const f = fieldsOf(data, video);
    const value = (id: number) => (f.has(id) ? uint(data, f.get(id)!) : 0);
    const track = state.track;
    track.width = value(ID.PixelWidth);
    track.height = value(ID.PixelHeight);
    const dw = value(ID.DisplayWidth);
    const dh = value(ID.DisplayHeight);
    const pixels = value(ID.DisplayUnit) === 0 && dw > 0 && dh > 0;
    if (!pixels || track.width <= 0 || track.height <= 0) return;
    const w = dw * track.height;
    const h = dh * track.width;
    const g = gcd(w, h);
    track.sarWidth = w / g;
    track.sarHeight = h / g;
  }

  private audioTrack(
    data: Uint8Array,
    audio: Element | undefined,
    state: TrackState
  ): void {
    const track = state.track;
    track.sampleRate = 8000;
    track.channels = 1;
    if (!audio) return;
    const f = fieldsOf(data, audio);
    const rate = f.get(ID.SamplingFrequency);
    const channels = f.get(ID.Channels);
    if (rate) track.sampleRate = Math.round(float(data, rate));
    if (channels) track.channels = uint(data, channels);
    track.timescale = track.sampleRate;
  }

  /** The MP4 form of a track's codec; marks the track unsupported when there is none. */
  private configure(
    state: TrackState,
    codecId: string,
    codecPrivate: Uint8Array | null
  ): void {
    const track = state.track;
    if (track.kind === 'text') {
      configureText(track, codecId, codecPrivate);
      return;
    }
    const handled = codecId.startsWith('V_')
      ? this.configureVideo(state, codecId, codecPrivate)
      : configureAudio(track, codecId, codecPrivate);
    if (!handled) track.unsupported = codecId || 'no codec';
  }

  /** A video codec's configuration; `false` when RNAP has none for it. */
  private configureVideo(
    state: TrackState,
    codecId: string,
    cp: Uint8Array | null
  ): boolean {
    const track = state.track;
    switch (codecId) {
      case 'V_MPEG4/ISO/AVC': {
        if (!cp || cp.length <= 6) return false;
        track.entry = 'avc1';
        track.config = cp;
        track.codec = avcCodec(cp);
        const sps = avcConfigInfo(cp).sps;
        if (sps) this.picture(track, parseAvcSps(sps));
        return true;
      }
      case 'V_MPEGH/ISO/HEVC': {
        if (!cp || cp.length <= 22) return false;
        track.entry = 'hvc1';
        track.config = cp;
        track.codec = hevcCodec(cp);
        const sps = hevcConfigInfo(cp).sps;
        if (sps) {
          const info = parseHevcSps(sps);
          track.width = info.width;
          track.height = info.height;
        }
        return true;
      }
      case 'V_AV1':
        if (!cp || cp.length < 4) return false;
        track.entry = 'av01';
        track.config = cp;
        track.codec = av1Codec(cp);
        return true;
      case 'V_VP9':
        track.entry = 'vp09';
        state.features = cp ? vp9CodecFeatures(cp) : {};
        return true;
      case 'V_VP8': {
        track.entry = 'vp08';
        const info = {
          profile: 0,
          bitDepth: 8,
          chroma: 0,
          fullRange: false,
          colorSpace: 0,
        };
        track.config = vpcConfig(info, vp9Level(track.width, track.height));
        track.codec = vpxCodec('vp08', track.config);
        return true;
      }
      default:
        return false;
    }
  }

  private picture(
    track: RemuxTrack,
    info: { width: number; height: number; sarWidth: number; sarHeight: number }
  ): void {
    track.width = info.width;
    track.height = info.height;
    if (track.sarWidth === 1 && track.sarHeight === 1) {
      track.sarWidth = info.sarWidth;
      track.sarHeight = info.sarHeight;
    }
  }

  /** A configuration only a frame can give (VP9, AC-3, E-AC-3). */
  private configureFromFrame(state: TrackState, frame: Uint8Array): void {
    const track = state.track;
    if (track.entry === 'vp09') {
      vp9FromFrame(state, frame);
      return;
    }
    if (track.entry === 'ac-3' || track.entry === 'ec-3')
      ac3FromFrame(track, frame);
  }

  // ── Blocks ──

  private block(
    block: Uint8Array,
    key: boolean,
    duration: number | null,
    sink: DemuxSink
  ): void {
    const number = vint(block, 0, false);
    if (!number || block.length < number.length + 3) return;
    const state = this.states.get(number.value);
    if (!state || state.track.unsupported != null) return;
    const at = number.length;
    const relative = ((block[at]! << 24) >> 16) | block[at + 1]!;
    const flags = block[at + 2]!;
    const time = this.clusterTime + relative;
    const frames = delace(block, at + 3, (flags >> 1) & 3);
    if (!frames) return;
    const track = state.track;
    if (track.kind === 'text') {
      for (const frame of frames) {
        sink.cue({
          track: track.id,
          start: this.ms(time),
          end: duration == null ? null : this.ms(time + duration),
          text: utf8(frame),
        });
      }
      return;
    }
    const pts = Math.max(0, time) * this.unit;
    frames.forEach((raw, i) => {
      const data = state.prefix ? joinPrefix(state.prefix, raw) : raw;
      if (track.codec == null) this.configureFromFrame(state, data);
      sink.frame({ track: track.id, pts: lacedPts(state, pts, i), key, data });
    });
  }
}

function joinPrefix(prefix: Uint8Array, frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + frame.length);
  out.set(prefix);
  out.set(frame, prefix.length);
  return out;
}

/**
 * A laced frame's time: the block's for the first; the next ones of a video
 * track by its DefaultDuration; audio's follow on (`null`, timed by the remuxer).
 */
function lacedPts(state: TrackState, pts: number, i: number): number | null {
  if (i === 0) return pts;
  const step = state.frameDuration;
  return state.track.kind === 'video' && step != null ? pts + i * step : null;
}

type Laced = { sizes: number[]; pos: number } | null;

/** Xiph lacing: each size as a run of 255s and the byte that ends it. */
function xiphSizes(block: Uint8Array, pos: number, count: number): Laced {
  const sizes: number[] = [];
  let at = pos;
  for (let i = 0; i < count - 1; i++) {
    let size = 0;
    let byte = 255;
    while (byte === 255 && at < block.length) {
      byte = block[at]!;
      at += 1;
      size += byte;
    }
    if (byte === 255) return null; // cut
    sizes.push(size);
  }
  return { sizes, pos: at };
}

/** EBML lacing: the first size, then signed differences. */
function ebmlSizes(block: Uint8Array, pos: number, count: number): Laced {
  const first = vint(block, pos, false);
  if (!first) return null;
  let at = pos + first.length;
  const sizes = [first.value];
  for (let i = 1; i < count - 1; i++) {
    const raw = vint(block, at, false);
    if (!raw) return null;
    at += raw.length;
    const delta = raw.value - (2 ** (7 * raw.length - 1) - 1);
    sizes.push(sizes[i - 1]! + delta);
  }
  return { sizes, pos: at };
}

/** Fixed lacing: frames of one size. */
function fixedSizes(block: Uint8Array, pos: number, count: number): Laced {
  const each = (block.length - pos) / count;
  if (!Number.isInteger(each)) return null;
  return { sizes: Array.from({ length: count - 1 }, () => each), pos };
}

/** The frames of a block's payload at `at`, by its lacing (0 none, 1 Xiph, 2 fixed, 3 EBML). */
export function delace(
  block: Uint8Array,
  at: number,
  lacing: number
): Uint8Array[] | null {
  if (lacing === 0) return [block.slice(at)];
  if (at >= block.length) return null;
  const count = block[at]! + 1;
  const readers = [xiphSizes, fixedSizes, ebmlSizes];
  const laced = readers[lacing - 1]!(block, at + 1, count);
  if (!laced) return null;
  const { sizes } = laced;
  let pos = laced.pos;
  const used = sizes.reduce((a, b) => a + b, 0);
  if (used > block.length - pos || sizes.some((n) => n < 0)) return null;
  sizes.push(block.length - pos - used);
  const frames: Uint8Array[] = [];
  for (const size of sizes) {
    frames.push(block.slice(pos, pos + size));
    pos += size;
  }
  return frames;
}

/** A text codec: SubRip, ASS (its script header kept for the styles), WebVTT. */
function configureText(
  track: RemuxTrack,
  codecId: string,
  codecPrivate: Uint8Array | null
): void {
  if (codecId === 'S_TEXT/UTF8' || codecId === 'S_TEXT/ASCII')
    track.codec = 'srt';
  else if (/^S_(TEXT\/)?(ASS|SSA)$/.test(codecId)) track.codec = 'ass';
  else if (codecId === 'S_TEXT/WEBVTT') track.codec = 'vtt';
  else track.unsupported = codecId;
  if (track.codec === 'ass' && codecPrivate) track.header = utf8(codecPrivate);
}

/** An audio codec's configuration; `false` when RNAP has none for it. */
function configureAudio(
  track: RemuxTrack,
  codecId: string,
  cp: Uint8Array | null
): boolean {
  if (codecId.startsWith('A_AAC')) {
    aac(track, codecId, cp);
    return true;
  }
  switch (codecId) {
    case 'A_MPEG/L3':
      track.entry = 'mp4a';
      track.objectType = 0x6b;
      track.codec = 'mp4a.6B';
      return true;
    case 'A_AC3':
    case 'A_EAC3':
      track.entry = codecId === 'A_AC3' ? 'ac-3' : 'ec-3';
      return true;
    case 'A_OPUS':
      if (!cp) return false;
      opus(track, codecId, cp);
      return true;
    case 'A_FLAC':
      if (!cp) return false;
      flac(track, codecId, cp);
      return true;
    default:
      return false;
  }
}

function opus(track: RemuxTrack, codecId: string, cp: Uint8Array): void {
  const config = opusConfig(cp);
  if (!config) {
    track.unsupported = codecId;
    return;
  }
  track.entry = 'Opus';
  track.config = config.config;
  track.codec = 'opus';
  track.channels = config.channels;
  track.sampleRate = 48000;
  track.timescale = 48000;
}

function flac(track: RemuxTrack, codecId: string, cp: Uint8Array): void {
  const config = flacConfig(cp);
  if (!config) {
    track.unsupported = codecId;
    return;
  }
  track.entry = 'fLaC';
  track.config = config.config;
  track.codec = 'flac';
  track.sampleRate = config.sampleRate;
  track.channels = config.channels;
  track.timescale = config.sampleRate;
}

function aac(
  track: RemuxTrack,
  codecId: string,
  codecPrivate: Uint8Array | null
): void {
  let asc = codecPrivate && codecPrivate.length >= 2 ? codecPrivate : null;
  if (!asc) {
    const profile = /\/(MAIN|LC|SSR|LTP)/.exec(codecId)?.[1] ?? 'LC';
    const objectType = { MAIN: 1, LC: 2, SSR: 3, LTP: 4 }[profile]!;
    asc = makeAsc(objectType, track.sampleRate, track.channels);
  }
  const info = parseAsc(asc);
  if (!info.sampleRate) {
    track.unsupported = 'AAC without a sample rate';
    return;
  }
  track.entry = 'mp4a';
  track.objectType = 0x40;
  track.config = asc;
  track.codec = `mp4a.40.${info.objectType}`;
  track.sampleRate = info.sampleRate;
  track.timescale = info.sampleRate;
  if (info.channels > 0) track.channels = info.channels;
}

/** VP9's configuration from its first keyframe (and the CodecPrivate's features). */
function vp9FromFrame(state: TrackState, frame: Uint8Array): void {
  const track = state.track;
  const info = vp9Keyframe(frame);
  if (!info) return;
  const f = state.features ?? {};
  if (f[1] != null) info.profile = f[1];
  if (f[3] != null) info.bitDepth = f[3];
  const level = f[2] ?? vp9Level(track.width, track.height);
  track.config = vpcConfig(info, level);
  track.codec = vpxCodec('vp09', track.config);
}

/** AC-3 / E-AC-3's configuration from a sync frame. */
function ac3FromFrame(track: RemuxTrack, frame: Uint8Array): void {
  const h = ac3Header(frame, 0);
  if (!h) return;
  track.entry = h.extended ? 'ec-3' : 'ac-3';
  track.config = h.config;
  track.codec = track.entry;
  track.sampleRate = h.sampleRate;
  track.timescale = h.sampleRate;
  track.channels = h.channels;
}
