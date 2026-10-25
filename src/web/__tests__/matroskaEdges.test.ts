/* eslint-disable no-bitwise -- EBML lacing sizes and block headers are bit fields. */
// The Matroska demuxer's edges: track tables, codecs, lacing, content
// encodings, cues, unknown sizes and truncated or corrupt files — files built
// here byte by byte, or cut from conformance/remux/.

import { avcConfig, hevcConfig, opusConfig } from '../remux/codecs';
import { MatroskaDemuxer, delace, utf8 } from '../remux/Matroska';
import { type DemuxFrame } from '../remux/types';
import { concat } from './audioFixtures';
import {
  AVC_CONFIG,
  AVC_PPS,
  HEVC_PPS,
  HEVC_VPS,
  MKV,
  ac3Frame,
  audio,
  avcSps,
  blockBytes,
  blockGroup,
  bytes,
  cluster,
  demuxMkv,
  eac3Frame,
  el,
  floatEl,
  hevcSps,
  hex,
  infoEl,
  mkv,
  read,
  simpleBlock,
  strEl,
  trackEntry,
  trackOf,
  tracksEl,
  uintEl,
  video,
  vp9Frame,
  type TrackSpec,
} from './remuxFixtures';

describe('Matroska: the Info element', () => {
  test('reads the doc type, duration and a millisecond clock', () => {
    const { demuxer } = demuxMkv(
      mkv([infoEl([floatEl(MKV.Duration, 2500)]), tracksEl(video())])
    );
    expect(demuxer.docType).toBe('matroska');
    expect(demuxer.duration).toBe(2500);
    expect(demuxer.clock).toBe(1000);
  });

  test.each([
    [1_000_000, 4, 1000],
    [500_000, 8, 2000],
    [1000, 8, 1_000_000],
    [3, 4, 1_000_000_000],
  ])(
    'a TimestampScale of %d gives a clock of %d per second',
    (scale, bytesOfFloat, clock) => {
      const { demuxer } = demuxMkv(
        mkv([
          infoEl([
            uintEl(MKV.TimestampScale, scale, 4),
            floatEl(MKV.Duration, 1000, bytesOfFloat as 4 | 8),
          ]),
        ])
      );
      expect(demuxer.clock).toBe(clock);
      expect(demuxer.duration).toBe(Math.round((1000 * scale) / 1_000_000));
    }
  );

  test('a zero TimestampScale is the default one', () => {
    const { demuxer } = demuxMkv(
      mkv([infoEl([uintEl(MKV.TimestampScale, 0)])])
    );
    expect(demuxer.clock).toBe(1000);
  });

  test.each([
    ['a zero duration', floatEl(MKV.Duration, 0)],
    ['a negative one', floatEl(MKV.Duration, -5)],
    ['an infinite one', floatEl(MKV.Duration, Infinity)],
    ['one of an odd size', el(MKV.Duration, bytes(1, 2, 3))],
  ])('%s is no duration', (_, duration) => {
    const { demuxer } = demuxMkv(mkv([infoEl([duration])]));
    expect(demuxer.duration).toBeNull();
  });

  test('a file without an Info element has no duration', () => {
    expect(demuxMkv(mkv([tracksEl(video())])).demuxer.duration).toBeNull();
  });
});

describe('Matroska: track entries', () => {
  test('reads the names, flags and languages', () => {
    const track = trackOf(
      audio({ name: 'Director', language: 'por', default: false, forced: true })
    );
    expect(track).toMatchObject({
      id: 2,
      kind: 'audio',
      name: 'Director',
      language: 'por',
      default: false,
      forced: true,
    });
  });

  test('a BCP 47 language wins over the ISO one; the default is English', () => {
    expect(
      trackOf(audio({ language: 'por', languageBcp47: 'pt-BR' })).language
    ).toBe('pt-BR');
    expect(trackOf(audio()).language).toBe('eng');
    expect(trackOf(audio()).default).toBe(true);
    expect(trackOf(audio()).forced).toBe(false);
  });

  test('skips entries without a number or of a kind it does not mux', () => {
    const { demuxer } = demuxMkv(
      mkv([
        tracksEl(
          video({ number: 0 }),
          { number: 5, type: 3, codec: 'V_X' },
          { number: 6, type: 33, codec: 'S_X' },
          audio()
        ),
      ])
    );
    expect(demuxer.tracks.map((t) => t.id)).toEqual([2]);
  });

  test('a second Tracks element changes nothing', () => {
    const { demuxer } = demuxMkv(mkv([tracksEl(video()), tracksEl(audio())]));
    expect(demuxer.tracks.map((t) => t.id)).toEqual([1]);
    expect(demuxer.tracksKnown).toBe(true);
  });

  test('a disabled track is unsupported', () => {
    expect(trackOf(audio({ enabled: false })).unsupported).toBe('disabled');
  });

  test('the first of two fields of the same ID counts', () => {
    const entry = el(MKV.TrackEntry, [
      uintEl(MKV.TrackNumber, 4),
      uintEl(MKV.TrackNumber, 9),
      uintEl(MKV.TrackType, 2),
      strEl(MKV.CodecID, 'A_MPEG/L3'),
    ]);
    const { demuxer } = demuxMkv(mkv([el(MKV.Tracks, [entry])]));
    expect(demuxer.tracks.map((t) => t.id)).toEqual([4]);
  });

  test('a missing codec is "no codec"', () => {
    expect(trackOf({ number: 1, type: 2 }).unsupported).toBe('no codec');
  });
});

describe('Matroska: picture sizes', () => {
  test.each([
    [
      { width: 720, height: 480, displayWidth: 853, displayHeight: 480 },
      853,
      720,
    ],
    [
      { width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080 },
      1,
      1,
    ],
    [
      {
        width: 720,
        height: 480,
        displayWidth: 16,
        displayHeight: 9,
        displayUnit: 3,
      },
      1,
      1,
    ],
    [{ width: 720, height: 480 }, 1, 1],
    [{ width: 720, height: 480, displayWidth: 640, displayHeight: 0 }, 1, 1],
    [{ displayWidth: 640, displayHeight: 480 }, 1, 1],
  ])(
    'the display size %j gives a pixel aspect of %d:%d',
    (size, sarWidth, sarHeight) => {
      const track = trackOf(
        video({ codecPrivate: undefined, codec: 'V_VP9', video: size })
      );
      expect([track.sarWidth, track.sarHeight]).toEqual([sarWidth, sarHeight]);
    }
  );

  test("the SPS's aspect ratio fills in when the track gives none", () => {
    const wide = avcConfig([avcSps({ sar: [32, 27] })], [AVC_PPS]);
    const track = trackOf(video({ codecPrivate: wide, video: {} }));
    expect([
      track.width,
      track.height,
      track.sarWidth,
      track.sarHeight,
    ]).toEqual([640, 480, 32, 27]);
  });

  test("a track's own aspect ratio wins over the SPS's", () => {
    const wide = avcConfig([avcSps({ sar: [4, 3] })], [AVC_PPS]);
    const track = trackOf(
      video({
        codecPrivate: wide,
        video: { width: 720, height: 480, displayWidth: 16, displayHeight: 9 },
      })
    );
    expect([track.sarWidth, track.sarHeight]).toEqual([32, 27]);
  });
});

describe('Matroska: video codecs', () => {
  test('AVC takes its avcC, codec string and picture from the CodecPrivate', () => {
    expect(trackOf(video())).toMatchObject({
      kind: 'video',
      entry: 'avc1',
      codec: 'avc1.42001E',
      width: 640,
      height: 480,
      unsupported: null,
    });
  });

  test.each([
    [
      'AVC without a CodecPrivate',
      video({ codecPrivate: undefined }),
      'V_MPEG4/ISO/AVC',
    ],
    [
      'AVC with a CodecPrivate of 6 bytes',
      video({ codecPrivate: new Uint8Array(6) }),
      'V_MPEG4/ISO/AVC',
    ],
    [
      'HEVC without a CodecPrivate',
      video({ codec: 'V_MPEGH/ISO/HEVC', codecPrivate: undefined }),
      'V_MPEGH/ISO/HEVC',
    ],
    [
      'HEVC with a short CodecPrivate',
      video({ codec: 'V_MPEGH/ISO/HEVC', codecPrivate: new Uint8Array(22) }),
      'V_MPEGH/ISO/HEVC',
    ],
    [
      'AV1 without a CodecPrivate',
      video({ codec: 'V_AV1', codecPrivate: undefined }),
      'V_AV1',
    ],
    [
      'AV1 with a short CodecPrivate',
      video({ codec: 'V_AV1', codecPrivate: new Uint8Array(3) }),
      'V_AV1',
    ],
    ['MPEG-4 Visual', video({ codec: 'V_MS/VFW/FOURCC' }), 'V_MS/VFW/FOURCC'],
    ['an unknown V_ codec', video({ codec: 'V_THEORA' }), 'V_THEORA'],
  ])('%s is unsupported as %s', (_, spec, reason) => {
    expect(trackOf(spec).unsupported).toBe(reason);
  });

  test('an AVC CodecPrivate with no SPS still gives its codec string', () => {
    const bare = AVC_CONFIG.slice(0, 8);
    bare[5] = 0xe0;
    const track = trackOf(
      video({ codecPrivate: bare, video: { width: 100, height: 50 } })
    );
    expect([track.entry, track.width, track.height]).toEqual(['avc1', 100, 50]);
  });

  test('HEVC takes its hvcC, codec string and picture', () => {
    const hvcC = hevcConfig(
      [HEVC_VPS],
      [hevcSps({ width: 1280, height: 720 })],
      [HEVC_PPS]
    );
    expect(
      trackOf(
        video({ codec: 'V_MPEGH/ISO/HEVC', codecPrivate: hvcC, video: {} })
      )
    ).toMatchObject({
      entry: 'hvc1',
      codec: 'hvc1.1.6.L93.90',
      width: 1280,
      height: 720,
    });
  });

  test('HEVC with an hvcC that has no SPS keeps the size the track says', () => {
    const hvcC = new Uint8Array(40);
    hvcC[12] = 90;
    const track = trackOf(
      video({ codec: 'V_MPEGH/ISO/HEVC', codecPrivate: hvcC })
    );
    expect([track.entry, track.width, track.height]).toEqual([
      'hvc1',
      640,
      480,
    ]);
  });

  test('AV1 takes its av1C', () => {
    const track = trackOf(
      video({ codec: 'V_AV1', codecPrivate: bytes(0x81, 0x08, 0x0c, 0) })
    );
    expect(track).toMatchObject({ entry: 'av01', codec: 'av01.0.08M.08' });
  });

  test('VP9 waits for a frame to say its codec string', () => {
    const track = trackOf(video({ codec: 'V_VP9', codecPrivate: undefined }));
    expect(track).toMatchObject({
      entry: 'vp09',
      codec: null,
      config: null,
      unsupported: null,
    });
  });

  test('VP8 has a fixed configuration, its level from the picture size', () => {
    expect(
      trackOf(
        video({
          codec: 'V_VP8',
          codecPrivate: undefined,
          video: { width: 1280, height: 720 },
        })
      )
    ).toMatchObject({
      entry: 'vp08',
      codec: 'vp08.00.31.08',
    });
    expect(
      trackOf(video({ codec: 'V_VP8', codecPrivate: undefined, video: {} }))
        .codec
    ).toBe('vp08.00.10.08');
  });

  test('a DefaultDuration gives the frame duration in clock units', () => {
    const { demuxer } = demuxMkv(
      mkv([tracksEl(video({ defaultDurationNs: 40_000_000 }))])
    );
    expect(demuxer.frameDuration(1)).toBe(40);
    expect(demuxer.frameDuration(1)).toBe(40);
    expect(demuxer.frameDuration(7)).toBeNull();
  });

  test('no DefaultDuration, no frame duration', () => {
    expect(
      demuxMkv(mkv([tracksEl(video())])).demuxer.frameDuration(1)
    ).toBeNull();
  });
});

describe('Matroska: audio codecs', () => {
  const OPUS_HEAD = concat(
    Uint8Array.from(Buffer.from('OpusHead')),
    bytes(1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0)
  );

  test.each([
    ['A_AAC', 2],
    ['A_AAC/MPEG4/LC', 2],
    ['A_AAC/MPEG2/MAIN', 1],
    ['A_AAC/MPEG4/SSR', 3],
    ['A_AAC/MPEG4/LTP', 4],
    ['A_AAC/MPEG2/LC/SBR', 2],
  ])(
    '%s without a CodecPrivate makes an AudioSpecificConfig of type %d',
    (codec, type) => {
      const track = trackOf(audio({ codec }));
      expect(track).toMatchObject({
        entry: 'mp4a',
        objectType: 0x40,
        codec: `mp4a.40.${type}`,
        sampleRate: 44100,
        channels: 2,
        timescale: 44100,
      });
      expect(track.config).toHaveLength(2);
    }
  );

  test("AAC takes the CodecPrivate's rate and channels over the track's", () => {
    const track = trackOf(
      audio({
        codecPrivate: bytes(0x11, 0x90),
        audio: { rate: 8000, channels: 1 },
      })
    );
    expect(track).toMatchObject({
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      channels: 2,
      timescale: 48000,
    });
  });

  test("AAC keeps the track's channels when its config says zero", () => {
    const track = trackOf(
      audio({
        codecPrivate: bytes(0x12, 0x00),
        audio: { rate: 44100, channels: 6 },
      })
    );
    expect(track.channels).toBe(6);
  });

  test('AAC without an Audio element is 8 kHz mono', () => {
    const track = trackOf(audio({ audio: undefined }));
    expect([track.sampleRate, track.channels, track.codec]).toEqual([
      8000,
      1,
      'mp4a.40.2',
    ]);
  });

  test('a CodecPrivate of one byte is ignored', () => {
    expect(trackOf(audio({ codecPrivate: bytes(0x12) })).sampleRate).toBe(
      44100
    );
  });

  test('AAC with no rate at all is unsupported', () => {
    expect(
      trackOf(audio({ audio: { rate: 0, channels: 2 } })).unsupported
    ).toBe('AAC without a sample rate');
    expect(
      trackOf(audio({ codecPrivate: bytes(0x16, 0x90) })).unsupported
    ).toBe('AAC without a sample rate');
  });

  test('MP3 is an esds object type 0x6B', () => {
    expect(trackOf(audio({ codec: 'A_MPEG/L3' }))).toMatchObject({
      entry: 'mp4a',
      objectType: 0x6b,
      codec: 'mp4a.6B',
    });
  });

  test.each([
    ['A_AC3', 'ac-3'],
    ['A_EAC3', 'ec-3'],
  ])('%s is %s, its configuration waiting for a frame', (codec, entry) => {
    expect(trackOf(audio({ codec }))).toMatchObject({
      entry,
      codec: null,
      config: null,
      unsupported: null,
    });
  });

  test('Opus reads its OpusHead', () => {
    const track = trackOf(
      audio({
        codec: 'A_OPUS',
        codecPrivate: OPUS_HEAD,
        audio: { rate: 48000, channels: 6 },
      })
    );
    expect(track).toMatchObject({
      entry: 'Opus',
      codec: 'opus',
      channels: 2,
      sampleRate: 48000,
      timescale: 48000,
    });
    expect(hex(track.config!)).toBe(hex(opusConfig(OPUS_HEAD)!.config));
  });

  test.each([
    ['Opus without a CodecPrivate', audio({ codec: 'A_OPUS' }), 'A_OPUS'],
    [
      'Opus with something else',
      audio({ codec: 'A_OPUS', codecPrivate: bytes(1, 2, 3) }),
      'A_OPUS',
    ],
    ['FLAC without a CodecPrivate', audio({ codec: 'A_FLAC' }), 'A_FLAC'],
    [
      'FLAC without a STREAMINFO',
      audio({ codec: 'A_FLAC', codecPrivate: bytes(0x66, 0x4c, 0x61, 0x43) }),
      'A_FLAC',
    ],
    [
      'Vorbis',
      audio({ codec: 'A_VORBIS', codecPrivate: bytes(2, 3, 4) }),
      'A_VORBIS',
    ],
    ['DTS', audio({ codec: 'A_DTS' }), 'A_DTS'],
    ['PCM', audio({ codec: 'A_PCM/INT/LIT' }), 'A_PCM/INT/LIT'],
  ])('%s is unsupported as %s', (_, spec, reason) => {
    expect(trackOf(spec).unsupported).toBe(reason);
  });

  test('FLAC reads its STREAMINFO', () => {
    const info = new Uint8Array(34);
    info[10] = 0x0a;
    info[11] = 0xc4;
    info[12] = 0x42; // 44100 Hz, 2 channels
    const flac = concat(bytes(0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34), info);
    expect(
      trackOf(audio({ codec: 'A_FLAC', codecPrivate: flac }))
    ).toMatchObject({
      entry: 'fLaC',
      codec: 'flac',
      sampleRate: 44100,
      channels: 2,
      timescale: 44100,
    });
  });
});

describe('Matroska: text tracks', () => {
  test.each([
    ['S_TEXT/UTF8', 'srt'],
    ['S_TEXT/ASCII', 'srt'],
    ['S_TEXT/ASS', 'ass'],
    ['S_TEXT/SSA', 'ass'],
    ['S_ASS', 'ass'],
    ['S_SSA', 'ass'],
    ['S_TEXT/WEBVTT', 'vtt'],
  ])('%s is %s', (codec, kind) => {
    expect(trackOf({ number: 3, type: 17, codec })).toMatchObject({
      kind: 'text',
      codec: kind,
      unsupported: null,
    });
  });

  test.each(['S_VOBSUB', 'S_HDMV/PGS', 'S_TEXT/USF'])(
    '%s is unsupported',
    (codec) => {
      expect(trackOf({ number: 3, type: 17, codec }).unsupported).toBe(codec);
    }
  );

  test('an ASS track keeps its script header, without trailing NULs', () => {
    const header = new TextEncoder().encode('[Script Info]\nTitle: x\n');
    const track = trackOf({
      number: 3,
      type: 17,
      codec: 'S_TEXT/ASS',
      codecPrivate: concat(header, bytes(0, 0)),
    });
    expect(track.header).toBe('[Script Info]\nTitle: x\n');
  });

  test('only an ASS track has a header', () => {
    const track = trackOf({
      number: 3,
      type: 17,
      codec: 'S_TEXT/UTF8',
      codecPrivate: bytes(65),
    });
    expect(track.header).toBeNull();
  });

  test('cues come with their times and an end only when the block has a duration', () => {
    const text = (s: string) => new TextEncoder().encode(s);
    const { cues } = demuxMkv(
      mkv([
        infoEl(),
        tracksEl({ number: 3, type: 17, codec: 'S_TEXT/UTF8' }),
        cluster(1000, [
          simpleBlock(3, 500, text('first')),
          blockGroup(3, 2000, text('second'), { duration: 1500 }),
          simpleBlock(3, -2000, text('before the cluster')),
        ]),
      ])
    );
    expect(cues).toEqual([
      { track: 3, start: 1500, end: null, text: 'first' },
      { track: 3, start: 3000, end: 4500, text: 'second' },
      { track: 3, start: 0, end: null, text: 'before the cluster' },
    ]);
  });

  test("laced cues share the block's time", () => {
    const { cues } = demuxMkv(
      mkv([
        tracksEl({ number: 3, type: 17, codec: 'S_TEXT/UTF8' }),
        cluster(0, [
          el(
            MKV.SimpleBlock,
            blockBytes(3, 10, 0x80 | 0x02, bytes(1, 1, 0x61, 0x62, 0x63))
          ),
        ]),
      ])
    );
    expect(cues.map((c) => [c.start, c.text])).toEqual([
      [10, 'a'],
      [10, 'bc'],
    ]);
  });

  test('utf8 drops trailing NULs and decodes multi-byte text', () => {
    expect(utf8(bytes(0xc3, 0xa9, 0, 0))).toBe('é');
    expect(utf8(new Uint8Array(0))).toBe('');
  });
});

describe('Matroska: content encodings', () => {
  const encoding = (...children: Uint8Array[]) =>
    el(MKV.ContentEncoding, children);

  test('encryption makes the track unsupported', () => {
    const track = trackOf(
      audio({
        codec: 'A_MPEG/L3',
        encodings: [encoding(el(MKV.ContentEncryption))],
      })
    );
    expect(track.unsupported).toBe('encrypted');
  });

  test.each([
    ['zlib', [uintEl(MKV.ContentCompAlgo, 0)]],
    ['bzlib', [uintEl(MKV.ContentCompAlgo, 1)]],
    ['no algorithm', []],
  ])('compression by %s makes the track unsupported', (_, algo) => {
    const track = trackOf(
      audio({
        codec: 'A_MPEG/L3',
        encodings: [encoding(el(MKV.ContentCompression, algo))],
      })
    );
    expect(track.unsupported).toBe('compressed');
  });

  test('header stripping puts the removed bytes back in front of every frame', () => {
    const compression = el(MKV.ContentCompression, [
      uintEl(MKV.ContentCompAlgo, 3),
      el(MKV.ContentCompSettings, bytes(0xff, 0xfb)),
    ]);
    const { frames } = demuxMkv(
      mkv([
        tracksEl(
          audio({ codec: 'A_MPEG/L3', encodings: [encoding(compression)] })
        ),
        cluster(0, [
          simpleBlock(2, 0, bytes(1, 2, 3)),
          simpleBlock(2, 26, bytes(4)),
        ]),
      ])
    );
    expect(frames.map((f) => hex(f.data))).toEqual(['fffb010203', 'fffb04']);
  });

  test('header stripping without settings strips nothing', () => {
    const compression = el(MKV.ContentCompression, [
      uintEl(MKV.ContentCompAlgo, 3),
    ]);
    const { frames } = demuxMkv(
      mkv([
        tracksEl(
          audio({ codec: 'A_MPEG/L3', encodings: [encoding(compression)] })
        ),
        cluster(0, [simpleBlock(2, 0, bytes(7, 8))]),
      ])
    );
    expect(frames.map((f) => hex(f.data))).toEqual(['0708']);
  });
});

describe('Matroska: blocks', () => {
  const base = (...children: Uint8Array[]) =>
    mkv([
      infoEl(),
      tracksEl(
        video({ defaultDurationNs: 40_000_000 }),
        audio({ codec: 'A_MPEG/L3' })
      ),
      ...children,
    ]);

  test('a SimpleBlock is a frame at the cluster time plus its offset, keyed by its flag', () => {
    const { frames } = demuxMkv(
      base(
        cluster(1000, [
          simpleBlock(1, 0, bytes(1), 0x80),
          simpleBlock(1, 40, bytes(2), 0x00),
        ])
      )
    );
    expect(frames).toEqual([
      { track: 1, pts: 1000, key: true, data: bytes(1) },
      { track: 1, pts: 1040, key: false, data: bytes(2) },
    ]);
  });

  test('a BlockGroup is a keyframe unless it references another frame', () => {
    const { frames } = demuxMkv(
      base(
        cluster(0, [
          blockGroup(1, 0, bytes(1)),
          blockGroup(1, 40, bytes(2), { reference: true }),
        ])
      )
    );
    expect(frames.map((f) => [f.pts, f.key])).toEqual([
      [0, true],
      [40, false],
    ]);
  });

  test('a time before zero is zero', () => {
    const { frames } = demuxMkv(
      base(cluster(0, [simpleBlock(1, -30, bytes(1))]))
    );
    expect(frames[0]!.pts).toBe(0);
  });

  test('the 16-bit offset is signed', () => {
    const { frames } = demuxMkv(
      base(cluster(100, [simpleBlock(1, -30, bytes(1))]))
    );
    expect(frames[0]!.pts).toBe(70);
  });

  test('blocks of unknown, unsupported or too-short tracks are ignored', () => {
    const { frames } = demuxMkv(
      mkv([
        tracksEl(video(), audio({ codec: 'A_DTS' })),
        cluster(0, [
          simpleBlock(9, 0, bytes(1)),
          simpleBlock(2, 0, bytes(2)),
          el(MKV.SimpleBlock, bytes(0x81, 0, 0)),
          simpleBlock(1, 0, bytes(3)),
        ]),
      ])
    );
    expect(frames.map((f) => f.data[0])).toEqual([3]);
  });

  test('a Block outside a BlockGroup is dropped', () => {
    const { frames } = demuxMkv(
      base(cluster(0, [el(MKV.Block, blockBytes(1, 0, 0, bytes(1)))]))
    );
    expect(frames).toEqual([]);
  });

  test('a BlockGroup without a Block gives nothing', () => {
    const { frames } = demuxMkv(
      base(cluster(0, [el(MKV.BlockGroup, [uintEl(MKV.BlockDuration, 5)])]))
    );
    expect(frames).toEqual([]);
  });

  test('a duration or reference outside a BlockGroup is ignored', () => {
    const { frames } = demuxMkv(
      base(
        cluster(0, [
          uintEl(MKV.BlockDuration, 5),
          el(MKV.ReferenceBlock, bytes(1)),
          simpleBlock(1, 0, bytes(1)),
        ])
      )
    );
    expect(frames).toHaveLength(1);
  });

  test('laced video follows its DefaultDuration, laced audio is timed by the remuxer', () => {
    const { frames } = demuxMkv(
      base(
        cluster(0, [
          el(
            MKV.SimpleBlock,
            blockBytes(1, 0, 0x80 | 0x04, bytes(2, 0xa, 0xb, 0xc))
          ),
          el(
            MKV.SimpleBlock,
            blockBytes(2, 100, 0x80 | 0x04, bytes(1, 0xd, 0xe))
          ),
        ])
      )
    );
    expect(frames.map((f) => [f.track, f.pts, hex(f.data)])).toEqual([
      [1, 0, '0a'],
      [1, 40, '0b'],
      [1, 80, '0c'],
      [2, 100, '0d'],
      [2, null, '0e'],
    ]);
  });

  test('laced video without a DefaultDuration has no times after the first', () => {
    const { frames } = demuxMkv(
      mkv([
        tracksEl(video()),
        cluster(0, [
          el(MKV.SimpleBlock, blockBytes(1, 0, 0x80 | 0x04, bytes(1, 1, 2))),
        ]),
      ])
    );
    expect(frames.map((f) => f.pts)).toEqual([0, null]);
  });

  test('a laced block that does not add up is dropped', () => {
    const { frames } = demuxMkv(
      base(
        cluster(0, [
          el(MKV.SimpleBlock, blockBytes(1, 0, 0x80 | 0x04, bytes(2, 1, 2))),
        ])
      )
    );
    expect(frames).toEqual([]);
  });

  test('with a TimestampScale of 1 ms a time is in clock units', () => {
    const { frames, demuxer } = demuxMkv(
      mkv([
        infoEl([uintEl(MKV.TimestampScale, 3)]),
        tracksEl(video()),
        cluster(7, [simpleBlock(1, 1, bytes(1))]),
      ])
    );
    expect(demuxer.clock).toBe(1_000_000_000);
    expect(frames[0]!.pts).toBe(8 * 3);
  });
});

describe('Matroska: delace', () => {
  const block = (...values: number[]) => bytes(...values);

  test('a block without lacing is one frame from the offset on', () => {
    expect(delace(block(9, 9, 1, 2, 3), 2, 0)!.map(hex)).toEqual(['010203']);
  });

  test('Xiph lacing reads sizes as runs of 255', () => {
    const big = new Uint8Array(300).fill(7);
    const data = concat(bytes(2, 255, 45, 2), big, bytes(1, 2), bytes(9));
    const frames = delace(data, 0, 1)!;
    expect(frames.map((f) => f.length)).toEqual([300, 2, 1]);
  });

  test('EBML lacing reads the first size and then signed differences', () => {
    // sizes 3, 2 (delta -1: 0xbf - 0xbf... 1-byte vint: value 62 = 63 - 1), then the rest
    const data = concat(
      bytes(2, 0x83, 0xbe),
      bytes(1, 1, 1),
      bytes(2, 2),
      bytes(3, 3, 3, 3)
    );
    expect(delace(data, 0, 3)!.map((f) => f.length)).toEqual([3, 2, 4]);
  });

  test('fixed lacing divides the rest evenly', () => {
    expect(delace(bytes(2, 1, 2, 3, 4, 5, 6), 0, 2)!.map(hex)).toEqual([
      '0102',
      '0304',
      '0506',
    ]);
  });

  test.each([
    ['Xiph', 1, bytes(2, 255)],
    ['fixed, uneven', 2, bytes(1, 1, 2, 3)],
    ['EBML, without a first size', 3, bytes(2)],
    ['EBML, with a size cut', 3, bytes(3, 0x81)],
    ['EBML, with a negative size', 3, bytes(3, 0x81, 0xc0, 1, 2)],
    ['Xiph, with sizes past the data', 1, bytes(1, 9, 1)],
  ])('%s lacing that is malformed gives nothing', (_, lacing, data) => {
    expect(delace(data, 0, lacing)).toBeNull();
  });

  test('a laced block with no count byte gives nothing', () => {
    expect(delace(bytes(1), 1, 1)).toBeNull();
  });
});

describe('Matroska: structure', () => {
  const tracksAndClusters = (...clusters: Uint8Array[]) => [
    infoEl([floatEl(MKV.Duration, 3000)]),
    tracksEl(video({ defaultDurationNs: 40_000_000 })),
    ...clusters,
  ];
  const keyed = (n: number) => simpleBlock(1, 0, bytes(n));

  test('chunk size does not change what is read', () => {
    const data = mkv(
      tracksAndClusters(
        cluster(0, [keyed(1), keyed(2)]),
        cluster(1000, [keyed(3)])
      )
    );
    const whole = demuxMkv(data);
    for (const size of [1, 3, 17]) {
      const other = demuxMkv(data, size);
      expect(other.frames).toEqual(whole.frames);
      expect(other.demuxer.tracks).toEqual(whole.demuxer.tracks);
    }
    expect(whole.frames.map((f) => f.data[0])).toEqual([1, 2, 3]);
  });

  test('a segment and clusters of unknown size stream the same', () => {
    const known = mkv(
      tracksAndClusters(cluster(0, [keyed(1)]), cluster(1000, [keyed(2)]))
    );
    const live = mkv(
      tracksAndClusters(
        cluster(0, [keyed(1)], 'unknown'),
        cluster(1000, [keyed(2)], 'unknown')
      ),
      true
    );
    for (const size of [live.length, 1, 5]) {
      expect(demuxMkv(live, size).frames).toEqual(demuxMkv(known).frames);
    }
  });

  test('an unknown-size cluster ends at the top-level element that follows it', () => {
    const tags = el(MKV.Tags, [el(MKV.Void, new Uint8Array(4))]);
    const { frames, demuxer } = demuxMkv(
      mkv(
        [
          ...tracksAndClusters(cluster(0, [keyed(1)], 'unknown'), tags),
          cluster(500, [keyed(2)]),
        ],
        true
      )
    );
    expect(frames.map((f) => [f.pts, f.data[0]])).toEqual([
      [0, 1],
      [500, 2],
    ]);
    expect(demuxer.firstCluster).not.toBeNull();
  });

  test('elements it does not read are skipped across chunks', () => {
    const attachments = el(0x1941a469, [new Uint8Array(500).fill(9)]);
    const data = mkv([
      ...tracksAndClusters(),
      attachments,
      el(MKV.Tags, new Uint8Array(40)),
      el(MKV.Void, new Uint8Array(30)),
      cluster(0, [keyed(1)]),
    ]);
    expect(demuxMkv(data, 7).frames).toHaveLength(1);
  });

  test('reads the cues position from the SeekHead', () => {
    const seekHead = el(MKV.SeekHead, [
      el(MKV.Seek, [
        uintEl(MKV.SeekID, MKV.Info, 4),
        uintEl(MKV.SeekPosition, 1, 4),
      ]),
      el(MKV.Seek, [
        uintEl(MKV.SeekID, MKV.Cues, 4),
        uintEl(MKV.SeekPosition, 12345, 4),
      ]),
      el(MKV.Seek, [uintEl(MKV.SeekPosition, 9, 4)]),
    ]);
    const { demuxer } = demuxMkv(mkv([seekHead, ...tracksAndClusters()]));
    expect(demuxer.cuesOffset).toBe(demuxer.segmentStart! + 12345);
  });

  test('a SeekHead before the Segment is known has no cues position', () => {
    const demuxer = new MatroskaDemuxer();
    const sink = { frame: jest.fn(), cue: jest.fn() };
    demuxer.push(
      el(MKV.SeekHead, [
        el(MKV.Seek, [
          uintEl(MKV.SeekID, MKV.Cues, 4),
          uintEl(MKV.SeekPosition, 5, 4),
        ]),
      ]),
      sink
    );
    expect(demuxer.cuesOffset).toBeNull();
  });

  describe('cues', () => {
    const cuePoint = (
      time: number,
      ...positions: Array<[number | null, number]>
    ) =>
      el(MKV.CuePoint, [
        uintEl(MKV.CueTime, time),
        ...positions.map(([track, position]) =>
          el(MKV.CueTrackPositions, [
            ...(track == null ? [] : [uintEl(MKV.CueTrack, track)]),
            uintEl(MKV.CueClusterPosition, position, 4),
          ])
        ),
      ]);
    const cuesEl = (...points: Uint8Array[]) => el(MKV.Cues, points);

    test('are sorted and deduplicated by cluster, on the video track', () => {
      const { demuxer } = demuxMkv(
        mkv([
          ...tracksAndClusters(),
          cuesEl(
            cuePoint(2000, [1, 300]),
            cuePoint(0, [1, 100]),
            cuePoint(500, [2, 150], [1, 100]),
            cuePoint(1000, [1, 200])
          ),
        ])
      );
      const start = demuxer.segmentStart!;
      expect(demuxer.cues).toEqual([
        { time: 0, offset: start + 100 },
        { time: 1000, offset: start + 200 },
        { time: 2000, offset: start + 300 },
      ]);
    });

    test('a cue point without a time is at zero', () => {
      const { demuxer } = demuxMkv(
        mkv([
          ...tracksAndClusters(),
          cuesEl(
            el(MKV.CuePoint, [
              el(MKV.CueTrackPositions, [
                uintEl(MKV.CueTrack, 1),
                uintEl(MKV.CueClusterPosition, 50, 4),
              ]),
            ])
          ),
        ])
      );
      expect(demuxer.cues).toEqual([
        { time: 0, offset: demuxer.segmentStart! + 50 },
      ]);
    });

    test("a position without a track is not the video track's", () => {
      const { demuxer } = demuxMkv(
        mkv([...tracksAndClusters(), cuesEl(cuePoint(0, [null, 50]))])
      );
      expect(demuxer.cues).toEqual([]);
    });

    test("a cue point with no position, or only another track's, is left out", () => {
      const { demuxer } = demuxMkv(
        mkv([
          ...tracksAndClusters(),
          cuesEl(
            el(MKV.CuePoint, [uintEl(MKV.CueTime, 5)]),
            cuePoint(10, [2, 80]),
            el(MKV.CuePoint, [uintEl(MKV.CueTime, 20), el(MKV.Void, bytes(1))]),
            cuePoint(30, [1, 90])
          ),
        ])
      );
      expect(demuxer.cues.map((c) => c.time)).toEqual([30]);
    });

    test("a file with only audio takes the first track's cues", () => {
      const { demuxer } = demuxMkv(
        mkv([
          infoEl(),
          tracksEl(audio({ codec: 'A_MPEG/L3' })),
          cuesEl(cuePoint(0, [2, 70]), cuePoint(1000, [9, 90])),
        ])
      );
      expect(demuxer.cues.map((c) => c.time)).toEqual([0, 1000]);
    });

    test('cues in a file with no segment are ignored', () => {
      const demuxer = new MatroskaDemuxer();
      const sink = { frame: jest.fn(), cue: jest.fn() };
      demuxer.push(cuesEl(cuePoint(0, [1, 5])), sink);
      expect(demuxer.cues).toEqual([]);
    });

    test('are read from an element fetched on its own', () => {
      const demuxer = demuxMkv(mkv(tracksAndClusters())).demuxer;
      const element = cuesEl(cuePoint(0, [1, 10]), cuePoint(700, [1, 20]));
      expect(demuxer.readCuesElement(concat(element, bytes(1, 2, 3)))).toBe(
        true
      );
      expect(demuxer.cues.map((c) => c.time)).toEqual([0, 700]);
    });

    test.each([
      ['an element that is not Cues', el(MKV.Tags, bytes(1))],
      [
        'a Cues element that is cut',
        cuesEl(cuePoint(0, [1, 10])).subarray(0, 12),
      ],
      [
        'a Cues element of unknown size',
        el(MKV.Cues, [cuePoint(0, [1, 10])], 'unknown'),
      ],
      ['garbage', bytes(0, 0, 0, 0)],
      ['nothing', new Uint8Array(0)],
    ])('%s is refused', (_, data) => {
      const demuxer = demuxMkv(mkv(tracksAndClusters())).demuxer;
      expect(demuxer.readCuesElement(data)).toBe(false);
      expect(demuxer.cues).toEqual([]);
    });
  });

  describe('corrupt and truncated files', () => {
    test('bytes that are no element resync on the next cluster', () => {
      const { frames } = demuxMkv(
        concat(
          mkv(tracksAndClusters(cluster(0, [keyed(1)])), true),
          bytes(0x00, 0x00, 0x05, 0x04, 0x03),
          cluster(1000, [keyed(2)]),
          bytes(0x07, 0x00),
          cluster(2000, [keyed(3)])
        ),
        13
      );
      expect(frames.map((f) => f.data[0])).toEqual([1, 2, 3]);
    });

    test('a whole element of unknown size is corrupt', () => {
      const bad = concat(bytes(0xa3), bytes(0xff));
      const { frames } = demuxMkv(
        concat(
          mkv(tracksAndClusters(), true),
          bad,
          bytes(1, 2, 3),
          cluster(300, [keyed(7)])
        )
      );
      expect(frames.map((f) => f.data[0])).toEqual([7]);
    });

    test('a whole element of absurd size is corrupt', () => {
      const bad = concat(
        bytes(0xa3, 0x01, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00)
      );
      const { frames } = demuxMkv(
        concat(mkv(tracksAndClusters(), true), bad, cluster(300, [keyed(8)]))
      );
      expect(frames.map((f) => f.data[0])).toEqual([8]);
    });

    test('an element of unknown size that is not a master is corrupt', () => {
      const bad = concat(bytes(0x53, 0x6e, 0xff), new Uint8Array(6));
      const { frames } = demuxMkv(
        concat(mkv(tracksAndClusters(), true), bad, cluster(300, [keyed(9)]))
      );
      expect(frames.map((f) => f.data[0])).toEqual([9]);
    });

    test('an ID that starts with a zero nibble is invalid', () => {
      const { frames } = demuxMkv(
        concat(
          mkv(tracksAndClusters(), true),
          bytes(0x05, 0x01, 0x01),
          cluster(300, [keyed(4)])
        )
      );
      expect(frames.map((f) => f.data[0])).toEqual([4]);
    });

    test('nothing to resync on keeps waiting for more bytes', () => {
      const demuxer = new MatroskaDemuxer();
      const frames: DemuxFrame[] = [];
      const sink = { frame: (f: DemuxFrame) => frames.push(f), cue: jest.fn() };
      const head = mkv(tracksAndClusters(), true);
      demuxer.push(head, sink);
      demuxer.push(
        bytes(0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88),
        sink
      );
      demuxer.push(cluster(10, [keyed(5)]), sink);
      demuxer.end(sink);
      expect(frames.map((f) => f.data[0])).toEqual([5]);
    });

    test('a file cut anywhere gives a prefix of its frames', () => {
      const data = read('h264-aac-laced.mkv');
      const full = demuxMkv(data, 4096).frames;
      const step = Math.ceil(data.length / 40);
      for (let cut = 100; cut < data.length; cut += step) {
        const { frames } = demuxMkv(data.subarray(0, cut), 4096);
        expect(frames.length).toBeLessThanOrEqual(full.length);
        expect(frames).toEqual(full.slice(0, frames.length));
      }
    });

    test('a BlockGroup cut after its Block is still delivered at the end', () => {
      const group = blockGroup(1, 0, bytes(1, 2, 3), { duration: 40 });
      const data = mkv(
        [
          ...tracksAndClusters(),
          el(MKV.Cluster, [uintEl(MKV.Timestamp, 0), group], 'unknown'),
        ],
        true
      );
      const { frames } = demuxMkv(data.subarray(0, data.length - 3));
      expect(frames).toEqual([
        { track: 1, pts: 0, key: true, data: bytes(1, 2, 3) },
      ]);
    });

    test('a file of a few bytes is not an error', () => {
      expect(demuxMkv(bytes(0x1a, 0x45)).frames).toEqual([]);
      expect(demuxMkv(new Uint8Array(0)).demuxer.tracks).toEqual([]);
    });
  });

  describe('seeking', () => {
    test('resumes at a cluster from its offset, with the segment still open', () => {
      const first = cluster(0, [keyed(1)]);
      const second = cluster(1000, [keyed(2)]);
      const head = mkv([...tracksAndClusters()], true);
      const demuxer = new MatroskaDemuxer();
      const frames: DemuxFrame[] = [];
      const sink = { frame: (f: DemuxFrame) => frames.push(f), cue: jest.fn() };
      demuxer.push(concat(head, first, second), sink);
      expect(frames).toHaveLength(2);
      demuxer.seek(head.length + first.length);
      demuxer.push(second, sink);
      demuxer.end(sink);
      expect(frames.map((f) => f.pts)).toEqual([0, 1000, 1000]);
    });

    test('before the segment was read starts with no open element', () => {
      const demuxer = new MatroskaDemuxer();
      demuxer.seek(0);
      const frames: DemuxFrame[] = [];
      demuxer.push(mkv(tracksAndClusters(cluster(0, [keyed(1)]))), {
        frame: (f) => frames.push(f),
        cue: jest.fn(),
      });
      expect(frames).toHaveLength(1);
    });
  });
});

describe('Matroska: configuration from a frame', () => {
  const frames = (spec: TrackSpec, data: Uint8Array) => {
    const result = demuxMkv(
      mkv([tracksEl(spec), cluster(0, [simpleBlock(spec.number, 0, data)])])
    );
    return { track: result.demuxer.tracks[0]!, frames: result.frames };
  };
  const vp9 = (extra: Partial<TrackSpec> = {}) =>
    video({
      codec: 'V_VP9',
      codecPrivate: undefined,
      video: { width: 1280, height: 720 },
      ...extra,
    });

  test('VP9 reads its codec string from its first keyframe', () => {
    const { track } = frames(vp9(), vp9Frame());
    expect(track.codec).toBe('vp09.00.31.08');
    expect(hex(track.config!)).toBe('001f800101010000');
  });

  test("VP9 takes profile, level and bit depth from the CodecPrivate's features", () => {
    const { track } = frames(
      vp9({ codecPrivate: bytes(1, 1, 2, 2, 1, 41, 3, 1, 10) }),
      vp9Frame({ profile: 2 })
    );
    expect(track.codec).toBe('vp09.02.41.10');
  });

  test('VP9 waits through frames that are not keyframes', () => {
    const { track } = frames(vp9(), vp9Frame({ keyframe: false }));
    expect(track.codec).toBeNull();
  });

  test('AC-3 reads its configuration from a frame', () => {
    const { track } = frames(audio({ codec: 'A_AC3' }), ac3Frame());
    expect(track).toMatchObject({
      entry: 'ac-3',
      codec: 'ac-3',
      sampleRate: 48000,
      channels: 6,
      timescale: 48000,
    });
    expect(hex(track.config!)).toBe('103dc0');
  });

  test('E-AC-3 reads its configuration from a frame', () => {
    const { track } = frames(audio({ codec: 'A_EAC3' }), eac3Frame());
    expect(track).toMatchObject({ entry: 'ec-3', codec: 'ec-3', channels: 6 });
  });

  test('a frame that is not AC-3 leaves the track waiting', () => {
    const { track, frames: out } = frames(
      audio({ codec: 'A_AC3' }),
      bytes(1, 2, 3, 4, 5, 6, 7, 8, 9)
    );
    expect(track.codec).toBeNull();
    expect(out).toHaveLength(1);
  });

  test('a track with a codec string is not configured again', () => {
    const { track } = frames(video(), vp9Frame());
    expect(track.codec).toBe('avc1.42001E');
  });
});

describe('Matroska: damaged elements', () => {
  test('a track entry that runs past its Tracks element is not read', () => {
    const entry = trackEntry(video());
    const data = mkv([
      el(MKV.Tracks, entry.subarray(0, entry.length - 4), entry.length),
    ]);
    expect(demuxMkv(data).demuxer.tracks).toEqual([]);
  });

  test('a child of unknown size ends the children read before it', () => {
    const info = el(MKV.Info, [
      floatEl(MKV.Duration, 1500),
      el(MKV.Name, bytes(1), 'unknown'),
      uintEl(MKV.TimestampScale, 500_000),
    ]);
    const { demuxer } = demuxMkv(mkv([info]));
    expect(demuxer.duration).toBe(1500);
    expect(demuxer.clock).toBe(1000);
  });

  test('a video track without a Video element has no size', () => {
    const track = trackOf(
      video({ codec: 'V_VP9', codecPrivate: undefined, video: undefined })
    );
    expect([track.width, track.height, track.sarWidth]).toEqual([0, 0, 1]);
  });

  test('an Audio element without a rate or channels is 8 kHz mono', () => {
    const track = trackOf(audio({ codec: 'A_MPEG/L3', audio: {} }));
    expect([track.sampleRate, track.channels, track.timescale]).toEqual([
      8000, 1, 8000,
    ]);
  });

  test('a SimpleBlock with no valid track number is ignored', () => {
    const { frames } = demuxMkv(
      mkv([
        tracksEl(video()),
        cluster(0, [
          el(MKV.SimpleBlock, bytes(0, 0, 0, 0x80, 1)),
          simpleBlock(1, 0, bytes(2)),
        ]),
      ])
    );
    expect(frames.map((f) => f.data[0])).toEqual([2]);
  });

  test('an element whose size field is invalid resyncs on the next cluster', () => {
    const { frames } = demuxMkv(
      concat(
        mkv([infoEl(), tracksEl(video())], true),
        bytes(0xa3, 0x00),
        new Uint8Array(9),
        cluster(300, [simpleBlock(1, 0, bytes(6))])
      )
    );
    expect(frames.map((f) => f.data[0])).toEqual([6]);
  });

  test('an element cut inside its size field waits for more bytes', () => {
    const demuxer = new MatroskaDemuxer();
    const frames: DemuxFrame[] = [];
    const sink = { frame: (f: DemuxFrame) => frames.push(f), cue: jest.fn() };
    const block = cluster(0, [simpleBlock(1, 0, bytes(4))]);
    demuxer.push(mkv([infoEl(), tracksEl(video())], true), sink);
    demuxer.push(block.subarray(0, 5), sink);
    demuxer.push(block.subarray(5), sink);
    expect(frames.map((f) => f.data[0])).toEqual([4]);
  });

  test('cue points of the same time are ordered by their cluster', () => {
    const point = (position: number) =>
      el(MKV.CuePoint, [
        uintEl(MKV.CueTime, 700),
        el(MKV.CueTrackPositions, [
          uintEl(MKV.CueTrack, 1),
          uintEl(MKV.CueClusterPosition, position, 4),
        ]),
      ]);
    const { demuxer } = demuxMkv(
      mkv([tracksEl(video()), el(MKV.Cues, [point(300), point(200)])])
    );
    const start = demuxer.segmentStart!;
    expect(demuxer.cues).toEqual([
      { time: 700, offset: start + 200 },
      { time: 700, offset: start + 300 },
    ]);
  });
});
