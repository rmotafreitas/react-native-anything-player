import {
  Fmp4Muxer,
  MP4_TYPES,
  initSegment,
  mediaSegment,
} from '../platform/Fmp4Muxer';
import { FrameScanner, MP3_FORMAT, AAC_FORMAT } from '../platform/AudioFrames';
import {
  adtsFrame,
  ascii,
  boxes,
  chunked,
  concat,
  find,
  id3Tag,
  mp3Frame,
  parseInit,
  parseSegment,
  u32,
  type ParsedSegment,
} from './audioFixtures';

/** Every sample the muxer wrote for `chunks`, in order, with the segments' start times. */
function muxAll(muxer: Fmp4Muxer, chunks: Uint8Array[]) {
  const samples: Uint8Array[] = [];
  const segments: ParsedSegment[] = [];
  const inits: Uint8Array[] = [];
  let changed = false;
  for (const chunk of chunks) {
    const out = muxer.push(chunk);
    if (out.init) inits.push(out.init);
    if (out.fragment) {
      const segment = parseSegment(out.fragment);
      segments.push(segment);
      samples.push(...segment.samples.map((s) => s.data));
    }
    changed ||= out.changed;
  }
  return { samples, segments, inits, changed };
}

describe('Fmp4Muxer: MP3', () => {
  it('parses the header: 128 kbps, 44.1 kHz, stereo, padding', () => {
    expect(mp3Frame()).toHaveLength(417);
    expect(mp3Frame({ padding: true })).toHaveLength(418);
    const muxer = new Fmp4Muxer('mp3');
    const out = muxer.push(
      concat(mp3Frame(), mp3Frame({ padding: true }), mp3Frame())
    );
    // The first frame is confirmed by the header after it; the others follow it.
    const init = parseInit(out.init!);
    expect(init).toMatchObject({
      timescale: 44100,
      channels: 2,
      sampleEntryRate: 44100,
      objectType: 0x6b,
      specific: [],
    });
    const segment = parseSegment(out.fragment!);
    expect(segment.samples.map((s) => s.data.length)).toEqual([417, 418, 417]);
    expect(segment.samples.every((s) => s.duration === 1152)).toBe(true);
    expect(segment.baseMediaDecodeTime).toBe(0);
    expect(segment.sequence).toBe(1);
  });

  it('keeps the frame header in the sample (MP3 in MP4 carries whole frames)', () => {
    const frames = [mp3Frame({ fill: 1 }), mp3Frame({ fill: 2 }), mp3Frame()];
    const out = new Fmp4Muxer('mp3').push(concat(...frames));
    const [first] = parseSegment(out.fragment!).samples;
    expect(Array.from(first!.data)).toEqual(Array.from(frames[0]!));
  });

  it('lays out ftyp + moov with the boxes a demuxer needs', () => {
    const init = initSegment(
      new FrameScanner(MP3_FORMAT).scan(
        concat(mp3Frame(), mp3Frame(), mp3Frame())
      ).config!
    );
    expect(boxes(init).map((b) => b.type)).toEqual(['ftyp', 'moov']);
    const ftyp = boxes(init)[0]!;
    expect(ascii(ftyp.body.subarray(0, 4))).toBe('iso5');
    for (const path of [
      'moov/mvhd',
      'moov/trak/tkhd',
      'moov/trak/mdia/mdhd',
      'moov/trak/mdia/hdlr',
      'moov/trak/mdia/minf/smhd',
      'moov/trak/mdia/minf/dinf',
      'moov/trak/mdia/minf/stbl/stsd',
      'moov/trak/mdia/minf/stbl/stts',
      'moov/trak/mdia/minf/stbl/stsc',
      'moov/trak/mdia/minf/stbl/stsz',
      'moov/trak/mdia/minf/stbl/stco',
      'moov/mvex/trex',
    ]) {
      expect(find(init, path)).toBeDefined();
    }
    expect(ascii(find(init, 'moov/trak/mdia/hdlr')!.body.subarray(8, 12))).toBe(
      'soun'
    );
    // mvhd and mdhd share the timescale; the next track id follows track 1.
    expect(u32(find(init, 'moov/mvhd')!.body, 12)).toBe(44100);
    expect(u32(find(init, 'moov/trak/tkhd')!.body, 12)).toBe(1);
  });

  it('writes a continuous timeline across chunks', () => {
    const frames = Array.from({ length: 12 }, (_, i) => mp3Frame({ fill: i }));
    const { samples, segments, inits } = muxAll(
      new Fmp4Muxer('mp3'),
      chunked(concat(...frames), 1000)
    );
    expect(inits).toHaveLength(1);
    expect(segments.length).toBeGreaterThan(1);
    // Every segment starts where the previous one ended.
    let expected = 0;
    for (const segment of segments) {
      expect(segment.baseMediaDecodeTime).toBe(expected);
      expected += segment.samples.length * 1152;
    }
    expect(samples.map((sample) => sample[100])).toEqual(
      frames.map((frame) => frame[100])
    );
  });

  it('numbers segments and advances baseMediaDecodeTime by the samples written', () => {
    const muxer = new Fmp4Muxer('mp3');
    const a = muxer.push(concat(mp3Frame(), mp3Frame(), mp3Frame()));
    const b = muxer.push(concat(mp3Frame(), mp3Frame()));
    const first = parseSegment(a.fragment!);
    const second = parseSegment(b.fragment!);
    expect(first.baseMediaDecodeTime).toBe(0);
    expect(second.baseMediaDecodeTime).toBe(3 * 1152);
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(b.init).toBeNull();
  });

  it('carries a partial frame over, however the stream is cut', () => {
    const frames = Array.from({ length: 9 }, (_, i) =>
      mp3Frame({ fill: i + 1, padding: i % 2 === 1 })
    );
    const stream = concat(...frames);
    for (const size of [1, 3, 7, 100, 417, 418, 419, 1000, stream.length]) {
      const muxer = new Fmp4Muxer('mp3');
      const { samples } = muxAll(muxer, chunked(stream, size));
      expect(samples.map((s) => s[50])).toEqual(frames.map((f) => f[50]));
      expect(samples.map((s) => s.length)).toEqual(frames.map((f) => f.length));
      expect(muxer.pending).toBe(0);
    }
  });

  it('holds the bytes of a cut frame until the rest arrives', () => {
    const muxer = new Fmp4Muxer('mp3');
    const stream = concat(mp3Frame(), mp3Frame(), mp3Frame());
    // The first frame needs a verified successor: nothing is emitted yet.
    expect(muxer.push(stream.subarray(0, 300))).toMatchObject({
      init: null,
      fragment: null,
    });
    expect(muxer.pending).toBe(300);
    const out = muxer.push(stream.subarray(300, 417 + 50));
    // The second header is now visible: the first frame is real.
    expect(parseSegment(out.fragment!).samples).toHaveLength(1);
    expect(muxer.pending).toBe(50);
  });

  it('skips ID3v2 tags: at the start, in the middle, with a footer, split across chunks', () => {
    const frames = [
      mp3Frame({ fill: 1 }),
      mp3Frame({ fill: 2 }),
      mp3Frame({ fill: 3 }),
    ];
    const stream = concat(
      id3Tag(300),
      frames[0]!,
      id3Tag(20, true),
      frames[1]!,
      frames[2]!,
      mp3Frame({ fill: 4 })
    );
    for (const size of [1, 2, 5, 37, 512, stream.length]) {
      const { samples } = muxAll(new Fmp4Muxer('mp3'), chunked(stream, size));
      expect(samples.map((s) => s[60])).toEqual([1, 2, 3, 4]);
    }
  });

  it('resyncs after garbage, rejecting false syncs', () => {
    const junk = Uint8Array.of(0x00, 0xff, 0xfb, 0x90, 0xff, 0xff, 0x12, 0x49);
    const frames = [
      mp3Frame({ fill: 7 }),
      mp3Frame({ fill: 8 }),
      mp3Frame({ fill: 9 }),
    ];
    const stream = concat(
      junk,
      frames[0]!,
      frames[1]!,
      junk,
      frames[2]!,
      mp3Frame({ fill: 10 }),
      mp3Frame({ fill: 11 })
    );
    for (const size of [1, 4, 100, stream.length]) {
      const { samples } = muxAll(new Fmp4Muxer('mp3'), chunked(stream, size));
      // The false 0xFF 0xFB 0x90 header in the junk would be a 417-byte frame
      // of whatever follows; the lookahead check refuses it.
      expect(samples.map((s) => s[60])).toEqual([7, 8, 9, 10, 11]);
    }
  });

  it('drops the Xing frame an encoder puts first', () => {
    const xing = mp3Frame({ fill: 0 });
    xing.set([0x58, 0x69, 0x6e, 0x67], 4 + 32); // MPEG-1 stereo: side info is 32 bytes
    const stream = concat(
      xing,
      mp3Frame({ fill: 1 }),
      mp3Frame({ fill: 2 }),
      mp3Frame({ fill: 3 })
    );
    const { samples } = muxAll(new Fmp4Muxer('mp3'), [stream]);
    expect(samples.map((s) => s[60])).toEqual([1, 2, 3]);
  });

  it('reads MPEG-2 (576 samples per frame, 22.05 kHz) and mono', () => {
    const frames = [0, 1, 2].map(() =>
      mp3Frame({ version: 2, rateIndex: 0, bitrateIndex: 8, mono: true })
    );
    const out = new Fmp4Muxer('mp3').push(concat(...frames));
    expect(parseInit(out.init!)).toMatchObject({
      timescale: 22050,
      channels: 1,
    });
    const segment = parseSegment(out.fragment!);
    expect(segment.samples.every((s) => s.duration === 576)).toBe(true);
    // Mono MPEG-2 puts the Xing tag at 4 + 9, not 4 + 32.
    expect(segment.samples).toHaveLength(3);
  });

  it('tells MPEG-1 mono, and 48 kHz, apart in the init segment', () => {
    const out = new Fmp4Muxer('mp3').push(
      concat(...[0, 1, 2].map(() => mp3Frame({ rateIndex: 1, mono: true })))
    );
    expect(parseInit(out.init!)).toMatchObject({
      timescale: 48000,
      channels: 1,
    });
  });

  it('ignores frames it cannot carry: Layer II, free format, reserved fields', () => {
    const layer2 = mp3Frame();
    layer2[1] = 0xfd; // Layer II
    const free = mp3Frame();
    free[2] = 0x00; // bitrate index 0
    const reserved = mp3Frame();
    reserved[2] = 0x9c; // sample rate index 3
    const bad = mp3Frame();
    bad[1] = 0xe9; // reserved version
    const muxer = new Fmp4Muxer('mp3');
    const out = muxer.push(concat(layer2, free, reserved, bad));
    expect(out.fragment).toBeNull();
    expect(muxer.frames).toBe(0);
  });

  it('stops at a change of sample rate, after the frames before it', () => {
    const muxer = new Fmp4Muxer('mp3');
    const before = [mp3Frame({ fill: 1 }), mp3Frame({ fill: 2 })];
    const after = [
      mp3Frame({ rateIndex: 1, fill: 9 }),
      mp3Frame({ rateIndex: 1, fill: 9 }),
      mp3Frame({ rateIndex: 1, fill: 9 }),
    ];
    const out = muxer.push(concat(...before, ...after));
    expect(out.changed).toBe(true);
    expect(parseSegment(out.fragment!).samples).toHaveLength(2);
    // Nothing more is taken once it has stopped.
    const next = muxer.push(concat(mp3Frame(), mp3Frame()));
    expect(next).toMatchObject({ fragment: null, changed: true });
  });

  it('does not take a lone odd frame for a change', () => {
    const muxer = new Fmp4Muxer('mp3');
    const stray = mp3Frame({ rateIndex: 2, fill: 9 });
    const out = muxer.push(
      concat(
        mp3Frame({ fill: 1 }),
        mp3Frame({ fill: 2 }),
        stray,
        mp3Frame({ fill: 3 }),
        mp3Frame({ fill: 4 })
      )
    );
    // `stray` has no successor of its kind: a false sync, resynced past.
    expect(out.changed).toBe(false);
    expect(parseSegment(out.fragment!).samples.map((s) => s.data[60])).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it('restarts mid-frame on the same timeline, with a fresh init segment', () => {
    const muxer = new Fmp4Muxer('mp3');
    const first = muxer.push(concat(mp3Frame(), mp3Frame(), mp3Frame()));
    expect(first.init).not.toBeNull();
    // A cut frame is pending when the connection drops.
    muxer.push(mp3Frame().subarray(0, 100));
    expect(muxer.pending).toBeGreaterThan(0);
    muxer.restart();
    expect(muxer.pending).toBe(0);
    const tail = mp3Frame({ fill: 5 }).subarray(200);
    const second = muxer.push(
      concat(
        tail,
        mp3Frame({ fill: 6 }),
        mp3Frame({ fill: 7 }),
        mp3Frame({ fill: 8 })
      )
    );
    expect(second.init).not.toBeNull();
    const segment = parseSegment(second.fragment!);
    expect(segment.samples.map((s) => s.data[60])).toEqual([6, 7, 8]);
    expect(segment.baseMediaDecodeTime).toBe(3 * 1152);
    expect(segment.sequence).toBe(2);
  });

  it('reports the MSE type of the segments', () => {
    expect(new Fmp4Muxer('mp3').mimeType).toBe('audio/mp4; codecs="mp3"');
    expect(new Fmp4Muxer('aac').mimeType).toBe(MP4_TYPES.aac);
  });
});

describe('Fmp4Muxer: ADTS AAC', () => {
  it('builds the AudioSpecificConfig and strips the ADTS header', () => {
    const frames = [
      adtsFrame({ fill: 1, payload: 100 }),
      adtsFrame({ fill: 2, payload: 80 }),
      adtsFrame({ fill: 3, payload: 90 }),
    ];
    const out = new Fmp4Muxer('aac').push(concat(...frames));
    expect(parseInit(out.init!)).toMatchObject({
      timescale: 44100,
      channels: 2,
      objectType: 0x40,
      // AAC-LC (2), 44.1 kHz (index 4), stereo: 00010 0100 0010 000
      specific: [0x12, 0x10],
    });
    const segment = parseSegment(out.fragment!);
    expect(segment.samples.map((s) => s.data.length)).toEqual([100, 80, 90]);
    expect(segment.samples.every((s) => s.duration === 1024)).toBe(true);
    expect(segment.samples[0]!.data.every((b) => b === 1)).toBe(true);
  });

  it('strips the 9-byte header of a frame with a CRC', () => {
    const frames = [
      adtsFrame({ crc: true, payload: 50, fill: 1 }),
      adtsFrame({ crc: true, payload: 60, fill: 2 }),
      adtsFrame({ crc: true, payload: 70, fill: 3 }),
    ];
    const { samples } = muxAll(new Fmp4Muxer('aac'), [concat(...frames)]);
    expect(samples.map((s) => s.length)).toEqual([50, 60, 70]);
  });

  it('reads other rates and layouts: 48 kHz mono, 5.1, 7.1', () => {
    const cases: Array<
      [Parameters<typeof adtsFrame>[0], number, number, number[]]
    > = [
      [{ rateIndex: 3, channelConfig: 1 }, 48000, 1, [0x11, 0x88]],
      [{ rateIndex: 4, channelConfig: 6 }, 44100, 6, [0x12, 0x30]],
      [{ rateIndex: 4, channelConfig: 7 }, 44100, 8, [0x12, 0x38]],
    ];
    for (const [options, rate, channels, config] of cases) {
      const out = new Fmp4Muxer('aac').push(
        concat(adtsFrame(options), adtsFrame(options), adtsFrame(options))
      );
      expect(parseInit(out.init!)).toMatchObject({
        timescale: rate,
        channels,
        specific: config,
      });
    }
  });

  it('carries partial frames, skips ID3 and resyncs', () => {
    const frames = Array.from({ length: 8 }, (_, i) =>
      adtsFrame({ fill: i + 1, payload: 30 + i * 11 })
    );
    const stream = concat(
      id3Tag(64),
      Uint8Array.of(0x00, 0xff, 0x12),
      ...frames
    );
    for (const size of [1, 2, 13, 100, stream.length]) {
      const { samples } = muxAll(new Fmp4Muxer('aac'), chunked(stream, size));
      expect(samples.map((s) => s[0])).toEqual(frames.map((f) => f[7]));
      expect(samples.map((s) => s.length)).toEqual(
        frames.map((f) => f.length - 7)
      );
    }
  });

  it('rejects headers it cannot carry: channel config 0, several raw blocks, bad rate', () => {
    const muxer = new Fmp4Muxer('aac');
    const out = muxer.push(
      concat(
        adtsFrame({ channelConfig: 0 }),
        adtsFrame({ rawBlocks: 1 }),
        adtsFrame({ rateIndex: 13 }),
        adtsFrame({ rateIndex: 15 })
      )
    );
    expect(out.fragment).toBeNull();
  });

  it('stops at a change of layout', () => {
    const out = new Fmp4Muxer('aac').push(
      concat(
        adtsFrame({ fill: 1 }),
        adtsFrame({ fill: 2 }),
        adtsFrame({ channelConfig: 1 }),
        adtsFrame({ channelConfig: 1 })
      )
    );
    expect(out.changed).toBe(true);
    expect(parseSegment(out.fragment!).samples).toHaveLength(2);
  });
});

describe('media segments', () => {
  it('write baseMediaDecodeTime in 64 bits', () => {
    const time = 2 ** 33 + 5;
    const frames = [
      { data: Uint8Array.of(1, 2, 3), samples: 1152 },
      { data: Uint8Array.of(4, 5), samples: 1152 },
    ];
    const segment = mediaSegment(7, time, frames);
    const parsed = parseSegment(segment);
    expect(parsed.baseMediaDecodeTime).toBe(time);
    expect(parsed.sequence).toBe(7);
    expect(parsed.samples.map((s) => Array.from(s.data))).toEqual([
      [1, 2, 3],
      [4, 5],
    ]);
    // moof and mdat tile the buffer exactly.
    expect(boxes(segment).map((b) => b.type)).toEqual(['moof', 'mdat']);
  });

  it('size the moof for the sample count (data offsets point past it)', () => {
    const frames = Array.from({ length: 50 }, (_, i) => ({
      data: new Uint8Array(10 + i).fill(i),
      samples: 576,
    }));
    const parsed = parseSegment(mediaSegment(1, 0, frames));
    expect(parsed.samples).toHaveLength(50);
    parsed.samples.forEach((s, i) => expect(s.data[0]).toBe(i));
  });
});

describe('FrameScanner', () => {
  it('needs a verified header for the first frame, not for the ones that follow', () => {
    const scanner = new FrameScanner(MP3_FORMAT);
    const frame = mp3Frame();
    expect(scanner.scan(frame).frames).toHaveLength(0); // no successor to confirm it
    expect(scanner.pending).toBe(417);
    expect(scanner.scan(frame.subarray(0, 4)).frames).toHaveLength(1);
    expect(scanner.pending).toBe(4);
    // Now in sync: a frame is taken as soon as it is whole.
    expect(scanner.scan(frame.subarray(4)).frames).toHaveLength(1);
    expect(scanner.pending).toBe(0);
  });

  it('keeps a tag header it has only part of', () => {
    const scanner = new FrameScanner(MP3_FORMAT);
    scanner.scan(Uint8Array.of(0x49, 0x44));
    expect(scanner.pending).toBe(2);
    const rest = concat(
      id3Tag(5).subarray(2),
      mp3Frame(),
      mp3Frame(),
      mp3Frame()
    );
    expect(scanner.scan(rest).frames).toHaveLength(3);
  });

  it('is not fooled by an "ID3" that is not a tag', () => {
    const scanner = new FrameScanner(AAC_FORMAT);
    const notATag = Uint8Array.of(0x49, 0x44, 0x33, 0xff, 0, 0, 0, 0, 0, 0, 0);
    const stream = concat(notATag, adtsFrame(), adtsFrame(), adtsFrame());
    expect(scanner.scan(stream).frames).toHaveLength(3);
  });
});
