/* eslint-disable no-bitwise -- MP4 boxes are bit fields and big-endian integers. */
// A dependency-free fragmented-MP4 muxer for MP3 and ADTS AAC. Browsers whose
// MSE takes these codecs only inside MP4 (Firefox: `audio/mp4; codecs="mp3"`
// and `"mp4a.40.2"`, not `audio/mpeg` or `audio/aac`) cannot be fed the raw
// stream; this wraps its frames: one init segment (ftyp + moov), then one
// media segment (moof + mdat) per chunk of whole frames, on a continuous
// timeline. Frames are not touched, only given a container.

import {
  AAC_FORMAT,
  FrameScanner,
  MP3_FORMAT,
  type AudioCodec,
  type AudioConfig,
  type Frame,
} from './AudioFrames';

export type { AudioCodec } from './AudioFrames';

/** The MSE type each codec takes inside MP4. */
export const MP4_TYPES: Record<AudioCodec, string> = {
  mp3: 'audio/mp4; codecs="mp3"',
  aac: 'audio/mp4; codecs="mp4a.40.2"',
};

export interface MuxOutput {
  /** The init segment, with the first segment (and again after `restart`). */
  init: Uint8Array | null;
  /** The media segment for the frames found; `null` when the chunk held none. */
  fragment: Uint8Array | null;
  /**
   * The stream changed sample rate or channels. The init segment cannot
   * describe both, so the muxer stops here (the frames before the change are
   * in this output): the caller ends the stream and a reconnect starts a new
   * one, with an init segment of its own.
   */
  changed: boolean;
  /**
   * AAC other than LC (Main, SSR, LTP). The MSE type was chosen as
   * `mp4a.40.2` before the first frame: the caller plays the stream on the
   * element instead. (HE-AAC in ADTS signals LC, with implicit SBR.)
   */
  unsupported: boolean;
}

const TRACK_ID = 1;
const IDENTITY_MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];
/** tfhd: the base data offset is the start of the moof. */
const DEFAULT_BASE_IS_MOOF = 0x020000;
/** trun: data offset, then a duration and a size per sample. */
const TRUN_OFFSET_DURATION_SIZE = 0x000301;
const TWO_POW_32 = 4_294_967_296;
/** `und`, as the three 5-bit letters ISO 639-2 packs into mdhd. */
const LANGUAGE_UND = 0x55c4;

/** Writes boxes into one growing buffer; `end` patches the size of the box `begin` opened. */
class BoxWriter {
  private bytes: Uint8Array;
  private view: DataView;
  private pos = 0;
  private readonly open: number[] = [];

  constructor(capacity = 512) {
    this.bytes = new Uint8Array(capacity);
    this.view = new DataView(this.bytes.buffer);
  }

  begin(type: string, version?: number, flags = 0): this {
    this.open.push(this.pos);
    this.u32(0).ascii(type);
    if (version !== undefined) this.u32(((version << 24) | flags) >>> 0);
    return this;
  }

  end(): this {
    const start = this.open.pop()!;
    this.view.setUint32(start, this.pos - start);
    return this;
  }

  u8(value: number): this {
    this.reserve(1);
    this.view.setUint8(this.pos, value);
    this.pos += 1;
    return this;
  }

  u16(value: number): this {
    this.reserve(2);
    this.view.setUint16(this.pos, value);
    this.pos += 2;
    return this;
  }

  u32(value: number): this {
    this.reserve(4);
    this.view.setUint32(this.pos, value >>> 0);
    this.pos += 4;
    return this;
  }

  u64(value: number): this {
    return this.u32(Math.floor(value / TWO_POW_32)).u32(value % TWO_POW_32);
  }

  zeros(count: number): this {
    this.reserve(count);
    this.pos += count;
    return this;
  }

  ascii(text: string): this {
    for (let i = 0; i < text.length; i++) this.u8(text.charCodeAt(i));
    return this;
  }

  raw(data: Uint8Array): this {
    this.reserve(data.length);
    this.bytes.set(data, this.pos);
    this.pos += data.length;
    return this;
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.pos);
  }

  private reserve(count: number): void {
    const needed = this.pos + count;
    if (needed <= this.bytes.length) return;
    const grown = new Uint8Array(Math.max(needed, this.bytes.length * 2));
    grown.set(this.bytes);
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }
}

function matrix(writer: BoxWriter): void {
  for (const value of IDENTITY_MATRIX) writer.u32(value);
}

/** The `esds` box: an ES descriptor holding the decoder configuration. */
function esds(writer: BoxWriter, config: AudioConfig): void {
  const specific = config.specific.length > 0 ? 2 + config.specific.length : 0;
  const decoderConfig = 13 + specific;
  writer.begin('esds', 0);
  // Every length here is below 128: one byte each.
  writer.u8(0x03).u8(3 + (2 + decoderConfig) + 3);
  writer.u16(0).u8(0); // ES_ID, no flags
  writer.u8(0x04).u8(decoderConfig);
  writer.u8(config.objectType).u8(0x15); // audio stream
  writer.zeros(3).u32(0).u32(0); // buffer size, max and average bitrate: unknown
  if (specific > 0)
    writer.u8(0x05).u8(config.specific.length).raw(config.specific);
  writer.u8(0x06).u8(1).u8(0x02); // SLConfigDescriptor: MP4 file
  writer.end();
}

function sampleEntry(writer: BoxWriter, config: AudioConfig): void {
  writer.begin('mp4a');
  writer.zeros(6).u16(1); // reserved, data reference index
  writer.zeros(8); // version, revision, vendor
  writer.u16(config.channels).u16(16).u32(0); // channels, sample size, pre-defined + reserved
  // 16.16 fixed point: rates above 65535 Hz are only in the codec configuration.
  writer.u32(config.sampleRate > 0xffff ? 0 : config.sampleRate << 16);
  esds(writer, config);
  writer.end();
}

function emptyTable(writer: BoxWriter, type: string, extra = 0): void {
  writer.begin(type, 0).zeros(extra).u32(0).end();
}

function sampleTable(writer: BoxWriter, config: AudioConfig): void {
  writer.begin('stbl');
  writer.begin('stsd', 0).u32(1);
  sampleEntry(writer, config);
  writer.end();
  emptyTable(writer, 'stts');
  emptyTable(writer, 'stsc');
  emptyTable(writer, 'stsz', 4); // sample size 0: sizes are per sample
  emptyTable(writer, 'stco');
  writer.end();
}

function mediaInformation(writer: BoxWriter, config: AudioConfig): void {
  writer.begin('minf');
  writer.begin('smhd', 0).u32(0).end(); // balance
  writer.begin('dinf').begin('dref', 0).u32(1);
  writer.begin('url ', 0, 1).end(); // media data in this file
  writer.end().end();
  sampleTable(writer, config);
  writer.end();
}

function track(writer: BoxWriter, config: AudioConfig): void {
  writer.begin('trak');
  // enabled | in movie | in preview
  writer.begin('tkhd', 0, 0x000007).u32(0).u32(0).u32(TRACK_ID).u32(0);
  writer.u32(0).zeros(8).u16(0).u16(0).u16(0x0100).u16(0);
  matrix(writer);
  writer.u32(0).u32(0).end(); // width and height: audio
  writer.begin('mdia');
  writer.begin('mdhd', 0).u32(0).u32(0).u32(config.sampleRate).u32(0);
  writer.u16(LANGUAGE_UND).u16(0).end();
  writer.begin('hdlr', 0).u32(0).ascii('soun').zeros(12);
  writer.ascii('SoundHandler').u8(0).end();
  mediaInformation(writer, config);
  writer.end().end();
}

/** `ftyp` + `moov` for a fragmented file whose samples all come in `moof`s. */
export function initSegment(config: AudioConfig): Uint8Array {
  const writer = new BoxWriter();
  writer.begin('ftyp').ascii('iso5').u32(1);
  writer.ascii('iso5').ascii('iso6').ascii('mp41').end();
  writer.begin('moov');
  writer.begin('mvhd', 0).u32(0).u32(0).u32(config.sampleRate).u32(0);
  writer.u32(0x00010000).u16(0x0100).zeros(10); // rate, volume, reserved
  matrix(writer);
  writer
    .zeros(24)
    .u32(TRACK_ID + 1)
    .end(); // pre-defined, next track id
  track(writer, config);
  writer.begin('mvex');
  writer.begin('trex', 0).u32(TRACK_ID).u32(1).u32(0).u32(0).u32(0).end();
  writer.end().end();
  return writer.finish();
}

/** `moof` + `mdat` for `frames`, the first starting at `decodeTime` (in sample-rate units). */
export function mediaSegment(
  sequence: number,
  decodeTime: number,
  frames: Frame[]
): Uint8Array {
  // moof: header 8 + mfhd 16 + traf (8 + tfhd 16 + tfdt 20 + trun 20 + 8 per sample)
  const moofSize = 88 + 8 * frames.length;
  let payload = 0;
  for (const frame of frames) payload += frame.data.length;
  const writer = new BoxWriter(moofSize + 8 + payload);
  writer.begin('moof');
  writer.begin('mfhd', 0).u32(sequence).end();
  writer.begin('traf');
  writer.begin('tfhd', 0, DEFAULT_BASE_IS_MOOF).u32(TRACK_ID).end();
  writer.begin('tfdt', 1).u64(decodeTime).end();
  writer.begin('trun', 0, TRUN_OFFSET_DURATION_SIZE);
  writer.u32(frames.length).u32(moofSize + 8); // data offset: past the mdat header
  for (const frame of frames) writer.u32(frame.samples).u32(frame.data.length);
  writer.end().end().end();
  writer.begin('mdat');
  for (const frame of frames) writer.raw(frame.data);
  writer.end();
  return writer.finish();
}

export class Fmp4Muxer {
  private readonly scanner: FrameScanner;
  private config: AudioConfig | null = null;
  private initPending = true;
  private sequence = 0;
  /** Samples muxed so far: the next segment's baseMediaDecodeTime. */
  private decodeTime = 0;
  /** Frames muxed so far. */
  frames = 0;

  constructor(readonly codec: AudioCodec) {
    this.scanner = new FrameScanner(codec === 'mp3' ? MP3_FORMAT : AAC_FORMAT);
  }

  /** The MSE type of the segments. */
  get mimeType(): string {
    return MP4_TYPES[this.codec];
  }

  /** Bytes taken but not muxed yet: a partial frame waiting for the rest. */
  get pending(): number {
    return this.scanner.pending;
  }

  /** Muxes the whole frames in `chunk` (bytes of a frame cut by the chunk wait for the next one). */
  push(chunk: Uint8Array): MuxOutput {
    const scan = this.scanner.scan(chunk);
    let init: Uint8Array | null = null;
    let fragment: Uint8Array | null = null;
    this.config ??= scan.config;
    if (
      this.codec === 'aac' &&
      this.config &&
      !this.config.key.startsWith('aac/2/')
    )
      return { init, fragment, changed: false, unsupported: true };
    if (scan.frames.length > 0 && this.config) {
      if (this.initPending) init = initSegment(this.config);
      this.initPending = false;
      this.sequence += 1;
      fragment = mediaSegment(this.sequence, this.decodeTime, scan.frames);
      for (const frame of scan.frames) this.decodeTime += frame.samples;
      this.frames += scan.frames.length;
    }
    return { init, fragment, changed: scan.changed, unsupported: false };
  }

  /**
   * A new connection continues the stream, mid-frame: drops the partial frame
   * and sends the init segment again (the source buffer's parser was reset),
   * on the same timeline.
   */
  restart(): void {
    this.scanner.restart();
    this.initPending = true;
  }
}
