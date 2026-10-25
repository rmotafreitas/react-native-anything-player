/* eslint-disable no-bitwise -- MPEG-TS headers are bit fields. */
// A streaming MPEG-TS demuxer (also M2TS's 192-byte packets): bytes in, in
// chunks of any size; the first program's video and audio out. Video access
// units leave as MP4 samples (4-byte NAL lengths, the parameter sets moved to
// the track's configuration), audio as single frames. Times stay on the
// stream's 90 kHz clock, unwrapped past the 33-bit rollover; the remuxer
// moves them to zero. Packets that lose sync are skipped up to the next sync.
//
// The Swift twin is ios/Core/Remux/MpegTs.swift.

import { concat, equalBytes, readUint } from './bytes';
import {
  ac3Header,
  adtsHeader,
  avcCodec,
  avcConfig,
  hevcCodec,
  hevcConfig,
  lengthPrefixed,
  makeAsc,
  mpegAudioHeader,
  parseAvcSps,
  parseHevcSps,
  splitAnnexB,
} from './codecs';
import type { DemuxSink } from './Matroska';
import { emptyTrack, type RemuxTrack } from './types';

const PACKET = 188;
const SYNC = 0x47;
const PTS_WRAP = 2 ** 33;

/** `probe`: a private stream without a descriptor that says what it is (HDMV's AAC): its first frame does. */
type StreamKind = 'h264' | 'hevc' | 'aac' | 'mpeg' | 'ac3' | 'eac3' | 'probe';

interface Stream {
  track: RemuxTrack;
  kind: StreamKind | null;
  /** The PES being assembled. */
  parts: Uint8Array[];
  size: number;
  /** The PES's declared length (0: unbounded, video). */
  expected: number;
  /** Audio bytes of a frame the last PES cut. */
  carry: Uint8Array;
  /** E-AC-3: the frame waiting for its dependent substreams. */
  held: { pts: number | null; data: Uint8Array } | null;
  /** Video: the parameter sets in the configuration. */
  params: Uint8Array[][];
}

/** The stream type (and descriptors) → what RNAP makes of it. */
function streamKind(
  type: number,
  descriptors: Uint8Array
): {
  kind: StreamKind | null;
  track: 'video' | 'audio' | 'text';
  reason: string | null;
} | null {
  switch (type) {
    case 0x1b:
      return { kind: 'h264', track: 'video', reason: null };
    case 0x24:
      return { kind: 'hevc', track: 'video', reason: null };
    case 0x0f:
      return { kind: 'aac', track: 'audio', reason: null };
    case 0x03:
    case 0x04:
      return { kind: 'mpeg', track: 'audio', reason: null };
    case 0x81:
      return { kind: 'ac3', track: 'audio', reason: null };
    case 0x87:
    case 0x84: // Blu-ray (HDMV)
      return { kind: 'eac3', track: 'audio', reason: null };
    case 0x80:
      return { kind: null, track: 'audio', reason: 'LPCM' };
    case 0x82:
    case 0x85:
    case 0x86:
      return { kind: null, track: 'audio', reason: 'DTS' };
    case 0x83:
      return { kind: null, track: 'audio', reason: 'TrueHD' };
    case 0x90:
      return { kind: null, track: 'text', reason: 'PGS subtitles' };
    case 0xea:
      return { kind: null, track: 'video', reason: 'VC-1' };
    case 0x01:
    case 0x02:
      return { kind: null, track: 'video', reason: 'MPEG-2 video' };
    case 0x10:
      return { kind: null, track: 'video', reason: 'MPEG-4 Visual' };
    case 0x11:
      return { kind: null, track: 'audio', reason: 'AAC in LATM' };
    case 0x06:
      return privateStream(descriptors);
    default:
      return null;
  }
}

/** A DVB private stream: AC-3, E-AC-3 or subtitles, by its descriptors. */
function privateStream(descriptors: Uint8Array) {
  let at = 0;
  while (at + 2 <= descriptors.length) {
    const tag = descriptors[at]!;
    const length = descriptors[at + 1]!;
    const body = descriptors.subarray(at + 2, at + 2 + length);
    const registration =
      tag === 0x05 ? String.fromCodePoint(...body.subarray(0, 4)) : '';
    if (tag === 0x6a || registration === 'AC-3')
      return { kind: 'ac3' as const, track: 'audio' as const, reason: null };
    if (tag === 0x7a || registration === 'EAC3')
      return { kind: 'eac3' as const, track: 'audio' as const, reason: null };
    if (tag === 0x59)
      return { kind: null, track: 'text' as const, reason: 'DVB subtitles' };
    if (tag === 0x56)
      return { kind: null, track: 'text' as const, reason: 'teletext' };
    at += 2 + length;
  }
  return { kind: 'probe' as const, track: 'audio' as const, reason: null };
}

/** The ISO 639 language descriptor's code, if any. */
function languageOf(descriptors: Uint8Array): string | null {
  let at = 0;
  while (at + 2 <= descriptors.length) {
    const length = descriptors[at + 1]!;
    if (descriptors[at] === 0x0a && length >= 3) {
      const code = String.fromCodePoint(
        ...descriptors.subarray(at + 2, at + 5)
      );
      return /^[a-z]{3}$/i.test(code) ? code.toLowerCase() : null;
    }
    at += 2 + length;
  }
  return null;
}

/**
 * What a NAL unit is to the remuxer: a parameter set (its index in the
 * configuration), a sample's unit (`key`: a random access point), or
 * nothing (`drop`: delimiters and filler).
 */
type UnitRole = number | 'key' | 'sample' | 'drop';

function avcUnit(unit: Uint8Array): UnitRole {
  const type = unit[0]! & 0x1f;
  if (type === 7 || type === 8) return type - 7;
  if (type >= 9 && type <= 12) return 'drop';
  // An IDR, or a recovery point (SEI payload 6: broadcast streams with
  // open GOPs and no IDR).
  return type === 5 || (type === 6 && unit[1] === 6) ? 'key' : 'sample';
}

function hevcUnit(unit: Uint8Array): UnitRole {
  const type = (unit[0]! >> 1) & 0x3f;
  if (type >= 32 && type <= 34) return type - 32;
  if (type >= 35 && type <= 38) return 'drop';
  return type >= 16 && type <= 23 ? 'key' : 'sample';
}

type AudioFrame =
  { length: number; skip: number; independent: boolean } | 'short' | null;

/** The ADTS frame at `at` (its header dropped); the track takes its configuration. */
function adtsFrame(
  track: RemuxTrack,
  data: Uint8Array,
  at: number
): AudioFrame {
  const h = adtsHeader(data, at);
  if (!h) return null;
  const asc = makeAsc(h.objectType, h.sampleRate, h.channels);
  if (!equalBytes(track.config, asc)) {
    track.entry = 'mp4a';
    track.objectType = 0x40;
    track.config = asc;
    track.codec = `mp4a.40.${h.objectType}`;
    track.sampleRate = h.sampleRate;
    track.channels = h.channels;
    track.timescale = h.sampleRate;
  }
  return { length: h.length, skip: h.headerLength, independent: true };
}

/** The MP3 frame at `at` (other layers: the track is unsupported). */
function mpegFrame(
  track: RemuxTrack,
  data: Uint8Array,
  at: number
): AudioFrame {
  const h = mpegAudioHeader(data, at);
  if (!h) return null;
  if (h.layer !== 3) {
    track.unsupported = `MPEG audio layer ${h.layer}`;
    return null;
  }
  const changed =
    track.codec == null ||
    track.sampleRate !== h.sampleRate ||
    track.channels !== h.channels;
  if (changed) {
    track.entry = 'mp4a';
    track.objectType = 0x6b;
    track.codec = 'mp4a.6B';
    track.sampleRate = h.sampleRate;
    track.channels = h.channels;
    track.timescale = h.sampleRate;
  }
  return { length: h.length, skip: 0, independent: true };
}

/** The AC-3 or E-AC-3 sync frame at `at`. */
function ac3Frame(track: RemuxTrack, data: Uint8Array, at: number): AudioFrame {
  const h = ac3Header(data, at);
  if (!h) return null;
  if (h.independent && !equalBytes(track.config, h.config)) {
    track.entry = h.extended ? 'ec-3' : 'ac-3';
    track.config = h.config;
    track.codec = track.entry;
    track.sampleRate = h.sampleRate;
    track.channels = h.channels;
    track.timescale = h.sampleRate;
  }
  return { length: h.length, skip: 0, independent: h.independent };
}

/** A 33-bit timestamp from the 5 bytes at `at`. */
function timestamp(data: Uint8Array, at: number): number {
  return (
    ((data[at]! >> 1) & 7) * 2 ** 30 +
    data[at + 1]! * 2 ** 22 +
    (data[at + 2]! >> 1) * 2 ** 15 +
    data[at + 3]! * 2 ** 7 +
    (data[at + 4]! >> 1)
  );
}

export class TsDemuxer {
  readonly clock = 90000;
  readonly tracks: RemuxTrack[] = [];
  /** The program's streams are known (its PMT was read). */
  tracksKnown = false;

  private packetSize = 0;
  private carry = new Uint8Array(0);
  private pmtPid = -1;
  private readonly sections = new Map<number, Uint8Array>();
  private readonly streams = new Map<number, Stream>();
  /** The last unwrapped timestamp: the next one is placed nearest to it. */
  private reference: number | null = null;

  push(chunk: Uint8Array, sink: DemuxSink): void {
    let data = this.carry.length > 0 ? concat([this.carry, chunk]) : chunk;
    let at = 0;
    if (this.packetSize === 0) {
      const found = findSync(data, 0);
      if (!found) {
        this.carry = data.slice(Math.max(0, data.length - 3 * 192));
        return;
      }
      this.packetSize = found.size;
      at = found.at;
    }
    const size = this.packetSize;
    // A 192-byte packet starts with a 4-byte timecode: the sync byte follows.
    const lead = size - PACKET;
    let synced = true;
    while (synced && at + size <= data.length) {
      if (data[at + lead] === SYNC) {
        this.packet(data.subarray(at + lead, at + lead + PACKET), sink);
        at += size;
      } else {
        // Lost sync: on to where packets line up again (kept for the next chunk if not here).
        const found = findSync(data, at + 1, size);
        synced = found != null;
        at = found ? found.at : Math.max(at + 1, data.length - 2 * size);
      }
    }
    data = data.subarray(at);
    this.carry = data.slice();
  }

  /** The stream ended: the PES being assembled is complete. */
  end(sink: DemuxSink): void {
    for (const stream of this.streams.values()) {
      this.flushPes(stream, sink);
      this.release(stream, sink);
    }
  }

  /** The next bytes pushed come from elsewhere in the file (a seek). */
  seek(): void {
    this.carry = new Uint8Array(0);
    this.sections.clear();
    for (const stream of this.streams.values()) {
      stream.parts = [];
      stream.size = 0;
      stream.carry = new Uint8Array(0);
      stream.held = null;
    }
  }

  private packet(p: Uint8Array, sink: DemuxSink): void {
    const start = (p[1]! & 0x40) !== 0;
    const pid = ((p[1]! & 0x1f) << 8) | p[2]!;
    const control = (p[3]! >> 4) & 3;
    if (!(control & 1)) return; // no payload
    let at = 4;
    if (control & 2) at += 1 + p[4]!;
    if (at >= PACKET) return;
    const payload = p.subarray(at);
    if (pid === 0 || pid === this.pmtPid) {
      this.section(pid, payload, start);
      return;
    }
    const stream = this.streams.get(pid);
    if (stream) this.pes(stream, payload, start, sink);
  }

  // ── Program tables ──

  private section(pid: number, payload: Uint8Array, start: boolean): void {
    let data: Uint8Array;
    if (start) {
      data = payload.subarray(1 + payload[0]!);
    } else {
      const previous = this.sections.get(pid);
      if (!previous) return;
      data = concat([previous, payload]);
    }
    if (data.length < 3) {
      this.sections.set(pid, data.slice());
      return;
    }
    const length = 3 + (((data[1]! & 0x0f) << 8) | data[2]!);
    if (data.length < length) {
      this.sections.set(pid, data.slice());
      return;
    }
    this.sections.delete(pid);
    const section = data.subarray(0, length);
    if (pid === 0 && section[0] === 0x00) {
      this.pat(section);
      return;
    }
    if (section[0] === 0x02) this.pmt(section);
  }

  private pat(section: Uint8Array): void {
    for (let at = 8; at + 4 <= section.length - 4; at += 4) {
      const program = readUint(section, at, 2);
      if (program === 0) continue;
      if (this.pmtPid < 0) this.pmtPid = readUint(section, at + 2, 2) & 0x1fff;
      return;
    }
  }

  private pmt(section: Uint8Array): void {
    if (this.tracksKnown) return;
    const infoLength = readUint(section, 10, 2) & 0x0fff;
    for (let at = 12 + infoLength; at + 5 <= section.length - 4;) {
      const esLength = readUint(section, at + 3, 2) & 0x0fff;
      this.addStream(
        section[at]!,
        readUint(section, at + 1, 2) & 0x1fff,
        section.subarray(at + 5, at + 5 + esLength)
      );
      at += 5 + esLength;
    }
    this.tracksKnown = true;
  }

  /** A PMT entry: a track, and a stream to read when RNAP can mux it. */
  private addStream(type: number, pid: number, descriptors: Uint8Array) {
    const known = streamKind(type, descriptors);
    if (!known || this.streams.has(pid)) return;
    const track = emptyTrack(pid, known.track);
    track.language = languageOf(descriptors);
    track.unsupported = known.reason;
    if (known.track === 'video') track.timescale = this.clock;
    this.tracks.push(track);
    if (known.kind == null) return;
    this.streams.set(pid, {
      track,
      kind: known.kind,
      parts: [],
      size: 0,
      expected: 0,
      carry: new Uint8Array(0),
      held: null,
      params: [],
    });
  }

  // ── PES ──

  private pes(
    stream: Stream,
    payload: Uint8Array,
    start: boolean,
    sink: DemuxSink
  ): void {
    if (!start && stream.parts.length === 0) return; // the start was missed
    if (start) {
      this.flushPes(stream, sink);
      const header =
        payload.length >= 6 &&
        payload[0] === 0 &&
        payload[1] === 0 &&
        payload[2] === 1;
      stream.expected = header ? readUint(payload, 4, 2) : 0;
    }
    stream.parts.push(payload.slice());
    stream.size += payload.length;
    if (stream.expected > 0 && stream.size >= 6 + stream.expected)
      this.flushPes(stream, sink);
  }

  private flushPes(stream: Stream, sink: DemuxSink): void {
    if (stream.parts.length === 0) return;
    const pes = concat(stream.parts);
    stream.parts = [];
    stream.size = 0;
    if (pes.length < 9 || pes[0] !== 0 || pes[1] !== 0 || pes[2] !== 1) return;
    const flags = pes[7]!;
    const headerEnd = 9 + pes[8]!;
    if (headerEnd > pes.length) return;
    const pts =
      flags & 0x80 && headerEnd >= 14 ? this.unwrap(timestamp(pes, 9)) : null;
    let body = pes.subarray(headerEnd);
    if (stream.expected > 0)
      body = body.subarray(0, Math.max(0, 6 + stream.expected - headerEnd));
    if (stream.kind === 'h264' || stream.kind === 'hevc')
      this.video(stream, pts, body, sink);
    else this.audio(stream, pts, body, sink);
  }

  private unwrap(raw: number): number {
    if (this.reference == null) {
      this.reference = raw;
      return raw;
    }
    // The nearest: round((reference − raw) / 2³³), half up.
    const k = Math.floor((this.reference - raw + PTS_WRAP / 2) / PTS_WRAP);
    const value = raw + k * PTS_WRAP;
    this.reference = value;
    return value;
  }

  // ── Video ──

  private video(
    stream: Stream,
    pts: number | null,
    body: Uint8Array,
    sink: DemuxSink
  ): void {
    const hevc = stream.kind === 'hevc';
    const params: Uint8Array[][] = hevc ? [[], [], []] : [[], []];
    const kept: Uint8Array[] = [];
    let key = false;
    for (const unit of splitAnnexB(body)) {
      const role = hevc ? hevcUnit(unit) : avcUnit(unit);
      if (role === 'key' || role === 'sample') kept.push(unit);
      if (role === 'key') key = true;
      if (typeof role === 'number') params[role]!.push(unit);
    }
    if (params.every((p) => p.length > 0)) this.configureVideo(stream, params);
    if (kept.length === 0 || pts == null) return;
    sink.frame({
      track: stream.track.id,
      pts,
      key,
      data: lengthPrefixed(kept),
    });
  }

  private configureVideo(stream: Stream, params: Uint8Array[][]): void {
    const same =
      stream.params.length === params.length &&
      stream.params.every(
        (list, i) =>
          list.length === params[i]!.length &&
          list.every((unit, j) => equalBytes(unit, params[i]![j]!))
      );
    if (same) return;
    const track = stream.track;
    try {
      if (stream.kind === 'hevc') {
        const config = hevcConfig(params[0]!, params[1]!, params[2]!);
        const info = parseHevcSps(params[1]![0]!);
        track.entry = 'hvc1';
        track.config = config;
        track.codec = hevcCodec(config);
        track.width = info.width;
        track.height = info.height;
      } else {
        if (params[0]![0]!.length < 4) return;
        const config = avcConfig(params[0]!, params[1]!);
        const info = parseAvcSps(params[0]![0]!);
        track.entry = 'avc1';
        track.config = config;
        track.codec = avcCodec(config);
        track.width = info.width;
        track.height = info.height;
        track.sarWidth = info.sarWidth;
        track.sarHeight = info.sarHeight;
      }
      stream.params = params;
    } catch {
      // A parameter set too short to read: wait for the next.
    }
  }

  // ── Audio ──

  private audio(
    stream: Stream,
    pts: number | null,
    body: Uint8Array,
    sink: DemuxSink
  ): void {
    if (stream.kind === 'probe') this.probe(stream, body);
    if (stream.track.unsupported != null) return;
    const carried = stream.carry.length;
    const data = carried > 0 ? concat([stream.carry, body]) : body;
    // The PES's time is its first frame's that starts in it (not one the last PES cut).
    let time = pts;
    let at = 0;
    let whole = true;
    while (whole && at < data.length) {
      const frame = this.audioFrame(stream, data, at);
      if (frame == null) {
        at += 1; // not a frame header: resync
      } else if (frame === 'short' || at + frame.length > data.length) {
        whole = false; // the rest waits for the next PES
      } else {
        const own = at >= carried ? time : null;
        if (at >= carried) time = null;
        const bytes = data.subarray(at + frame.skip, at + frame.length);
        this.emitAudio(stream, own, bytes, frame.independent, sink);
        at += frame.length;
      }
    }
    stream.carry = data.slice(at);
  }

  private emitAudio(
    stream: Stream,
    pts: number | null,
    bytes: Uint8Array,
    independent: boolean,
    sink: DemuxSink
  ): void {
    if (stream.kind === 'eac3') {
      this.eac3(stream, pts, bytes, independent, sink);
      return;
    }
    sink.frame({ track: stream.track.id, pts, key: true, data: bytes.slice() });
  }

  /** A private stream's first PES says what it carries. */
  private probe(stream: Stream, body: Uint8Array): void {
    if (adtsHeader(body, 0)) stream.kind = 'aac';
    else if (ac3Header(body, 0)) stream.kind = 'ac3';
    else if (mpegAudioHeader(body, 0)?.layer === 3) stream.kind = 'mpeg';
    else stream.track.unsupported = 'unknown private stream';
  }

  /** The audio frame at `at`: its length and header bytes to drop; `short` when the header is cut. */
  private audioFrame(stream: Stream, data: Uint8Array, at: number): AudioFrame {
    if (data.length - at < 8) return 'short';
    if (stream.kind === 'aac') return adtsFrame(stream.track, data, at);
    if (stream.kind === 'mpeg') return mpegFrame(stream.track, data, at);
    return ac3Frame(stream.track, data, at);
  }

  /** E-AC-3: a dependent substream joins the independent frame before it. */
  private eac3(
    stream: Stream,
    pts: number | null,
    bytes: Uint8Array,
    independent: boolean,
    sink: DemuxSink
  ): void {
    if (!independent && stream.held) {
      stream.held.data = concat([stream.held.data, bytes]);
      return;
    }
    this.release(stream, sink);
    stream.held = { pts, data: bytes.slice() };
  }

  private release(stream: Stream, sink: DemuxSink): void {
    const held = stream.held;
    stream.held = null;
    if (held)
      sink.frame({
        track: stream.track.id,
        pts: held.pts,
        key: true,
        data: held.data,
      });
  }
}

/** The first offset from `from` where packets of `size` (or either size) line up three times. */
function findSync(
  data: Uint8Array,
  from: number,
  only?: number
): { at: number; size: number } | null {
  const sizes = only ? [only] : [PACKET, 192];
  for (let i = from; i < data.length; i++) {
    const size = sizes.find((n) => linesUp(data, i, n));
    if (size != null) return { at: i, size };
    if (i + 3 * 192 >= data.length) return null;
  }
  return null;
}

/** Three packets of `size` from `i`, each starting with the sync byte. */
function linesUp(data: Uint8Array, i: number, size: number): boolean {
  const p = i + size - PACKET;
  if (p + 2 * size >= data.length) return false;
  return (
    data[p] === SYNC && data[p + size] === SYNC && data[p + 2 * size] === SYNC
  );
}

/** The last PTS in the tail of a TS file (for its duration), on the 90 kHz clock; `null` when there is none. */
export function lastTimestamp(
  tail: Uint8Array,
  pid: number | null
): number | null {
  const found = findSync(tail, 0);
  if (!found) return null;
  const lead = found.size - PACKET;
  let last: number | null = null;
  for (let at = found.at; at + found.size <= tail.length; at += found.size) {
    const p = tail.subarray(at + lead, at + lead + PACKET);
    last = pesTimestamp(p, pid) ?? last;
  }
  return last;
}

/** The PTS of a PES that starts in packet `p` (of `pid`, when given); `null` otherwise. */
function pesTimestamp(p: Uint8Array, pid: number | null): number | null {
  if (p[0] !== SYNC || !(p[1]! & 0x40)) return null;
  const packetPid = ((p[1]! & 0x1f) << 8) | p[2]!;
  if (pid != null && packetPid !== pid) return null;
  const control = (p[3]! >> 4) & 3;
  const off = control & 2 ? 5 + p[4]! : 4;
  if (!(control & 1) || off + 14 > PACKET) return null;
  if (p[off] !== 0 || p[off + 1] !== 0 || p[off + 2] !== 1) return null;
  return p[off + 7]! & 0x80 ? timestamp(p, off + 9) : null;
}
