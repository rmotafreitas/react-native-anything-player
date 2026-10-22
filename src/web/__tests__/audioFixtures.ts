/* eslint-disable no-bitwise -- builds bit-field headers. */
// Real MP3 and ADTS frames, and a reader for the MP4 the muxer writes: what the
// muxer tests and the fake browser's source buffer need.

const MPEG1_BITRATES = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];

export interface Mp3FrameOptions {
  /** 44100 (index 0), 48000, 32000; the MPEG-2 half rates with `version: 2`. */
  rateIndex?: number;
  bitrateIndex?: number;
  version?: 1 | 2;
  mono?: boolean;
  padding?: boolean;
  crc?: boolean;
  /** A byte that makes frames tell apart. */
  fill?: number;
}

/** A Layer III frame with a valid header and `fill` as its payload. */
export function mp3Frame(options: Mp3FrameOptions = {}): Uint8Array {
  const rateIndex = options.rateIndex ?? 0;
  const bitrateIndex = options.bitrateIndex ?? 9; // 128 kbps (MPEG-1)
  const mpeg1 = (options.version ?? 1) === 1;
  const rates = mpeg1 ? [44100, 48000, 32000] : [22050, 24000, 16000];
  const kbps = mpeg1
    ? MPEG1_BITRATES[bitrateIndex]!
    : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][
        bitrateIndex
      ]!;
  const padding = options.padding ? 1 : 0;
  const length =
    Math.floor(((mpeg1 ? 144 : 72) * kbps * 1000) / rates[rateIndex]!) +
    padding;
  const frame = new Uint8Array(length).fill(options.fill ?? 0x55);
  frame[0] = 0xff;
  // sync, version (MPEG-1 = 11, MPEG-2 = 10), Layer III = 01, protection bit
  frame[1] = 0xe0 | ((mpeg1 ? 3 : 2) << 3) | (1 << 1) | (options.crc ? 0 : 1);
  frame[2] = (bitrateIndex << 4) | (rateIndex << 2) | (padding << 1);
  frame[3] = options.mono ? 0xc0 : 0x00;
  return frame;
}

export interface AdtsFrameOptions {
  /** Sampling index: 4 = 44100 Hz, 3 = 48000 Hz. */
  rateIndex?: number;
  channelConfig?: number;
  /** AAC object type minus one (1 = LC). */
  profile?: number;
  /** Raw data bytes after the header. */
  payload?: number;
  crc?: boolean;
  fill?: number;
  /** `number_of_raw_data_blocks_in_frame`. */
  rawBlocks?: number;
}

/** An ADTS AAC frame. */
export function adtsFrame(options: AdtsFrameOptions = {}): Uint8Array {
  const header = options.crc ? 9 : 7;
  const length = header + (options.payload ?? 24);
  const frame = new Uint8Array(length).fill(options.fill ?? 0x33);
  const channelConfig = options.channelConfig ?? 2;
  frame[0] = 0xff;
  frame[1] = 0xf0 | (0x01 * (options.crc ? 0 : 1)); // MPEG-4, layer 0, protection_absent
  frame[2] =
    ((options.profile ?? 1) << 6) |
    ((options.rateIndex ?? 4) << 2) |
    (channelConfig >> 2);
  frame[3] = ((channelConfig & 3) << 6) | (length >> 11);
  frame[4] = (length >> 3) & 0xff;
  frame[5] = ((length & 7) << 5) | 0x1f;
  frame[6] = 0xfc | (options.rawBlocks ?? 0);
  return frame;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** An ID3v2.4 tag with a `size`-byte body (zero padding). */
export function id3Tag(size: number, footer = false): Uint8Array {
  const tag = new Uint8Array(10 + size + (footer ? 10 : 0));
  tag.set([0x49, 0x44, 0x33, 4, 0, footer ? 0x10 : 0]);
  tag.set(
    [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f],
    6
  );
  return tag;
}

/** Splits `bytes` into chunks of `size` (the last one shorter). */
export function chunked(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += size)
    out.push(bytes.subarray(at, at + size));
  return out;
}

// ── MP4 ──

export interface Mp4Box {
  type: string;
  /** Offset of the box header in the parsed buffer. */
  start: number;
  size: number;
  /** The body: after the header (and the version/flags of a full box, when asked). */
  body: Uint8Array;
}

const CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'dinf',
  'mvex',
  'moof',
  'traf',
]);

/** The boxes at one level of `bytes`; throws when a size does not add up. */
export function boxes(bytes: Uint8Array): Mp4Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const out: Mp4Box[] = [];
  let at = 0;
  while (at < bytes.length) {
    if (at + 8 > bytes.length) throw new Error(`truncated box header at ${at}`);
    const size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (size < 8 || at + size > bytes.length)
      throw new Error(`bad size ${size} for ${type} at ${at}`);
    out.push({
      type,
      start: at,
      size,
      body: bytes.subarray(at + 8, at + size),
    });
    at += size;
  }
  return out;
}

/** The first box along `path` (`'moov/trak/mdia'`), descending through containers. */
export function find(bytes: Uint8Array, path: string): Mp4Box | undefined {
  let level = bytes;
  let found: Mp4Box | undefined;
  for (const type of path.split('/')) {
    found = boxes(level).find((b) => b.type === type);
    if (!found) return undefined;
    level = CONTAINERS.has(type) ? found.body : new Uint8Array(0);
  }
  return found;
}

export function u32(bytes: Uint8Array, at: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(
    at
  );
}

export function ascii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

export interface ParsedInit {
  timescale: number;
  channels: number;
  /** The sample rate in the `mp4a` entry. */
  sampleEntryRate: number;
  /** esds objectTypeIndication. */
  objectType: number;
  /** esds DecoderSpecificInfo. */
  specific: number[];
}

/** What an init segment declares. */
export function parseInit(init: Uint8Array): ParsedInit {
  const mdhd = find(init, 'moov/trak/mdia/mdhd')!;
  const stsd = find(init, 'moov/trak/mdia/minf/stbl/stsd')!;
  // stsd: version/flags + entry count, then the mp4a box.
  const mp4a = boxes(stsd.body.subarray(8))[0]!;
  const entry = mp4a.body;
  const esdsBox = boxes(entry.subarray(28))[0]!;
  const d = esdsBox.body.subarray(4); // past version/flags
  // ES descriptor (tag, size, ES_ID, flags) → decoder config descriptor.
  let at = 2 + 3;
  if (d[at] !== 0x04) throw new Error('no decoder config descriptor');
  const objectType = d[at + 2]!;
  at += 2 + 13;
  const specific: number[] = [];
  if (d[at] === 0x05) specific.push(...d.subarray(at + 2, at + 2 + d[at + 1]!));
  return {
    timescale: u32(mdhd.body, 12),
    channels: (entry[16]! << 8) | entry[17]!,
    sampleEntryRate: u32(entry, 24) >>> 16,
    objectType,
    specific,
  };
}

export interface ParsedSegment {
  sequence: number;
  baseMediaDecodeTime: number;
  samples: Array<{ duration: number; data: Uint8Array }>;
}

/** Reads a `moof` + `mdat` pair, following the data offset into the `mdat`. */
export function parseSegment(segment: Uint8Array): ParsedSegment {
  const [moof, mdat, ...rest] = boxes(segment);
  if (moof?.type !== 'moof' || mdat?.type !== 'mdat' || rest.length > 0)
    throw new Error('expected one moof and one mdat');
  const mfhd = find(moof.body, 'mfhd')!;
  const tfhd = find(moof.body, 'traf/tfhd')!;
  const tfdt = find(moof.body, 'traf/tfdt')!;
  const trun = find(moof.body, 'traf/trun')!;
  if ((u32(tfhd.body, 0) & 0x020000) === 0)
    throw new Error('default-base-is-moof not set');
  const version = tfdt.body[0]!;
  const time =
    version === 1
      ? u32(tfdt.body, 4) * 2 ** 32 + u32(tfdt.body, 8)
      : u32(tfdt.body, 4);
  const count = u32(trun.body, 4);
  const dataOffset = u32(trun.body, 8);
  if (dataOffset !== moof.size + 8) throw new Error('bad data offset');
  const samples: ParsedSegment['samples'] = [];
  let data = 0; // relative to the mdat body: the offset was checked above
  for (let i = 0; i < count; i++) {
    const duration = u32(trun.body, 12 + 8 * i);
    const size = u32(trun.body, 16 + 8 * i);
    samples.push({ duration, data: mdat.body.subarray(data, data + size) });
    data += size;
  }
  if (data !== mdat.body.length) throw new Error('mdat size mismatch');
  return {
    sequence: u32(mfhd.body, 4),
    baseMediaDecodeTime: time,
    samples,
  };
}

// ── ID3 text frames ──

export interface Id3TextFrame {
  id: string;
  /** 0 ISO-8859-1, 1 UTF-16 with a BOM, 2 UTF-16BE, 3 UTF-8. */
  encoding: 0 | 1 | 2 | 3;
  text: string;
}

function encodeText(encoding: number, text: string): number[] {
  const units = Array.from({ length: text.length }, (_, i) =>
    text.charCodeAt(i)
  );
  if (encoding === 0) return units;
  if (encoding === 3) return Array.from(new TextEncoder().encode(text));
  if (encoding === 2) return units.flatMap((u) => [u >> 8, u & 0xff]);
  return [0xff, 0xfe, ...units.flatMap((u) => [u & 0xff, u >> 8])];
}

/** An ID3v2.`major` tag holding text frames (and `padding` zero bytes after them). */
export function id3TextTag(
  major: 2 | 3 | 4,
  frames: Id3TextFrame[],
  options: { padding?: number; extendedHeader?: boolean } = {}
): Uint8Array {
  const body: number[] = [];
  if (options.extendedHeader && major === 4) body.push(0, 0, 0, 6, 1, 0);
  if (options.extendedHeader && major === 3)
    body.push(0, 0, 0, 6, 0, 0, 0, 0, 0, 0);
  for (const frame of frames) {
    const content = [frame.encoding, ...encodeText(frame.encoding, frame.text)];
    const size = content.length;
    if (major === 2) {
      body.push(...Array.from(frame.id, (c) => c.charCodeAt(0)));
      body.push((size >> 16) & 255, (size >> 8) & 255, size & 255);
    } else {
      body.push(...Array.from(frame.id, (c) => c.charCodeAt(0)));
      body.push(
        ...(major === 4
          ? [
              (size >> 21) & 0x7f,
              (size >> 14) & 0x7f,
              (size >> 7) & 0x7f,
              size & 0x7f,
            ]
          : [
              (size >>> 24) & 255,
              (size >> 16) & 255,
              (size >> 8) & 255,
              size & 255,
            ]),
        0,
        0
      );
    }
    body.push(...content);
  }
  for (let i = 0; i < (options.padding ?? 0); i++) body.push(0);
  const size = body.length;
  return Uint8Array.from([
    0x49,
    0x44,
    0x33,
    major,
    0,
    options.extendedHeader ? 0x40 : 0,
    (size >> 21) & 0x7f,
    (size >> 14) & 0x7f,
    (size >> 7) & 0x7f,
    size & 0x7f,
    ...body,
  ]);
}
