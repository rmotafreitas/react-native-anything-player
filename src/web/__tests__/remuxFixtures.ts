/* eslint-disable no-bitwise -- builds bit-field headers. */
// Small builders for the remux tests: bit-exact H.264/HEVC parameter sets, a
// VP9 keyframe header, AC-3 and E-AC-3 sync frames, EBML elements, and MPEG-TS
// packets, tables and PES packets.

import fs from 'node:fs';
import path from 'node:path';

import { avcConfig } from '../remux/codecs';
import { MatroskaDemuxer } from '../remux/Matroska';
import { TsDemuxer } from '../remux/MpegTs';
import type { DemuxFrame, RemuxCue, RemuxTrack } from '../remux/types';
import { concat } from './audioFixtures';

// ── Bits ──

export class BitWriter {
  private readonly out: number[] = [];

  bits(value: number, count: number): this {
    for (let i = count - 1; i >= 0; i--)
      this.out.push(Math.floor(value / 2 ** i) % 2);
    return this;
  }

  flag(on: boolean): this {
    return this.bits(on ? 1 : 0, 1);
  }

  ue(value: number): this {
    const code = value + 1;
    const length = Math.floor(Math.log2(code)) + 1;
    return this.bits(0, length - 1).bits(code, length);
  }

  se(value: number): this {
    return this.ue(value > 0 ? 2 * value - 1 : -2 * value);
  }

  /** The bits so far, padded with zeros to whole bytes. */
  bytes(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.out.length / 8));
    this.out.forEach((bit, i) => {
      out[i >> 3]! |= bit << (7 - (i & 7));
    });
    return out;
  }
}

// ── H.264 ──

export interface AvcSpsOptions {
  profile?: number;
  level?: number;
  chroma?: number;
  separatePlanes?: boolean;
  bitDepthLuma?: number;
  bitDepthChroma?: number;
  /** One entry per scaling list: `full` lists every delta, `default` ends at once, `null` is absent. */
  scaling?: Array<'full' | 'default' | null>;
  pocType?: 0 | 1 | 2;
  pocCycle?: number;
  widthMbs?: number;
  heightMapUnits?: number;
  frameMbsOnly?: boolean;
  crop?: [number, number, number, number];
  /** `undefined`: no VUI; `null`: a VUI without an aspect ratio; a number: aspect_ratio_idc; a pair: Extended_SAR. */
  sar?: number | [number, number] | null;
}

const HIGH = new Set([
  100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
]);

function writeScalingList(
  w: BitWriter,
  kind: 'full' | 'default',
  size: number
) {
  if (kind === 'default') {
    w.se(-8); // next_scale = 0: the rest of the list is the default
    return;
  }
  for (let i = 0; i < size; i++) w.se(0);
}

/** An H.264 SPS NAL (header byte included; no emulation prevention). */
export function avcSps(o: AvcSpsOptions = {}): Uint8Array {
  const profile = o.profile ?? 66;
  const chroma = o.chroma ?? 1;
  const w = new BitWriter();
  w.bits(profile, 8)
    .bits(0, 8)
    .bits(o.level ?? 30, 8);
  w.ue(0); // seq_parameter_set_id
  if (HIGH.has(profile)) {
    w.ue(chroma);
    if (chroma === 3) w.flag(o.separatePlanes ?? false);
    w.ue((o.bitDepthLuma ?? 8) - 8).ue((o.bitDepthChroma ?? 8) - 8);
    w.bits(0, 1); // qpprime_y_zero_transform_bypass_flag
    w.flag(o.scaling != null);
    const lists = chroma === 3 ? 12 : 8;
    for (let i = 0; o.scaling && i < lists; i++) {
      const kind = o.scaling[i] ?? null;
      w.flag(kind != null);
      if (kind) writeScalingList(w, kind, i < 6 ? 16 : 64);
    }
  }
  w.ue(0); // log2_max_frame_num_minus4
  const poc = o.pocType ?? 2;
  w.ue(poc);
  if (poc === 0) w.ue(0);
  if (poc === 1) {
    w.bits(0, 1).se(0).se(0);
    const cycle = o.pocCycle ?? 2;
    w.ue(cycle);
    for (let i = 0; i < cycle; i++) w.se(1);
  }
  w.ue(1); // max_num_ref_frames
  w.bits(0, 1);
  w.ue((o.widthMbs ?? 40) - 1).ue((o.heightMapUnits ?? 30) - 1);
  const frameMbsOnly = o.frameMbsOnly ?? true;
  w.flag(frameMbsOnly);
  if (!frameMbsOnly) w.bits(0, 1);
  w.bits(1, 1); // direct_8x8_inference_flag
  w.flag(o.crop != null);
  if (o.crop) for (const c of o.crop) w.ue(c);
  w.flag(o.sar !== undefined);
  if (o.sar !== undefined) {
    w.flag(o.sar !== null);
    if (o.sar !== null) {
      if (Array.isArray(o.sar))
        w.bits(255, 8).bits(o.sar[0], 16).bits(o.sar[1], 16);
      else w.bits(o.sar, 8);
    }
  }
  w.bits(1, 1); // rbsp stop bit
  return concat(Uint8Array.of(0x67), w.bytes());
}

export const AVC_PPS = Uint8Array.of(0x68, 0xce, 0x38, 0x80);

// ── HEVC ──

export interface HevcSpsOptions {
  /** sps_max_sub_layers_minus1 (the SPS's own field, `subLayers - 1`). */
  maxSubLayers?: number;
  profileSpace?: number;
  tier?: number;
  profileIdc?: number;
  compatibility?: number;
  constraints?: number[];
  level?: number;
  /** Per sub-layer: whether its profile and its level are present. */
  subLayerFlags?: Array<[boolean, boolean]>;
  chroma?: number;
  separatePlanes?: boolean;
  width?: number;
  height?: number;
  crop?: [number, number, number, number];
  bitDepthLuma?: number;
  bitDepthChroma?: number;
  temporalIdNested?: boolean;
}

/** An HEVC SPS NAL (2-byte header included). */
export function hevcSps(o: HevcSpsOptions = {}): Uint8Array {
  const maxSubLayers = o.maxSubLayers ?? 0;
  const w = new BitWriter();
  w.bits(0, 4); // sps_video_parameter_set_id
  w.bits(maxSubLayers, 3);
  w.flag(o.temporalIdNested ?? true);
  w.bits(o.profileSpace ?? 0, 2)
    .bits(o.tier ?? 0, 1)
    .bits(o.profileIdc ?? 1, 5);
  w.bits(o.compatibility ?? 0x60000000, 32);
  for (const b of o.constraints ?? [0x90, 0, 0, 0, 0, 0]) w.bits(b, 8);
  w.bits(o.level ?? 93, 8);
  const flags = o.subLayerFlags ?? [];
  for (let i = 0; i < maxSubLayers; i++) {
    w.flag(flags[i]?.[0] ?? false).flag(flags[i]?.[1] ?? false);
  }
  if (maxSubLayers > 0) w.bits(0, 2 * (8 - maxSubLayers));
  for (let i = 0; i < maxSubLayers; i++) {
    if (flags[i]?.[0]) w.bits(0, 32).bits(0, 32).bits(0, 24);
    if (flags[i]?.[1]) w.bits(0, 8);
  }
  w.ue(0); // sps_seq_parameter_set_id
  const chroma = o.chroma ?? 1;
  w.ue(chroma);
  if (chroma === 3) w.flag(o.separatePlanes ?? false);
  w.ue(o.width ?? 1920).ue(o.height ?? 1088);
  w.flag(o.crop != null);
  if (o.crop) for (const c of o.crop) w.ue(c);
  w.ue((o.bitDepthLuma ?? 8) - 8).ue((o.bitDepthChroma ?? 8) - 8);
  w.bits(1, 1);
  return concat(Uint8Array.of(0x42, 0x01), w.bytes());
}

export const HEVC_VPS = Uint8Array.of(0x40, 0x01, 0x0c, 0x01);
export const HEVC_PPS = Uint8Array.of(0x44, 0x01, 0xc1, 0x72);

// ── VP9 ──

export interface Vp9Options {
  profile?: number;
  keyframe?: boolean;
  showExisting?: boolean;
  marker?: number;
  sync?: number;
  bitDepth12?: boolean;
  colorSpace?: number;
  fullRange?: boolean;
  subsampling?: [number, number];
}

/** A VP9 frame's uncompressed header (the first bytes of a frame). */
export function vp9Frame(o: Vp9Options = {}): Uint8Array {
  const profile = o.profile ?? 0;
  const w = new BitWriter();
  w.bits(o.marker ?? 2, 2)
    .bits(profile & 1, 1)
    .bits(profile >> 1, 1);
  if (profile === 3) w.bits(0, 1);
  w.flag(o.showExisting ?? false);
  if (o.showExisting) return concat(w.bits(0, 3).bytes(), new Uint8Array(8));
  w.flag(!(o.keyframe ?? true)); // frame_type: 0 is a keyframe
  w.bits(1, 1).bits(0, 1); // show_frame, error_resilient_mode
  w.bits(o.sync ?? 0x498342, 24);
  if (profile >= 2) w.flag(o.bitDepth12 ?? false);
  const colorSpace = o.colorSpace ?? 2;
  w.bits(colorSpace, 3);
  if (colorSpace !== 7) {
    w.flag(o.fullRange ?? false);
    if (profile === 1 || profile === 3) {
      w.bits(o.subsampling?.[0] ?? 0, 1).bits(o.subsampling?.[1] ?? 0, 1);
    }
  }
  return concat(w.bytes(), new Uint8Array(8));
}

// ── AC-3, E-AC-3 ──

export interface Ac3Options {
  fscod?: number;
  frmsizecod?: number;
  bsid?: number;
  bsmod?: number;
  acmod?: number;
  lfeon?: boolean;
  /** Bytes of the whole frame. */
  size?: number;
}

/** An AC-3 sync frame: the header, then zeros. */
export function ac3Frame(o: Ac3Options = {}): Uint8Array {
  const acmod = o.acmod ?? 7;
  const w = new BitWriter();
  w.bits(o.fscod ?? 0, 2).bits(o.frmsizecod ?? 28, 6);
  w.bits(o.bsid ?? 8, 5)
    .bits(o.bsmod ?? 0, 3)
    .bits(acmod, 3);
  if ((acmod & 1) !== 0 && acmod !== 1) w.bits(0, 2);
  if ((acmod & 4) !== 0) w.bits(0, 2);
  if (acmod === 2) w.bits(0, 2);
  w.flag(o.lfeon ?? true);
  const body = w.bytes();
  const out = new Uint8Array(Math.max(o.size ?? 8, 4 + body.length));
  out.set([0x0b, 0x77, 0, 0]);
  out.set(body, 4);
  return out;
}

export interface Eac3Options {
  /** 0 independent, 1 dependent. */
  strmtyp?: number;
  substreamid?: number;
  /** Bytes of the whole frame. */
  size?: number;
  fscod?: number;
  numblkscod?: number;
  fscod2?: number;
  acmod?: number;
  lfeon?: boolean;
  bsid?: number;
}

/** An E-AC-3 sync frame: the header, then zeros. */
export function eac3Frame(o: Eac3Options = {}): Uint8Array {
  const size = o.size ?? 64;
  const w = new BitWriter();
  w.bits(o.strmtyp ?? 0, 2).bits(o.substreamid ?? 0, 3);
  w.bits(size / 2 - 1, 11);
  const fscod = o.fscod ?? 0;
  w.bits(fscod, 2);
  if (fscod === 3) w.bits(o.fscod2 ?? 0, 2);
  else w.bits(o.numblkscod ?? 3, 2);
  w.bits(o.acmod ?? 7, 3)
    .flag(o.lfeon ?? true)
    .bits(o.bsid ?? 16, 5);
  const body = w.bytes();
  const out = new Uint8Array(size);
  out.set([0x0b, 0x77]);
  out.set(body, 2);
  return out;
}

// ── EBML ──

function idBytes(id: number): Uint8Array {
  const out: number[] = [];
  for (let n = id; n > 0; n = Math.floor(n / 256)) out.unshift(n % 256);
  return Uint8Array.from(out);
}

/** The minimal EBML size (or one of `length` bytes), or the unknown-size marker. */
export function sizeBytes(
  size: number | 'unknown',
  length?: number
): Uint8Array {
  if (size === 'unknown') return Uint8Array.of(0xff);
  let n = length ?? 1;
  while (size >= 2 ** (7 * n) - 1) n += 1;
  const out = new Uint8Array(n);
  let rest = size;
  for (let i = n - 1; i >= 0; i--) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0]! |= 0x80 >> (n - 1);
  return out;
}

/** An element: its ID, size, and payload. */
export function el(
  id: number,
  payload: Uint8Array | readonly Uint8Array[] = new Uint8Array(0),
  size?: number | 'unknown'
): Uint8Array {
  const body = payload instanceof Uint8Array ? payload : concat(...payload);
  return concat(idBytes(id), sizeBytes(size ?? body.length), body);
}

export function uintEl(id: number, value: number, length?: number): Uint8Array {
  const bytes: number[] = [];
  for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  while (bytes.length < (length ?? 1)) bytes.unshift(0);
  return el(id, Uint8Array.from(bytes));
}

export function strEl(id: number, value: string): Uint8Array {
  return el(id, new TextEncoder().encode(value));
}

export function floatEl(
  id: number,
  value: number,
  bytes: 4 | 8 = 8
): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  if (bytes === 4) view.setFloat32(0, value);
  else view.setFloat64(0, value);
  return el(id, out);
}

export const MKV = {
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
  Void: 0xec,
} as const;

export const ebmlHeader = (docType = 'matroska') =>
  el(MKV.EBML, [strEl(MKV.DocType, docType)]);

export interface TrackSpec {
  number: number;
  /** 1 video, 2 audio, 17 text. */
  type: number;
  codec?: string;
  codecPrivate?: Uint8Array;
  enabled?: boolean;
  default?: boolean;
  forced?: boolean;
  name?: string;
  language?: string;
  languageBcp47?: string;
  defaultDurationNs?: number;
  video?: {
    width?: number;
    height?: number;
    displayWidth?: number;
    displayHeight?: number;
    displayUnit?: number;
  };
  audio?: { rate?: number; channels?: number };
  /** Raw ContentEncodings children (ContentEncoding elements). */
  encodings?: Uint8Array[];
}

export function trackEntry(t: TrackSpec): Uint8Array {
  const parts = [
    uintEl(MKV.TrackNumber, t.number),
    uintEl(MKV.TrackType, t.type),
  ];
  if (t.enabled === false) parts.push(uintEl(MKV.FlagEnabled, 0));
  if (t.default != null) parts.push(uintEl(MKV.FlagDefault, t.default ? 1 : 0));
  if (t.forced != null) parts.push(uintEl(MKV.FlagForced, t.forced ? 1 : 0));
  if (t.defaultDurationNs)
    parts.push(uintEl(MKV.DefaultDuration, t.defaultDurationNs, 4));
  if (t.name != null) parts.push(strEl(MKV.Name, t.name));
  if (t.language != null) parts.push(strEl(MKV.Language, t.language));
  if (t.languageBcp47 != null)
    parts.push(strEl(MKV.LanguageBCP47, t.languageBcp47));
  if (t.codec != null) parts.push(strEl(MKV.CodecID, t.codec));
  if (t.codecPrivate) parts.push(el(MKV.CodecPrivate, t.codecPrivate));
  if (t.encodings) parts.push(el(MKV.ContentEncodings, t.encodings));
  if (t.video) {
    const v = t.video;
    const fields: Uint8Array[] = [];
    if (v.width != null) fields.push(uintEl(MKV.PixelWidth, v.width, 2));
    if (v.height != null) fields.push(uintEl(MKV.PixelHeight, v.height, 2));
    if (v.displayWidth != null)
      fields.push(uintEl(MKV.DisplayWidth, v.displayWidth, 2));
    if (v.displayHeight != null)
      fields.push(uintEl(MKV.DisplayHeight, v.displayHeight, 2));
    if (v.displayUnit != null)
      fields.push(uintEl(MKV.DisplayUnit, v.displayUnit));
    parts.push(el(MKV.Video, fields));
  }
  if (t.audio) {
    const fields: Uint8Array[] = [];
    if (t.audio.rate != null)
      fields.push(floatEl(MKV.SamplingFrequency, t.audio.rate));
    if (t.audio.channels != null)
      fields.push(uintEl(MKV.Channels, t.audio.channels));
    parts.push(el(MKV.Audio, fields));
  }
  return el(MKV.TrackEntry, parts);
}

export const tracksEl = (...tracks: TrackSpec[]) =>
  el(MKV.Tracks, tracks.map(trackEntry));

export const infoEl = (fields: Uint8Array[] = []) => el(MKV.Info, fields);

/** The block header: track number (1 byte vint), 16-bit relative time, flags. */
export function blockBytes(
  track: number,
  relative: number,
  flags: number,
  payload: Uint8Array
): Uint8Array {
  return concat(
    Uint8Array.of(0x80 | track, (relative >> 8) & 0xff, relative & 0xff, flags),
    payload
  );
}

export const simpleBlock = (
  track: number,
  relative: number,
  data: Uint8Array,
  flags = 0x80
) => el(MKV.SimpleBlock, blockBytes(track, relative, flags, data));

export function blockGroup(
  track: number,
  relative: number,
  data: Uint8Array,
  options: { duration?: number; reference?: boolean; flags?: number } = {}
): Uint8Array {
  const parts = [
    el(MKV.Block, blockBytes(track, relative, options.flags ?? 0, data)),
  ];
  if (options.duration != null)
    parts.push(uintEl(MKV.BlockDuration, options.duration));
  if (options.reference)
    parts.push(el(MKV.ReferenceBlock, Uint8Array.of(0xff)));
  return el(MKV.BlockGroup, parts);
}

export const cluster = (
  time: number,
  children: Uint8Array[],
  size?: number | 'unknown'
) => el(MKV.Cluster, [uintEl(MKV.Timestamp, time), ...children], size);

/** A segment with its size and children; the header length is `segmentStart`. */
export function mkv(
  children: Uint8Array[],
  unknownSegment = false
): Uint8Array {
  return concat(
    ebmlHeader(),
    el(MKV.Segment, children, unknownSegment ? 'unknown' : undefined)
  );
}

// ── MPEG-TS ──

/** A 188-byte packet; what the payload leaves is stuffing, in an adaptation field. */
export function tsPacket(
  pid: number,
  payload: Uint8Array,
  options: { start?: boolean; adaptation?: Uint8Array } = {}
): Uint8Array {
  const total = 184 - payload.length;
  if (total < 0) throw new Error('payload too large for a packet');
  let field = options.adaptation ?? null;
  if (!field && total > 0)
    field = total === 1 ? new Uint8Array(0) : Uint8Array.of(0);
  const p = new Uint8Array(188).fill(0xff);
  p[0] = 0x47;
  p[1] = (options.start ? 0x40 : 0) | (pid >> 8);
  p[2] = pid & 0xff;
  p[3] = field ? 0x30 : 0x10;
  let at = 4;
  if (field) {
    p[at] = total - 1; // the length byte counts the field and its stuffing
    p.set(field, at + 1);
    at += total;
  }
  p.set(payload, at);
  return p;
}

/** A PSI section, split over as many packets as it needs. */
export function psiPackets(
  pid: number,
  table: Uint8Array,
  split = 183
): Uint8Array[] {
  const data = concat(Uint8Array.of(0), table);
  const packets: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += split)
    packets.push(
      tsPacket(pid, data.subarray(at, at + split), { start: at === 0 })
    );
  return packets;
}

function section(tableId: number, body: Uint8Array): Uint8Array {
  const length = body.length + 4;
  return concat(
    Uint8Array.of(tableId, 0xb0 | (length >> 8), length & 0xff),
    body,
    new Uint8Array(4)
  );
}

export function patSection(programs: Array<[number, number]>): Uint8Array {
  const entries = programs.flatMap(([program, pid]) => [
    program >> 8,
    program & 0xff,
    0xe0 | (pid >> 8),
    pid & 0xff,
  ]);
  return section(0x00, Uint8Array.of(0, 1, 0xc1, 0, 0, ...entries));
}

export interface PmtStream {
  type: number;
  pid: number;
  descriptors?: number[];
}

export function pmtSection(
  streams: PmtStream[],
  programInfo: number[] = []
): Uint8Array {
  const entries = streams.flatMap((s) => {
    const d = s.descriptors ?? [];
    return [
      s.type,
      0xe0 | (s.pid >> 8),
      s.pid & 0xff,
      0xf0 | (d.length >> 8),
      d.length & 0xff,
      ...d,
    ];
  });
  return section(
    0x02,
    Uint8Array.of(
      0,
      1,
      0xc1,
      0,
      0,
      0xe1,
      0x00,
      0xf0 | (programInfo.length >> 8),
      programInfo.length & 0xff,
      ...programInfo,
      ...entries
    )
  );
}

/** A 33-bit timestamp as the 5 bytes of a PES header. */
export function ptsBytes(pts: number): Uint8Array {
  const hi = Math.floor(pts / 2 ** 30) & 7;
  return Uint8Array.of(
    0x21 | (hi << 1),
    Math.floor(pts / 2 ** 22) & 0xff,
    ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1,
    Math.floor(pts / 2 ** 7) & 0xff,
    ((pts % 128) << 1) | 1
  );
}

/** A PES packet; `bounded` writes its length (audio), else 0 (video). */
export function pesPacket(
  streamId: number,
  pts: number | null,
  payload: Uint8Array,
  bounded = false
): Uint8Array {
  const header = pts == null ? new Uint8Array(0) : ptsBytes(pts);
  const length = 3 + header.length + payload.length;
  return concat(
    Uint8Array.of(
      0,
      0,
      1,
      streamId,
      bounded ? length >> 8 : 0,
      bounded ? length & 0xff : 0,
      0x80,
      pts == null ? 0 : 0x80,
      header.length
    ),
    header,
    payload
  );
}

/** A PES split into packets of `pid`; the last is stuffed. */
export function pesPackets(pid: number, pes: Uint8Array): Uint8Array[] {
  const packets: Uint8Array[] = [];
  for (let at = 0; at < pes.length; at += 184)
    packets.push(
      tsPacket(pid, pes.subarray(at, at + 184), { start: at === 0 })
    );
  return packets;
}

/** An Annex B access unit: each NAL behind a 4-byte start code. */
export function annexB(...nals: Uint8Array[]): Uint8Array {
  return concat(...nals.flatMap((n) => [Uint8Array.of(0, 0, 0, 1), n]));
}

export const IDR = Uint8Array.of(0x65, 0x88, 0x84, 0x00, 0x10);
export const SLICE = Uint8Array.of(0x41, 0x9a, 0x02, 0x03);
export const AUD = Uint8Array.of(0x09, 0xf0);

// ── Demuxing helpers ──

export const DIR = path.resolve(__dirname, '../../../conformance/remux');
export const read = (file: string) =>
  new Uint8Array(fs.readFileSync(path.join(DIR, file)));
export const bytes = (...values: number[]) => Uint8Array.from(values);
export const hex = (data: Uint8Array) => Buffer.from(data).toString('hex');

export interface Demuxed<D> {
  demuxer: D;
  frames: DemuxFrame[];
  cues: RemuxCue[];
}

export function chunks(data: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < data.length; at += size)
    out.push(data.subarray(at, at + size));
  return out;
}

export function demuxMkv(
  data: Uint8Array,
  size = data.length
): Demuxed<MatroskaDemuxer> {
  const demuxer = new MatroskaDemuxer();
  const frames: DemuxFrame[] = [];
  const cues: RemuxCue[] = [];
  const sink = {
    frame: (f: DemuxFrame) => frames.push(f),
    cue: (c: RemuxCue) => cues.push(c),
  };
  for (const part of chunks(data, size)) demuxer.push(part, sink);
  demuxer.end(sink);
  return { demuxer, frames, cues };
}

export function demuxTs(
  data: Uint8Array,
  size = data.length
): Demuxed<TsDemuxer> {
  const demuxer = new TsDemuxer();
  const frames: DemuxFrame[] = [];
  const cues: RemuxCue[] = [];
  const sink = {
    frame: (f: DemuxFrame) => frames.push(f),
    cue: (c: RemuxCue) => cues.push(c),
  };
  for (const part of chunks(data, size)) demuxer.push(part, sink);
  demuxer.end(sink);
  return { demuxer, frames, cues };
}

// ── Matroska fixtures ──

export const AVC_CONFIG = avcConfig([avcSps()], [AVC_PPS]);
export const video = (overrides: Partial<TrackSpec> = {}): TrackSpec => ({
  number: 1,
  type: 1,
  codec: 'V_MPEG4/ISO/AVC',
  codecPrivate: AVC_CONFIG,
  video: { width: 640, height: 480 },
  ...overrides,
});
export const audio = (overrides: Partial<TrackSpec> = {}): TrackSpec => ({
  number: 2,
  type: 2,
  codec: 'A_AAC',
  audio: { rate: 44100, channels: 2 },
  ...overrides,
});

/** One track's summary through a file that holds only it. */
export function trackOf(spec: TrackSpec): RemuxTrack {
  const { demuxer } = demuxMkv(mkv([infoEl(), tracksEl(spec)]));
  return demuxer.tracks[0]!;
}

export const PMT_PID = 0x100;
export const VIDEO_PID = 0x101;
export const AUDIO_PID = 0x102;

/** Packets of a PID nobody reads: sync needs three in a row to be sure. */
export const filler = () =>
  Array.from({ length: 3 }, () => tsPacket(0x1fff, new Uint8Array(184)));

export function tables(
  streams: PmtStream[],
  programInfo: number[] = []
): Uint8Array[] {
  return [
    ...psiPackets(0, patSection([[1, PMT_PID]])),
    ...psiPackets(PMT_PID, pmtSection(streams, programInfo)),
    ...filler(),
  ];
}

export const H264 = { type: 0x1b, pid: VIDEO_PID };
export const AAC = { type: 0x0f, pid: AUDIO_PID };

export function videoAu(
  pts: number,
  key: boolean,
  withParams = key
): Uint8Array[] {
  const nals: Uint8Array[] = [AUD];
  if (withParams) nals.push(avcSps(), AVC_PPS);
  nals.push(key ? IDR : SLICE);
  return pesPackets(VIDEO_PID, pesPacket(0xe0, pts, annexB(...nals)));
}

export function audioPes(pts: number, ...frames: Uint8Array[]): Uint8Array[] {
  return pesPackets(AUDIO_PID, pesPacket(0xc0, pts, concat(...frames), true));
}

export const join = (packets: Uint8Array[]) => concat(...packets);
