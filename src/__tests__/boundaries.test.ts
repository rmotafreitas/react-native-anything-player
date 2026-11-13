import { BoundaryFinder, type BoundaryWindow } from '../core/boundaries';
import { BoundaryTracker } from '../core/boundaryTracker';
import type { AudioSample, StreamBoundary } from '../types';

// Audio as a station sends it: 4096-frame windows (44.1 kHz) of 128 points,
// built from stretches of music, silence between items (MP3 decodes it to
// zeros; HE-AAC to about −111 dB), a file's own quiet start (−94 dB), and
// fade-out tails. Times are ms from the start of the audio.
const WINDOW_MS = (4096 / 44100) * 1000;
const POINTS = 128;
type Kind = 'music' | 'zeros' | 'aacGap' | 'dither' | 'smeared' | 'tail';
const AMPLITUDE: Record<Kind, number> = {
  music: 0.1, // −20 dB
  zeros: 0,
  aacGap: 10 ** (-111 / 20),
  dither: 10 ** (-94 / 20),
  smeared: 10 ** (-100 / 20),
  tail: 10 ** (-104 / 20),
};

/** Windows for consecutive stretches `[kind, ms]`, from `base` (epoch ms). */
function audio(
  stretches: Array<[Kind, number]>,
  base = 1_000_000
): BoundaryWindow[] {
  const edges: Array<{ until: number; kind: Kind }> = [];
  let t = 0;
  for (const [kind, ms] of stretches) edges.push({ until: (t += ms), kind });
  const total = t;
  const kindAt = (ms: number) =>
    edges.find((e) => ms < e.until)?.kind ?? 'music';
  const windows: BoundaryWindow[] = [];
  let seed = 7;
  const noise = () =>
    ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let at = 0; at < total; at += WINDOW_MS) {
    const points: number[] = [];
    for (let i = 0; i < POINTS; i++) {
      const ms = at + (i / POINTS) * WINDOW_MS;
      points.push(AMPLITUDE[kindAt(ms)] * Math.SQRT2 * noise());
    }
    windows.push({ at: base + at, duration: WINDOW_MS, points });
  }
  return windows;
}

/** Feeds windows, giving titles `[title, ms]` as their time comes; returns the boundaries, relative to `base`. */
function run(
  windows: BoundaryWindow[],
  titles: Array<[string, number]>,
  base = 1_000_000
) {
  const finder = new BoundaryFinder();
  const found: Array<Pick<StreamBoundary, 'title' | 'kind'> & { at: number }> =
    [];
  const keep = (b: StreamBoundary | null) => {
    if (b)
      found.push({ title: b.title, kind: b.kind, at: Math.round(b.at - base) });
  };
  const pending = [...titles];
  for (const w of windows) {
    while (pending.length && base + pending[0]![1] <= w.at) {
      const [title, at] = pending.shift()!;
      keep(finder.title(title, base + at));
    }
    keep(finder.push(w));
  }
  return found;
}

const near = (ms: number) => expect.closeTo(ms, -1.5); // within ±16 ms

describe('BoundaryFinder', () => {
  it('a title sent early: the item starts where the gap after it ends', () => {
    const w = audio([
      ['music', 3_000],
      ['zeros', 600],
      ['dither', 700],
      ['music', 3_000],
    ]);
    // The title comes 1.5 s before the new file's first frame (3.6 s).
    expect(run(w, [['Song', 2_100]])).toEqual([
      { title: 'Song', kind: 'gap', at: near(3_600) },
    ]);
  });

  it('a title sent late: the gap before it, found as the title is heard', () => {
    const w = audio([
      ['music', 3_000],
      ['zeros', 300],
      ['music', 4_000],
    ]);
    expect(run(w, [['Song', 4_600]])).toEqual([
      { title: 'Song', kind: 'gap', at: near(3_300) },
    ]);
  });

  it('an HE-AAC gap (not zeros) ends at the new file, not at its music', () => {
    const w = audio([
      ['music', 3_000],
      ['aacGap', 500],
      ['dither', 800],
      ['music', 3_000],
    ]);
    expect(run(w, [['Song', 3_200]])).toEqual([
      { title: 'Song', kind: 'gap', at: near(3_500) },
    ]);
  });

  it('a blip in a fade-out tail is no gap', () => {
    const w = audio([
      ['music', 2_000],
      ['tail', 200],
      ['aacGap', 120],
      ['dither', 12],
      ['tail', 300],
      ['zeros', 400],
      ['music', 3_000],
    ]);
    expect(run(w, [['Song', 2_800]])).toEqual([
      { title: 'Song', kind: 'gap', at: near(3_032) },
    ]);
  });

  it('a short gap HE-AAC smeared: a cut from near silence to full level', () => {
    const w = audio([
      ['music', 3_000],
      ['smeared', 60],
      ['music', 4_000],
    ]);
    expect(run(w, [['Song', 4_000]])).toEqual([
      { title: 'Song', kind: 'gap', at: near(3_060) },
    ]);
  });

  it("a jingle starts at its onset; the song after it at its own gap, not the jingle's start", () => {
    const w = audio([
      ['music', 2_000],
      ['dither', 1_300],
      ['music', 2_200], // the jingle, after a fade to quiet
      ['dither', 500],
      ['zeros', 450],
      ['music', 3_000],
    ]);
    // The jingle's title 1.65 s before its sound; the song's 2.4 s before its gap ends.
    expect(
      run(w, [
        ['Jingle', 1_650],
        ['Song', 4_050],
      ])
    ).toEqual([
      { title: 'Jingle', kind: 'onset', at: near(3_300) },
      { title: 'Song', kind: 'gap', at: near(6_450) },
    ]);
  });

  it('music running straight on: the title is all there is, once the search is over', () => {
    const w = audio([['music', 9_000]]);
    expect(run(w, [['Song', 2_000]])).toEqual([
      { title: 'Song', kind: 'title', at: 2_000 },
    ]);
  });

  it('a title superseded before its search ends settles with what was heard', () => {
    const w = audio([['music', 9_000]]);
    expect(
      run(w, [
        ['A', 1_000],
        ['B', 2_000],
      ])
    ).toEqual([
      { title: 'A', kind: 'title', at: 1_000 },
      { title: 'B', kind: 'title', at: 2_000 },
    ]);
  });
});

describe('BoundaryTracker', () => {
  const sample = (w: BoundaryWindow): AudioSample => ({
    waveform: Array.from(w.points),
    level: 0,
    duration: w.duration / 1000,
    // Decoded 120 ms before it is heard.
    outputLatency: 0.12,
    timestamp: w.at - 120,
  });
  const metadata = (title: string, at: number) => ({
    raw: { StreamTitle: title },
    timestamp: at,
  });

  it('shares the sampling: detection alone asks for a few points, the app its own', () => {
    const configure = jest.fn(() => true);
    const t = new BoundaryTracker(() => {}, configure);
    expect(t.setDetection(true)).toBe(true);
    expect(configure).toHaveBeenLastCalledWith(true, 128);
    t.setAppSampling(true, 1024);
    expect(configure).toHaveBeenLastCalledWith(true, 1024);
    t.setAppSampling(false, 1024);
    expect(configure).toHaveBeenLastCalledWith(true, 128);
    t.setDetection(false);
    expect(configure).toHaveBeenLastCalledWith(false, 128);
  });

  it("without the lag, a connection's first title is not searched; later ones are", () => {
    const found: StreamBoundary[] = [];
    const t = new BoundaryTracker(
      (b) => found.push(b),
      () => true
    );
    t.setDetection(true);
    const base = 1_000_000;
    const windows = audio(
      [
        ['music', 3_000],
        ['zeros', 400],
        ['music', 3_000],
      ],
      base
    );
    t.metadata(metadata('Playing at tune-in', base + 500));
    for (const w of windows) {
      if (w.at >= base + 2_000 && w.at < base + 2_000 + WINDOW_MS)
        t.metadata(metadata('Next', base + 2_000));
      t.sample(sample(w));
    }
    expect(found).toEqual([
      {
        title: 'Next',
        titleAt: base + 2_000,
        at: near(base + 3_400),
        kind: 'gap',
      },
    ]);
    // A reconnect: the next title is a tune-in again.
    t.reset();
    t.metadata(metadata('After reconnect', base + 7_000));
    expect(found).toHaveLength(1);
  });

  it("finds a connection's first item when it started in the audio from before live", () => {
    const found: StreamBoundary[] = [];
    // The connection opens 5 s behind live.
    const t = new BoundaryTracker(
      (b) => found.push(b),
      () => true,
      () => ({ ms: 5_000, settled: true })
    );
    t.setDetection(true);
    const base = 1_000_000;
    // The item named at connect started 2.6 s into what is heard first.
    const windows = audio(
      [
        ['music', 2_000],
        ['zeros', 600],
        ['music', 6_000],
      ],
      base
    );
    t.metadata(metadata('Started just before tune-in', base + 50));
    for (const w of windows) t.sample(sample(w));
    expect(found).toEqual([
      {
        title: 'Started just before tune-in',
        titleAt: base + 50,
        at: near(base + 2_600),
        kind: 'gap',
      },
    ]);
  });

  it("a connection's first item starts at the last gap of its opening audio, told once that was heard", () => {
    const found: StreamBoundary[] = [];
    const t = new BoundaryTracker(
      (b) => found.push(b),
      () => true,
      () => ({ ms: 5_000, settled: true })
    );
    t.setDetection(true);
    const base = 1_000_000;
    // A jingle started 1 s into what is heard first, the item named 3.4 s in.
    const windows = audio(
      [
        ['music', 800],
        ['zeros', 200],
        ['music', 2_000],
        ['zeros', 400],
        ['music', 5_000],
      ],
      base
    );
    t.metadata(metadata('After a jingle', base + 50));
    for (const w of windows) {
      t.sample(sample(w));
      // Not while a later gap may still come.
      if (w.at < base + 4_800) expect(found).toEqual([]);
    }
    expect(found).toEqual([
      {
        title: 'After a jingle',
        titleAt: base + 50,
        at: near(base + 3_400),
        kind: 'gap',
      },
    ]);
  });

  it('searches the opening audio as far as the lag grows while the burst arrives', () => {
    const found: StreamBoundary[] = [];
    // A slow link: 1.5 s behind live at the first audio, 5 s once all of the burst is in.
    let lag = { ms: 1_500, settled: false };
    const t = new BoundaryTracker(
      (b) => found.push(b),
      () => true,
      () => lag
    );
    t.setDetection(true);
    const base = 1_000_000;
    const windows = audio(
      [
        ['music', 2_000],
        ['zeros', 600],
        ['music', 6_000],
      ],
      base
    );
    t.metadata(metadata('Started just before tune-in', base + 50));
    for (const w of windows) {
      if (w.at >= base + 1_000) lag = { ms: 5_000, settled: false };
      if (w.at >= base + 4_000) lag = { ms: 5_000, settled: true };
      t.sample(sample(w));
    }
    expect(found).toEqual([
      {
        title: 'Started just before tune-in',
        titleAt: base + 50,
        at: near(base + 2_600),
        kind: 'gap',
      },
    ]);
  });

  it('an opening whose lag never settles is told when the next title is heard', () => {
    const found: StreamBoundary[] = [];
    const t = new BoundaryTracker(
      (b) => found.push(b),
      () => true,
      () => ({ ms: 5_000, settled: false })
    );
    t.setDetection(true);
    const base = 1_000_000;
    const windows = audio(
      [
        ['music', 2_000],
        ['zeros', 600],
        ['music', 6_000],
      ],
      base
    );
    t.metadata(metadata('First', base + 50));
    for (const w of windows) t.sample(sample(w));
    expect(found).toEqual([]);
    t.metadata(metadata('Next', base + 8_600));
    expect(found).toEqual([
      {
        title: 'First',
        titleAt: base + 50,
        at: near(base + 2_600),
        kind: 'gap',
      },
    ]);
  });

  it("the silence a connection's audio begins with is no gap (a decoder starting mid-stream)", () => {
    const found: StreamBoundary[] = [];
    const t = new BoundaryTracker(
      (b) => found.push(b),
      () => true,
      () => ({ ms: 4_000, settled: true })
    );
    t.setDetection(true);
    const base = 1_000_000;
    // As an Android decoder opens an MP3 stream: 14 ms of zeros, then the
    // music, its first windows timed a little apart while the output fills.
    const windows = [
      { at: base, duration: 14, points: new Array<number>(128).fill(0) },
      ...audio([['music', 6_000]], base + 38),
    ];
    t.metadata(metadata('Playing for a while', base + 50));
    for (const w of windows) t.sample(sample(w));
    expect(found).toEqual([]);
  });

  it("reports nothing for a connection's first item that started before its opening audio", () => {
    const found: StreamBoundary[] = [];
    const t = new BoundaryTracker(
      (b) => found.push(b),
      () => true,
      () => ({ ms: 5_000, settled: true })
    );
    t.setDetection(true);
    const base = 1_000_000;
    // A gap after the opening audio (past live) is not this item's start.
    const windows = audio(
      [
        ['music', 6_000],
        ['zeros', 400],
        ['music', 2_000],
      ],
      base
    );
    t.metadata(metadata('Playing for a while', base + 50));
    for (const w of windows) t.sample(sample(w));
    expect(found).toEqual([]);
  });

  describe('after a reconnect (the title playing is not reported again)', () => {
    const base = 1_000_000;
    /** A tracker that heard 'Playing', then got a fresh connection at `base`, its lag read by `lag`. */
    const reconnect = (lag: () => { ms: number; settled: boolean }) => {
      const found: StreamBoundary[] = [];
      const t = new BoundaryTracker(
        (b) => found.push(b),
        () => true,
        lag
      );
      t.setDetection(true);
      t.metadata(metadata('Playing', base - 60_000));
      t.reconnected(base);
      return { t, found };
    };

    it("searches the new connection's opening audio for the start of the item playing", () => {
      const { t, found } = reconnect(() => ({ ms: 5_000, settled: true }));
      const windows = audio(
        [
          ['music', 2_000],
          ['zeros', 600],
          ['music', 6_000],
        ],
        base
      );
      for (const w of windows) t.sample(sample(w));
      expect(found).toEqual([
        {
          title: 'Playing',
          titleAt: base,
          at: near(base + 2_600),
          kind: 'gap',
        },
      ]);
    });

    it('the next title is a change like any other, its start found around it', () => {
      const { t, found } = reconnect(() => ({ ms: 3_000, settled: true }));
      const windows = audio(
        [
          ['music', 9_000],
          ['zeros', 400],
          ['music', 6_000],
        ],
        base
      );
      for (const w of windows) {
        if (w.at >= base + 9_000 && w.at < base + 9_000 + WINDOW_MS)
          t.metadata(metadata('Next', base + 9_000));
        t.sample(sample(w));
      }
      expect(found).toEqual([
        {
          title: 'Next',
          titleAt: base + 9_000,
          at: near(base + 9_400),
          kind: 'gap',
        },
      ]);
    });

    it('a title heard after the opening audio is a change, though the lag has not settled', () => {
      // 2 s behind live, and still unsettled when the next title is heard 3 s in.
      const { t, found } = reconnect(() => ({ ms: 2_000, settled: false }));
      const windows = audio(
        [
          ['music', 800],
          ['zeros', 200],
          ['music', 2_000],
          ['zeros', 400],
          ['music', 6_000],
        ],
        base
      );
      for (const w of windows) {
        if (w.at >= base + 3_000 && w.at < base + 3_000 + WINDOW_MS)
          t.metadata(metadata('Next', base + 3_000));
        t.sample(sample(w));
      }
      // 'Playing' started in the opening audio; 'Next' at its own gap, not there.
      expect(found).toEqual([
        {
          title: 'Playing',
          titleAt: base,
          at: near(base + 1_000),
          kind: 'gap',
        },
        {
          title: 'Next',
          titleAt: base + 3_000,
          at: near(base + 3_400),
          kind: 'gap',
        },
      ]);
    });

    it('a new title within the opening audio is the connection’s first: the item changed meanwhile', () => {
      let lag = { ms: 5_000, settled: false };
      const { t, found } = reconnect(() => lag);
      // No gap in the opening audio: 'Changed meanwhile' started before it.
      const windows = audio([['music', 8_000]], base);
      for (const w of windows) {
        if (w.at >= base + 400 && w.at < base + 400 + WINDOW_MS)
          t.metadata(metadata('Changed meanwhile', base + 400));
        if (w.at >= base + 4_000) lag = { ms: 5_000, settled: true };
        t.sample(sample(w));
      }
      // Not placed at its title, as a change without a gap would be.
      expect(found).toEqual([]);
    });
  });

  it('a repeated title is not a change', () => {
    const t = new BoundaryTracker(
      () => {},
      () => true
    );
    t.setDetection(true);
    const finder = (t as unknown as { finder: BoundaryFinder }).finder;
    const title = jest.spyOn(finder, 'title');
    t.metadata(metadata('A', 1));
    t.metadata(metadata('B', 2));
    t.metadata(metadata('B', 3));
    expect(title).toHaveBeenCalledTimes(1);
  });
});
