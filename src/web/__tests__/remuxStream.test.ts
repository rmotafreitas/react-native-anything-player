/// <reference types="node" />
// RemuxStream against conformance/remux/: each container opened through range
// requests on a scripted server, remuxed to fragmented MP4 and appended to a
// fake MediaSource. Covers the sniffing, the track choice (the unplayable
// picture, the sound no browser decodes), the audio and subtitle tracks, the
// seeks (Cues, bitrate guess, buffered ranges), live streams, the eviction and
// back-pressure of the buffer, and every failure and close.

import { FakeMediaSource } from './FakeBrowser';
import {
  Mp4Buffer,
  Mp4MediaSource,
  Rig,
  fixture,
  fragmentsOf,
  settle,
  timescalesOf,
  type RigOptions,
} from './remuxStreamHarness';
import { fragmentStart, sniffContainer } from '../platform/RemuxStream';

const H264 = 'avc1.4D500B';
const HEVC = 'hvc1.1.6.L30.90';
const AAC = 'mp4a.40.2';
const MP3 = 'mp4a.6B';
const ALL = [
  H264,
  HEVC,
  'vp09.00.10.08',
  'av01.0.00M.08',
  AAC,
  MP3,
  'ac-3',
  'ec-3',
  'opus',
  'flac',
];
const without = (...codecs: string[]) => ALL.filter((c) => !codecs.includes(c));

let rig: Rig | null = null;

function open(options: Omit<RigOptions, 'codecs'> & { codecs?: string[] }) {
  rig = new Rig({ codecs: ALL, ...options });
  rig.start();
  return rig;
}

/** The first read stops after `bytes`, as a slow connection would. */
function openStalled(file: string, bytes = 20000) {
  rig = new Rig({ codecs: ALL, file });
  rig.server.next({ stallAfter: bytes });
  rig.start();
  return rig;
}

async function advance(ms: number): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  await settle();
}

const rangesOf = (b: Mp4Buffer) =>
  Array.from({ length: b.buffered.length }, (_, i) => [
    b.buffered.start(i),
    b.buffered.end(i),
  ]);

/** The start (s) of each media segment appended, from the bytes themselves. */
const startsOf = (b: Mp4Buffer) => b.fragments.map((f) => f.start);

/** The file with `from` replaced by `to` (the same length), as the bytes of a file that differs a little. */
function patched(file: string, from: number[], to: number[]): Uint8Array {
  const bytes = fixture(file).slice();
  const at = Buffer.from(bytes).indexOf(Buffer.from(from));
  if (at < 0) throw new Error(`${file} does not hold ${from}`);
  bytes.set(to, at);
  return bytes;
}

const latin1 = (text: string) => [...Buffer.from(text, 'latin1')];

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
});

afterEach(() => {
  rig?.dispose();
  rig = null;
  jest.useRealTimers();
});

describe('sniffContainer', () => {
  const sniff = (file: string, length?: number) =>
    sniffContainer(fixture(file).subarray(0, length));

  test.each([
    ['h264-aac.mkv', 'matroska'],
    ['vp9-opus.webm', 'matroska'],
    ['h264-aac.mpegts', 'mpegts'],
    ['h264-aac.m2ts', 'mpegts'],
  ])('tells %s by its first bytes: %s', (file, format) => {
    expect(sniff(file, 1024)).toBe(format);
  });

  test('finds TS packets that start a few bytes in', () => {
    const bytes = new Uint8Array([
      1,
      2,
      3,
      4,
      5,
      ...fixture('h264-aac.mpegts').subarray(0, 1024),
    ]);
    expect(sniffContainer(bytes)).toBe('mpegts');
  });

  test('needs three packets to call a stream TS', () => {
    expect(sniff('h264-aac.mpegts', 2 * 188)).toBeNull();
  });

  test.each([
    ['nothing', new Uint8Array(0)],
    ['text', new TextEncoder().encode('<html>'.repeat(200))],
    ['zeros', new Uint8Array(2000)],
  ])('finds no container in %s', (_, bytes) => {
    expect(sniffContainer(bytes)).toBeNull();
  });
});

describe('fragmentStart', () => {
  async function appended() {
    open({ file: 'h264-aac.mkv' });
    await settle();
    return rig!.buffer.appended;
  }

  test('reads the time of each fragment the remuxer wrote', async () => {
    const [, ...media] = await appended();
    expect(media.map((m) => fragmentStart(m, [1000, 48000]))).toEqual([
      0, 1, 2,
    ]);
  });

  test('has no time for an init segment', async () => {
    const [init] = await appended();
    expect(fragmentStart(init!, [1000, 48000])).toBeNull();
  });

  test('has no time for a track it does not know', async () => {
    const [, media] = await appended();
    expect(fragmentStart(media!, [])).toBeNull();
  });

  test('has no time for a segment cut short', async () => {
    const [, media] = await appended();
    expect(fragmentStart(media!.subarray(0, 60), [1000, 48000])).toBeNull();
  });
});

describe('opening each container', () => {
  const CASES = [
    ['h264-aac.mkv', 'matroska', `${H264},${AAC}`, 3.023],
    ['h264-aac-laced.mkv', 'matroska', `${H264},${AAC}`, 3.041],
    ['vp9-opus.webm', 'matroska', 'vp09.00.10.08,opus', 3.008],
    ['av1-flac.mkv', 'matroska', 'av01.0.00M.08,flac', 3],
    ['hevc-eac3-mp3.mkv', 'matroska', `${HEVC},ec-3`, 3.025],
    ['h264-aac.mpegts', 'mpegts', `${H264},${AAC}`, 2.92],
    ['h264-aac.m2ts', 'mpegts', `${H264},${AAC}`, 2.92],
    ['hevc-ac3-mp3.mpegts', 'mpegts', `${HEVC},ac-3`, 2.88],
  ] as const;

  test.each(CASES)(
    'plays %s from %s with %s, %s s long',
    async (file, format, codecs, duration) => {
      const r = open({ file });
      await settle();

      expect(r.failures).toEqual([]);
      expect(r.fallbacks).toEqual([]);
      expect(r.notes[0]).toEqual({ event: 'remux', details: { from: format } });
      expect(r.mediaSource.types).toEqual([`video/mp4; codecs="${codecs}"`]);
      expect(r.buffer.inits).toHaveLength(1);
      expect(r.buffer.mp4Errors).toEqual([]);
      expect(startsOf(r.buffer)).toEqual([
        0,
        expect.any(Number),
        expect.any(Number),
      ]);
      expect(rangesOf(r.buffer)).toEqual([[0, 3]]);
      expect(r.mediaSource.duration).toBeCloseTo(duration, 3);
      expect(r.mediaSource.readyState).toBe('ended');
      expect(r.stream.readyInfo()).toEqual({
        duration: r.mediaSource.duration,
        isLive: false,
        seekable: true,
      });
      expect(r.stream.live).toBe(false);
      expect(r.tracksAnnounced).toBe(1);
    }
  );

  test('asks for the file from its first byte, with the source headers', async () => {
    const r = open({
      file: 'h264-aac.mkv',
      headers: { Authorization: 'Bearer abc' },
    });
    await settle();

    expect(r.server.requests[0]).toMatchObject({
      url: 'https://media.example/h264-aac.mkv',
      headers: { Authorization: 'Bearer abc', Range: 'bytes=0-' },
      cache: 'no-store',
      mode: 'cors',
    });
  });

  test('a given format skips the sniffing', async () => {
    const r = open({ file: 'h264-aac.mkv', format: 'matroska' });
    await settle();

    expect(r.mediaSource.readyState).toBe('ended');
    expect(r.notes[0]!.details).toEqual({ from: 'matroska' });
  });

  test('sniffs across chunks smaller than the sniffing window', async () => {
    open({ file: 'h264-aac.mpegts' });
    await settle();
    const whole = Buffer.concat(rig!.buffer.appended);
    rig!.dispose();

    const r = open({ file: 'h264-aac.mpegts' });
    r.server.chunk = 100;
    await settle(30000);

    expect(Buffer.concat(r.buffer.appended).equals(whole)).toBe(true);
  });

  test('the init segment goes in before the first media segment', async () => {
    const r = open({ file: 'vp9-opus.webm' });
    await settle();

    const [init, first] = r.buffer.appended;
    expect([...timescalesOf(init!).values()]).toEqual([1000, 48000]);
    expect(fragmentsOf(first!, timescalesOf(init!))[0]).toMatchObject({
      track: 1,
      start: 0,
    });
  });

  test('a managed media source plays with remote playback off', () => {
    const r = open({ file: 'h264-aac.mkv', managed: true });

    expect(r.element.disableRemotePlayback).toBe(true);
  });

  test('an unmanaged one leaves remote playback alone', () => {
    const r = open({ file: 'h264-aac.mkv' });

    expect(r.element.disableRemotePlayback).toBe(false);
  });

  test('knows nothing of the file before the tracks are read', () => {
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv' });

    expect(rig.stream.readyInfo()).toBeNull();
    expect(rig.stream.live).toBeNull();
    expect(rig.stream.audioTracks).toEqual([]);
  });

  test('an audio player muxes only the sound', async () => {
    const r = open({ file: 'h264-aac.mkv', video: false });
    await settle();

    expect(r.mediaSource.types).toEqual([`audio/mp4; codecs="${AAC}"`]);
    expect(r.failures).toEqual([]);
    expect(r.buffer.buffered.start(0)).toBe(0);
    expect(r.buffer.buffered.end(0)).toBeCloseTo(3.03, 2);
  });
});

describe('what the file does not give away', () => {
  test('a server without ranges is read whole, and a TS duration stays unknown', async () => {
    const r = open({ file: 'h264-aac.mpegts' });
    r.server.ranges = false;
    await settle();

    expect(r.server.requests).toHaveLength(1);
    expect(r.stream.readyInfo()).toEqual({
      duration: null,
      isLive: false,
      seekable: true,
    });
    expect(r.mediaSource.duration).toBeNaN();
    expect(r.mediaSource.readyState).toBe('ended');
  });

  test('a TS duration comes from the last timestamps of the file tail', async () => {
    const r = open({ file: 'h264-aac.mpegts' });
    await settle();

    const size = fixture('h264-aac.mpegts').length;
    expect(r.server.requests[1]).toMatchObject({
      streaming: false,
      range: { from: 0, to: size - 1 },
    });
    expect(r.stream.readyInfo()!.duration).toBeCloseTo(2.92, 2);
  });

  test.each([
    ['fails', { error: new Error('offline') }],
    ['is answered without a range', { status: 200 }],
  ])('a TS tail read that %s leaves the duration unknown', async (_, plan) => {
    const r = open({ file: 'h264-aac.mpegts' });
    r.server.next({});
    r.server.next(plan);
    await settle();

    expect(r.stream.readyInfo()!.duration).toBeNull();
    expect(r.failures).toEqual([]);
    expect(r.mediaSource.readyState).toBe('ended');
  });

  test('a Matroska file whose Cues come after its clusters has them read', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    await settle();

    const size = fixture('h264-aac.mkv').length;
    expect(r.server.requests[1]!.range).toEqual({ from: 50976, to: size - 1 });
    expect(r.notes).toContainEqual({
      event: 'remux cues',
      details: { points: '3' },
    });
  });

  test('Cues that cannot be read are left out', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    r.server.next({});
    r.server.next({ error: new Error('offline') });
    await settle();

    expect(r.events).not.toContain('remux cues');
    expect(r.mediaSource.readyState).toBe('ended');
  });

  test('a server without ranges is not asked for the Cues', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    r.server.ranges = false;
    await settle();

    expect(r.server.requests).toHaveLength(1);
    expect(r.events).not.toContain('remux cues');
  });
});

describe('live streams', () => {
  test('a source flagged live has no length and no seeking', async () => {
    const r = open({ file: 'h264-aac.mpegts', liveHint: true });
    r.server.next({ stallAfter: 30000 });
    await settle();

    expect(r.stream.live).toBe(true);
    expect(r.stream.readyInfo()).toEqual({
      duration: null,
      isLive: true,
      seekable: false,
    });
    expect(r.mediaSource.duration).toBe(Number.POSITIVE_INFINITY);
    expect(r.mediaSource.readyState).toBe('open');
    expect(r.server.requests).toHaveLength(1);
  });

  test('a response without a length is live too', async () => {
    const r = open({ file: 'h264-aac.mpegts' });
    r.server.lengthKnown = false;
    r.server.next({ stallAfter: 30000 });
    await settle();

    expect(r.stream.readyInfo()!.isLive).toBe(true);
  });

  test('a seek in a live stream starts no read', async () => {
    const r = open({ file: 'h264-aac.mpegts', liveHint: true });
    r.server.next({ stallAfter: 30000 });
    await settle();

    r.element.currentTime = 40;
    r.element.dispatch('seeking');
    await settle();

    expect(r.server.requests).toHaveLength(1);
    expect(r.server.requests[0]!.signal!.aborted).toBe(false);
  });

  test('a live stream that ends is reported as recoverable', async () => {
    const r = open({ file: 'h264-aac.mpegts', liveHint: true });
    await settle();

    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      code: 'STREAM_ENDED',
      message: 'The stream ended.',
      recoverable: true,
    });
    expect(r.mediaSource.readyState).toBe('open');
  });
});

describe('the audio track', () => {
  test('lists the tracks the browser can decode', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    await settle();

    expect(r.stream.audioTracks).toEqual([
      { name: 'English', lang: 'eng', default: true },
      { name: 'Português', lang: 'por', default: false },
    ]);
  });

  test('leaves out the tracks it cannot', async () => {
    const r = open({
      file: 'hevc-eac3-mp3.mkv',
      codecs: without(MP3, 'mp3', 'mp4a.69'),
    });
    await settle();

    expect(r.stream.audioTracks).toEqual([{ lang: 'und', default: true }]);
  });

  test('picking the other track muxes it again from the playhead', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    await settle();
    expect(r.buffer.inits).toHaveLength(1);
    const requests = r.server.requests.length;

    r.stream.selectAudio(1);
    await settle();

    expect(r.notes).toContainEqual({
      event: 'audio switch',
      details: { track: '3' },
    });
    expect(r.buffer.aborts).toBe(1);
    expect(r.buffer.removed[0]).toEqual([0, Number.POSITIVE_INFINITY]);
    expect(r.buffer.retyped).toEqual([]);
    expect(r.buffer.inits).toHaveLength(2);
    expect([...timescalesOf(r.buffer.inits[1]!).values()]).toEqual([
      1000, 44100,
    ]);
    expect(r.server.requests).toHaveLength(requests + 1);
    expect(r.server.requests.at(-1)!.range!.from).toBeGreaterThan(0);
    expect(rangesOf(r.buffer)).toEqual([[0, 3]]);
    expect(r.failures).toEqual([]);
  });

  test('picking the track that plays does nothing', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    await settle();
    const requests = r.server.requests.length;

    r.stream.selectAudio(0);
    r.stream.selectAudio(7);
    await settle();

    expect(r.server.requests).toHaveLength(requests);
    expect(r.buffer.aborts).toBe(0);
  });

  test('a track of another codec changes the source buffer type', async () => {
    const r = open({ file: 'hevc-ac3-mp3.mpegts' });
    await settle();

    r.stream.selectAudio(1);
    await settle();

    expect(r.buffer.retyped).toEqual([`video/mp4; codecs="${HEVC},${MP3}"`]);
    expect(r.buffer.inits).toHaveLength(2);
    expect(r.failures).toEqual([]);
  });

  test.each(['mp3', 'mp4a.69'])(
    'MP3 goes in under the name %s when the browser takes only that',
    async (name) => {
      const r = open({
        file: 'hevc-ac3-mp3.mpegts',
        codecs: [...without(MP3), name],
      });
      await settle();

      r.stream.selectAudio(1);
      await settle();

      expect(r.buffer.retyped).toEqual([`video/mp4; codecs="${HEVC},${name}"`]);
    }
  );

  test('a browser that cannot retype its buffer keeps the track playing', async () => {
    const r = open({ file: 'hevc-ac3-mp3.mpegts' });
    Mp4MediaSource.changeType = false;
    await settle();
    const requests = r.server.requests.length;

    r.stream.selectAudio(1);
    await settle();

    expect(r.notes).toContainEqual({
      event: 'audio switch skipped',
      details: { reason: 'no SourceBuffer.changeType' },
    });
    expect(r.buffer.aborts).toBe(0);
    expect(r.server.requests).toHaveLength(requests);
  });

  test('a stream closed while the switch begins reads nothing more', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    await settle();
    const requests = r.server.requests.length;

    r.stream.selectAudio(1);
    r.stream.close();
    await settle();

    expect(r.server.requests).toHaveLength(requests);
    expect(r.buffer.inits).toHaveLength(1);
  });

  test('a pick before the tracks are known is ignored', () => {
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv' });

    rig.stream.selectAudio(1);

    expect(rig.server.requests).toHaveLength(0);
  });
});

describe('subtitles', () => {
  test('the Matroska subtitle tracks load into hidden text tracks', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    await settle();

    expect(
      r.subtitles.map((t) => [t.kind, t.label, t.language, t.mode])
    ).toEqual([
      ['subtitles', '', 'eng', 'disabled'],
      ['subtitles', 'Styled', 'por', 'disabled'],
    ]);
    expect(r.stream.subtitleTracks).toEqual([
      { name: undefined, lang: 'eng', default: false, forced: false },
      { name: 'Styled', lang: 'por', default: false, forced: false },
    ]);
  });

  test('SubRip and ASS cues are added with their times and text', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    await settle();

    const [srt, ass] = r.subtitles;
    expect(srt!.cues.map((c) => [c.startTime, c.endTime, c.text])).toEqual([
      [0.5, 1.5, 'Hello <i>there</i>'],
      [2, 2.8, 'Second line\ntwo rows'],
    ]);
    expect(ass!.cues.map((c) => [c.startTime, c.endTime, c.text])).toEqual([
      [0.6, 1.4, '<b>Bold</b> words'],
      [2.1, 2.9, 'On top'],
    ]);
  });

  test('an ASS cue with a top alignment is placed at the top', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    await settle();

    const [plain, top] = r.subtitles[1]!.cues;
    expect(plain).toMatchObject({ line: 'auto', align: 'center' });
    expect(top).toMatchObject({ line: 0, align: 'center' });
  });

  test('an ASS cue aligned to the middle is centred', async () => {
    const bytes = patched('h264-aac.mkv', latin1('{\\an8}'), latin1('{\\an5}'));
    const r = open({ file: 'h264-aac.mkv', bytes });
    await settle();

    expect(r.subtitles[1]!.cues[1]).toMatchObject({
      snapToLines: false,
      line: 50,
      lineAlign: 'center',
    });
  });

  test('an ASS cue with a position is placed there', async () => {
    const bytes = patched(
      'h264-aac.mkv',
      latin1('{\\b1}Bold{\\b0}'),
      latin1('{\\pos(96,72)}A')
    );
    const r = open({ file: 'h264-aac.mkv', bytes });
    await settle();

    const cue = r.subtitles[1]!.cues[0]!;
    expect(cue).toMatchObject({ text: 'A words', snapToLines: false });
    expect(cue.position).toBeCloseTo(25, 5);
    expect(cue.line).toBeCloseTo(25, 5);
  });

  test('cues read again after a seek are not added twice', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    await settle();

    r.stream.selectAudio(1);
    await settle();

    expect(r.subtitles.map((t) => t.cues.length)).toEqual([2, 2]);
  });

  test('picking a subtitle track shows it hidden and disables the others', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    await settle();

    r.stream.selectSubtitles(1);
    expect(r.subtitles.map((t) => t.mode)).toEqual(['disabled', 'hidden']);

    r.stream.selectSubtitles(0);
    expect(r.subtitles.map((t) => t.mode)).toEqual(['hidden', 'disabled']);

    r.stream.selectSubtitles(-1);
    expect(r.subtitles.map((t) => t.mode)).toEqual(['disabled', 'disabled']);
  });

  test('a browser without VTTCue gets the tracks and no cues', async () => {
    const r = open({ file: 'h264-aac.mkv', noVttCue: true });
    await settle();

    expect(r.subtitles).toHaveLength(2);
    expect(r.subtitles.map((t) => t.cues.length)).toEqual([0, 0]);
  });

  test('an audio element has no text tracks to fill', async () => {
    const r = open({ file: 'h264-aac.mkv', audioElement: true, video: false });
    await settle();

    expect(r.stream.subtitleTracks).toEqual([]);
    expect(r.failures).toEqual([]);
    expect(() => r.stream.selectSubtitles(0)).not.toThrow();
  });

  test('a file without subtitles lists none', async () => {
    const r = open({ file: 'vp9-opus.webm' });
    await settle();

    expect(r.subtitles).toEqual([]);
    expect(r.stream.subtitleTracks).toEqual([]);
  });
});

describe('the picture and the sound the browser cannot play', () => {
  test('a picture no codec of the browser plays fails the stream', async () => {
    const r = open({ file: 'hevc-ac3-mp3.mpegts', codecs: without(HEVC) });
    await settle();

    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      message: `This browser cannot play the picture (${HEVC}).`,
      recoverable: false,
    });
    expect(r.stream.failed).toBe(true);
    expect(r.mediaSource.buffers).toHaveLength(0);
    expect(r.server.streams[0]!.signal!.aborted).toBe(true);
  });

  test('a failed stream starts no read for a seek', async () => {
    const r = open({ file: 'hevc-ac3-mp3.mpegts', codecs: without(HEVC) });
    await settle();

    r.element.currentTime = 2;
    r.element.dispatch('seeking');
    r.element.dispatch('timeupdate');
    await settle();

    expect(r.failures).toHaveLength(1);
    expect(r.server.streams).toHaveLength(1);
  });

  test('an audio player given a file of nothing it can play fails', async () => {
    const r = open({
      file: 'h264-aac.mpegts',
      video: false,
      codecs: without(AAC),
    });
    await settle();

    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      message: `This browser cannot play no playable track (video ${H264}, audio ${AAC}).`,
      recoverable: false,
    });
    expect(r.warnings).toEqual([]);
  });

  test.each([
    ['hevc-eac3-mp3.mkv', ['ec-3', MP3], 'E-AC-3'],
    ['av1-flac.mkv', ['flac'], 'FLAC'],
    ['hevc-ac3-mp3.mpegts', ['ac-3', MP3], 'AC-3'],
    ['vp9-opus.webm', ['opus'], 'Opus'],
    ['h264-aac.mpegts', [AAC], AAC],
  ])(
    'a sound no browser decodes in %s is reported and the picture plays',
    async (file, dropped, name) => {
      const r = open({ file, codecs: without(...dropped) });
      await settle();

      expect(r.failures).toEqual([]);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatchObject({
        code: 'UNSUPPORTED_FORMAT',
        message: `This browser cannot decode the sound (${name}). The picture plays without it.`,
        recoverable: false,
      });
      expect(r.mediaSource.types[0]).toMatch(/^video\/mp4; codecs="[^,]+"$/);
      expect(rangesOf(r.buffer)).toEqual([[0, 3]]);
      expect(r.stream.audioTracks).toEqual([]);
      expect(r.mediaSource.readyState).toBe('ended');
    }
  );

  test('a listener without onWarning still plays the picture', async () => {
    const r = open({
      file: 'vp9-opus.webm',
      codecs: without('opus'),
      full: false,
    });
    await settle();

    expect(r.warnings).toEqual([]);
    expect(r.failures).toEqual([]);
    expect(rangesOf(r.buffer)).toEqual([[0, 3]]);
  });

  test('a file with sound no browser decodes is not reported when only sound is wanted', async () => {
    const r = open({
      file: 'vp9-opus.webm',
      video: false,
      codecs: without('opus'),
    });
    await settle();

    expect(r.warnings).toEqual([]);
    expect(r.failures).toHaveLength(1);
  });
});

describe('the network', () => {
  test.each([
    [404, 'SOURCE_NOT_FOUND', false],
    [410, 'SOURCE_NOT_FOUND', false],
    [403, 'HTTP_ERROR', false],
    [503, 'HTTP_ERROR', true],
  ])('an HTTP %i fails with %s', async (status, code, recoverable) => {
    const r = open({ file: 'h264-aac.mkv' });
    r.server.next({ status });
    await settle();

    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      code,
      recoverable,
      httpStatus: status,
    });
    expect(r.server.requests[0]!.cancelled).toBe(true);
    expect(r.mediaSource.buffers).toHaveLength(0);
  });

  test('an answer without a body fails', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    r.server.next({ noBody: true });
    await settle();

    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      message: 'The response had no body.',
      recoverable: false,
    });
  });

  test('a fetch the server refuses hands the file to the element', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    r.server.next({ error: new TypeError('Failed to fetch') });
    await settle();

    expect(r.fallbacks).toEqual([
      'fetch failed (CORS or network): TypeError: Failed to fetch',
    ]);
    expect(r.failures).toEqual([]);
    expect(r.stream.failed).toBe(false);
  });

  test('a file that is neither Matroska nor MPEG-TS goes to the element', async () => {
    const r = open({
      file: 'h264-aac.mkv',
      bytes: new TextEncoder().encode('<html>'.repeat(300)),
    });
    await settle();

    expect(r.fallbacks).toEqual(['neither Matroska nor MPEG-TS']);
    expect(r.failures).toEqual([]);
    expect(r.mediaSource.buffers).toHaveLength(0);
    expect(r.server.streams[0]!.cancelled).toBe(true);
  });

  test('a file shorter than the sniffing window is judged when it ends', async () => {
    const r = open({
      file: 'h264-aac.mkv',
      bytes: new TextEncoder().encode('not media'),
    });
    await settle();

    expect(r.fallbacks).toEqual(['neither Matroska nor MPEG-TS']);
    expect(r.failures).toEqual([]);
  });

  test('a connection that drops mid-file is a recoverable network error', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    r.server.next({ dropAfter: 20000 });
    await settle();

    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'The connection dropped.',
      recoverable: true,
      nativeCause: 'Error: connection reset',
    });
  });

  test('a read for a seek that cannot reach the server fails', async () => {
    const r = openStalled('h264-aac.mkv');
    r.server.next({});
    r.server.next({ error: new TypeError('offline') });
    await settle();

    r.element.currentTime = 2.5;
    r.element.dispatch('seeking');
    await settle();

    expect(r.fallbacks).toEqual([]);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'The file could not be reached.',
      recoverable: true,
      nativeCause: 'TypeError: offline',
    });
  });
});

describe('the buffer', () => {
  test('a source buffer the browser refuses fails the stream', async () => {
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv' });
    FakeMediaSource.failAdd = true;
    rig.start();
    await settle();

    expect(rig.failures).toHaveLength(1);
    expect(rig.failures[0]).toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      message: `This browser cannot play video/mp4; codecs="${H264},${AAC}".`,
      recoverable: false,
      nativeCause: 'Error: NotSupportedError',
    });
  });

  test('a media source that rejects the duration fails the remux', async () => {
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv' });
    Mp4MediaSource.rejectDuration = true;
    rig.start();
    await settle();

    expect(rig.failures).toHaveLength(1);
    expect(rig.failures[0]).toMatchObject({
      code: 'DECODER_ERROR',
      message: 'The file could not be remuxed.',
      recoverable: false,
    });
    expect(rig.failures[0]!.nativeCause).toContain('not open');
  });

  test('an append the browser refuses fails the stream', async () => {
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv' });
    Mp4MediaSource.created = (buffer) => {
      buffer.appendError = new Error('decode error');
    };
    rig.start();
    await settle();

    expect(rig.failures).toHaveLength(1);
    expect(rig.failures[0]).toMatchObject({
      code: 'DECODER_ERROR',
      message: 'The remuxed media could not be played.',
      recoverable: false,
      nativeCause: 'Error: decode error',
    });
  });

  test('a full buffer is tried again after a second', async () => {
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv' });
    Mp4MediaSource.created = (buffer) => {
      buffer.quotaFailures = 2;
    };
    rig.start();
    await settle();
    expect(rig.buffer.appended).toHaveLength(0);

    await advance(1000);
    expect(rig.buffer.appended).toHaveLength(0);

    await advance(1000);
    expect(rig.buffer.appended.length).toBeGreaterThan(1);
    expect(rig.failures).toEqual([]);
    expect(rig.mediaSource.readyState).toBe('ended');
  });

  test('a buffer that stays full fails after three tries', async () => {
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv' });
    Mp4MediaSource.created = (buffer) => {
      buffer.quotaFailures = 3;
    };
    rig.start();
    await settle();
    await advance(3000);

    expect(rig.failures).toHaveLength(1);
    expect(rig.failures[0]).toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'The buffer stayed full.',
      recoverable: true,
    });
    expect(rig.buffer.appended).toHaveLength(0);
  });

  test('reading waits while more than 30 s are buffered ahead', async () => {
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv' });
    Mp4Buffer.stretch = 40;
    rig.start();
    await settle();
    expect(rig.buffer.appended).toHaveLength(2);

    await advance(5000);
    expect(rig.buffer.appended).toHaveLength(2);

    Mp4Buffer.stretch = 0;
    await advance(500);
    expect(rig.buffer.appended).toHaveLength(4);
    expect(rig.mediaSource.readyState).toBe('ended');
  });

  test('what is more than 30 s behind the playhead is evicted', async () => {
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv' });
    rig.element.currentTime = 45;
    rig.start();
    await settle();

    expect(rig.buffer.removed[0]).toEqual([0, 15]);
    expect(rig.failures).toEqual([]);
  });

  test('what is less than that behind is kept', async () => {
    open({ file: 'h264-aac.mkv' });
    await settle();

    expect(rig!.buffer.removed).toEqual([]);
  });
});

describe('seeking', () => {
  const MKV = fixture('h264-aac.mkv');

  test('a seek inside the buffer reads nothing', async () => {
    const r = openStalled('h264-aac.mpegts', 40000);
    await settle();
    const requests = r.server.requests.length;
    expect(rangesOf(r.buffer)).toEqual([[0, 2]]);

    r.element.currentTime = 1.5;
    r.element.dispatch('seeking');
    await settle();

    expect(r.server.requests).toHaveLength(requests);
  });

  test('a seek in a Matroska file reads from the cluster its Cues name', async () => {
    const r = openStalled('h264-aac.mkv');
    await settle();
    expect(startsOf(r.buffer)).toEqual([0]);

    r.element.currentTime = 2.5;
    r.element.dispatch('seeking');
    await settle();

    const read = r.server.streams.at(-1)!;
    expect(read.range).toEqual({ from: 33300, to: null });
    expect([...MKV.subarray(33300, 33304)]).toEqual([0x1f, 0x43, 0xb6, 0x75]);
    expect(r.server.streams[0]!.signal!.aborted).toBe(true);
    expect(startsOf(r.buffer)).toEqual([0, 2]);
    expect(rangesOf(r.buffer)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(r.element.currentTime).toBe(2.5);
    expect(r.mediaSource.readyState).toBe('ended');
    expect(r.failures).toEqual([]);
  });

  test('a seek in a TS file reads from the byte its bitrate suggests', async () => {
    const r = openStalled('h264-aac.mpegts');
    await settle();
    const size = fixture('h264-aac.mpegts').length;
    const guess = Math.floor(((2.5 - 2) * (size / 2.92)) / 188) * 188;

    r.element.currentTime = 2.5;
    r.element.dispatch('seeking');
    await settle();

    expect(r.server.streams.at(-1)!.range).toEqual({ from: guess, to: null });
    expect(startsOf(r.buffer)).toEqual([0, 1, 2]);
    expect(r.element.currentTime).toBe(2.5);
    expect(r.failures).toEqual([]);
  });

  test('a Matroska file without readable Cues is sought by its bitrate', async () => {
    const r = openStalled('h264-aac.mkv');
    r.server.next({ error: new Error('offline') });
    await settle();
    const size = MKV.length;
    const guess = Math.floor(((2.5 - 2) * (size / 3.023)) / 188) * 188;

    r.element.currentTime = 2.5;
    r.element.dispatch('seeking');
    await settle();

    expect(r.server.streams.at(-1)!.range).toEqual({ from: guess, to: null });
    expect(guess).toBeGreaterThan(1629);
  });

  test('a seek on a server without ranges reads the file again from the start', async () => {
    const r = openStalled('h264-aac.mkv');
    r.server.ranges = false;
    await settle();

    r.element.currentTime = 2.5;
    r.element.dispatch('seeking');
    await settle();

    const read = r.server.streams.at(-1)!;
    expect(read.range).toBeNull();
    expect(read.headers.Range).toBeUndefined();
    expect(startsOf(r.buffer)).toEqual([0, 0, 1, 2]);
    expect(r.failures).toEqual([]);
  });

  test('a seek that keeps landing far before its target is tried three times, then played', async () => {
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mpegts' });
    // The server under-reports the length: the bitrate guess is far off.
    rig.server.next({ stallAfter: 20000, length: 5752 });
    rig.start();
    await settle();

    rig.element.currentTime = 40;
    rig.element.dispatch('seeking');
    await settle();

    const misses = rig.notes.filter((n) => n.event === 'remux seek');
    expect(misses).toHaveLength(3);
    expect(misses[0]!.details).toEqual({ target: '40.0', landed: '1.0' });
    const reads = rig.server.streams.slice(1);
    expect(reads.map((r) => r.signal!.aborted)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(startsOf(rig.buffer)).toEqual([0, 1, 2]);
    expect(rig.failures).toEqual([]);
    expect(rig.mediaSource.readyState).toBe('ended');
  });

  test('a Cue that names a cluster whose first keyframe is later moves the playhead there', async () => {
    // The third cluster's Cue claims it starts at 1.2 s; its keyframe is at 2 s.
    const bytes = patched(
      'h264-aac.mkv',
      [0xb3, 0x82, 0x07, 0xd0],
      [0xb3, 0x82, 0x04, 0xb0]
    );
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv', bytes });
    rig.server.next({ stallAfter: 20000 });
    rig.start();
    await settle();

    rig.element.currentTime = 1.5;
    rig.element.dispatch('seeking');
    await settle();

    expect(rig.server.streams.at(-1)!.range!.from).toBe(33300);
    expect(startsOf(rig.buffer)).toEqual([0, 2]);
    expect(rig.element.currentTime).toBe(2);
    expect(rig.failures).toEqual([]);
  });

  test('a seek is ignored before the tracks are known', async () => {
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv' });
    rig.server.next({ stallAfter: 100 });
    rig.start();
    await settle();

    rig.element.currentTime = 2;
    rig.element.dispatch('seeking');
    await settle();

    expect(rig.server.requests).toHaveLength(1);
    expect(rig.server.requests[0]!.signal!.aborted).toBe(false);
  });
});

describe('reading on after a seek', () => {
  /** [0, 1] and [2, 3] buffered by a seek to 2.5, the first part trimmed to [0, 0.5]. */
  async function twoRanges() {
    const r = openStalled('h264-aac.mkv');
    await settle();
    r.element.currentTime = 2.5;
    r.element.dispatch('seeking');
    await settle();
    r.buffer.remove(0.5, 1);
    await settle();
    return r;
  }

  test('a playhead near the end of a range the reader is not filling resumes reading there', async () => {
    const r = await twoRanges();
    const reads = r.server.streams.length;

    r.element.currentTime = 0.3;
    r.element.dispatch('timeupdate');
    await settle();

    expect(r.notes).toContainEqual({
      event: 'remux continue',
      details: { at: '0.5' },
    });
    expect(r.server.streams).toHaveLength(reads + 1);
    expect(r.server.streams.at(-1)!.range!.from).toBe(1629);
    expect(rangesOf(r.buffer)).toEqual([[0, 3]]);
    expect(r.element.currentTime).toBe(0.3);
  });

  test('a playhead in the range the reader fills starts nothing', async () => {
    const r = await twoRanges();
    const reads = r.server.streams.length;

    r.element.currentTime = 2.2;
    r.element.dispatch('timeupdate');
    await settle();

    expect(r.events).not.toContain('remux continue');
    expect(r.server.streams).toHaveLength(reads);
  });

  test('a playhead outside every range starts nothing', async () => {
    const r = await twoRanges();
    const reads = r.server.streams.length;

    r.element.currentTime = 1.5;
    r.element.dispatch('timeupdate');
    await settle();

    expect(r.events).not.toContain('remux continue');
    expect(r.server.streams).toHaveLength(reads);
  });

  test('a playhead far from the end of its range waits', async () => {
    const r = openStalled('h264-aac.mkv');
    await settle();
    Mp4Buffer.stretch = 40;
    r.element.currentTime = 2.5;
    r.element.dispatch('seeking');
    await settle();
    const reads = r.server.streams.length;

    r.element.currentTime = 0.1;
    r.element.dispatch('timeupdate');
    await settle();

    expect(r.events).not.toContain('remux continue');
    expect(r.server.streams).toHaveLength(reads);
  });
});

describe('closing', () => {
  test('stops the read, frees the object URL and removes the listeners', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    r.server.next({ stallAfter: 20000 });
    await settle();
    const revoke = jest.spyOn(URL, 'revokeObjectURL');

    r.stream.selectSubtitles(0);
    r.stream.close();
    await settle();

    expect(r.server.streams[0]!.signal!.aborted).toBe(true);
    expect(revoke).toHaveBeenCalledWith(r.element.srcHistory[0]);
    expect(r.element.listenerCount('seeking')).toBe(0);
    expect(r.element.listenerCount('timeupdate')).toBe(0);
    expect(r.subtitles.map((t) => t.mode)).toEqual(['disabled', 'disabled']);
    expect(r.failures).toEqual([]);
    expect(jest.getTimerCount()).toBe(0);
    revoke.mockRestore();
  });

  test('twice does nothing more', async () => {
    const r = open({ file: 'h264-aac.mkv' });
    await settle();
    const revoke = jest.spyOn(URL, 'revokeObjectURL');

    r.stream.close();
    r.stream.close();

    expect(revoke).toHaveBeenCalledTimes(1);
    revoke.mockRestore();
  });

  test('before the media source opens reads nothing', async () => {
    const r = open({ file: 'h264-aac.mkv' });

    r.stream.close();
    await settle();

    expect(r.server.requests).toHaveLength(0);
    expect(r.failures).toEqual([]);
  });

  test('ignores a seek and a time update that follow', async () => {
    const r = openStalled('h264-aac.mkv');
    await settle();
    r.stream.close();
    const requests = r.server.requests.length;

    r.element.currentTime = 2.5;
    r.element.dispatch('seeking');
    r.element.dispatch('timeupdate');
    await settle();

    expect(r.server.requests).toHaveLength(requests);
  });

  test('during a fetch that has not answered discards the answer when it comes', async () => {
    let answer = () => {};
    const gate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv' });
    rig.server.next({ gate });
    rig.start();
    await settle();

    rig.stream.close();
    answer();
    await settle();

    expect(rig.failures).toEqual([]);
    expect(rig.mediaSource.buffers).toHaveLength(0);
    expect(rig.server.requests[0]!.cancelled).toBe(true);
  });

  test('during a fetch that then fails reports nothing', async () => {
    let answer = () => {};
    const gate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    rig = new Rig({ codecs: ALL, file: 'h264-aac.mkv' });
    rig.server.next({ gate, error: new TypeError('Failed to fetch') });
    rig.start();
    await settle();

    rig.stream.close();
    answer();
    await settle();

    expect(rig.failures).toEqual([]);
    expect(rig.fallbacks).toEqual([]);
  });
});
