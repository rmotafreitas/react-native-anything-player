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

  it("does not search the connection's first title: it names an item already playing", () => {
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
