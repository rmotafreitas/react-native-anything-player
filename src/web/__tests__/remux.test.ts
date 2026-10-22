/// <reference types="node" />
// A browser that takes MP3 and AAC in MSE only inside MP4 (Firefox): the
// stream is remuxed to fragmented MP4 and everything MseStream does for a raw
// stream — ICY titles timed to the audio, splices, backpressure, the
// visualizer — still holds. Driven through `WebModule` on the fake browser.

import {
  FakeMediaSource,
  MP4_AUDIO_TYPES,
  RAW_AUDIO_TYPES,
  install,
  uninstall,
  type FakeWorld,
} from './FakeBrowser';
import { WebModule } from '../platform/WebModule';
import {
  adtsFrame,
  chunked,
  concat,
  mp3Frame,
  parseInit,
} from './audioFixtures';

type Event = Record<string, unknown> & { type: string };

let world: FakeWorld;
let module: WebModule;
let events: Event[];

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await jest.advanceTimersByTimeAsync(0);
}
const ofType = (type: string) => events.filter((e) => e.type === type);
const diagnostics = (id: string) =>
  (module.getDiagnostics(id) as Array<{ event: string }>).map((d) => d.event);

function setup(options: Parameters<typeof install>[0] = {}) {
  world = install({ mediaTypes: MP4_AUDIO_TYPES, ...options });
  module = new WebModule();
  events = [];
  module.onPlayerEvent((e) => events.push(e as Event));
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
  setup();
});

afterEach(() => {
  uninstall();
  jest.useRealTimers();
});

const SECONDS_PER_MP3_FRAME = 1152 / 44100;

/** `count` MP3 frames, each filled with its index (so a sample can be told apart). */
function mp3Frames(count: number, from = 0): Uint8Array {
  return concat(
    ...Array.from({ length: count }, (_, i) => mp3Frame({ fill: from + i }))
  );
}

/** ICY framing: after every `metaint` audio bytes, a block (the title, if `titles` has one for that interval). */
function icy(
  audio: Uint8Array,
  metaint: number,
  titles: Record<number, string> = {}
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let at = 0, n = 0; at + metaint <= audio.length; at += metaint, n++) {
    parts.push(audio.subarray(at, at + metaint));
    const title = titles[n];
    if (title == null) {
      parts.push(Uint8Array.of(0));
      continue;
    }
    const payload = [...new TextEncoder().encode(`StreamTitle='${title}';`)];
    const blocks = Math.ceil(payload.length / 16);
    while (payload.length < blocks * 16) payload.push(0);
    parts.push(Uint8Array.from([blocks, ...payload]));
  }
  return concat(...parts);
}

async function openStream(
  headers: Record<string, string>,
  uri = 'https://radio.example/live'
) {
  world.fetch.respond({ headers });
  const id = module.createPlayer({});
  const loading = module.load(id, { uri }, { autoplay: true });
  loading.catch(() => undefined);
  await flush();
  return {
    id,
    loading,
    element: world.element(),
    body: () => world.fetch.last().body,
    buffer: () => world.element().mediaSource!.buffers[0]!,
  };
}

const ICY = {
  'content-type': 'audio/mpeg',
  'icy-metaint': '2048',
  'icy-name': 'Radio X',
};

describe('choosing the type', () => {
  it('takes the MP4 form for MP3 and remuxes', async () => {
    const { id, buffer, body } = await openStream(ICY);
    expect(buffer().type).toBe('audio/mp4; codecs="mp3"');
    expect(buffer().mode).toBe('sequence');
    expect(diagnostics(id)).toContain('remux');
    body().push(icy(mp3Frames(20), 2048));
    await flush();
    const [first] = buffer().appended;
    // The first append is the init segment followed by the first media segment.
    expect(parseInit(first!.subarray(0, initLength(first!)))).toMatchObject({
      timescale: 44100,
      channels: 2,
      objectType: 0x6b,
    });
    expect(first!.length).toBeGreaterThan(initLength(first!));
    expect(buffer().mp4Errors).toEqual([]);
    expect(buffer().buffered.length).toBe(1);
  });

  it('takes the MP4 form for AAC', async () => {
    const { buffer, body } = await openStream({
      'content-type': 'audio/aacp',
      'icy-metaint': '0',
    });
    expect(buffer().type).toBe('audio/mp4; codecs="mp4a.40.2"');
    body().push(
      concat(
        ...Array.from({ length: 30 }, (_, i) =>
          adtsFrame({ fill: i + 1, payload: 100 })
        )
      )
    );
    await flush();
    expect(buffer().mp4Errors).toEqual([]);
    // 30 frames of 1024 samples at 44.1 kHz, less the last one waiting for a successor... all in sync after the first.
    expect(buffer().buffered.end(0)).toBeCloseTo((30 * 1024) / 44100, 3);
  });

  it('prefers the raw type where the browser takes it', async () => {
    uninstall();
    setup({ mediaTypes: [...RAW_AUDIO_TYPES, ...MP4_AUDIO_TYPES] });
    const { buffer, body, id } = await openStream({
      'content-type': 'audio/mpeg',
    });
    expect(buffer().type).toBe('audio/mpeg');
    const audio = mp3Frames(3);
    body().push(audio);
    await flush();
    expect(Array.from(buffer().appended[0]!)).toEqual(Array.from(audio));
    expect(diagnostics(id)).not.toContain('remux');
  });

  it('plays on the element when the browser takes neither form', async () => {
    uninstall();
    setup({ mediaTypes: [] });
    const { id, element } = await openStream({ 'content-type': 'audio/mpeg' });
    expect(diagnostics(id)).toContain('plain playback');
    expect(element.src).toBe('https://radio.example/live');
  });

  it('plays on the element when the bytes are no MP3 at all', async () => {
    const { id, element, body } = await openStream({
      'content-type': 'audio/mpeg',
    });
    body().push(new Uint8Array(40_000).fill(7));
    await flush();
    expect(diagnostics(id)).not.toContain('plain playback');
    body().push(new Uint8Array(40_000).fill(7));
    await flush();
    expect(diagnostics(id)).toContain('plain playback');
    expect(element.src).toBe('https://radio.example/live');
    // The connection RNAP held is closed; the element reads on its own.
    expect(world.fetch.last().signal.aborted).toBe(true);
  });
});

describe('the stream through the muxer', () => {
  it('times each title to the audio it was sent with, not to the bytes received', async () => {
    const { id, element, body, buffer } = await openStream(ICY);
    element.becomeReady(Number.POSITIVE_INFINITY);
    element.startPlaying();
    // 4096 audio bytes (two intervals) pass before the title; the frames are
    // 417 bytes, so the title belongs to frame ≈ 9.8.
    body().push(icy(mp3Frames(40), 2048, { 1: 'Björk - Jóga' }));
    await flush();
    expect(ofType('metadata').pop()).toMatchObject({
      metadata: { station: 'Radio X' },
    });
    const heardAt = (4096 / 417) * SECONDS_PER_MP3_FRAME;
    expect(buffer().buffered.end(0)).toBeGreaterThan(heardAt);

    element.currentTime = heardAt - 0.05;
    element.dispatch('timeupdate');
    await flush();
    expect(
      ofType('metadata').filter((e) => (e.metadata as { title: unknown }).title)
    ).toHaveLength(0);
    element.currentTime = heardAt + 0.05;
    element.dispatch('timeupdate');
    await flush();
    expect(ofType('metadata').pop()).toMatchObject({
      metadata: { title: 'Jóga', artist: 'Björk' },
    });
    expect(id).toBeDefined();
  });

  it('times a title right when the chunk boundary falls inside a frame', async () => {
    const { element, body } = await openStream(ICY);
    element.becomeReady(Number.POSITIVE_INFINITY);
    element.startPlaying();
    const stream = icy(mp3Frames(40), 2048, { 3: 'A - B' });
    // Cut at arbitrary points (a TCP segment does not know about frames).
    for (const chunk of chunked(stream, 1111)) body().push(chunk);
    await flush();
    const heardAt = (8192 / 417) * SECONDS_PER_MP3_FRAME;
    element.currentTime = heardAt + 0.1;
    element.dispatch('timeupdate');
    await flush();
    expect(ofType('metadata').pop()).toMatchObject({
      metadata: { title: 'B', artist: 'A' },
    });
  });

  it('reports the live offset from the remuxed buffer', async () => {
    const { id, element, body } = await openStream(ICY);
    element.becomeReady(Number.POSITIVE_INFINITY);
    body().push(icy(mp3Frames(40), 2048));
    await flush();
    const offset = (module.getProgress(id) as { liveOffset: number })
      .liveOffset;
    expect(offset).toBeGreaterThan(0.9);
    expect(offset).toBeLessThan(1.1);
  });

  it('waits for room before appending more', async () => {
    const { element, body, buffer } = await openStream(ICY);
    element.becomeReady(Number.POSITIVE_INFINITY);
    // 60 s of audio at once: more than the 30 s of room.
    const frames = Math.ceil(60 / SECONDS_PER_MP3_FRAME);
    body().push(icy(mp3Frames(frames), 2048));
    body().push(icy(mp3Frames(10), 2048));
    await flush();
    // The first 60 s went in; the next chunk waits for the playhead.
    expect(buffer().appended).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(buffer().appended).toHaveLength(1);
    element.currentTime = 50;
    await jest.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(buffer().appended).toHaveLength(2);
    expect(buffer().mp4Errors).toEqual([]);
  });

  it('splices a new connection mid-frame: a fresh init segment, the same timeline', async () => {
    const { id, element, body, buffer } = await openStream(ICY);
    element.becomeReady(Number.POSITIVE_INFINITY);
    element.startPlaying();
    body().push(icy(mp3Frames(60), 2048));
    await flush();
    await jest.advanceTimersByTimeAsync(3_000); // up long enough to earn a splice
    const beforeEnd = buffer().buffered.end(0);
    const startsBefore = buffer().segmentStarts.length;

    world.fetch.respond({ headers: ICY });
    body().fail(new Error('connection reset'));
    await flush();
    expect(world.fetch.requests).toHaveLength(2);
    expect(buffer().aborts).toBe(1);
    expect(diagnostics(id)).toEqual(
      expect.arrayContaining(['connection dropped', 'connection spliced'])
    );

    // The new connection joins the live point in the middle of a frame.
    const resumed = icy(
      concat(mp3Frame({ fill: 200 }).subarray(123), mp3Frames(30, 201)),
      2048
    );
    world.fetch.last().body.push(resumed);
    await flush();

    const spliced = buffer().appended[startsBefore]!;
    // ftyp comes first: the parser was reset, so the init segment is sent again.
    expect(String.fromCharCode(...spliced.subarray(4, 8))).toBe('ftyp');
    expect(buffer().mp4Errors).toEqual([]);
    // One continuous timeline: the second connection's first segment starts
    // where the first connection's last ended.
    const starts = buffer().segmentStarts;
    expect(starts[starts.length - 1]!).toBeGreaterThan(starts[0]!);
    expect(buffer().buffered.end(0)).toBeGreaterThan(beforeEnd);
    expect(ofType('discontinuity')).toHaveLength(0);
    element.currentTime = beforeEnd + 0.01;
    element.dispatch('timeupdate');
    await flush();
    expect(ofType('discontinuity').pop()).toMatchObject({
      position: beforeEnd,
    });
  });

  it('ends the stream when the sample rate changes, and the engine reconnects with a new init segment', async () => {
    const { id, element, body, buffer } = await openStream(ICY);
    element.becomeReady(Number.POSITIVE_INFINITY);
    element.startPlaying();
    const at48k = concat(
      ...Array.from({ length: 20 }, (_, i) =>
        mp3Frame({ rateIndex: 1, fill: 100 + i })
      )
    );
    body().push(icy(concat(mp3Frames(20), at48k), 2048));
    await flush();
    expect(diagnostics(id)).toContain('stream ended');
    expect(world.fetch.requests).toHaveLength(1); // no splice for a format change
    expect(world.fetch.last().signal.aborted).toBe(true);
    expect(element.mediaSource!.readyState).toBe('ended');
    const first = parseInit(
      buffer().appended[0]!.subarray(0, 0 + initLength(buffer().appended[0]!))
    );
    expect(first.timescale).toBe(44100);

    // The element plays out what it has and ends: the engine reconnects,
    // the new MediaSource gets an init segment for 48 kHz.
    world.fetch.respond({ headers: ICY });
    element.dispatch('ended');
    await jest.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(FakeMediaSource.instances.length).toBeGreaterThan(1);
    const second =
      FakeMediaSource.instances[FakeMediaSource.instances.length - 1]!;
    world.fetch.last().body.push(icy(at48k, 2048));
    await flush();
    const init = second.buffers[0]!.appended[0]!;
    expect(parseInit(init.subarray(0, initLength(init))).timescale).toBe(48000);
  });
});

/** Bytes of the init segment at the front of an append (ftyp + moov). */
function initLength(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const ftyp = view.getUint32(0);
  return ftyp + view.getUint32(ftyp);
}
