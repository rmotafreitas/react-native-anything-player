/* eslint-disable no-bitwise -- frame headers are bit fields. */
// Frame-level parsing of the two elementary audio streams a radio sends:
// MPEG-1/2/2.5 Layer III (MP3) and ADTS AAC. The scanner finds whole frames in
// arbitrary chunks of a live stream: it skips ID3 tags, resyncs after garbage
// (a connection that joins mid-frame, a corrupt run) and carries a partial
// frame over to the next chunk. `Fmp4Muxer` wraps what it finds.

export type AudioCodec = 'mp3' | 'aac';

/** What an init segment says about the stream; frames with equal keys share one. */
export interface AudioConfig {
  codec: AudioCodec;
  /** Hz. */
  sampleRate: number;
  /** As the sample entry declares them. */
  channels: number;
  /** The `esds` objectTypeIndication. */
  objectType: number;
  /** The `esds` DecoderSpecificInfo (the AAC AudioSpecificConfig); empty for MP3. */
  specific: Uint8Array;
  key: string;
}

export interface FrameHeader {
  config: AudioConfig;
  /** Bytes of the whole frame, header included. */
  length: number;
  /** Header bytes that are not part of the MP4 sample (ADTS); an MP3 sample keeps its header. */
  skip: number;
  /** PCM samples per channel the frame decodes to. */
  samples: number;
}

/** One frame, as the sample the muxer writes. */
export interface Frame {
  data: Uint8Array;
  samples: number;
}

export interface FrameFormat {
  /** Bytes a header needs to be read. */
  readonly headerBytes: number;
  /** The header at `at` (`headerBytes` are available), or `null` when it is not one. */
  read(bytes: Uint8Array, at: number): FrameHeader | null;
  /** The first frame is a Xing/Info tag, not audio. */
  isInfo?(bytes: Uint8Array, at: number, header: FrameHeader): boolean;
}

// ── MP3 ──

const MP3_BITRATES_MPEG1 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
];
const MP3_BITRATES_MPEG2 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
];
/** Version bits (3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5) → sample rates. */
const MP3_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};
const MP3_LAYER_III = 1;
const MP3_RESERVED_VERSION = 1;
const MP3_MONO = 3;

function readMp3Header(bytes: Uint8Array, at: number): FrameHeader | null {
  const b1 = bytes[at + 1]!;
  const b2 = bytes[at + 2]!;
  const b3 = bytes[at + 3]!;
  if (bytes[at] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3;
  if (version === MP3_RESERVED_VERSION || ((b1 >> 1) & 3) !== MP3_LAYER_III)
    return null;
  const bitrateIndex = b2 >> 4;
  const rateIndex = (b2 >> 2) & 3;
  // Free format (0) has no length to read; 15 and rate 3 are reserved.
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const bitrate =
    (mpeg1 ? MP3_BITRATES_MPEG1 : MP3_BITRATES_MPEG2)[bitrateIndex]! * 1000;
  const sampleRate = MP3_RATES[version]![rateIndex]!;
  const padding = (b2 >> 1) & 1;
  const channels = b3 >> 6 === MP3_MONO ? 1 : 2;
  return {
    config: {
      codec: 'mp3',
      sampleRate,
      channels,
      // MPEG-1 Audio; browsers read MPEG-2/2.5 Layer III under the same type.
      objectType: 0x6b,
      specific: new Uint8Array(0),
      key: `mp3/${version}/${sampleRate}/${channels}`,
    },
    length: Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding,
    skip: 0,
    samples: mpeg1 ? 1152 : 576,
  };
}

/** Side information bytes before the Xing tag: [mono, stereo]. */
const XING_SIDE_INFO_MPEG1 = [17, 32];
const XING_SIDE_INFO_MPEG2 = [9, 17];

/** A Xing/Info frame (the encoder's seek table) decodes as silence: it is not audio. */
function isXingFrame(
  bytes: Uint8Array,
  at: number,
  header: FrameHeader
): boolean {
  const mpeg1 = header.samples === 1152;
  const mono = header.config.channels === 1;
  // The tag follows the 4-byte header and the side information.
  const sideInfo = mpeg1 ? XING_SIDE_INFO_MPEG1 : XING_SIDE_INFO_MPEG2;
  const offset = at + 4 + sideInfo[mono ? 0 : 1]!;
  if (offset + 4 > at + header.length) return false;
  const tag = String.fromCodePoint(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!
  );
  return tag === 'Xing' || tag === 'Info';
}

export const MP3_FORMAT: FrameFormat = {
  headerBytes: 4,
  read: readMp3Header,
  isInfo: isXingFrame,
};

// ── ADTS AAC ──

const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];
const AAC_SAMPLES = 1024;

/** The AudioSpecificConfig: object type (5 bits), rate index (4), channel configuration (4). */
function audioSpecificConfig(
  objectType: number,
  rateIndex: number,
  channelConfig: number
): Uint8Array {
  return Uint8Array.of(
    (objectType << 3) | (rateIndex >> 1),
    ((rateIndex & 1) << 7) | (channelConfig << 3)
  );
}

function readAdtsHeader(bytes: Uint8Array, at: number): FrameHeader | null {
  const b1 = bytes[at + 1]!;
  const b2 = bytes[at + 2]!;
  const b3 = bytes[at + 3]!;
  // Twelve sync bits, then the ID bit (either) and layer 00.
  if (bytes[at] !== 0xff || (b1 & 0xf6) !== 0xf0) return null;
  const objectType = (b2 >> 6) + 1;
  const rateIndex = (b2 >> 2) & 0xf;
  const channelConfig = ((b2 & 1) << 2) | (b3 >> 6);
  const length =
    ((b3 & 3) << 11) | (bytes[at + 4]! << 3) | (bytes[at + 5]! >> 5);
  const rawBlocks = bytes[at + 6]! & 3;
  const skip = b1 & 1 ? 7 : 9; // protection_absent: no CRC
  // Channel configuration 0 puts the layout in the stream; several raw data
  // blocks per frame would need splitting: neither is supported.
  if (
    rateIndex >= AAC_RATES.length ||
    channelConfig === 0 ||
    rawBlocks !== 0 ||
    length <= skip
  )
    return null;
  const sampleRate = AAC_RATES[rateIndex]!;
  const channels = channelConfig === 7 ? 8 : channelConfig;
  return {
    config: {
      codec: 'aac',
      sampleRate,
      channels,
      objectType: 0x40, // MPEG-4 Audio
      specific: audioSpecificConfig(objectType, rateIndex, channelConfig),
      key: `aac/${objectType}/${rateIndex}/${channelConfig}`,
    },
    length,
    skip,
    samples: AAC_SAMPLES,
  };
}

export const AAC_FORMAT: FrameFormat = {
  headerBytes: 7,
  read: readAdtsHeader,
};

// ── ID3 ──

const ID3_HEADER_BYTES = 10;
const ID3_FOOTER_BYTES = 10;
const ID3_FOOTER_FLAG = 0x10;

/**
 * Bytes of the ID3v2 tag at `at`; `0` when there is none, `-1` when the
 * header is not all here yet.
 */
function id3Length(bytes: Uint8Array, at: number): number {
  const available = bytes.length - at;
  const prefix = Math.min(3, available);
  for (let i = 0; i < prefix; i++) {
    if (bytes[at + i] !== 'ID3'.codePointAt(i)) return 0;
  }
  if (available < ID3_HEADER_BYTES) return -1;
  // Version and revision are below 0xff and the size is four 7-bit bytes.
  const size = [6, 7, 8, 9].map((i) => bytes[at + i]!);
  if (
    bytes[at + 3] === 0xff ||
    bytes[at + 4] === 0xff ||
    size.some((b) => b >= 0x80)
  )
    return 0;
  const footer = bytes[at + 5]! & ID3_FOOTER_FLAG ? ID3_FOOTER_BYTES : 0;
  const body = (size[0]! << 21) | (size[1]! << 14) | (size[2]! << 7) | size[3]!;
  return ID3_HEADER_BYTES + body + footer;
}

// ── Scanner ──

/** Used as "the previous frame ended here" when there was none. */
const NOT_SYNCED = -1;
/** Returned by a step that needs more bytes. */
const NEED_MORE = -1;

/** Where scanning goes next: a position (`NEED_MORE`: wait for bytes) and where the last frame ended. */
interface Step {
  next: number;
  lastEnd: number;
}

export interface ScanResult {
  frames: Frame[];
  /** The configuration of the first frame, once there is one. */
  config: AudioConfig | null;
  /** A frame with another configuration (sample rate, channels) started: nothing after it was read. */
  changed: boolean;
}

export class FrameScanner {
  private carry: Uint8Array = new Uint8Array(0);
  /** Bytes of an ID3 tag still to discard. */
  private skipping = 0;
  /** The carry starts exactly where the last frame ended. */
  private synced = false;
  private established: AudioConfig | null = null;
  private first = true;
  private halted = false;

  constructor(private readonly format: FrameFormat) {}

  /** Bytes held back: a partial frame (or tag header) waiting for the rest. */
  get pending(): number {
    return this.carry.length;
  }

  /** Forgets the partial frame: the next bytes come from another connection. */
  restart(): void {
    this.carry = new Uint8Array(0);
    this.skipping = 0;
    this.synced = false;
  }

  scan(chunk: Uint8Array): ScanResult {
    const frames: Frame[] = [];
    if (this.halted) return this.result(frames, true);
    const skipped = Math.min(this.skipping, chunk.length);
    this.skipping -= skipped;
    const data = this.join(chunk.subarray(skipped));
    // Where the previous frame ended in `data`, while there is one.
    let lastEnd = this.synced && skipped === 0 ? 0 : NOT_SYNCED;
    let pos = 0;
    while (pos < data.length && !this.halted) {
      const step = this.step(data, pos, lastEnd, frames);
      if (step.next === NEED_MORE) break;
      pos = step.next;
      lastEnd = step.lastEnd;
    }
    this.synced = lastEnd === pos;
    this.carry = data.slice(pos);
    return this.result(frames, this.halted);
  }

  private result(frames: Frame[], changed: boolean): ScanResult {
    return { frames, config: this.established, changed };
  }

  private join(chunk: Uint8Array): Uint8Array {
    if (this.carry.length === 0) return chunk;
    const data = new Uint8Array(this.carry.length + chunk.length);
    data.set(this.carry);
    data.set(chunk, this.carry.length);
    return data;
  }

  /** Handles what starts at `pos`; the new position (or `NEED_MORE`) and where the last frame ended. */
  private step(
    data: Uint8Array,
    pos: number,
    lastEnd: number,
    frames: Frame[]
  ): Step {
    const lead = data[pos]!;
    if (lead === 0x49) {
      const tag = this.tagStep(data, pos, lastEnd);
      if (tag) return tag;
    }
    if (lead !== 0xff) return { next: pos + 1, lastEnd };
    return this.frameStep(data, pos, lastEnd, frames);
  }

  /** An ID3 tag at `pos`: skipped (the rest of it, if it runs past `data`); `null` when it is none. */
  private tagStep(data: Uint8Array, pos: number, lastEnd: number): Step | null {
    const tag = id3Length(data, pos);
    if (tag === 0) return null;
    if (tag < 0) return { next: NEED_MORE, lastEnd };
    this.skipping = Math.max(0, pos + tag - data.length);
    const next = Math.min(data.length, pos + tag);
    return { next, lastEnd: lastEnd === pos ? next : lastEnd };
  }

  /** A frame header at `pos` (a 0xFF byte): the frame, or a step past a false sync. */
  private frameStep(
    data: Uint8Array,
    pos: number,
    lastEnd: number,
    frames: Frame[]
  ): Step {
    if (data.length - pos < this.format.headerBytes)
      return { next: NEED_MORE, lastEnd };
    const header = this.format.read(data, pos);
    if (!header) return { next: pos + 1, lastEnd };
    const verdict = this.verify(data, pos, header, lastEnd === pos);
    if (verdict === 'more') return { next: NEED_MORE, lastEnd };
    if (verdict === 'false') return { next: pos + 1, lastEnd };
    const end = pos + header.length;
    if (this.established && this.established.key !== header.config.key) {
      this.halted = true;
      return { next: pos, lastEnd };
    }
    this.established ??= header.config;
    const audio = !(this.first && this.format.isInfo?.(data, pos, header));
    this.first = false;
    if (audio) {
      frames.push({
        data: data.subarray(pos + header.skip, end),
        samples: header.samples,
      });
    }
    return { next: end, lastEnd: end };
  }

  /**
   * Whether the header at `pos` starts a frame. One that follows the previous
   * frame directly, in the same configuration, is taken as it is; any other
   * (the start, after garbage) must be followed by another consistent header,
   * or an ID3 tag, or it is a false sync inside the data.
   */
  private verify(
    data: Uint8Array,
    pos: number,
    header: FrameHeader,
    contiguous: boolean
  ): 'ok' | 'more' | 'false' {
    const end = pos + header.length;
    if (end > data.length) return 'more';
    if (contiguous && this.established?.key === header.config.key) return 'ok';
    if (end === data.length) return 'more';
    // A tag between two tracks follows the frame as well as a frame does.
    const tag = id3Length(data, end);
    if (tag !== 0) return tag < 0 ? 'more' : 'ok';
    if (data.length - end < this.format.headerBytes) return 'more';
    const next = this.format.read(data, end);
    return next?.config.key === header.config.key ? 'ok' : 'false';
  }
}
