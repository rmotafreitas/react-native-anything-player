/* eslint-disable no-bitwise -- MPEG-TS headers are bit fields. */
// The MPEG-TS demuxer's edges: program tables, stream types and descriptors,
// packets and adaptation fields, PES assembly, timestamp unwrapping, video
// and audio frames, and truncated or garbled streams.

import { TsDemuxer, lastTimestamp } from '../remux/MpegTs';
import { type DemuxFrame } from '../remux/types';
import { adtsFrame, concat, mp3Frame } from './audioFixtures';
import {
  AAC,
  AUD,
  AUDIO_PID,
  AVC_PPS,
  H264,
  HEVC_PPS,
  HEVC_VPS,
  IDR,
  PMT_PID,
  SLICE,
  VIDEO_PID,
  ac3Frame,
  annexB,
  audioPes,
  avcSps,
  bytes,
  demuxTs,
  eac3Frame,
  hevcSps,
  hex,
  join,
  patSection,
  pesPacket,
  pesPackets,
  pmtSection,
  psiPackets,
  read,
  tables,
  tsPacket,
  videoAu,
} from './remuxFixtures';

describe('MPEG-TS: program tables', () => {
  test('reads a PAT and a PMT, and the streams in it', () => {
    const { demuxer } = demuxTs(join(tables([H264, AAC])));
    expect(demuxer.tracksKnown).toBe(true);
    expect(demuxer.tracks.map((t) => [t.id, t.kind, t.unsupported])).toEqual([
      [VIDEO_PID, 'video', null],
      [AUDIO_PID, 'audio', null],
    ]);
    expect(demuxer.tracks[0]!.timescale).toBe(90000);
  });

  test('a PAT that names only the network (program 0) has no PMT', () => {
    const data = join([
      ...psiPackets(0, patSection([[0, 0x10]])),
      ...psiPackets(PMT_PID, pmtSection([H264])),
    ]);
    expect(demuxTs(data).demuxer.tracksKnown).toBe(false);
  });

  test('the first program of the PAT counts', () => {
    const data = join([
      ...psiPackets(
        0,
        patSection([
          [0, 0x10],
          [1, PMT_PID],
          [2, 0x200],
        ])
      ),
      ...psiPackets(PMT_PID, pmtSection([H264])),
      ...psiPackets(0x200, pmtSection([AAC])),
    ]);
    expect(demuxTs(data).demuxer.tracks.map((t) => t.id)).toEqual([VIDEO_PID]);
  });

  test('a section split over several packets is put together', () => {
    const data = join([
      ...psiPackets(0, patSection([[1, PMT_PID]])),
      ...psiPackets(PMT_PID, pmtSection([H264, AAC]), 10),
    ]);
    expect(demuxTs(data).demuxer.tracks).toHaveLength(2);
  });

  test('a continuation of a section whose start was missed is ignored', () => {
    const lone = tsPacket(PMT_PID, new Uint8Array(20), {});
    const { demuxer } = demuxTs(
      join([
        ...psiPackets(0, patSection([[1, PMT_PID]])),
        lone,
        ...tables([H264]),
      ])
    );
    expect(demuxer.tracks).toHaveLength(1);
  });

  test('a section start with fewer than three bytes waits for the rest', () => {
    const section = pmtSection([H264]);
    const withPointer = concat(bytes(0), section);
    const packets = [
      tsPacket(PMT_PID, withPointer.subarray(0, 2), { start: true }),
      tsPacket(PMT_PID, withPointer.subarray(2)),
    ];
    const { demuxer } = demuxTs(
      join([...psiPackets(0, patSection([[1, PMT_PID]])), ...packets])
    );
    expect(demuxer.tracks).toHaveLength(1);
  });

  test('a second PMT changes nothing', () => {
    const data = join([
      ...tables([H264]),
      ...psiPackets(PMT_PID, pmtSection([AAC])),
    ]);
    expect(demuxTs(data).demuxer.tracks).toHaveLength(1);
  });

  test('a PMT with program info skips it', () => {
    const data = join(tables([H264], [0x0e, 0x03, 1, 2, 3]));
    expect(demuxTs(data).demuxer.tracks).toHaveLength(1);
  });

  test('a section of another kind on the PMT PID is ignored', () => {
    const other = section0x42();
    const data = join([
      ...psiPackets(0, patSection([[1, PMT_PID]])),
      ...psiPackets(PMT_PID, other),
      ...psiPackets(PMT_PID, pmtSection([H264])),
    ]);
    expect(demuxTs(data).demuxer.tracks).toHaveLength(1);
  });

  test('a stream listed twice, or of a type nobody knows, is skipped', () => {
    const { demuxer } = demuxTs(
      join(
        tables([
          H264,
          { type: 0x1b, pid: VIDEO_PID },
          { type: 0x99, pid: 0x300 },
          AAC,
        ])
      )
    );
    expect(demuxer.tracks.map((t) => t.id)).toEqual([VIDEO_PID, AUDIO_PID]);
  });

  test.each([
    [0x80, 'audio', 'LPCM'],
    [0x82, 'audio', 'DTS'],
    [0x85, 'audio', 'DTS'],
    [0x86, 'audio', 'DTS'],
    [0x83, 'audio', 'TrueHD'],
    [0x90, 'text', 'PGS subtitles'],
    [0xea, 'video', 'VC-1'],
    [0x01, 'video', 'MPEG-2 video'],
    [0x02, 'video', 'MPEG-2 video'],
    [0x10, 'video', 'MPEG-4 Visual'],
    [0x11, 'audio', 'AAC in LATM'],
  ])(
    'stream type 0x%s is an unsupported %s track (%s)',
    (type, kind, reason) => {
      const { demuxer } = demuxTs(join(tables([{ type, pid: 0x300 }])));
      expect(demuxer.tracks[0]).toMatchObject({
        id: 0x300,
        kind,
        unsupported: reason,
      });
    }
  );

  test.each([
    [0x24, 'video'],
    [0x03, 'audio'],
    [0x04, 'audio'],
    [0x81, 'audio'],
    [0x84, 'audio'],
    [0x87, 'audio'],
  ])('stream type 0x%s is a supported %s track', (type, kind) => {
    const { demuxer } = demuxTs(join(tables([{ type, pid: 0x300 }])));
    expect(demuxer.tracks[0]).toMatchObject({ kind, unsupported: null });
  });

  test.each([
    ['AC-3', [0x6a, 0x00], 'audio', null],
    ['E-AC-3', [0x7a, 0x00], 'audio', null],
    [
      'AC-3 by registration',
      [0x05, 0x04, 0x41, 0x43, 0x2d, 0x33],
      'audio',
      null,
    ],
    [
      'E-AC-3 by registration',
      [0x05, 0x04, 0x45, 0x41, 0x43, 0x33],
      'audio',
      null,
    ],
    ['DVB subtitles', [0x59, 0x00], 'text', 'DVB subtitles'],
    ['teletext', [0x56, 0x00], 'text', 'teletext'],
    [
      'an unknown descriptor first',
      [0x52, 0x01, 0x07, 0x6a, 0x00],
      'audio',
      null,
    ],
    ['no descriptor', [], 'audio', null],
  ])(
    'a private stream with %s descriptors is %s (%s)',
    (_, descriptors, kind, reason) => {
      const { demuxer } = demuxTs(
        join(tables([{ type: 0x06, pid: 0x300, descriptors }]))
      );
      expect(demuxer.tracks[0]).toMatchObject({ kind, unsupported: reason });
    }
  );

  test.each([
    [[0x0a, 0x04, 0x70, 0x6f, 0x72, 0x00], 'por'],
    [[0x0a, 0x04, 0x45, 0x4e, 0x47, 0x00], 'eng'],
    [[0x52, 0x01, 0x00, 0x0a, 0x04, 0x66, 0x72, 0x61, 0x00], 'fra'],
    [[0x0a, 0x04, 0x31, 0x32, 0x33, 0x00], null],
    [[0x0a, 0x02, 0x70, 0x6f], null],
    [[], null],
  ])('the language descriptor %j gives %p', (descriptors, language) => {
    const { demuxer } = demuxTs(join(tables([{ ...AAC, descriptors }])));
    expect(demuxer.tracks[0]!.language).toBe(language);
  });
});

function section0x42(): Uint8Array {
  return Uint8Array.of(0x42, 0xb0, 0x09, 0, 1, 0xc1, 0, 0, 1, 2, 3, 4, 5, 6);
}

describe('MPEG-TS: packets', () => {
  test('a packet without a payload, or whose adaptation field eats it, is skipped', () => {
    const noPayload = tsPacket(VIDEO_PID, new Uint8Array(0), {
      adaptation: Uint8Array.of(0),
    });
    noPayload[3] = 0x20;
    const huge = tsPacket(VIDEO_PID, new Uint8Array(0), {
      adaptation: new Uint8Array(0),
    });
    huge[3] = 0x30;
    huge[4] = 183;
    const { frames } = demuxTs(
      join([...tables([H264]), noPayload, huge, ...videoAu(9000, true)])
    );
    expect(frames).toHaveLength(1);
  });

  test('an adaptation field is skipped to reach the payload', () => {
    const pes = pesPacket(0xe0, 9000, annexB(AUD, avcSps(), AVC_PPS, IDR));
    const packet = tsPacket(VIDEO_PID, pes, {
      start: true,
      adaptation: Uint8Array.of(0x10, 0, 1, 2, 3, 4, 5),
    });
    const { frames } = demuxTs(join([...tables([H264]), packet]));
    expect(frames).toEqual([
      {
        track: VIDEO_PID,
        pts: 9000,
        key: true,
        data: concat(bytes(0, 0, 0, IDR.length), IDR),
      },
    ]);
  });

  test('packets of a PID that is not in the PMT are ignored', () => {
    const stray = pesPackets(0x555, pesPacket(0xe0, 90, annexB(IDR)));
    const { frames } = demuxTs(
      join([...tables([H264]), ...stray, ...videoAu(9000, true)])
    );
    expect(frames).toHaveLength(1);
  });

  test('a PES continuation whose start was missed is ignored', () => {
    const mid = tsPacket(VIDEO_PID, new Uint8Array(184).fill(1));
    const { frames } = demuxTs(
      join([...tables([H264]), mid, ...videoAu(9000, true)])
    );
    expect(frames).toHaveLength(1);
  });

  test('chunks of any size give the same frames', () => {
    const data = join([
      ...tables([H264, AAC]),
      ...videoAu(9000, true),
      ...audioPes(9000, adtsFrame(), adtsFrame()),
      ...videoAu(12600, false),
      ...videoAu(16200, true),
    ]);
    const whole = demuxTs(data);
    for (const size of [1, 100, 188, 1000]) {
      expect(demuxTs(data, size).frames).toEqual(whole.frames);
    }
    // A video PES has no length: it is complete when the next one starts.
    expect(whole.frames.map((f) => f.track)).toEqual([
      AUDIO_PID,
      AUDIO_PID,
      VIDEO_PID,
      VIDEO_PID,
      VIDEO_PID,
    ]);
  });

  test('M2TS packets carry a 4-byte timecode in front', () => {
    const packets = [...tables([H264]), ...videoAu(9000, true)];
    const m2ts = join(packets.map((p) => concat(bytes(0, 0, 0, 0), p)));
    const { frames, demuxer } = demuxTs(m2ts);
    expect(demuxer.tracks).toHaveLength(1);
    expect(frames).toEqual(demuxTs(join(packets)).frames);
    expect(frames).toHaveLength(1);
  });

  test('garbage between packets is skipped up to where they line up again', () => {
    const data = join([
      new Uint8Array(500).fill(0x11),
      ...tables([H264]),
      bytes(1, 2, 3, 4, 5, 6, 7),
      ...videoAu(9000, true),
      ...videoAu(12600, false),
      ...videoAu(16200, true),
      ...videoAu(19800, false),
    ]);
    const { frames } = demuxTs(data);
    expect(frames.map((f) => f.pts)).toEqual([9000, 12600, 16200, 19800]);
  });

  test('no sync byte to be found keeps only the tail for the next chunk', () => {
    const demuxer = new TsDemuxer();
    const frames: DemuxFrame[] = [];
    const sink = { frame: (f: DemuxFrame) => frames.push(f), cue: jest.fn() };
    demuxer.push(new Uint8Array(5000).fill(0x11), sink);
    expect(demuxer.tracksKnown).toBe(false);
    demuxer.push(
      join([
        ...tables([H264]),
        ...videoAu(9000, true),
        ...videoAu(12600, false),
        ...videoAu(16200, true),
      ]),
      sink
    );
    expect(demuxer.tracks).toHaveLength(1);
    expect(frames.map((f) => f.pts)).toEqual([9000, 12600]);
  });

  test('a TS file cut anywhere gives a prefix of the frames of each stream', () => {
    const data = read('h264-aac.mpegts');
    const times = (bytesOf: Uint8Array, track: number) =>
      demuxTs(bytesOf, 1500)
        .frames.filter((f) => f.track === track)
        .map((f) => f.pts);
    for (const track of [256, 257]) {
      const full = times(data, track);
      expect(full.length).toBeGreaterThan(10);
      for (let cut = 1000; cut < data.length; cut += 9973) {
        const part = times(data.subarray(0, cut), track);
        const settled = Math.max(0, part.length - 1);
        expect(part.slice(0, settled)).toEqual(full.slice(0, settled));
      }
    }
  });

  test('seek drops what was half-read', () => {
    const demuxer = new TsDemuxer();
    const frames: DemuxFrame[] = [];
    const sink = { frame: (f: DemuxFrame) => frames.push(f), cue: jest.fn() };
    const pes = pesPackets(
      VIDEO_PID,
      pesPacket(
        0xe0,
        9000,
        annexB(AUD, avcSps(), AVC_PPS, IDR, new Uint8Array(400).fill(5))
      )
    );
    demuxer.push(join([...tables([H264]), ...pes.slice(0, 1)]), sink);
    demuxer.seek();
    demuxer.push(
      join([
        ...videoAu(18000, true),
        ...videoAu(21600, false),
        ...videoAu(25200, false),
      ]),
      sink
    );
    demuxer.end(sink);
    expect(frames.map((f) => f.pts)).toEqual([18000, 21600, 25200]);
  });
});

describe('MPEG-TS: PES packets and time', () => {
  test('a PES without a PTS gives a frame with no time (audio) or none at all (video)', () => {
    const audioFrames = demuxTs(
      join([
        ...tables([AAC]),
        ...pesPackets(AUDIO_PID, pesPacket(0xc0, null, adtsFrame(), true)),
      ])
    ).frames;
    expect(audioFrames.map((f) => f.pts)).toEqual([null]);
    const videoFrames = demuxTs(
      join([
        ...tables([H264]),
        ...pesPackets(
          VIDEO_PID,
          pesPacket(0xe0, null, annexB(avcSps(), AVC_PPS, IDR))
        ),
      ])
    ).frames;
    expect(videoFrames).toEqual([]);
  });

  test('a PES that does not start with a start code is dropped', () => {
    const bad = tsPacket(AUDIO_PID, new Uint8Array(40).fill(9), {
      start: true,
    });
    const { frames } = demuxTs(
      join([...tables([AAC]), bad, ...audioPes(9000, adtsFrame())])
    );
    expect(frames).toHaveLength(1);
  });

  test('a PES whose header length runs past its data is dropped', () => {
    const pes = pesPacket(0xc0, 9000, adtsFrame(), true);
    pes[8] = 200;
    const { frames } = demuxTs(
      join([...tables([AAC]), ...pesPackets(AUDIO_PID, pes)])
    );
    expect(frames).toEqual([]);
  });

  test('a bounded PES ends at its declared length', () => {
    const pes = concat(
      pesPacket(0xc0, 9000, adtsFrame(), true),
      new Uint8Array(20)
    );
    const { frames } = demuxTs(
      join([...tables([AAC]), ...pesPackets(AUDIO_PID, pes)])
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]!.data).toHaveLength(31 - 7);
  });

  test('an AAC frame cut by the end of a PES continues in the next', () => {
    const frame = adtsFrame({ payload: 60 });
    const next = adtsFrame({ payload: 10 });
    const data = join([
      ...tables([AAC]),
      ...audioPes(
        9000,
        concat(adtsFrame({ payload: 10 }), frame.subarray(0, 30))
      ),
      ...audioPes(9000 + 2000, concat(frame.subarray(30), next)),
    ]);
    const { frames } = demuxTs(data);
    expect(frames.map((f) => [f.pts, f.data.length])).toEqual([
      [9000, 10],
      [null, 60],
      [11000, 10],
    ]);
  });

  test('a PES that is not at a frame boundary resyncs byte by byte', () => {
    const { frames } = demuxTs(
      join([
        ...tables([AAC]),
        ...audioPes(9000, bytes(1, 2, 3), adtsFrame(), bytes(4)),
      ])
    );
    expect(frames).toHaveLength(1);
  });

  test('a frame header cut at the end of a PES waits for the next', () => {
    const frame = adtsFrame();
    const data = join([
      ...tables([AAC]),
      ...audioPes(9000, frame.subarray(0, 5)),
      ...audioPes(9000, frame.subarray(5)),
    ]);
    expect(demuxTs(data).frames).toHaveLength(1);
  });

  test('timestamps unwrap past the 33-bit rollover', () => {
    const near = 2 ** 33 - 90000;
    const data = join([
      ...tables([AAC]),
      ...audioPes(near, adtsFrame()),
      ...audioPes(near + 45000, adtsFrame()),
      ...audioPes((near + 90000 + 4500) % 2 ** 33, adtsFrame()),
      ...audioPes((near + 90000 + 9000) % 2 ** 33, adtsFrame()),
    ]);
    const { frames } = demuxTs(data);
    expect(frames.map((f) => f.pts)).toEqual([
      near,
      near + 45000,
      2 ** 33 + 4500,
      2 ** 33 + 9000,
    ]);
  });

  test('a timestamp that steps back a little stays near the last', () => {
    const data = join([
      ...tables([AAC]),
      ...audioPes(2 ** 33 - 10, adtsFrame()),
      ...audioPes(2 ** 33 - 20, adtsFrame()),
    ]);
    expect(demuxTs(data).frames.map((f) => f.pts)).toEqual([
      2 ** 33 - 10,
      2 ** 33 - 20,
    ]);
  });
});

describe('MPEG-TS: video', () => {
  test('the parameter sets leave the sample and configure the track', () => {
    const { frames, demuxer } = demuxTs(
      join([...tables([H264]), ...videoAu(9000, true)])
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ track: VIDEO_PID, pts: 9000, key: true });
    expect(hex(frames[0]!.data)).toBe(
      hex(concat(bytes(0, 0, 0, IDR.length), IDR))
    );
    expect(demuxer.tracks[0]).toMatchObject({
      entry: 'avc1',
      codec: 'avc1.42001E',
      width: 640,
      height: 480,
    });
  });

  test('a picture is a keyframe when it holds a recovery point SEI', () => {
    const sei = bytes(0x06, 0x06, 0x01, 0x00);
    const { frames } = demuxTs(
      join([
        ...tables([H264]),
        ...pesPackets(
          VIDEO_PID,
          pesPacket(0xe0, 9000, annexB(AUD, sei, SLICE))
        ),
      ])
    );
    expect(frames[0]!.key).toBe(true);
    const other = bytes(0x06, 0x05, 0x01, 0x00);
    const plain = demuxTs(
      join([
        ...tables([H264]),
        ...pesPackets(VIDEO_PID, pesPacket(0xe0, 9000, annexB(other, SLICE))),
      ])
    ).frames;
    expect(plain[0]!.key).toBe(false);
  });

  test('delimiters and filler are dropped, a unit of nothing but them gives no frame', () => {
    const filler = bytes(0x0c, 0xff);
    const { frames } = demuxTs(
      join([
        ...tables([H264]),
        ...pesPackets(VIDEO_PID, pesPacket(0xe0, 9000, annexB(AUD, filler))),
      ])
    );
    expect(frames).toEqual([]);
  });

  test('a new SPS changes the configuration', () => {
    const wide = avcSps({ widthMbs: 80 });
    const au = (sps: Uint8Array, pts: number) =>
      pesPackets(
        VIDEO_PID,
        pesPacket(0xe0, pts, annexB(AUD, sps, AVC_PPS, IDR))
      );
    const { demuxer } = demuxTs(
      join([...tables([H264]), ...au(avcSps(), 9000), ...au(wide, 12600)])
    );
    expect(demuxer.tracks[0]!.width).toBe(1280);
  });

  test('the same parameter sets again leave the configuration alone', () => {
    const { demuxer } = demuxTs(
      join([...tables([H264]), ...videoAu(9000, true), ...videoAu(12600, true)])
    );
    expect(demuxer.tracks[0]!.width).toBe(640);
  });

  test('a parameter set too short to read waits for the next', () => {
    const tiny = bytes(0x67, 0x42);
    const { demuxer } = demuxTs(
      join([
        ...tables([H264]),
        ...pesPackets(
          VIDEO_PID,
          pesPacket(0xe0, 9000, annexB(tiny, AVC_PPS, IDR))
        ),
      ])
    );
    expect(demuxer.tracks[0]!.codec).toBeNull();
  });

  test('HEVC gathers VPS, SPS and PPS, and marks IRAP pictures as keys', () => {
    const idr = bytes(0x26, 0x01, 0xaf, 0x08);
    const trail = bytes(0x02, 0x01, 0xd0, 0x09);
    const aud = bytes(0x46, 0x01, 0x50);
    const au = (pts: number, ...nals: Uint8Array[]) =>
      pesPackets(VIDEO_PID, pesPacket(0xe0, pts, annexB(aud, ...nals)));
    const { frames, demuxer } = demuxTs(
      join([
        ...tables([{ type: 0x24, pid: VIDEO_PID }]),
        ...au(
          9000,
          HEVC_VPS,
          hevcSps({ width: 1280, height: 720 }),
          HEVC_PPS,
          idr
        ),
        ...au(12600, trail),
      ])
    );
    expect(frames.map((f) => f.key)).toEqual([true, false]);
    expect(demuxer.tracks[0]).toMatchObject({
      entry: 'hvc1',
      codec: 'hvc1.1.6.L93.90',
      width: 1280,
      height: 720,
    });
  });

  test('HEVC with a parameter set missing is not configured', () => {
    const idr = bytes(0x26, 0x01, 0xaf, 0x08);
    const { demuxer } = demuxTs(
      join([
        ...tables([{ type: 0x24, pid: VIDEO_PID }]),
        ...pesPackets(
          VIDEO_PID,
          pesPacket(0xe0, 9000, annexB(HEVC_VPS, HEVC_PPS, idr))
        ),
      ])
    );
    expect(demuxer.tracks[0]!.codec).toBeNull();
  });
});

describe('MPEG-TS: audio', () => {
  test('ADTS frames configure an AAC track and leave without their header', () => {
    const { frames, demuxer } = demuxTs(
      join([
        ...tables([AAC]),
        ...audioPes(
          9000,
          adtsFrame({ fill: 7 }),
          adtsFrame({ crc: true, fill: 8 })
        ),
      ])
    );
    expect(frames.map((f) => [f.pts, f.data.length, f.data[0]])).toEqual([
      [9000, 24, 7],
      [null, 24, 8],
    ]);
    expect(demuxer.tracks[0]).toMatchObject({
      entry: 'mp4a',
      codec: 'mp4a.40.2',
      sampleRate: 44100,
      channels: 2,
      objectType: 0x40,
    });
  });

  test('a change of sample rate reconfigures the track', () => {
    const { demuxer } = demuxTs(
      join([
        ...tables([AAC]),
        ...audioPes(9000, adtsFrame()),
        ...audioPes(18000, adtsFrame({ rateIndex: 3 })),
      ])
    );
    expect(demuxer.tracks[0]!.sampleRate).toBe(48000);
  });

  test('MP3 frames configure an MP3 track, whole in the sample', () => {
    const { frames, demuxer } = demuxTs(
      join([
        ...tables([{ type: 0x03, pid: AUDIO_PID }]),
        ...audioPes(9000, mp3Frame({ fill: 1 }), mp3Frame({ fill: 2 })),
      ])
    );
    expect(frames.map((f) => [f.pts, f.data.length, f.data[8]])).toEqual([
      [9000, 417, 1],
      [null, 417, 2],
    ]);
    expect(demuxer.tracks[0]).toMatchObject({
      codec: 'mp4a.6B',
      objectType: 0x6b,
      sampleRate: 44100,
    });
  });

  test('a change of MP3 rate or channels reconfigures the track', () => {
    const { demuxer } = demuxTs(
      join([
        ...tables([{ type: 0x03, pid: AUDIO_PID }]),
        ...audioPes(9000, mp3Frame()),
        ...audioPes(18000, mp3Frame({ rateIndex: 1, mono: true })),
      ])
    );
    expect(demuxer.tracks[0]).toMatchObject({ sampleRate: 48000, channels: 1 });
  });

  test('MPEG audio of Layer II makes the track unsupported', () => {
    const layer2 = mp3Frame();
    layer2[1] = (layer2[1]! & ~0x06) | (2 << 1);
    layer2[2] = layer2[2]! | 0;
    const { frames, demuxer } = demuxTs(
      join([
        ...tables([{ type: 0x03, pid: AUDIO_PID }]),
        ...audioPes(9000, layer2, new Uint8Array(500)),
      ])
    );
    expect(frames).toEqual([]);
    expect(demuxer.tracks[0]!.unsupported).toBe('MPEG audio layer 2');
  });

  test('AC-3 frames configure an AC-3 track', () => {
    const { frames, demuxer } = demuxTs(
      join([
        ...tables([{ type: 0x81, pid: AUDIO_PID }]),
        ...audioPes(9000, ac3Frame({ size: 1536 }), ac3Frame({ size: 1536 })),
      ])
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]!.data).toHaveLength(1536);
    expect(demuxer.tracks[0]).toMatchObject({
      entry: 'ac-3',
      sampleRate: 48000,
      channels: 6,
    });
  });

  test('E-AC-3 dependent substreams join the frame before them', () => {
    const independent = eac3Frame({ size: 64, strmtyp: 0 });
    const dependent = eac3Frame({ size: 32, strmtyp: 1 });
    const { frames, demuxer } = demuxTs(
      join([
        ...tables([{ type: 0x87, pid: AUDIO_PID }]),
        ...audioPes(9000, independent, dependent, eac3Frame({ size: 64 })),
        ...audioPes(18000, eac3Frame({ size: 64 })),
      ])
    );
    expect(frames.map((f) => [f.pts, f.data.length])).toEqual([
      [9000, 96],
      [null, 64],
      [18000, 64],
    ]);
    expect(demuxer.tracks[0]).toMatchObject({ entry: 'ec-3', codec: 'ec-3' });
  });

  test('a dependent frame with nothing before it starts a frame of its own', () => {
    const { frames } = demuxTs(
      join([
        ...tables([{ type: 0x87, pid: AUDIO_PID }]),
        ...audioPes(9000, eac3Frame({ size: 32, strmtyp: 1 })),
      ])
    );
    expect(frames).toHaveLength(1);
  });

  test('a private stream says what it carries in its first PES', () => {
    const private06 = (frame: Uint8Array) =>
      demuxTs(
        join([
          ...tables([{ type: 0x06, pid: AUDIO_PID }]),
          ...audioPes(9000, frame),
        ])
      );
    expect(private06(adtsFrame()).demuxer.tracks[0]!.codec).toBe('mp4a.40.2');
    expect(private06(ac3Frame()).demuxer.tracks[0]!.entry).toBe('ac-3');
    expect(private06(mp3Frame()).demuxer.tracks[0]!.codec).toBe('mp4a.6B');
    expect(private06(new Uint8Array(40)).demuxer.tracks[0]!.unsupported).toBe(
      'unknown private stream'
    );
  });

  test('a private stream of Layer II is unknown', () => {
    const layer2 = mp3Frame();
    layer2[1] = (layer2[1]! & ~0x06) | (2 << 1);
    const { demuxer } = demuxTs(
      join([
        ...tables([{ type: 0x06, pid: AUDIO_PID }]),
        ...audioPes(9000, layer2),
      ])
    );
    expect(demuxer.tracks[0]!.unsupported).toBe('unknown private stream');
  });
});

describe('MPEG-TS: lastTimestamp', () => {
  const stream = join([
    ...tables([H264, AAC]),
    ...videoAu(9000, true),
    ...audioPes(10000, adtsFrame()),
    ...videoAu(12600, false),
    ...audioPes(11000, adtsFrame()),
  ]);

  test('is the last PTS of the tail, of any PID or of one', () => {
    expect(lastTimestamp(stream, null)).toBe(11000);
    expect(lastTimestamp(stream, VIDEO_PID)).toBe(12600);
    expect(lastTimestamp(stream, 0x999)).toBeNull();
  });

  test('is null without packets or a PES start', () => {
    expect(lastTimestamp(new Uint8Array(100), null)).toBeNull();
    expect(lastTimestamp(join(tables([H264])), VIDEO_PID)).toBeNull();
  });

  test('skips PES without a PTS, packets with no payload, and non-PES starts', () => {
    const noPts = pesPackets(
      AUDIO_PID,
      pesPacket(0xc0, null, adtsFrame(), true)
    );
    const notPes = tsPacket(AUDIO_PID, new Uint8Array(30).fill(2), {
      start: true,
    });
    const noPayload = tsPacket(AUDIO_PID, new Uint8Array(0), {
      start: true,
      adaptation: new Uint8Array(0),
    });
    noPayload[3] = 0x20;
    noPayload[4] = 183;
    const tail = join([
      ...audioPes(7000, adtsFrame()),
      ...noPts,
      notPes,
      noPayload,
    ]);
    expect(lastTimestamp(concat(tail, tail, tail), null)).toBe(7000);
  });

  test('reads packets after an adaptation field', () => {
    const packet = tsPacket(
      AUDIO_PID,
      pesPacket(0xc0, 7777, adtsFrame(), true),
      {
        start: true,
        adaptation: Uint8Array.of(0x10, 0, 1, 2, 3, 4, 5),
      }
    );
    expect(
      lastTimestamp(join([packet, packet, packet, packet]), AUDIO_PID)
    ).toBe(7777);
  });

  test('reads M2TS tails', () => {
    const packets = [
      ...audioPes(5555, adtsFrame()),
      ...audioPes(6666, adtsFrame()),
      ...audioPes(7777, adtsFrame()),
    ];
    const m2ts = join(packets.map((p) => concat(bytes(0, 0, 0, 0), p)));
    expect(lastTimestamp(m2ts, null)).toBe(7777);
  });
});
