/* eslint-disable no-bitwise -- MP4 box flags and MPEG-TS headers are bit fields. */
// The Remuxer over Matroska and MPEG-TS input: which tracks it muxes and why
// not, where the media starts, configuration changes, audio timing, seeks and
// reconnects — read back from the fragmented MP4 it writes.

import {
  Remuxer,
  audioFrameSamples,
  defaultChoice,
  playable,
  type RemuxFormat,
} from '../remux/Remuxer';
import { emptyTrack, type RemuxCue, type RemuxTrack } from '../remux/types';
import {
  adtsFrame,
  ascii,
  boxes,
  concat,
  mp3Frame,
  u32,
} from './audioFixtures';
import {
  AAC,
  AUD,
  AUDIO_PID,
  AVC_PPS,
  H264,
  IDR,
  MKV,
  SLICE,
  VIDEO_PID,
  annexB,
  audio,
  audioPes,
  avcSps,
  blockBytes,
  bytes,
  chunks,
  cluster,
  eac3Frame,
  el,
  filler,
  infoEl,
  join,
  mkv,
  pesPacket,
  pesPackets,
  simpleBlock,
  tables,
  tracksEl,
  video,
  videoAu,
  type TrackSpec,
} from './remuxFixtures';

// ── The Remuxer ──

function remux(format: RemuxFormat, data: Uint8Array, size = data.length) {
  const remuxer = new Remuxer(format);
  const segments: Uint8Array[] = [];
  const cues: RemuxCue[] = [];
  for (const part of chunks(data, size)) {
    const out = remuxer.push(part);
    segments.push(...out.segments);
    cues.push(...out.cues);
  }
  const out = remuxer.end();
  segments.push(...out.segments);
  cues.push(...out.cues);
  return { remuxer, segments, cues };
}

describe('Remuxer: playable tracks and defaults', () => {
  const track = (kind: RemuxTrack['kind'], over: Partial<RemuxTrack> = {}) => ({
    ...emptyTrack(over.id ?? 1, kind),
    codec: kind === 'text' ? 'srt' : 'x',
    ...over,
  });

  test('a track is playable with a codec and no objection, and is not text', () => {
    expect(playable(track('video'))).toBe(true);
    expect(playable(track('audio', { unsupported: 'DTS' }))).toBe(false);
    expect(playable(track('audio', { codec: null }))).toBe(false);
    expect(playable(track('text'))).toBe(false);
  });

  test('the default choice is the first video and the default audio', () => {
    const tracks = [
      track('video', { id: 1, unsupported: 'VC-1' }),
      track('video', { id: 2 }),
      track('audio', { id: 3 }),
      track('audio', { id: 4, default: true }),
      track('audio', { id: 5, default: true }),
      track('text', { id: 6 }),
    ];
    expect(defaultChoice(tracks)).toEqual({ video: 2, audio: 4 });
  });

  test('without a default flag the first audio track is chosen', () => {
    expect(
      defaultChoice([track('audio', { id: 7 }), track('audio', { id: 8 })])
    ).toEqual({
      video: null,
      audio: 7,
    });
    expect(defaultChoice([])).toEqual({ video: null, audio: null });
  });
});

describe('Remuxer: audio frame durations', () => {
  const t = (entry: string, objectType = 0) => ({
    ...emptyTrack(1, 'audio'),
    entry,
    objectType,
  });

  test.each([
    [
      'an AAC frame lasts 1024 samples',
      t('mp4a', 0x40),
      new Uint8Array(0),
      1024,
    ],
    ['an MP3 frame lasts 1152', t('mp4a', 0x6b), mp3Frame(), 1152],
    [
      'an MPEG-2 MP3 frame lasts 576',
      t('mp4a', 0x6b),
      mp3Frame({ version: 2 }),
      576,
    ],
    [
      'an MP3 frame with no header lasts 1152',
      t('mp4a', 0x6b),
      bytes(1, 2, 3, 4),
      1152,
    ],
    ['an AC-3 frame lasts 1536', t('ac-3'), new Uint8Array(0), 1536],
    [
      'an E-AC-3 frame lasts its blocks',
      t('ec-3'),
      eac3Frame({ numblkscod: 1 }),
      512,
    ],
    [
      'an E-AC-3 frame with no header lasts 1536',
      t('ec-3'),
      bytes(1, 2, 3),
      1536,
    ],
    [
      'an Opus packet lasts its TOC says',
      t('Opus'),
      bytes((1 << 3) | 1),
      2 * 960,
    ],
    ['an empty Opus packet lasts 960', t('Opus'), new Uint8Array(0), 960],
    [
      'a FLAC frame lasts its block size',
      t('fLaC'),
      bytes(0xff, 0xf8, 0xa0, 0, 0),
      1024,
    ],
    [
      'a FLAC frame with no header lasts 4096',
      t('fLaC'),
      bytes(1, 2, 3, 4, 5),
      4096,
    ],
    ['any other entry lasts 1024', t('xxxx'), bytes(1), 1024],
  ])('%s samples', (_, track, data, samples) => {
    expect(audioFrameSamples(track, data)).toBe(samples);
  });
});

// ── Remuxer: what the output holds ──

interface Traf {
  /** The MP4 track ID: 1 for the first muxed track. */
  track: number;
  time: number;
  samples: Array<{ duration: number; size: number; key: boolean | null }>;
}

/** The tracks of an init segment: ID and sample entry. */
function initTracks(init: Uint8Array): Array<{ id: number; entry: string }> {
  const moov = boxes(init).find((b) => b.type === 'moov')!;
  return boxes(moov.body)
    .filter((b) => b.type === 'trak')
    .map((trak) => {
      const kids = boxes(trak.body);
      const tkhd = kids.find((b) => b.type === 'tkhd')!;
      const mdia = boxes(kids.find((b) => b.type === 'mdia')!.body);
      const minf = boxes(mdia.find((b) => b.type === 'minf')!.body);
      const stbl = boxes(minf.find((b) => b.type === 'stbl')!.body);
      const stsd = stbl.find((b) => b.type === 'stsd')!;
      return {
        id: u32(tkhd.body, 12),
        entry: ascii(stsd.body.subarray(12, 16)),
      };
    });
}

/** The per-track runs of a `moof`: start time and samples. */
function trafs(segment: Uint8Array): Traf[] {
  const moof = boxes(segment).find((b) => b.type === 'moof')!;
  return boxes(moof.body)
    .filter((b) => b.type === 'traf')
    .map((traf) => {
      const kids = boxes(traf.body);
      const tfhd = kids.find((b) => b.type === 'tfhd')!;
      const tfdt = kids.find((b) => b.type === 'tfdt')!;
      const trun = kids.find((b) => b.type === 'trun')!;
      const hasFlags = (u32(trun.body, 0) & 0x400) !== 0;
      const stride = hasFlags ? 16 : 8;
      const samples = Array.from({ length: u32(trun.body, 4) }, (_, i) => {
        const at = 12 + i * stride;
        return {
          duration: u32(trun.body, at),
          size: u32(trun.body, at + 4),
          key: hasFlags ? u32(trun.body, at + 8) === 0x02000000 : null,
        };
      });
      return {
        track: u32(tfhd.body, 4),
        time: u32(tfdt.body, 4) * 2 ** 32 + u32(tfdt.body, 8),
        samples,
      };
    });
}

const media = (segments: Uint8Array[]) =>
  segments.filter((s) => ascii(s.subarray(4, 8)) === 'moof');
const inits = (segments: Uint8Array[]) =>
  segments.filter((s) => ascii(s.subarray(4, 8)) === 'ftyp');
/** Every run of one MP4 track, in order. */
const runs = (segments: Uint8Array[], track: number) =>
  media(segments).flatMap((s) => trafs(s).filter((t) => t.track === track));

// ── Remuxer: Matroska input ──

interface Block {
  track: number;
  ms: number;
  key?: boolean;
  data?: Uint8Array;
}

/** A Matroska file of the blocks, a cluster per `clusterMs`. */
function stream(
  specs: TrackSpec[],
  blocks: Block[],
  options: { clusterMs?: number; unknownSegment?: boolean } = {}
): Uint8Array {
  const clusterMs = options.clusterMs ?? 1000;
  const byCluster = new Map<number, Uint8Array[]>();
  for (const b of blocks) {
    const start = Math.floor(b.ms / clusterMs) * clusterMs;
    const list = byCluster.get(start) ?? [];
    list.push(
      simpleBlock(
        b.track,
        b.ms - start,
        b.data ?? bytes(0, 0, 0, 1, 9),
        b.key ? 0x80 : 0
      )
    );
    byCluster.set(start, list);
  }
  return mkv(
    [
      infoEl(),
      tracksEl(...specs),
      ...[...byCluster].map(([start, list]) => cluster(start, list)),
    ],
    options.unknownSegment
  );
}

const MP3 = (overrides: Partial<TrackSpec> = {}) =>
  audio({ codec: 'A_MPEG/L3', ...overrides });
const AAC48 = (overrides: Partial<TrackSpec> = {}) =>
  audio({ codec: 'A_AAC', audio: { rate: 48000, channels: 2 }, ...overrides });

describe('Remuxer: choosing the tracks', () => {
  test('says why when nothing can be played', () => {
    const { remuxer, segments } = remux(
      'matroska',
      stream(
        [
          video({ codec: 'V_THEORA', codecPrivate: undefined }),
          audio({ codec: 'A_VORBIS' }),
        ],
        [
          { track: 1, ms: 0, key: true },
          { track: 2, ms: 0 },
        ]
      )
    );
    expect(remuxer.failure).toBe(
      'no playable track (video V_THEORA, audio A_VORBIS)'
    );
    expect(remuxer.muxed).toEqual([]);
    expect(segments).toEqual([]);
  });

  test('says so when the file has no audio or video at all', () => {
    const { remuxer, cues } = remux(
      'matroska',
      stream(
        [{ number: 3, type: 17, codec: 'S_TEXT/UTF8' }],
        [{ track: 3, ms: 500, data: new TextEncoder().encode('hello') }]
      )
    );
    expect(remuxer.failure).toBe('no audio or video track');
    expect(cues).toEqual([{ track: 3, start: 500, end: null, text: 'hello' }]);
  });

  test('says why a TS file with only DTS cannot be played', () => {
    const data = join([
      ...tables([{ type: 0x82, pid: AUDIO_PID }]),
      ...filler(),
    ]);
    const { remuxer } = remux('mpegts', data);
    expect(remuxer.failure).toBe('no playable track (audio DTS)');
  });

  test('a choice of tracks of the wrong kind, or none, leaves nothing to play', () => {
    const file = stream(
      [video(), MP3()],
      [
        { track: 1, ms: 0, key: true },
        { track: 2, ms: 0 },
      ]
    );
    const remuxer = new Remuxer('matroska', {
      choose: () => ({ video: 2, audio: 1 }),
    });
    remuxer.push(file);
    expect(remuxer.failure).toBe(
      'no playable track (video avc1.42001E, audio mp4a.6B)'
    );
  });

  test('the choice can name another audio track; the other one is left out', () => {
    const file = stream(
      [video(), MP3(), AAC48({ number: 3 })],
      [
        { track: 1, ms: 0, key: true },
        { track: 2, ms: 0, data: mp3Frame() },
        { track: 3, ms: 0 },
        { track: 3, ms: 21 },
        { track: 1, ms: 1000, key: true },
      ]
    );
    const remuxer = new Remuxer('matroska', {
      choose: () => ({ video: 1, audio: 3 }),
    });
    const out = remuxer.push(file);
    const end = remuxer.end();
    expect(remuxer.muxed!.map((t) => t.id)).toEqual([1, 3]);
    expect(initTracks(out.segments[0]!)).toEqual([
      { id: 1, entry: 'avc1' },
      { id: 2, entry: 'mp4a' },
    ]);
    expect(
      runs([...out.segments, ...end.segments], 2)[0]!.samples
    ).toHaveLength(2);
  });

  test('a track whose codec never turns up is left out after three seconds of the file', () => {
    const file = stream(
      [video(), audio({ codec: 'A_AC3' })],
      [
        { track: 1, ms: 0, key: true },
        { track: 2, ms: 0, data: bytes(1, 2, 3, 4, 5, 6, 7, 8, 9) },
        { track: 1, ms: 1000, key: true },
        { track: 1, ms: 2000, key: true },
        { track: 1, ms: 3500, key: true },
      ]
    );
    const { remuxer, segments } = remux('matroska', file);
    expect(remuxer.tracks.find((t) => t.id === 2)!.unsupported).toBe('no data');
    expect(remuxer.muxed!.map((t) => t.id)).toEqual([1]);
    expect(initTracks(segments[0]!).map((t) => t.entry)).toEqual(['avc1']);
    expect(runs(segments, 1).flatMap((r) => r.samples)).toHaveLength(4);
  });

  test('at the end of a short file the same track is left out', () => {
    const file = stream(
      [video(), audio({ codec: 'A_AC3' })],
      [
        { track: 1, ms: 0, key: true },
        { track: 2, ms: 0, data: bytes(1, 2, 3, 4, 5, 6, 7, 8, 9) },
      ]
    );
    const { remuxer, segments } = remux('matroska', file);
    expect(remuxer.tracks.find((t) => t.id === 2)!.unsupported).toBe('no data');
    expect(initTracks(segments[0]!)).toHaveLength(1);
  });

  test('a file that ends before it has tracks gives nothing', () => {
    const remuxer = new Remuxer('matroska');
    expect(remuxer.end()).toEqual({ segments: [], cues: [] });
    expect(remuxer.muxed).toBeNull();
    expect(remuxer.init).toBeNull();
  });

  test('the clock and tracks come from the demuxer', () => {
    const remuxer = new Remuxer('matroska');
    remuxer.push(stream([video(), MP3()], []));
    expect(remuxer.clock).toBe(1000);
    expect(remuxer.tracks.map((t) => t.kind)).toEqual(['video', 'audio']);
    expect(new Remuxer('mpegts').clock).toBe(90000);
  });
});

describe('Remuxer: reselecting tracks', () => {
  const file = stream(
    [video(), MP3(), AAC48({ number: 3 })],
    [
      { track: 1, ms: 0, key: true },
      { track: 2, ms: 0, data: mp3Frame() },
      { track: 3, ms: 0 },
      { track: 1, ms: 1000, key: true },
    ]
  );

  function started() {
    const remuxer = new Remuxer('matroska');
    const first = remuxer.push(file);
    return { remuxer, first };
  }

  test('writes a new init segment first in the next output', () => {
    const { remuxer, first } = started();
    expect(remuxer.muxed!.map((t) => t.id)).toEqual([1, 2]);
    remuxer.reselect({ video: 1, audio: 3 });
    expect(remuxer.muxed!.map((t) => t.id)).toEqual([1, 3]);
    const next = remuxer.end();
    expect(ascii(next.segments[0]!.subarray(4, 8))).toBe('ftyp');
    expect(
      Buffer.from(next.segments[0]!).equals(Buffer.from(first.segments[0]!))
    ).toBe(false);
    expect(remuxer.init).toBe(next.segments[0]);
  });

  test('can drop the video', () => {
    const { remuxer } = started();
    remuxer.reselect({ video: null, audio: 3 });
    expect(remuxer.muxed!.map((t) => t.id)).toEqual([3]);
  });

  test('a choice that matches no playable track changes nothing', () => {
    const { remuxer } = started();
    remuxer.reselect({ video: 9, audio: 1 });
    expect(remuxer.muxed!.map((t) => t.id)).toEqual([1, 2]);
    expect(
      remuxer.end().segments.map((s) => ascii(s.subarray(4, 8)))
    ).not.toContain('ftyp');
  });

  test('before the tracks are chosen it does nothing', () => {
    const remuxer = new Remuxer('matroska');
    remuxer.reselect({ video: 1, audio: 2 });
    expect(remuxer.muxed).toBeNull();
  });
});

describe('Remuxer: where the media starts', () => {
  test('starts at the first video keyframe: earlier pictures and audio are dropped, audio still keeping time', () => {
    const file = stream(
      [video({ defaultDurationNs: 40_000_000 }), MP3()],
      [
        { track: 2, ms: 0, data: mp3Frame() },
        { track: 1, ms: 0 },
        { track: 2, ms: 20, data: mp3Frame() },
        { track: 1, ms: 40, key: true },
        { track: 2, ms: 40, data: mp3Frame() },
        { track: 1, ms: 80 },
        { track: 1, ms: 1000, key: true },
      ]
    );
    const { segments } = remux('matroska', file);
    const [first] = media(segments);
    const [v, a] = trafs(first!);
    expect(v).toMatchObject({ track: 1, time: 40 });
    expect(v!.samples.map((s) => s.key)).toEqual([true, false]);
    // Two frames of 1152 samples went by before the keyframe.
    expect(a).toMatchObject({ track: 2, time: 2 * 1152 });
    expect(a!.samples).toHaveLength(1);
  });

  test('a picture shown before the first keyframe is dropped', () => {
    const file = stream(
      [video()],
      [
        { track: 1, ms: 100, key: true },
        { track: 1, ms: 60 },
        { track: 1, ms: 140 },
      ]
    );
    const { segments } = remux('matroska', file);
    expect(runs(segments, 1)[0]!.samples).toHaveLength(2);
  });

  test('audio waits for a keyframe that never comes, keeping the last frames', () => {
    const blocks: Block[] = [{ track: 1, ms: 0 }];
    for (let i = 0; i < 2005; i++)
      blocks.push({ track: 2, ms: i, data: mp3Frame() });
    const { segments } = remux('matroska', stream([video(), MP3()], blocks));
    expect(media(segments)).toEqual([]);
    expect(inits(segments)).toHaveLength(1);
  });

  test('a video frame with no time is dropped', () => {
    const file = stream([video()], [{ track: 1, ms: 0, key: true }]);
    const laced = mkv([
      infoEl(),
      tracksEl(video()),
      cluster(0, [
        el(MKV.SimpleBlock, blockBytes(1, 0, 0x80 | 0x04, bytes(1, 5, 6))),
      ]),
    ]);
    expect(runs(remux('matroska', file).segments, 1)[0]!.samples).toHaveLength(
      1
    );
    expect(runs(remux('matroska', laced).segments, 1)[0]!.samples).toHaveLength(
      1
    );
  });

  test('one picture is as long as the DefaultDuration, else a 25 fps frame', () => {
    const one = (spec: TrackSpec) =>
      runs(
        remux('matroska', stream([spec], [{ track: 1, ms: 0, key: true }]))
          .segments,
        1
      )[0]!.samples[0]!.duration;
    expect(one(video({ defaultDurationNs: 33_000_000 }))).toBe(33);
    expect(one(video())).toBe(40);
    const ts = join([...tables([H264]), ...videoAu(9000, true)]);
    expect(runs(remux('mpegts', ts).segments, 1)[0]!.samples[0]!.duration).toBe(
      3600
    );
  });

  test('a TS stream starts at zero, or at the time base it was given', () => {
    const data = join([
      ...tables([H264]),
      ...videoAu(99000, true),
      ...videoAu(102600, false),
      ...videoAu(106200, true),
    ]);
    const plain = remux('mpegts', data);
    expect(plain.remuxer.timeBase).toBe(99000);
    expect(runs(plain.segments, 1)[0]!.time).toBe(0);
    const given = new Remuxer('mpegts', { timeBase: 90000 });
    expect(given.timeBase).toBe(90000);
    const segments = [
      ...chunks(data, 5000).flatMap((c) => given.push(c).segments),
      ...given.end().segments,
    ];
    expect(runs(segments, 1)[0]!.time).toBe(9000);
    expect(new Remuxer('mpegts').timeBase).toBeNull();
  });

  test('a Matroska file has no time base to move', () => {
    expect(new Remuxer('matroska').timeBase).toBe(0);
  });
});

describe('Remuxer: configuration changes', () => {
  const idr = (pts: number, sps = avcSps()) =>
    pesPackets(VIDEO_PID, pesPacket(0xe0, pts, annexB(AUD, sps, AVC_PPS, IDR)));
  const slice = (pts: number, sps = avcSps()) =>
    pesPackets(
      VIDEO_PID,
      pesPacket(0xe0, pts, annexB(AUD, sps, AVC_PPS, SLICE))
    );
  const WIDE = avcSps({ widthMbs: 80 });

  test('a new SPS on a keyframe closes the fragment and sends a new init segment', () => {
    const data = join([...tables([H264]), ...idr(9000), ...idr(12600, WIDE)]);
    const { segments } = remux('mpegts', data);
    expect(segments.map((s) => ascii(s.subarray(4, 8)))).toEqual([
      'ftyp',
      'moof',
      'ftyp',
      'moof',
    ]);
    expect(Buffer.from(segments[0]!).equals(Buffer.from(segments[2]!))).toBe(
      false
    );
  });

  test('a new SPS on a picture that is not a keyframe waits for the next keyframe', () => {
    const data = join([
      ...tables([H264]),
      ...idr(9000),
      ...slice(12600, WIDE),
      ...idr(16200, WIDE),
    ]);
    const { segments } = remux('mpegts', data);
    expect(segments.map((s) => ascii(s.subarray(4, 8)))).toEqual([
      'ftyp',
      'moof',
      'ftyp',
      'moof',
    ]);
    expect(runs(segments, 1).map((r) => r.samples.length)).toEqual([1, 1]);
  });

  test('a change of audio sample rate sends a new init segment', () => {
    const data = join([
      ...tables([H264, AAC]),
      ...idr(9000),
      ...slice(10800),
      ...audioPes(9000, adtsFrame({ rateIndex: 4 })),
      ...audioPes(12600, adtsFrame({ rateIndex: 3 })),
    ]);
    const { segments } = remux('mpegts', data);
    expect(inits(segments)).toHaveLength(2);
  });
});

describe('Remuxer: audio timing', () => {
  const adtsAt = (pts: number) => audioPes(pts, adtsFrame({ rateIndex: 3 }));

  test('audio alone is cut on whole seconds', () => {
    const data = join([
      ...tables([AAC]),
      ...Array.from({ length: 131 }, (_, i) => adtsAt(i * 1920)).flat(),
    ]);
    const { segments, remuxer } = remux('mpegts', data);
    const audioRuns = runs(segments, 1);
    expect(audioRuns.map((r) => r.samples.length)).toEqual([47, 47, 37]);
    expect(audioRuns.map((r) => r.time)).toEqual([0, 47 * 1024, 94 * 1024]);
    expect(remuxer.muxed!.map((t) => t.kind)).toEqual(['audio']);
  });

  test('audio frames with no time before the first one with a time are dropped', () => {
    const data = join([
      ...tables([AAC]),
      ...pesPackets(AUDIO_PID, pesPacket(0xc0, null, adtsFrame(), true)),
      ...adtsAt(9000),
      ...adtsAt(10920),
    ]);
    const { segments } = remux('mpegts', data);
    expect(runs(segments, 1)[0]!.samples).toHaveLength(2);
  });

  test('timestamps that jump ahead are carried over, the timeline going on', () => {
    const jump = 100 * 90000;
    const data = join([
      ...tables([AAC]),
      ...Array.from({ length: 150 }, (_, i) =>
        adtsAt(i * 1920 + (i >= 100 ? jump : 0))
      ).flat(),
    ]);
    const { segments } = remux('mpegts', data);
    expect(runs(segments, 1).map((r) => r.time)).toEqual([
      0,
      47 * 1024,
      94 * 1024,
      141 * 1024,
    ]);
  });

  describe('Matroska audio, on a millisecond clock', () => {
    const FRAME_MS = 1024 / 48;
    const frame = (ms: number): Block => ({
      track: 1,
      ms,
      data: bytes(1, 2, 3, 4),
    });
    const regular = Array.from({ length: 100 }, (_, i) =>
      frame(Math.round(i * FRAME_MS))
    );

    test('jitter within half a frame is smoothed into whole frames', () => {
      const { segments } = remux(
        'matroska',
        stream([AAC48({ number: 1 })], regular)
      );
      const times = runs(segments, 1).map((r) => r.time);
      expect(times).toEqual([0, 47 * 1024, 94 * 1024]);
    });

    test('a frame that overlaps the one before is dropped', () => {
      const withEcho = [
        ...regular.slice(0, 11),
        frame(Math.round(10 * FRAME_MS)),
        ...regular.slice(11),
      ];
      const { segments } = remux(
        'matroska',
        stream([AAC48({ number: 1 })], withEcho)
      );
      const total = runs(segments, 1).reduce((n, r) => n + r.samples.length, 0);
      expect(total).toBe(100);
    });

    test('a gap starts the next frame at its own time', () => {
      const { segments } = remux(
        'matroska',
        stream([AAC48({ number: 1 })], [...regular, frame(5000)])
      );
      const times = runs(segments, 1).map((r) => r.time);
      expect(times.at(-1)).toBe(5000 * 48);
    });
  });
});

describe('Remuxer: seeking and reconnecting', () => {
  function layout() {
    const head = mkv(
      [infoEl(), tracksEl(video({ defaultDurationNs: 40_000_000 }))],
      true
    );
    const clusterOf = (start: number, blocks: Uint8Array[]) =>
      cluster(start, blocks);
    const c1 = clusterOf(0, [
      simpleBlock(1, 0, bytes(1), 0x80),
      simpleBlock(1, 40, bytes(2), 0),
    ]);
    const c2 = clusterOf(1000, [simpleBlock(1, 0, bytes(3), 0x80)]);
    const c3 = clusterOf(2000, [
      simpleBlock(1, 0, bytes(4), 0),
      simpleBlock(1, 40, bytes(5), 0x80),
      simpleBlock(1, 80, bytes(6), 0),
    ]);
    return { head, c1, c2, c3, c3At: head.length + c1.length + c2.length };
  }

  test('a Matroska seek starts again at the next keyframe, with no new init segment', () => {
    const { head, c1, c2, c3, c3At } = layout();
    const remuxer = new Remuxer('matroska');
    const before = remuxer.push(concat(head, c1, c2));
    expect(inits(before.segments)).toHaveLength(1);
    remuxer.seek(c3At);
    const after = [...remuxer.push(c3).segments, ...remuxer.end().segments];
    expect(inits(after)).toEqual([]);
    const [run] = runs(after, 1);
    expect(run).toMatchObject({ time: 2040 });
    expect(run!.samples).toHaveLength(2);
  });

  test('a seek before the tracks were chosen drops the frames waiting', () => {
    const head = mkv(
      [infoEl(), tracksEl(video(), audio({ codec: 'A_AC3' }))],
      true
    );
    const first = cluster(0, [
      simpleBlock(1, 0, bytes(1), 0x80),
      simpleBlock(2, 0, bytes(1, 2, 3, 4, 5, 6, 7, 8, 9)),
    ]);
    const second = cluster(1000, [simpleBlock(1, 0, bytes(2), 0x80)]);
    const remuxer = new Remuxer('matroska');
    remuxer.push(concat(head, first));
    expect(remuxer.muxed).toBeNull();
    remuxer.seek(head.length + first.length);
    remuxer.push(second);
    const out = remuxer.end();
    expect(remuxer.tracks[1]!.unsupported).toBe('no data');
    expect(runs(out.segments, 1)).toMatchObject([{ time: 1000 }]);
    expect(runs(out.segments, 1)[0]!.samples).toHaveLength(1);
  });

  test('a TS seek drops the half-read picture and starts at a keyframe', () => {
    const idr = (pts: number) =>
      pesPackets(
        VIDEO_PID,
        pesPacket(0xe0, pts, annexB(AUD, avcSps(), AVC_PPS, IDR))
      );
    const remuxer = new Remuxer('mpegts');
    remuxer.push(join([...tables([H264]), ...idr(9000), ...idr(12600)]));
    remuxer.seek();
    const data = join([
      ...pesPackets(VIDEO_PID, pesPacket(0xe0, 91000, annexB(SLICE))),
      ...idr(93600),
      ...idr(97200),
    ]);
    const out = [...remuxer.push(data).segments, ...remuxer.end().segments];
    expect(inits(out)).toEqual([]);
    // The picture that is not a keyframe is dropped; the timeline is kept.
    expect(runs(out, 1).map((r) => [r.time, r.samples.length])).toEqual([
      [84600, 1],
      [88200, 1],
    ]);
  });

  test("after a reconnect of a live WebM the new connection's clusters follow", () => {
    const head = mkv(
      [infoEl(), tracksEl(video({ defaultDurationNs: 40_000_000 }))],
      true
    );
    const c1 = cluster(0, [simpleBlock(1, 0, bytes(1), 0x80)], 'unknown');
    const cut = cluster(1000, [simpleBlock(1, 0, bytes(2), 0x80)]);
    const c3 = cluster(2000, [simpleBlock(1, 0, bytes(3), 0x80)], 'unknown');
    const remuxer = new Remuxer('matroska');
    const segments = remuxer.push(
      concat(head, c1, cut.subarray(0, cut.length - 3))
    ).segments;
    remuxer.reconnected();
    segments.push(...remuxer.push(c3).segments, ...remuxer.end().segments);
    expect(runs(segments, 1).flatMap((r) => r.samples)).toHaveLength(2);
  });

  test('after a reconnect of a TS stream the partial PES is gone and the timeline goes on', () => {
    const idr = (pts: number, n = 0) =>
      pesPackets(
        VIDEO_PID,
        pesPacket(
          0xe0,
          pts,
          annexB(AUD, avcSps(), AVC_PPS, IDR, new Uint8Array(n).fill(7))
        )
      );
    const remuxer = new Remuxer('mpegts');
    const segments = remuxer.push(
      join([...tables([H264]), ...idr(9000), ...idr(12600, 600).slice(0, 2)])
    ).segments;
    remuxer.reconnected();
    segments.push(
      ...remuxer.push(join([...videoAu(18000, true), ...videoAu(21600, false)]))
        .segments,
      ...remuxer.end().segments
    );
    expect(runs(segments, 1).map((r) => r.samples.length)).toEqual([1, 2]);
  });
});
