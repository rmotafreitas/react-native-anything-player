/// <reference types="node" />
/* eslint-disable no-bitwise -- EBML lacing sizes are bit fields. */
// The container remuxer against conformance/remux/: each fixture's tracks,
// cues and fragmented MP4 output, byte for byte (the Swift twin compares with
// the same files). `RNAP_WRITE_GOLDEN=1 npx jest containerRemux` rewrites
// them after a deliberate change.

import fs from 'node:fs';
import path from 'node:path';

import { delace } from '../remux/Matroska';
import { MatroskaDemuxer } from '../remux/Matroska';
import { Remuxer, playable, type RemuxFormat } from '../remux/Remuxer';
import type { RemuxCue, RemuxTrack } from '../remux/types';

const DIR = path.resolve(__dirname, '../../../conformance/remux');
const WRITE = process.env.RNAP_WRITE_GOLDEN === '1';
const FIXTURES = fs
  .readdirSync(DIR)
  .filter((f) => /\.(mkv|webm|mpegts|m2ts)$/.test(f))
  .sort();

const formatOf = (file: string): RemuxFormat =>
  /\.(mpegts|m2ts)$/.test(file) ? 'mpegts' : 'matroska';

function hex(bytes: Uint8Array | null): string | null {
  return bytes ? Buffer.from(bytes).toString('hex') : null;
}

function summary(t: RemuxTrack) {
  return {
    id: t.id,
    kind: t.kind,
    codec: t.codec,
    entry: t.entry,
    config: hex(t.config),
    objectType: t.objectType,
    timescale: t.timescale,
    width: t.width,
    height: t.height,
    sar: `${t.sarWidth}:${t.sarHeight}`,
    sampleRate: t.sampleRate,
    channels: t.channels,
    language: t.language,
    name: t.name,
    default: t.default,
    forced: t.forced,
    unsupported: t.unsupported,
  };
}

interface Run {
  remuxer: Remuxer;
  segments: Uint8Array[];
  cues: RemuxCue[];
}

function run(
  file: string,
  bytes: Uint8Array,
  chunk: number,
  audio?: number
): Run {
  const remuxer = new Remuxer(
    formatOf(file),
    audio == null ? {} : { choose: () => ({ video: null, audio }) }
  );
  const segments: Uint8Array[] = [];
  const cues: RemuxCue[] = [];
  for (let at = 0; at < bytes.length; at += chunk) {
    const out = remuxer.push(bytes.subarray(at, at + chunk));
    segments.push(...out.segments);
    cues.push(...out.cues);
  }
  const out = remuxer.end();
  segments.push(...out.segments);
  cues.push(...out.cues);
  return { remuxer, segments, cues };
}

const joined = (parts: Uint8Array[]) =>
  Buffer.concat(parts.map((p) => Buffer.from(p)));

/** Top-level boxes of an MP4: type and size. */
function boxes(
  data: Uint8Array
): Array<{ type: string; at: number; size: number }> {
  const out = [];
  let at = 0;
  while (at + 8 <= data.length) {
    const size = Buffer.from(data.subarray(at, at + 4)).readUInt32BE(0);
    const type = Buffer.from(data.subarray(at + 4, at + 8)).toString('ascii');
    out.push({ type, at, size });
    if (size < 8) break;
    at += size;
  }
  return out;
}

/** Each moof's first tfdt (the first track's decode time). */
function decodeTimes(data: Uint8Array): number[] {
  const buffer = Buffer.from(data);
  const times: number[] = [];
  for (const box of boxes(data)) {
    if (box.type !== 'moof') continue;
    const at = buffer.indexOf('tfdt', box.at);
    times.push(Number(buffer.readBigUInt64BE(at + 8)));
  }
  return times;
}

describe('container remux (conformance/remux/)', () => {
  test.each(FIXTURES)('%s', (file) => {
    const bytes = new Uint8Array(fs.readFileSync(path.join(DIR, file)));
    const main = run(file, bytes, 1000);
    // The chunking does not change a byte.
    for (const chunk of [1, 188, 7919, bytes.length]) {
      if (chunk === 1 && bytes.length > 60_000) continue;
      const other = run(file, bytes, chunk);
      expect(joined(other.segments).equals(joined(main.segments))).toBe(true);
      expect(other.cues).toEqual(main.cues);
    }
    const outputs: Record<string, Buffer> = {
      'main.mp4': joined(main.segments),
    };
    const tracks = main.remuxer.tracks;
    const muxedAudio = main.remuxer.muxed?.find((t) => t.kind === 'audio')?.id;
    for (const t of tracks) {
      if (t.kind !== 'audio' || !playable(t) || t.id === muxedAudio) continue;
      outputs[`audio-${t.id}.mp4`] = joined(
        run(file, bytes, 1000, t.id).segments
      );
    }
    const json = {
      'tracks.json': {
        muxed: main.remuxer.muxed?.map((t) => t.id) ?? [],
        tracks: tracks.map(summary),
        segments: Object.fromEntries(
          Object.entries(outputs).map(([name, data]) => [
            name,
            boxes(data).map((b) => `${b.type} ${b.size}`),
          ])
        ),
      },
      'cues.json': main.cues,
    };
    const out = path.join(DIR, `${file}.out`);
    if (WRITE) {
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      for (const [name, data] of Object.entries(outputs))
        fs.writeFileSync(path.join(out, name), data);
      for (const [name, value] of Object.entries(json))
        fs.writeFileSync(
          path.join(out, name),
          `${JSON.stringify(value, null, 2)}\n`
        );
    }
    const written = fs.readdirSync(out).sort();
    expect(written).toEqual(
      [...Object.keys(outputs), ...Object.keys(json)].sort()
    );
    for (const [name, value] of Object.entries(json))
      expect(JSON.parse(fs.readFileSync(path.join(out, name), 'utf8'))).toEqual(
        JSON.parse(JSON.stringify(value))
      );
    for (const [name, data] of Object.entries(outputs))
      expect(fs.readFileSync(path.join(out, name)).equals(data)).toBe(true);
  });
});

describe('container remux behaviour', () => {
  const read = (file: string) =>
    new Uint8Array(fs.readFileSync(path.join(DIR, file)));

  test('a fragment per keyframe, starting at zero, picture and sound together', () => {
    for (const file of ['h264-aac.mkv', 'h264-aac.mpegts', 'vp9-opus.webm']) {
      const { segments, remuxer } = run(file, read(file), 4096);
      const data = joined(segments);
      const video = remuxer.muxed!.find((t) => t.kind === 'video')!;
      const times = decodeTimes(data).map((t) => t / video.timescale);
      expect(times[0]).toBe(0);
      expect(times).toHaveLength(3); // three seconds, a keyframe each
      expect(times[1]).toBeCloseTo(1, 1);
      expect(boxes(data)[0]!.type).toBe('ftyp');
    }
  });

  test('a Matroska file seeks to a cluster from its Cues', () => {
    const bytes = read('h264-aac.mkv');
    const head = new Remuxer('matroska');
    head.push(bytes);
    const demuxer = head.demuxer as MatroskaDemuxer;
    expect(demuxer.cues.length).toBeGreaterThanOrEqual(3);
    expect(demuxer.duration).toBeGreaterThan(2900);
    // A fresh remuxer: the head up to the first cluster, then a jump.
    const remuxer = new Remuxer('matroska');
    const first = demuxer.firstCluster!;
    const init = remuxer.push(bytes.subarray(0, first));
    const target = demuxer.cues[2]!;
    remuxer.seek(target.offset);
    const out = remuxer.push(bytes.subarray(target.offset));
    const end = remuxer.end();
    const data = joined([...init.segments, ...out.segments, ...end.segments]);
    expect(boxes(data)[0]!.type).toBe('ftyp');
    const times = decodeTimes(data);
    expect(times[0]).toBe(target.time); // ms: the video timescale is 1000
  });

  test('a TS file read from the middle starts at the next keyframe, on the same timeline', () => {
    const bytes = read('h264-aac.mpegts');
    const whole = run('h264-aac.mpegts', bytes, 4096);
    const remuxer = new Remuxer('mpegts');
    const head = remuxer.push(bytes.subarray(0, 20_000));
    remuxer.seek();
    const middle = 31_337; // not on a packet boundary
    const out = remuxer.push(bytes.subarray(middle));
    const end = remuxer.end();
    const data = joined([...head.segments, ...out.segments, ...end.segments]);
    const times = decodeTimes(data);
    const reference = decodeTimes(joined(whole.segments));
    expect(times[0]).toBe(0);
    expect(reference).toContain(times[times.length - 1]);
  });

  test('corrupt bytes in a Matroska file: it resyncs on the next cluster', () => {
    const bytes = read('h264-aac.mkv');
    const broken = bytes.slice();
    const cue = (() => {
      const r = new Remuxer('matroska');
      r.push(bytes);
      return (r.demuxer as MatroskaDemuxer).cues[1]!;
    })();
    broken.fill(0, cue.offset - 2000, cue.offset - 10);
    const { segments } = run('h264-aac.mkv', broken, 4096);
    const times = decodeTimes(joined(segments));
    expect(times).toContain(cue.time);
    expect(times[times.length - 1]).toBeGreaterThanOrEqual(cue.time);
  });

  test('lacing: Xiph, EBML and fixed', () => {
    const frames = [
      Uint8Array.of(1, 2, 3),
      new Uint8Array(300).fill(7),
      Uint8Array.of(9),
    ];
    const payload = Buffer.concat(frames.map((f) => Buffer.from(f)));
    // Xiph: 3 frames → count byte 2; sizes 3, then 300 as 255 + 45.
    const xiph = Uint8Array.from([2, 3, 255, 45, ...payload]);
    expect(delace(xiph, 0, 1)).toEqual(frames);
    // EBML: first size 3 (0x83), then 300 − 3 = +297 as a 2-byte signed vint.
    const delta = 297 + (2 ** 13 - 1);
    const ebml = Uint8Array.from([
      2,
      0x83,
      0x40 | (delta >> 8),
      delta & 0xff,
      ...payload,
    ]);
    expect(delace(ebml, 0, 3)).toEqual(frames);
    const fixed = Uint8Array.from([2, 1, 2, 3, 4, 5, 6]);
    expect(delace(fixed, 0, 2)).toEqual([
      Uint8Array.of(1, 2),
      Uint8Array.of(3, 4),
      Uint8Array.of(5, 6),
    ]);
    expect(delace(Uint8Array.of(2, 1, 2), 0, 2)).toBeNull();
  });
});

describe('container remux: TS discontinuities', () => {
  test('timestamps that jump back (a loop) or ahead go on from where they were', () => {
    const once = new Uint8Array(
      fs.readFileSync(path.join(DIR, 'h264-aac.mpegts'))
    );
    // The same file twice: the second copy's timestamps start over.
    const twice = new Uint8Array(once.length * 2);
    twice.set(once);
    twice.set(once, once.length);
    const { segments, remuxer } = run('h264-aac.mpegts', twice, 4096);
    const video = remuxer.muxed!.find((t) => t.kind === 'video')!;
    const times = decodeTimes(joined(segments)).map((t) => t / video.timescale);
    expect(times).toHaveLength(6);
    for (let i = 1; i < times.length; i++)
      expect(times[i]! - times[i - 1]!).toBeCloseTo(1, 1);
  });
});
