/// <reference types="node" />
// The subtitle fixtures in `conformance/subtitles/` and `conformance/tracks/`:
// parsing, encoding detection, cue timing and track choice.

import fs from 'node:fs';
import path from 'node:path';
import { detectCharset } from '../core/subtitles/charset';
import { formatFromName, parseSubtitles } from '../core/subtitles/parse';
import { activeCues, nextCueChange } from '../core/subtitles/schedule';
import {
  selectTracks,
  type MediaTrack,
  type TrackPreferences,
} from '../core/subtitles/tracks';
import type { SubtitleFormat } from '../core/subtitles/types';

const DIR = path.resolve(__dirname, '../../conformance');
const load = <T>(file: string): T[] =>
  JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) as T[];

interface ParseCase {
  name: string;
  format?: SubtitleFormat;
  text: string;
  expect: Array<Record<string, unknown>>;
}

describe('subtitle parsing (conformance/subtitles/parse.json)', () => {
  it.each(
    load<ParseCase>('subtitles/parse.json').map((c) => [c.name, c] as const)
  )('%s', (_, c) => {
    const cues = parseSubtitles(c.text, c.format);
    expect(cues.length).toBe(c.expect.length);
    c.expect.forEach((want, i) => {
      const cue = cues[i] as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(want)) {
        if (typeof value === 'number' && (key === 'x' || key === 'y'))
          expect(cue[key]).toBeCloseTo(value, 9);
        else expect([i, key, cue[key]]).toEqual([i, key, value]);
      }
    });
  });

  it('takes the format from a file name or MIME type', () => {
    expect(formatFromName('https://cdn.example/ep01.pt.SRT?sig=1')).toBe('srt');
    expect(formatFromName('subs.ssa')).toBe('ass');
    expect(formatFromName('text/vtt')).toBe('vtt');
    expect(formatFromName('application/ttml+xml')).toBe('ttml');
    expect(formatFromName('movie.mp4')).toBeNull();
  });
});

describe('subtitle encodings (conformance/subtitles/charset.json)', () => {
  const cases = load<{ name: string; hex: string; expect: string }>(
    'subtitles/charset.json'
  );
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(detectCharset(Uint8Array.from(Buffer.from(c.hex, 'hex')))).toBe(
      c.expect
    );
  });
});

describe('cue timing (conformance/subtitles/schedule.json)', () => {
  interface Check {
    position: number;
    delay?: number;
    active: number[];
    next: number | null;
  }
  const cases = load<{
    name: string;
    cues: Array<[number, number]>;
    checks: Check[];
  }>('subtitles/schedule.json');
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    const cues = c.cues.map(([start, end]) => ({ start, end }));
    for (const check of c.checks) {
      expect([
        check.position,
        activeCues(cues, check.position, check.delay),
      ]).toEqual([check.position, check.active]);
      expect([
        check.position,
        nextCueChange(cues, check.position, check.delay),
      ]).toEqual([check.position, check.next]);
    }
  });
});

describe('track choice (conformance/tracks/select.json)', () => {
  const cases = load<{
    name: string;
    tracks: MediaTrack[];
    preferences: TrackPreferences;
    expect: { audio: string | null; text: string | null };
  }>('tracks/select.json');
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_, c) => {
    expect(selectTracks(c.tracks, c.preferences)).toEqual(c.expect);
  });
});
