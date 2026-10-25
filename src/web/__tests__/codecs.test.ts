/* eslint-disable no-bitwise -- codec headers are bit fields. */
// The codec helpers of the remuxer (codecs.ts): Annex B splitting, H.264 and
// HEVC parameter sets and their configuration boxes, RFC 6381 codec strings,
// VP9 keyframes, AAC, MP3, AC-3/E-AC-3, Opus and FLAC headers.

import {
  AAC_RATES,
  ac3Header,
  adtsHeader,
  av1Codec,
  avcCodec,
  avcConfig,
  avcConfigInfo,
  flacConfig,
  flacSamples,
  hevcCodec,
  hevcConfig,
  hevcConfigInfo,
  lengthPrefixed,
  makeAsc,
  mpegAudioHeader,
  opusConfig,
  opusSamples,
  parseAsc,
  parseAvcSps,
  parseHevcSps,
  splitAnnexB,
  vp9CodecFeatures,
  vp9Keyframe,
  vp9Level,
  vpcConfig,
  vpxCodec,
} from '../remux/codecs';
import { adtsFrame, concat, mp3Frame } from './audioFixtures';
import {
  AVC_PPS,
  HEVC_PPS,
  HEVC_VPS,
  ac3Frame,
  avcSps,
  eac3Frame,
  hevcSps,
  vp9Frame,
} from './remuxFixtures';

const hex = (data: Uint8Array) => Buffer.from(data).toString('hex');
const bytes = (...values: number[]) => Uint8Array.from(values);
const withByte = (data: Uint8Array, at: number, value: number) =>
  Uint8Array.from(data, (b, i) => (i === at ? value : b));

describe('Annex B', () => {
  test('splits an access unit at its 3- and 4-byte start codes', () => {
    const data = bytes(
      0,
      0,
      0,
      1,
      0x67,
      1,
      2,
      0,
      0,
      1,
      0x68,
      3,
      0,
      0,
      1,
      0x65,
      4
    );
    expect(splitAnnexB(data).map(hex)).toEqual(['670102', '6803', '6504']);
  });

  test('keeps a NAL unit that ends the data and drops empty ones', () => {
    expect(splitAnnexB(bytes(0, 0, 1, 0, 0, 1, 0x41, 7)).map(hex)).toEqual([
      '4107',
    ]);
  });

  test('finds nothing without a start code', () => {
    expect(splitAnnexB(bytes(1, 2, 3, 4, 5))).toEqual([]);
    expect(splitAnnexB(bytes(0, 0))).toEqual([]);
    expect(splitAnnexB(bytes(0, 0, 1))).toEqual([]);
  });

  test('length-prefixes the units with 4 bytes each', () => {
    expect(hex(lengthPrefixed([bytes(1, 2, 3), bytes(9)]))).toBe(
      '00000003010203' + '0000000109'
    );
    expect(lengthPrefixed([])).toHaveLength(0);
    expect(hex(lengthPrefixed([new Uint8Array(258)]).subarray(0, 4))).toBe(
      '00000102'
    );
  });
});

describe('H.264 sequence parameter sets', () => {
  test('reads a baseline picture size with square pixels', () => {
    expect(parseAvcSps(avcSps())).toEqual({
      width: 640,
      height: 480,
      sarWidth: 1,
      sarHeight: 1,
      profile: 66,
      chromaFormat: 1,
      bitDepthLuma: 8,
      bitDepthChroma: 8,
    });
  });

  test.each([
    [{ widthMbs: 120, heightMapUnits: 68, crop: [0, 0, 0, 4] }, 1920, 1080],
    [{ crop: [1, 2, 3, 4] }, 640 - 2 * 3, 480 - 2 * 7],
    [{ heightMapUnits: 15, frameMbsOnly: false, crop: [0, 0, 0, 2] }, 640, 472],
  ] as const)('applies the cropping window of %j', (options, width, height) => {
    const sps = parseAvcSps(
      avcSps({
        ...options,
        crop: options.crop as [number, number, number, number],
      })
    );
    expect([sps.width, sps.height]).toEqual([width, height]);
  });

  test.each([
    [0, [1, 1]],
    [1, [1, 1]],
    [2, [12, 11]],
    [3, [10, 11]],
    [4, [16, 11]],
    [5, [40, 33]],
    [13, [160, 99]],
    [14, [4, 3]],
    [16, [2, 1]],
    [17, [1, 1]],
    [254, [1, 1]],
  ])('aspect_ratio_idc %d is %j', (idc, sar) => {
    const sps = parseAvcSps(avcSps({ sar: idc }));
    expect([sps.sarWidth, sps.sarHeight]).toEqual(sar);
  });

  test('reads an explicit sample aspect ratio, and ignores one with a zero', () => {
    const wide = parseAvcSps(avcSps({ sar: [32, 27] }));
    expect([wide.sarWidth, wide.sarHeight]).toEqual([32, 27]);
    const zero = parseAvcSps(avcSps({ sar: [0, 27] }));
    expect([zero.sarWidth, zero.sarHeight]).toEqual([1, 1]);
  });

  test.each([null, undefined])('a VUI of %p is square pixels', (sar) => {
    const sps = parseAvcSps(avcSps({ sar }));
    expect([sps.sarWidth, sps.sarHeight]).toEqual([1, 1]);
  });

  test.each([0, 1, 2] as const)(
    'skips the picture order count fields of type %d',
    (pocType) => {
      const sps = parseAvcSps(avcSps({ pocType, sar: [4, 3] }));
      expect([sps.width, sps.height, sps.sarWidth, sps.sarHeight]).toEqual([
        640, 480, 4, 3,
      ]);
    }
  );

  test('a picture order cycle of any length is skipped', () => {
    const sps = parseAvcSps(avcSps({ pocType: 1, pocCycle: 5, sar: [5, 4] }));
    expect([sps.width, sps.sarWidth]).toEqual([640, 5]);
  });

  test('a high profile has its chroma format and bit depths', () => {
    const sps = parseAvcSps(
      avcSps({ profile: 110, chroma: 2, bitDepthLuma: 10, bitDepthChroma: 9 })
    );
    expect(sps).toMatchObject({
      profile: 110,
      chromaFormat: 2,
      bitDepthLuma: 10,
      bitDepthChroma: 9,
      width: 640,
      height: 480,
    });
  });

  test('skips scaling lists, full and default, to the fields after them', () => {
    const sps = parseAvcSps(
      avcSps({
        profile: 100,
        scaling: ['full', null, 'default', null, null, 'full', 'default', null],
        sar: [7, 5],
      })
    );
    expect([sps.width, sps.height, sps.sarWidth, sps.sarHeight]).toEqual([
      640, 480, 7, 5,
    ]);
  });

  test('4:4:4 has twelve scaling lists, and separate planes crop in pixels', () => {
    const lists = Array.from({ length: 12 }, () => 'default' as const);
    const sps = parseAvcSps(
      avcSps({
        profile: 244,
        chroma: 3,
        separatePlanes: true,
        scaling: lists,
        crop: [0, 1, 0, 1],
      })
    );
    expect([sps.chromaFormat, sps.width, sps.height]).toEqual([3, 639, 479]);
  });

  test('4:4:4 with joint planes crops in pixels too', () => {
    const sps = parseAvcSps(
      avcSps({ profile: 244, chroma: 3, crop: [0, 2, 0, 2] })
    );
    expect([sps.width, sps.height]).toEqual([638, 478]);
  });
});

describe('the avcC', () => {
  const sps = avcSps({ profile: 77, level: 31 });

  test('holds the profile, the length size and the parameter sets', () => {
    const avcC = avcConfig([sps], [AVC_PPS]);
    expect(avcC[0]).toBe(1);
    expect([...avcC.subarray(1, 4)]).toEqual([77, 0, 31]);
    expect(avcC[4]).toBe(0xff);
    expect(avcC[5]).toBe(0xe1);
    expect(avcC).toHaveLength(6 + 2 + sps.length + 1 + 2 + AVC_PPS.length);
    expect(avcCodec(avcC)).toBe('avc1.4D001F');
  });

  test('a high profile adds the chroma format and bit depths', () => {
    const high = avcSps({
      profile: 110,
      chroma: 2,
      bitDepthLuma: 10,
      bitDepthChroma: 9,
    });
    const avcC = avcConfig([high], [AVC_PPS]);
    expect([...avcC.subarray(-4)]).toEqual([0xfc | 2, 0xf8 | 2, 0xf8 | 1, 0]);
  });

  test('gives the first SPS back with the length size', () => {
    const info = avcConfigInfo(avcConfig([sps], [AVC_PPS]));
    expect(info.lengthSize).toBe(4);
    expect(hex(info.sps!)).toBe(hex(sps));
  });

  test('without an SPS, or with the length cut, there is none to give', () => {
    expect(avcConfigInfo(bytes(1, 77, 0, 31, 0xfd, 0xe0, 0, 0)).sps).toBeNull();
    expect(avcConfigInfo(bytes(1, 77, 0, 31, 0xfd, 0xe1, 0)).sps).toBeNull();
  });

  test('the length size is the low two bits plus one, 4 for an empty avcC', () => {
    expect(avcConfigInfo(bytes(1, 77, 0, 31, 0xfd, 0xe0)).lengthSize).toBe(2);
    expect(avcConfigInfo(new Uint8Array(0)).lengthSize).toBe(4);
  });
});

describe('HEVC sequence parameter sets', () => {
  test('reads the profile, level and picture size', () => {
    expect(parseHevcSps(hevcSps())).toEqual({
      profileSpace: 0,
      tier: 0,
      profileIdc: 1,
      compatibility: 0x60000000,
      constraints: Uint8Array.of(0x90, 0, 0, 0, 0, 0),
      level: 93,
      chromaFormat: 1,
      bitDepthLuma: 8,
      bitDepthChroma: 8,
      width: 1920,
      height: 1088,
      subLayers: 1,
      temporalIdNested: true,
    });
  });

  test.each([
    [1, [0, 0, 0, 4], 1920, 1080],
    [2, [1, 1, 1, 1], 1916, 1086],
    [3, [1, 1, 1, 1], 1918, 1086],
    [0, [1, 1, 1, 1], 1918, 1086],
  ])('crops its conformance window (chroma %d, %j)', (chroma, crop, w, h) => {
    const sps = parseHevcSps(
      hevcSps({ chroma, crop: crop as [number, number, number, number] })
    );
    expect([sps.width, sps.height]).toEqual([w, h]);
  });

  test('separate colour planes crop in pixels', () => {
    const sps = parseHevcSps(
      hevcSps({ chroma: 3, separatePlanes: true, crop: [1, 1, 1, 1] })
    );
    expect([sps.width, sps.height]).toEqual([1918, 1086]);
  });

  test('skips the profile and level of its sub-layers', () => {
    const sps = parseHevcSps(
      hevcSps({
        maxSubLayers: 3,
        subLayerFlags: [
          [true, true],
          [false, true],
          [true, false],
        ],
        width: 640,
        height: 360,
        bitDepthLuma: 10,
        bitDepthChroma: 10,
        temporalIdNested: false,
      })
    );
    expect(sps).toMatchObject({
      subLayers: 4,
      width: 640,
      height: 360,
      bitDepthLuma: 10,
      bitDepthChroma: 10,
      temporalIdNested: false,
    });
  });

  test('reads the tier and profile space', () => {
    const sps = parseHevcSps(
      hevcSps({ profileSpace: 2, tier: 1, profileIdc: 4 })
    );
    expect([sps.profileSpace, sps.tier, sps.profileIdc]).toEqual([2, 1, 4]);
  });
});

describe('the hvcC', () => {
  const sps = hevcSps();

  test('lists the parameter sets by type, leaving out the missing ones', () => {
    const all = hevcConfig([HEVC_VPS], [sps], [HEVC_PPS]);
    expect(all[22]).toBe(3);
    expect(all[23]).toBe(0x80 | 32);
    const noVps = hevcConfig([], [sps], [HEVC_PPS]);
    expect(noVps[22]).toBe(2);
    expect(noVps[23]).toBe(0x80 | 33);
  });

  test('gives its SPS and length size back', () => {
    const info = hevcConfigInfo(hevcConfig([HEVC_VPS], [sps], [HEVC_PPS]));
    expect(info.lengthSize).toBe(4);
    expect(hex(info.sps!)).toBe(hex(sps));
  });

  test('an hvcC with no SPS array has none to give', () => {
    const vpsOnly = new Uint8Array(32);
    vpsOnly[22] = 1;
    vpsOnly[23] = 0x80 | 32;
    vpsOnly[25] = 1;
    vpsOnly[27] = HEVC_VPS.length;
    vpsOnly.set(HEVC_VPS, 28);
    expect(hevcConfigInfo(vpsOnly).sps).toBeNull();
    expect(hevcConfigInfo(vpsOnly.subarray(0, 24)).sps).toBeNull();
    expect(hevcConfigInfo(vpsOnly.subarray(0, 27)).sps).toBeNull();
    expect(hevcConfigInfo(new Uint8Array(22)).sps).toBeNull();
  });

  test('the length size is the low two bits plus one, 4 for an empty hvcC', () => {
    expect(hevcConfigInfo(new Uint8Array(22)).lengthSize).toBe(1);
    expect(hevcConfigInfo(new Uint8Array(0)).lengthSize).toBe(4);
  });

  test('the codec string of a Main profile stream', () => {
    const hvcC = hevcConfig([HEVC_VPS], [sps], [HEVC_PPS]);
    expect(hevcCodec(hvcC)).toBe('hvc1.1.6.L93.90');
  });

  test('the codec string carries the profile space, tier and every constraint byte', () => {
    const odd = hevcSps({
      profileSpace: 1,
      tier: 1,
      profileIdc: 2,
      compatibility: 0x20000000,
      level: 120,
      constraints: [0xb0, 0, 0x01, 0, 0, 0],
    });
    expect(hevcCodec(hevcConfig([], [odd], []))).toBe(
      'hvc1.A2.4.H120.B0.00.01'
    );
  });

  test('a stream with no constraint flags has none in its string', () => {
    const plain = hevcSps({ constraints: [0, 0, 0, 0, 0, 0] });
    expect(hevcCodec(hevcConfig([], [plain], []))).toBe('hvc1.1.6.L93');
  });

  test('profile space 2 is written B and 3 C', () => {
    const b = hevcConfig([], [hevcSps({ profileSpace: 2 })], []);
    const c = hevcConfig([], [hevcSps({ profileSpace: 3 })], []);
    expect(hevcCodec(b)).toContain('hvc1.B1.');
    expect(hevcCodec(c)).toContain('hvc1.C1.');
  });
});

describe('VP9', () => {
  test.each([
    [0, 8, 0],
    [1, 8, 3],
    [2, 10, 0],
    [3, 10, 3],
  ])(
    'reads profile %d of a keyframe (%d bits, chroma %d)',
    (profile, bitDepth, chroma) => {
      expect(vp9Keyframe(vp9Frame({ profile }))).toEqual({
        profile,
        bitDepth,
        chroma,
        fullRange: false,
        colorSpace: 2,
      });
    }
  );

  test('profile 2 can be 12 bits', () => {
    expect(
      vp9Keyframe(vp9Frame({ profile: 2, bitDepth12: true }))?.bitDepth
    ).toBe(12);
  });

  test.each([
    [[1, 1], 0],
    [[1, 0], 2],
    [[0, 0], 3],
  ] as const)(
    'profile 1 with subsampling %j has chroma %d',
    (subsampling, chroma) => {
      const info = vp9Keyframe(
        vp9Frame({ profile: 1, subsampling: [...subsampling] })
      );
      expect(info?.chroma).toBe(chroma);
    }
  );

  test('reads the colour range', () => {
    expect(vp9Keyframe(vp9Frame({ fullRange: true }))?.fullRange).toBe(true);
  });

  test.each([
    [0, 0],
    [1, 3],
  ])('RGB in profile %d is full range with chroma %d', (profile, chroma) => {
    expect(vp9Keyframe(vp9Frame({ profile, colorSpace: 7 }))).toMatchObject({
      fullRange: true,
      chroma,
      colorSpace: 7,
    });
  });

  test.each([
    ['a wrong frame marker', { marker: 1 }],
    ['a frame that shows an existing one', { showExisting: true }],
    ['an inter frame', { keyframe: false }],
    ['a wrong sync code', { sync: 0x123456 }],
  ])('%s is not a keyframe header', (_, options) => {
    expect(vp9Keyframe(vp9Frame(options))).toBeNull();
  });

  test.each([
    [64 * 36, 10],
    [73728, 11],
    [352 * 288, 20],
    [640 * 360, 21],
    [854 * 480, 30],
    [1280 * 720, 31],
    [1920 * 1080, 40],
    [3840 * 2160, 50],
    [7680 * 4320, 60],
  ])('a picture of %d pixels gets level %d', (size, level) => {
    expect(vp9Level(size, 1)).toBe(level);
  });

  test('the vpcC holds the profile, level, depth, range and colours', () => {
    const info = {
      profile: 2,
      bitDepth: 10,
      chroma: 0,
      fullRange: true,
      colorSpace: 5,
    };
    expect([...vpcConfig(info, 41)]).toEqual([2, 41, 0xa1, 9, 1, 9, 0, 0]);
  });

  test('the vpcC of an unknown colour space says unspecified', () => {
    const info = {
      profile: 0,
      bitDepth: 8,
      chroma: 0,
      fullRange: false,
      colorSpace: 0,
    };
    expect([...vpcConfig(info, 10)].slice(3, 6)).toEqual([2, 2, 2]);
  });

  test.each([
    ['vp09', [0, 10, 0x80], 'vp09.00.10.08'],
    ['vp09', [2, 41, 0xa0], 'vp09.02.41.10'],
    ['vp08', [], 'vp08.00.10.08'],
  ] as const)('the codec string of a %s %j is %s', (entry, vpcC, codec) => {
    expect(vpxCodec(entry, Uint8Array.from(vpcC))).toBe(codec);
  });

  test("Matroska's CodecPrivate features are triples of ID, length and value", () => {
    expect(
      vp9CodecFeatures(bytes(1, 1, 2, 2, 1, 41, 3, 1, 10, 4, 1, 0))
    ).toEqual({
      1: 2,
      2: 41,
      3: 10,
      4: 0,
    });
  });

  test('a feature that is not one byte, or is cut, is skipped', () => {
    expect(vp9CodecFeatures(bytes(1, 2, 7, 7, 2, 1, 5, 3, 1))).toEqual({
      2: 5,
    });
    expect(vp9CodecFeatures(new Uint8Array(0))).toEqual({});
  });
});

describe('AV1', () => {
  test.each([
    [[0x81, 0x08, 0x0c, 0], 'av01.0.08M.08'],
    [[0x81, 0x24, 0x40, 0], 'av01.1.04M.10'],
    [[0x81, 0x4d, 0xe0, 0], 'av01.2.13H.12'],
    [[0x81, 0x04, 0x80, 0], 'av01.0.04H.08'],
    [[], 'av01.0.00M.08'],
  ])('%j is %s', (av1C, codec) => {
    expect(av1Codec(Uint8Array.from(av1C))).toBe(codec);
  });
});

describe('AAC', () => {
  test.each([
    [2, 44100, 2, [0x12, 0x10]],
    [2, 48000, 6, [0x11, 0xb0]],
    [5, 22050, 1, [0x2b, 0x88]],
  ])(
    'the config of type %d, %d Hz, %d channels',
    (type, rate, channels, config) => {
      const asc = makeAsc(type, rate, channels);
      expect([...asc]).toEqual(config);
      expect(parseAsc(asc)).toEqual({
        objectType: type,
        sampleRate: rate,
        channels,
      });
    }
  );

  test('every standard rate has an index', () => {
    for (const rate of AAC_RATES)
      expect(parseAsc(makeAsc(2, rate, 2)).sampleRate).toBe(rate);
  });

  test('a rate with no index is written out in 24 bits', () => {
    const asc = makeAsc(2, 12345, 2);
    expect(asc).toHaveLength(5);
    expect(parseAsc(asc)).toEqual({
      objectType: 2,
      sampleRate: 12345,
      channels: 2,
    });
  });

  test('an object type of 31 continues in six more bits', () => {
    expect(parseAsc(bytes(0xf9, 0x48, 0x40))).toEqual({
      objectType: 42,
      sampleRate: 44100,
      channels: 2,
    });
  });

  test('an unknown rate index reads as no rate', () => {
    expect(parseAsc(bytes(0x16, 0x90)).sampleRate).toBe(0);
  });
});

describe('ADTS headers', () => {
  test('read the frame length, rate, channels and blocks', () => {
    const frame = adtsFrame({
      rateIndex: 3,
      channelConfig: 6,
      payload: 100,
      rawBlocks: 1,
    });
    expect(adtsHeader(frame, 0)).toEqual({
      length: 107,
      headerLength: 7,
      objectType: 2,
      sampleRate: 48000,
      channels: 6,
      blocks: 2,
    });
  });

  test('a CRC makes the header 9 bytes', () => {
    const header = adtsHeader(adtsFrame({ crc: true }), 0);
    expect([header?.headerLength, header?.length]).toEqual([9, 33]);
  });

  test('reads at an offset', () => {
    const data = concat(bytes(0, 0, 0), adtsFrame());
    expect(adtsHeader(data, 3)?.length).toBe(31);
    expect(adtsHeader(data, 0)).toBeNull();
  });

  test.each([
    ['cut short', adtsFrame().subarray(0, 6)],
    ['without the sync word', withByte(adtsFrame(), 0, 0xfe)],
    ['with the MPEG layer bits set', withByte(adtsFrame(), 1, 0xf7)],
    ['with a reserved rate index', adtsFrame({ rateIndex: 13 })],
  ])('%s is no header', (_, data) => {
    expect(adtsHeader(data, 0)).toBeNull();
  });

  test('a length shorter than its own header is no header', () => {
    const frame = adtsFrame({ crc: true });
    frame[3] = frame[3]! & 0xc0;
    frame[4] = 0;
    frame[5] = 5 << 5;
    expect(adtsHeader(frame, 0)).toBeNull();
  });
});

describe('MPEG audio headers', () => {
  test('reads a Layer III frame of MPEG-1', () => {
    expect(mpegAudioHeader(mp3Frame(), 0)).toEqual({
      length: 417,
      sampleRate: 44100,
      channels: 2,
      samples: 1152,
      layer: 3,
    });
  });

  test('a padded frame is a byte longer, and mono has one channel', () => {
    const header = mpegAudioHeader(mp3Frame({ padding: true, mono: true }), 0);
    expect([header?.length, header?.channels]).toEqual([418, 1]);
  });

  test.each([
    [0, 44100],
    [1, 48000],
    [2, 32000],
  ])('rate index %d is %d Hz', (rateIndex, rate) => {
    expect(mpegAudioHeader(mp3Frame({ rateIndex }), 0)?.sampleRate).toBe(rate);
  });

  test('MPEG-2 frames are 576 samples at half rates', () => {
    const frame = mp3Frame({ version: 2, rateIndex: 1, bitrateIndex: 8 });
    expect(mpegAudioHeader(frame, 0)).toMatchObject({
      sampleRate: 24000,
      samples: 576,
      length: 192,
    });
  });

  test('MPEG-2.5 rates are a quarter', () => {
    const frame = mp3Frame();
    frame[1] = 0xe3;
    frame[2] = (8 << 4) | (2 << 2);
    expect(mpegAudioHeader(frame, 0)).toMatchObject({
      sampleRate: 8000,
      samples: 576,
    });
  });

  test.each([
    [2, 2],
    [3, 1],
  ])('layer bits %d is Layer %d, which has no length', (layerBits, layer) => {
    const frame = mp3Frame();
    frame[1] = (frame[1]! & ~0x06) | (layerBits << 1);
    expect(mpegAudioHeader(frame, 0)).toMatchObject({
      layer,
      length: 0,
      samples: 1152,
    });
  });

  test.each([
    ['cut short', mp3Frame().subarray(0, 3)],
    ['without sync', bytes(0xff, 0x10, 0x90, 0)],
    ['the reserved version', bytes(0xff, 0xeb, 0x90, 0)],
    ['the reserved layer', bytes(0xff, 0xf9, 0x90, 0)],
    ['the reserved rate', bytes(0xff, 0xfb, 0x9c, 0)],
    ['the free bitrate', bytes(0xff, 0xfb, 0x00, 0)],
    ['the bad bitrate', bytes(0xff, 0xfb, 0xf0, 0)],
  ])('%s is no header', (_, data) => {
    expect(mpegAudioHeader(data, 0)).toBeNull();
  });
});

describe('AC-3 headers', () => {
  test('read a 5.1 frame at 48 kHz and build its dac3', () => {
    const header = ac3Header(ac3Frame(), 0)!;
    expect(header).toMatchObject({
      length: 1536,
      sampleRate: 48000,
      channels: 6,
      samples: 1536,
      independent: true,
      extended: false,
    });
    // fscod 0, bsid 8, bsmod 0, acmod 7, lfeon 1, bit_rate_code 14
    expect(hex(header.config)).toBe('103dc0');
  });

  test.each([
    [0, 28, 1536],
    [1, 28, 2 * Math.floor((384 * 320) / 147)],
    [1, 29, 2 * (Math.floor((384 * 320) / 147) + 1)],
    [2, 28, 2304],
  ])('fscod %d, size code %d is %d bytes', (fscod, frmsizecod, length) => {
    expect(ac3Header(ac3Frame({ fscod, frmsizecod }), 0)?.length).toBe(length);
  });

  test.each([
    [0, false, 2],
    [1, false, 1],
    [2, true, 3],
    [3, false, 3],
    [4, true, 4],
    [5, false, 4],
    [6, true, 5],
    [7, false, 5],
  ])('acmod %d with lfe %p has %d channels', (acmod, lfeon, channels) => {
    expect(ac3Header(ac3Frame({ acmod, lfeon }), 0)?.channels).toBe(channels);
  });

  test.each([
    ['the reserved sample rate', ac3Frame({ fscod: 3 })],
    ['a size code past the table', ac3Frame({ frmsizecod: 38 })],
    ['a missing sync word', withByte(ac3Frame(), 0, 0)],
    ['a missing second sync byte', withByte(ac3Frame(), 1, 0)],
    ['too few bytes', ac3Frame().subarray(0, 7)],
  ])('%s is no header', (_, data) => {
    expect(ac3Header(data, 0)).toBeNull();
  });
});

describe('E-AC-3 headers', () => {
  test('read an independent 5.1 frame and build its dec3', () => {
    const header = ac3Header(eac3Frame({ size: 768 }), 0)!;
    expect(header).toMatchObject({
      length: 768,
      sampleRate: 48000,
      channels: 6,
      samples: 1536,
      independent: true,
      extended: true,
    });
    // data_rate 192 kbit/s, fscod 0, bsid 16, acmod 7, lfeon 1
    expect(hex(header.config)).toBe('0600200f00');
  });

  test('a dependent substream is not independent', () => {
    expect(ac3Header(eac3Frame({ strmtyp: 1 }), 0)?.independent).toBe(false);
    expect(ac3Header(eac3Frame({ strmtyp: 2 }), 0)?.independent).toBe(true);
  });

  test.each([
    [0, 256],
    [1, 512],
    [2, 768],
    [3, 1536],
  ])('numblkscod %d is %d samples', (numblkscod, samples) => {
    expect(ac3Header(eac3Frame({ numblkscod }), 0)?.samples).toBe(samples);
  });

  test.each([
    [1, 44100],
    [2, 32000],
  ])('fscod %d is %d Hz', (fscod, rate) => {
    expect(ac3Header(eac3Frame({ fscod }), 0)?.sampleRate).toBe(rate);
  });

  test.each([
    [0, 24000],
    [1, 22050],
    [2, 16000],
  ])('fscod 3 with fscod2 %d is %d Hz, six blocks', (fscod2, rate) => {
    const header = ac3Header(eac3Frame({ fscod: 3, fscod2 }), 0);
    expect(header).toMatchObject({ sampleRate: rate, samples: 1536 });
    expect(header!.config[2]! >> 6).toBe(0);
  });

  test('the reserved fscod2 is no header', () => {
    expect(ac3Header(eac3Frame({ fscod: 3, fscod2: 3 }), 0)).toBeNull();
  });
});

describe('Opus', () => {
  const head = (channels: number, family = 0, extra: number[] = []) =>
    Uint8Array.from([
      ...Buffer.from('OpusHead'),
      1,
      channels,
      0x38,
      0x01, // pre-skip 312
      0x80,
      0xbb,
      0,
      0, // 48000 Hz
      0xff,
      0xff, // gain
      family,
      ...extra,
    ]);

  test('builds the dOps of a stereo head', () => {
    const config = opusConfig(head(2))!;
    expect(config.channels).toBe(2);
    expect([...config.config]).toEqual([
      0, 2, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0xff, 0xff, 0,
    ]);
  });

  test('a channel mapping family brings its table', () => {
    const table = [2, 2, 0, 1, 2, 3];
    const config = opusConfig(head(4, 1, table))!;
    expect(config.channels).toBe(4);
    expect([...config.config.subarray(11)]).toEqual(table);
  });

  test.each([
    ['too short', head(2).subarray(0, 18)],
    ['not an OpusHead', withByte(head(2), 0, 0x58)],
    ['a mapping table that is cut', head(6, 1, [1, 2])],
  ])('%s is no head', (_, data) => {
    expect(opusConfig(data)).toBeNull();
  });

  test('an empty packet has no samples', () => {
    expect(opusSamples(new Uint8Array(0))).toBe(0);
  });

  test.each([
    [0, 480],
    [1, 960],
    [2, 1920],
    [3, 2880],
    [4, 480],
    [11, 2880],
    [12, 480],
    [13, 960],
    [14, 480],
    [15, 960],
    [16, 120],
    [17, 240],
    [18, 480],
    [19, 960],
    [31, 960],
  ])('TOC config %d is one frame of %d samples', (config, samples) => {
    expect(opusSamples(bytes(config << 3, 0))).toBe(samples);
  });

  test.each([1, 2])('TOC frame code %d is two frames', (code) => {
    expect(opusSamples(bytes((1 << 3) | code, 0))).toBe(2 * 960);
  });

  test('frame code 3 counts the frames in the byte after the TOC', () => {
    expect(opusSamples(bytes((3 << 3) | 3, 0x45))).toBe(5 * 2880);
    expect(opusSamples(bytes((3 << 3) | 3))).toBe(0);
  });
});

describe('FLAC', () => {
  const streamInfo = (rate: number, channels: number) => {
    const info = new Uint8Array(34);
    info[10] = rate >> 12;
    info[11] = (rate >> 4) & 0xff;
    info[12] = ((rate & 15) << 4) | ((channels - 1) << 1);
    return info;
  };
  const block = (type: number, last: boolean, body: Uint8Array) =>
    concat(bytes((last ? 0x80 : 0) | type, 0, 0, body.length), body);
  const fLaC = bytes(0x66, 0x4c, 0x61, 0x43);

  test('builds the dfLa from the STREAMINFO block after the marker', () => {
    const info = streamInfo(44100, 2);
    const config = flacConfig(concat(fLaC, block(0, true, info)))!;
    expect(config).toMatchObject({ sampleRate: 44100, channels: 2 });
    expect(hex(config.config.subarray(0, 4))).toBe('80000022');
    expect(hex(config.config.subarray(4))).toBe(hex(info));
  });

  test('finds a STREAMINFO that follows another block, or comes without the marker', () => {
    const info = streamInfo(96000, 6);
    const padding = block(1, false, new Uint8Array(5));
    expect(
      flacConfig(concat(fLaC, padding, block(0, true, info)))
    ).toMatchObject({
      sampleRate: 96000,
      channels: 6,
    });
    expect(flacConfig(block(0, true, info))).toMatchObject({
      sampleRate: 96000,
    });
  });

  test.each([
    ['empty', new Uint8Array(0)],
    ['only the marker', fLaC],
    ['no STREAMINFO', concat(fLaC, block(1, true, new Uint8Array(8)))],
    [
      'a STREAMINFO that is too short',
      concat(fLaC, block(0, true, new Uint8Array(10))),
    ],
    [
      'a STREAMINFO that is cut',
      concat(fLaC, block(0, true, streamInfo(44100, 2)).subarray(0, 20)),
    ],
  ])('%s has no config', (_, data) => {
    expect(flacConfig(data)).toBeNull();
  });

  const frame = (code: number, ...rest: number[]) =>
    bytes(0xff, 0xf8, code << 4, 0, ...rest);

  test.each([
    [1, 192],
    [2, 576],
    [3, 1152],
    [4, 2304],
    [5, 4608],
    [8, 256],
    [9, 512],
    [10, 1024],
    [15, 32768],
  ])('block size code %d is %d samples', (code, samples) => {
    expect(flacSamples(frame(code, 0))).toBe(samples);
  });

  test('code 6 reads the size from the byte after a 1-byte frame number', () => {
    expect(flacSamples(frame(6, 0x00, 0x40))).toBe(0x41);
  });

  test('code 7 reads 16 bits after the frame number, whatever its length', () => {
    expect(flacSamples(frame(7, 0x00, 0x01, 0x00))).toBe(0x101);
    expect(
      flacSamples(bytes(0xff, 0xf9, 0x70, 0, 0xc2, 0x80, 0x03, 0xff))
    ).toBe(0x400);
  });

  test.each([
    ['the reserved code 0', frame(0, 0)],
    ['a short frame', bytes(0xff, 0xf8, 0x60, 0)],
    ['no sync', bytes(0, 0xf8, 0x10, 0, 0, 0)],
    ['a wrong second byte', bytes(0xff, 0xfa, 0x10, 0, 0, 0)],
    ['a code 6 cut before its size', frame(6, 0x00)],
    ['a code 7 cut before its size', frame(7, 0x00, 0x01)],
  ])('%s has no sample count', (_, data) => {
    expect(flacSamples(data)).toBeNull();
  });
});
