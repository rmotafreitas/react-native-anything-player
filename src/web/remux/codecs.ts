/* eslint-disable no-bitwise -- codec headers are bit fields. */
// What the MP4 sample entries need from each codec: the configuration boxes
// (avcC, hvcC, vpcC, AudioSpecificConfig, dOps, dfLa, dac3, dec3), the RFC
// 6381 codec strings, and the frame headers that give an audio frame's
// length and duration. The Swift twin is ios/Core/Remux/Codecs.swift.

import {
  BitReader,
  BoxWriter,
  hex2,
  pad2,
  readUint,
  unescapeRbsp,
} from './bytes';

// ── Annex B (MPEG-TS video) ──

/** The NAL units of an Annex B access unit (start codes removed). */
export function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  let start = -1;
  let i = 0;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) units.push(trimZeros(data.subarray(start, i)));
      i += 3;
      start = i;
    } else {
      i += 1;
    }
  }
  if (start >= 0 && start < data.length)
    units.push(trimZeros(data.subarray(start)));
  return units.filter((u) => u.length > 0);
}

/** A NAL unit without the zero bytes of the next start code (`00 00 00 01`). */
function trimZeros(unit: Uint8Array): Uint8Array {
  let end = unit.length;
  while (end > 0 && unit[end - 1] === 0) end -= 1;
  return unit.subarray(0, end);
}

/** NAL units with 4-byte big-endian lengths, as MP4 samples carry them. */
export function lengthPrefixed(units: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const unit of units) size += 4 + unit.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const unit of units) {
    const n = unit.length;
    out[at] = n >>> 24;
    out[at + 1] = (n >>> 16) & 0xff;
    out[at + 2] = (n >>> 8) & 0xff;
    out[at + 3] = n & 0xff;
    out.set(unit, at + 4);
    at += 4 + n;
  }
  return out;
}

// ── H.264 ──

export interface PictureInfo {
  width: number;
  height: number;
}

export interface AvcSps extends PictureInfo {
  /** The pixels' aspect ratio (the VUI's), `1:1` when it does not say. */
  sarWidth: number;
  sarHeight: number;
  profile: number;
  chromaFormat: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
}

function skipScalingList(r: BitReader, size: number): void {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    if (next !== 0) last = next;
  }
}

/** aspect_ratio_idc 1–16 → the sample aspect ratio. */
const AVC_SARS: Array<[number, number]> = [
  [1, 1],
  [12, 11],
  [10, 11],
  [16, 11],
  [40, 33],
  [24, 11],
  [20, 11],
  [32, 11],
  [80, 33],
  [18, 11],
  [15, 11],
  [64, 33],
  [160, 99],
  [4, 3],
  [3, 2],
  [2, 1],
];

const HIGH_PROFILES = [
  100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
];

/** The high profiles' chroma format and bit depths (the scaling lists skipped). */
function avcChroma(r: BitReader, profile: number) {
  const out = {
    chromaFormat: 1,
    bitDepthLuma: 8,
    bitDepthChroma: 8,
    separatePlanes: false,
  };
  if (!HIGH_PROFILES.includes(profile)) return out;
  out.chromaFormat = r.ue();
  if (out.chromaFormat === 3) out.separatePlanes = r.bit();
  out.bitDepthLuma = r.ue() + 8;
  out.bitDepthChroma = r.ue() + 8;
  r.skip(1); // qpprime_y_zero_transform_bypass_flag
  if (!r.bit()) return out;
  const lists = out.chromaFormat === 3 ? 12 : 8;
  for (let i = 0; i < lists; i++)
    if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
  return out;
}

/** pic_order_cnt_type and its fields. */
function skipPictureOrder(r: BitReader): void {
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue();
    return;
  }
  if (pocType !== 1) return;
  r.skip(1);
  r.se();
  r.se();
  const cycle = r.ue();
  for (let i = 0; i < cycle; i++) r.se();
}

/** The VUI's sample aspect ratio, `1:1` when it says none. */
function avcSar(r: BitReader): [number, number] {
  const vui = r.bit();
  const aspect = vui && r.bit();
  if (!aspect) return [1, 1];
  const idc = r.bits(8);
  const sar: [number, number] =
    idc === 255 ? [r.bits(16), r.bits(16)] : (AVC_SARS[idc - 1] ?? [1, 1]);
  return sar[0] === 0 || sar[1] === 0 ? [1, 1] : sar;
}

/** An H.264 sequence parameter set (with its NAL header byte). */
export function parseAvcSps(nal: Uint8Array): AvcSps {
  const r = new BitReader(unescapeRbsp(nal.subarray(1)));
  const profile = r.bits(8);
  r.skip(16); // constraint flags, level
  r.ue(); // seq_parameter_set_id
  const { chromaFormat, bitDepthLuma, bitDepthChroma, separatePlanes } =
    avcChroma(r, profile);
  r.ue(); // log2_max_frame_num_minus4
  skipPictureOrder(r);
  r.ue(); // max_num_ref_frames
  r.skip(1); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue() + 1;
  const heightUnits = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.skip(1);
  r.skip(1); // direct_8x8_inference_flag
  let crop = [0, 0, 0, 0];
  if (r.bit()) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  const sar = avcSar(r);
  const chroma = separatePlanes ? 0 : chromaFormat;
  const unitX = chroma === 1 || chroma === 2 ? 2 : 1;
  const fields = frameMbsOnly ? 1 : 2;
  const unitY = (chroma === 1 ? 2 : 1) * fields;
  return {
    sarWidth: sar[0],
    sarHeight: sar[1],
    profile,
    chromaFormat,
    bitDepthLuma,
    bitDepthChroma,
    width: widthMbs * 16 - unitX * (crop[0]! + crop[1]!),
    height: fields * heightUnits * 16 - unitY * (crop[2]! + crop[3]!),
  };
}

/** The `avcC` payload for these parameter sets (NAL header bytes included). */
export function avcConfig(
  sps: readonly Uint8Array[],
  pps: readonly Uint8Array[]
): Uint8Array {
  const first = sps[0]!;
  const w = new BoxWriter(64);
  w.u8(1).u8(first[1]!).u8(first[2]!).u8(first[3]!);
  w.u8(0xff); // 4-byte NAL lengths
  w.u8(0xe0 | sps.length);
  for (const unit of sps) w.u16(unit.length).raw(unit);
  w.u8(pps.length);
  for (const unit of pps) w.u16(unit.length).raw(unit);
  if ([100, 110, 122, 144].includes(first[1]!)) {
    const info = parseAvcSps(first);
    w.u8(0xfc | info.chromaFormat);
    w.u8(0xf8 | (info.bitDepthLuma - 8));
    w.u8(0xf8 | (info.bitDepthChroma - 8));
    w.u8(0);
  }
  return w.finish();
}

/** `avc1.PPCCLL` from an `avcC`. */
export function avcCodec(avcC: Uint8Array): string {
  return `avc1.${hex2(avcC[1]!)}${hex2(avcC[2]!)}${hex2(avcC[3]!)}`;
}

/** The first SPS of an `avcC`, and its NAL length size. */
export function avcConfigInfo(avcC: Uint8Array): {
  lengthSize: number;
  sps: Uint8Array | null;
} {
  const lengthSize = ((avcC[4] ?? 3) & 3) + 1;
  if ((avcC[5] ?? 0) & 0x1f && avcC.length >= 8) {
    const n = readUint(avcC, 6, 2);
    return { lengthSize, sps: avcC.subarray(8, 8 + n) };
  }
  return { lengthSize, sps: null };
}

// ── HEVC ──

export interface HevcSps extends PictureInfo {
  profileSpace: number;
  tier: number;
  profileIdc: number;
  compatibility: number;
  constraints: Uint8Array;
  level: number;
  chromaFormat: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  subLayers: number;
  temporalIdNested: boolean;
}

/** The sub-layers' profile and level flags, and what they announce. */
function skipSubLayers(r: BitReader, maxSubLayers: number): void {
  const present: Array<[boolean, boolean]> = [];
  for (let i = 0; i < maxSubLayers; i++) present.push([r.bit(), r.bit()]);
  if (maxSubLayers > 0) r.skip(2 * (8 - maxSubLayers));
  for (const [profilePresent, levelPresent] of present) {
    if (profilePresent) r.skip(88);
    if (levelPresent) r.skip(8);
  }
}

/** chroma_format_idc and the picture's size, its conformance window cropped. */
function hevcPicture(r: BitReader) {
  const chromaFormat = r.ue();
  const separatePlanes = chromaFormat === 3 && r.bit();
  let width = r.ue();
  let height = r.ue();
  if (r.bit()) {
    const chroma = separatePlanes ? 0 : chromaFormat;
    const unitX = chroma === 1 || chroma === 2 ? 2 : 1;
    const unitY = chroma === 1 ? 2 : 1;
    width -= unitX * (r.ue() + r.ue());
    height -= unitY * (r.ue() + r.ue());
  }
  return { chromaFormat, width, height };
}

/** An HEVC sequence parameter set (with its 2-byte NAL header). */
export function parseHevcSps(nal: Uint8Array): HevcSps {
  const r = new BitReader(unescapeRbsp(nal.subarray(2)));
  r.skip(4); // sps_video_parameter_set_id
  const maxSubLayers = r.bits(3);
  const temporalIdNested = r.bit();
  const profileSpace = r.bits(2);
  const tier = r.bits(1);
  const profileIdc = r.bits(5);
  const compatibility = r.bits(32);
  const constraints = new Uint8Array(6);
  for (let i = 0; i < 6; i++) constraints[i] = r.bits(8);
  const level = r.bits(8);
  skipSubLayers(r, maxSubLayers);
  r.ue(); // sps_seq_parameter_set_id
  const { chromaFormat, width, height } = hevcPicture(r);
  return {
    profileSpace,
    tier,
    profileIdc,
    compatibility,
    constraints,
    level,
    chromaFormat,
    bitDepthLuma: r.ue() + 8,
    bitDepthChroma: r.ue() + 8,
    width,
    height,
    subLayers: maxSubLayers + 1,
    temporalIdNested,
  };
}

/** The `hvcC` payload for these parameter sets (NAL headers included). */
export function hevcConfig(
  vps: readonly Uint8Array[],
  sps: readonly Uint8Array[],
  pps: readonly Uint8Array[]
): Uint8Array {
  const info = parseHevcSps(sps[0]!);
  const w = new BoxWriter(128);
  w.u8(1);
  w.u8((info.profileSpace << 6) | (info.tier << 5) | info.profileIdc);
  w.u32(info.compatibility).raw(info.constraints).u8(info.level);
  w.u16(0xf000); // min_spatial_segmentation_idc: unknown
  w.u8(0xfc); // parallelismType: unknown
  w.u8(0xfc | info.chromaFormat);
  w.u8(0xf8 | (info.bitDepthLuma - 8));
  w.u8(0xf8 | (info.bitDepthChroma - 8));
  w.u16(0); // avgFrameRate
  w.u8((info.subLayers << 3) | ((info.temporalIdNested ? 1 : 0) << 2) | 3);
  const arrays: Array<[number, readonly Uint8Array[]]> = [
    [32, vps],
    [33, sps],
    [34, pps],
  ];
  const present = arrays.filter(([, units]) => units.length > 0);
  w.u8(present.length);
  for (const [type, units] of present) {
    w.u8(0x80 | type).u16(units.length);
    for (const unit of units) w.u16(unit.length).raw(unit);
  }
  return w.finish();
}

function reverseBits32(value: number): number {
  let out = 0;
  for (let i = 0; i < 32; i++) out = out * 2 + ((value >>> i) & 1);
  return out;
}

/** `hvc1.<space><profile>.<compat>.<tier><level>.<constraints>` from an `hvcC`. */
export function hevcCodec(hvcC: Uint8Array): string {
  const b = hvcC[1] ?? 0;
  const space = ['', 'A', 'B', 'C'][b >> 6]!;
  const compat = reverseBits32(readUint(hvcC, 2, 4))
    .toString(16)
    .toUpperCase();
  const tier = (b >> 5) & 1 ? 'H' : 'L';
  const constraints = Array.from(hvcC.subarray(6, 12));
  while (constraints.length > 0 && constraints[constraints.length - 1] === 0)
    constraints.pop();
  const tail = constraints.map((c) => `.${hex2(c)}`).join('');
  return `hvc1.${space}${b & 31}.${compat}.${tier}${hvcC[12] ?? 0}${tail}`;
}

/** The first SPS of an `hvcC`, and its NAL length size. */
export function hevcConfigInfo(hvcC: Uint8Array): {
  lengthSize: number;
  sps: Uint8Array | null;
} {
  const lengthSize = ((hvcC[21] ?? 3) & 3) + 1;
  let at = 23;
  const arrays = hvcC[22] ?? 0;
  for (let a = 0; a < arrays && at + 3 <= hvcC.length; a++) {
    const type = hvcC[at]! & 0x3f;
    const count = readUint(hvcC, at + 1, 2);
    at += 3;
    for (let i = 0; i < count && at + 2 <= hvcC.length; i++) {
      const n = readUint(hvcC, at, 2);
      if (type === 33)
        return { lengthSize, sps: hvcC.subarray(at + 2, at + 2 + n) };
      at += 2 + n;
    }
  }
  return { lengthSize, sps: null };
}

// ── VP8, VP9 ──

export interface VpxInfo {
  profile: number;
  bitDepth: number;
  /** vpcC: 0 4:2:0, 2 4:2:2, 3 4:4:4. */
  chroma: number;
  fullRange: boolean;
  /** VP9 color_space (0: unknown). */
  colorSpace: number;
}

/** A VP9 keyframe's uncompressed header; `null` for anything else. */
export function vp9Keyframe(frame: Uint8Array): VpxInfo | null {
  const r = new BitReader(frame);
  if (r.bits(2) !== 2) return null;
  const low = r.bits(1);
  const profile = (r.bits(1) << 1) | low;
  if (profile === 3) r.skip(1);
  if (r.bit()) return null; // show_existing_frame
  if (r.bit()) return null; // not a keyframe
  r.skip(2); // show_frame, error_resilient_mode
  if (r.bits(24) !== 0x498342) return null;
  let bitDepth = 8;
  if (profile >= 2) bitDepth = r.bit() ? 12 : 10;
  const colorSpace = r.bits(3);
  const { fullRange, chroma } = vp9Color(r, profile, colorSpace);
  return { profile, bitDepth, chroma, fullRange, colorSpace };
}

/** A VP9 keyframe's color range and subsampling (as vpcC's chroma). */
function vp9Color(r: BitReader, profile: number, colorSpace: number) {
  const fourFourFour = profile === 1 || profile === 3;
  if (colorSpace === 7) {
    // RGB: full range; 4:4:4 in profiles 1 and 3.
    return { fullRange: true, chroma: fourFourFour ? 3 : 0 };
  }
  const fullRange = r.bit();
  if (!fourFourFour) return { fullRange, chroma: 0 };
  const ssX = r.bits(1);
  const ssY = r.bits(1);
  return { fullRange, chroma: vpxChroma(ssX, ssY) };
}

/** vpcC's chroma_subsampling: 0 4:2:0, 2 4:2:2, 3 4:4:4. */
function vpxChroma(ssX: number, ssY: number): number {
  if (ssX && ssY) return 0;
  return ssX ? 2 : 3;
}

/** VP9 color_space → colour primaries, transfer characteristics, matrix coefficients. */
const VP9_COLOURS: Record<number, [number, number, number]> = {
  1: [6, 6, 6],
  2: [1, 1, 1],
  3: [6, 6, 6],
  4: [7, 7, 7],
  5: [9, 1, 9],
  7: [2, 2, 0],
};

/** A level for a picture's size, when the file does not say (30 fps assumed). */
export function vp9Level(width: number, height: number): number {
  const size = width * height;
  const levels: Array<[number, number]> = [
    [36864, 10],
    [73728, 11],
    [122880, 20],
    [245760, 21],
    [552960, 30],
    [983040, 31],
    [2228224, 40],
    [8912896, 50],
  ];
  for (const [limit, level] of levels) if (size <= limit) return level;
  return 60;
}

/** The `vpcC` payload (version 1; the full box header is the writer's). */
export function vpcConfig(info: VpxInfo, level: number): Uint8Array {
  const [primaries, transfer, matrix] = VP9_COLOURS[info.colorSpace] ?? [
    2, 2, 2,
  ];
  const w = new BoxWriter(16);
  w.u8(info.profile).u8(level);
  w.u8((info.bitDepth << 4) | (info.chroma << 1) | (info.fullRange ? 1 : 0));
  w.u8(primaries).u8(transfer).u8(matrix);
  w.u16(0); // codecInitializationDataSize
  return w.finish();
}

/** `vp09.PP.LL.DD` / `vp08.PP.LL.DD`. */
export function vpxCodec(entry: 'vp09' | 'vp08', vpcC: Uint8Array): string {
  const depth = (vpcC[2] ?? 0x80) >> 4;
  return `${entry}.${pad2(vpcC[0] ?? 0)}.${pad2(vpcC[1] ?? 10)}.${pad2(depth)}`;
}

/** Matroska's VP9 CodecPrivate (ID, length, value triples): profile 1, level 2, bit depth 3, chroma 4. */
export function vp9CodecFeatures(data: Uint8Array): Record<number, number> {
  const out: Record<number, number> = {};
  let at = 0;
  while (at + 2 <= data.length) {
    const id = data[at]!;
    const length = data[at + 1]!;
    if (length === 1 && at + 2 < data.length) out[id] = data[at + 2]!;
    at += 2 + length;
  }
  return out;
}

// ── AV1 ──

/** `av01.P.LLT.DD` from an `av1C`. */
export function av1Codec(av1C: Uint8Array): string {
  const profile = (av1C[1] ?? 0) >> 5;
  const level = (av1C[1] ?? 0) & 31;
  const flags = av1C[2] ?? 0;
  const tier = flags & 0x80 ? 'H' : 'M';
  let depth = 8;
  if (flags & 0x40) depth = flags & 0x20 ? 12 : 10;
  return `av01.${profile}.${pad2(level)}${tier}.${pad2(depth)}`;
}

// ── AAC ──

export const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];

export interface AacInfo {
  objectType: number;
  sampleRate: number;
  channels: number;
}

/** An AudioSpecificConfig's object type, core sample rate and channels. */
export function parseAsc(asc: Uint8Array): AacInfo {
  const r = new BitReader(asc);
  let objectType = r.bits(5);
  if (objectType === 31) objectType = 32 + r.bits(6);
  const index = r.bits(4);
  const sampleRate = index === 15 ? r.bits(24) : (AAC_RATES[index] ?? 0);
  const channels = r.bits(4);
  return { objectType, sampleRate, channels };
}

/** A 2-byte AudioSpecificConfig (5-byte with an explicit rate). */
export function makeAsc(
  objectType: number,
  sampleRate: number,
  channels: number
): Uint8Array {
  const index = AAC_RATES.indexOf(sampleRate);
  if (index >= 0)
    return Uint8Array.of(
      (objectType << 3) | (index >> 1),
      ((index & 1) << 7) | (channels << 3)
    );
  // Escape (15) and a 24-bit rate: 5 + 4 + 24 + 4 bits, padded.
  const bits = [
    [objectType, 5],
    [15, 4],
    [sampleRate, 24],
    [channels, 4],
    [0, 3],
  ] as const;
  const out = new Uint8Array(5);
  let pos = 0;
  for (const [value, count] of bits) {
    for (let i = count - 1; i >= 0; i--) {
      if (Math.floor(value / 2 ** i) % 2) out[pos >> 3]! |= 0x80 >> (pos & 7);
      pos += 1;
    }
  }
  return out;
}

export interface AdtsHeader {
  /** Bytes of the whole frame. */
  length: number;
  /** Header bytes (7, or 9 with a CRC). */
  headerLength: number;
  objectType: number;
  sampleRate: number;
  channels: number;
  /** Raw data blocks in the frame (1024 samples each). */
  blocks: number;
}

/** The ADTS header at `at`; `null` when there is none (or it is cut). */
export function adtsHeader(data: Uint8Array, at: number): AdtsHeader | null {
  if (at + 7 > data.length) return null;
  if (data[at] !== 0xff || (data[at + 1]! & 0xf6) !== 0xf0) return null;
  const index = (data[at + 2]! >> 2) & 0x0f;
  const sampleRate = AAC_RATES[index];
  if (!sampleRate) return null;
  const length =
    ((data[at + 3]! & 3) << 11) | (data[at + 4]! << 3) | (data[at + 5]! >> 5);
  const headerLength = data[at + 1]! & 1 ? 7 : 9;
  if (length < headerLength) return null;
  return {
    length,
    headerLength,
    objectType: (data[at + 2]! >> 6) + 1,
    sampleRate,
    channels: ((data[at + 2]! & 1) << 2) | (data[at + 3]! >> 6),
    blocks: (data[at + 6]! & 3) + 1,
  };
}

// ── MPEG audio (MP3) ──

const MP3_BITRATES_V1 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MP3_BITRATES_V2 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
];
const MPEG_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

export interface MpegAudioHeader {
  length: number;
  sampleRate: number;
  channels: number;
  samples: number;
  /** 3: Layer III; 2: Layer II; 1: Layer I. */
  layer: number;
}

/** The MPEG audio frame header at `at`; `null` when there is none. Only Layer III has a length. */
export function mpegAudioHeader(
  data: Uint8Array,
  at: number
): MpegAudioHeader | null {
  if (at + 4 > data.length) return null;
  if (data[at] !== 0xff || (data[at + 1]! & 0xe0) !== 0xe0) return null;
  const version = (data[at + 1]! >> 3) & 3;
  const layerBits = (data[at + 1]! >> 1) & 3;
  const bitrateIndex = data[at + 2]! >> 4;
  const rateIndex = (data[at + 2]! >> 2) & 3;
  if (version === 1 || layerBits === 0 || rateIndex === 3) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;
  const sampleRate = MPEG_RATES[version]![rateIndex]!;
  const channels = data[at + 3]! >> 6 === 3 ? 1 : 2;
  const layer = 4 - layerBits;
  if (layer !== 3)
    return { length: 0, sampleRate, channels, samples: 1152, layer };
  const v1 = version === 3;
  const bitrate =
    (v1 ? MP3_BITRATES_V1 : MP3_BITRATES_V2)[bitrateIndex]! * 1000;
  const padding = (data[at + 2]! >> 1) & 1;
  const length = Math.floor(((v1 ? 144 : 72) * bitrate) / sampleRate) + padding;
  return { length, sampleRate, channels, samples: v1 ? 1152 : 576, layer };
}

// ── AC-3, E-AC-3 ──

const AC3_BITRATES = [
  32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512,
  576, 640,
];
const AC3_RATES = [48000, 44100, 32000];
const AC3_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];

export interface Ac3Header {
  length: number;
  sampleRate: number;
  channels: number;
  samples: number;
  /** The `dac3` (AC-3) or `dec3` (E-AC-3) payload. */
  config: Uint8Array;
  /** E-AC-3: an independent substream's frame (a dependent one belongs to the frame before). */
  independent: boolean;
  /** E-AC-3 (`ec-3`), not AC-3 (`ac-3`). */
  extended: boolean;
}

/** An AC-3 or E-AC-3 sync frame's header at `at`; `null` when there is none. */
export function ac3Header(data: Uint8Array, at: number): Ac3Header | null {
  if (at + 8 > data.length || data[at] !== 0x0b || data[at + 1] !== 0x77)
    return null;
  const bsid = data[at + 5]! >> 3;
  return bsid > 10 ? eac3Frame(data, at) : ac3Frame(data, at);
}

/** An AC-3 frame's 16-bit words, by bitrate and sample rate (44.1 kHz pads odd codes). */
function ac3Words(kbps: number, fscod: number, frmsizecod: number): number {
  if (fscod === 1) return Math.floor((kbps * 320) / 147) + (frmsizecod & 1);
  return fscod === 2 ? kbps * 3 : kbps * 2;
}

function ac3Frame(data: Uint8Array, at: number): Ac3Header | null {
  const r = new BitReader(data.subarray(at + 4, at + 8));
  const fscod = r.bits(2);
  const frmsizecod = r.bits(6);
  const bsid = r.bits(5);
  const bsmod = r.bits(3);
  const acmod = r.bits(3);
  if (fscod === 3 || frmsizecod > 37) return null;
  if ((acmod & 1) !== 0 && acmod !== 1) r.skip(2);
  if ((acmod & 4) !== 0) r.skip(2);
  if (acmod === 2) r.skip(2);
  const lfeon = r.bits(1);
  const words = ac3Words(AC3_BITRATES[frmsizecod >> 1]!, fscod, frmsizecod);
  const w = new BoxWriter(3);
  // fscod 2, bsid 5, bsmod 3, acmod 3, lfeon 1, bit_rate_code 5, reserved 5
  w.u8((fscod << 6) | (bsid << 1) | (bsmod >> 2));
  w.u8(
    ((bsmod & 3) << 6) | (acmod << 3) | (lfeon << 2) | ((frmsizecod >> 1) >> 3)
  );
  w.u8(((frmsizecod >> 1) & 7) << 5);
  return {
    length: words * 2,
    sampleRate: AC3_RATES[fscod]!,
    channels: AC3_CHANNELS[acmod]! + lfeon,
    samples: 1536,
    config: w.finish(),
    independent: true,
    extended: false,
  };
}

function eac3Frame(data: Uint8Array, at: number): Ac3Header | null {
  const r = new BitReader(data.subarray(at + 2, at + 8));
  const strmtyp = r.bits(2);
  r.skip(3); // substreamid
  const length = (r.bits(11) + 1) * 2;
  const fscod = r.bits(2);
  let sampleRate: number;
  let blocks = 6;
  if (fscod === 3) {
    const fscod2 = r.bits(2);
    sampleRate = [24000, 22050, 16000][fscod2] ?? 0;
  } else {
    blocks = [1, 2, 3, 6][r.bits(2)]!;
    sampleRate = AC3_RATES[fscod]!;
  }
  const acmod = r.bits(3);
  const lfeon = r.bits(1);
  const bsid = r.bits(5);
  if (!sampleRate) return null;
  const samples = blocks * 256;
  const dataRate = Math.floor((length * 8 * sampleRate) / (samples * 1000));
  // data_rate 13, num_ind_sub 3; fscod 2, bsid 5, reserved 1, asvc 1,
  // bsmod 3, acmod 3, lfeon 1, reserved 3, num_dep_sub 4, reserved 1
  const w = new BoxWriter(5);
  w.u16(dataRate << 3);
  w.u8(((fscod === 3 ? 0 : fscod) << 6) | (bsid << 1));
  w.u8((acmod << 1) | lfeon);
  w.u8(0);
  return {
    length,
    sampleRate,
    channels: AC3_CHANNELS[acmod]! + lfeon,
    samples,
    config: w.finish(),
    independent: strmtyp !== 1,
    extended: true,
  };
}

// ── Opus ──

/** The `dOps` payload from an `OpusHead` (Matroska's CodecPrivate); `null` when it is not one. */
export function opusConfig(head: Uint8Array): {
  config: Uint8Array;
  channels: number;
} | null {
  if (head.length < 19) return null;
  const magic = String.fromCharCode(...head.subarray(0, 8));
  if (magic !== 'OpusHead') return null;
  const channels = head[9]!;
  const family = head[18]!;
  const w = new BoxWriter(32);
  w.u8(0).u8(channels);
  w.u16(head[10]! | (head[11]! << 8)); // pre-skip
  w.u32(
    (head[12]! | (head[13]! << 8) | (head[14]! << 16) | (head[15]! << 24)) >>> 0
  );
  w.u16(head[16]! | (head[17]! << 8)); // output gain
  w.u8(family);
  if (family !== 0) {
    if (head.length < 21 + channels) return null;
    w.raw(head.subarray(19, 21 + channels));
  }
  return { config: w.finish(), channels };
}

/** Samples (at 48 kHz) an Opus packet decodes to, from its TOC byte. */
export function opusSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0]!;
  return opusFrameSize(toc >> 3) * opusFrames(toc & 3, packet[1] ?? 0);
}

/** Samples at 48 kHz of one frame of this TOC configuration (SILK, hybrid, CELT). */
function opusFrameSize(config: number): number {
  if (config < 12) return [480, 960, 1920, 2880][config & 3]!;
  if (config < 16) return config & 1 ? 960 : 480;
  return [120, 240, 480, 960][config & 3]!;
}

/** Frames in a packet, by its TOC code (3: the count byte that follows). */
function opusFrames(code: number, countByte: number): number {
  if (code === 0) return 1;
  return code === 3 ? countByte & 0x3f : 2;
}

// ── FLAC ──

/** The `dfLa` payload (STREAMINFO only) from Matroska's CodecPrivate (`fLaC` + metadata blocks). */
export function flacConfig(codecPrivate: Uint8Array): {
  config: Uint8Array;
  sampleRate: number;
  channels: number;
} | null {
  let at =
    codecPrivate.length >= 4 && readUint(codecPrivate, 0, 4) === 0x664c6143
      ? 4
      : 0;
  while (at + 4 <= codecPrivate.length) {
    const type = codecPrivate[at]! & 0x7f;
    const length = readUint(codecPrivate, at + 1, 3);
    if (type === 0 && length >= 18 && at + 4 + length <= codecPrivate.length) {
      const info = codecPrivate.subarray(at + 4, at + 4 + length);
      const w = new BoxWriter(4 + length);
      w.u8(0x80).u24(length).raw(info); // the last (only) block
      const sampleRate =
        (info[10]! << 12) | (info[11]! << 4) | (info[12]! >> 4);
      const channels = ((info[12]! >> 1) & 7) + 1;
      return { config: w.finish(), sampleRate, channels };
    }
    at += 4 + length;
  }
  return null;
}

/** Samples in a FLAC frame, from its header; `null` when it is not one. */
export function flacSamples(frame: Uint8Array): number | null {
  if (frame.length < 5 || frame[0] !== 0xff || (frame[1]! & 0xfe) !== 0xf8)
    return null;
  const code = frame[2]! >> 4;
  if (code === 1) return 192;
  if (code >= 2 && code <= 5) return 576 << (code - 2);
  if (code >= 8) return 256 << (code - 8);
  if (code !== 6 && code !== 7) return null;
  // The coded frame or sample number (UTF-8-like), then the size.
  const lead = frame[4]!;
  let extra = 0;
  while (extra < 7 && lead & (0x80 >> extra)) extra += 1;
  const at = 4 + Math.max(1, extra);
  if (code === 6) return at < frame.length ? frame[at]! + 1 : null;
  return at + 1 < frame.length ? readUint(frame, at, 2) + 1 : null;
}
