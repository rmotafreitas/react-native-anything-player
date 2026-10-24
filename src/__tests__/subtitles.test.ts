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
import { cuesToVtt, parseVtt } from '../core/subtitles/vtt';
import { parseSrt } from '../core/subtitles/srt';

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

describe('writing WebVTT (cues for a Cast receiver)', () => {
  it('round-trips through the parser: text, styles, place and times', () => {
    const cues = parseSrt(
      '1\n00:00:01,000 --> 00:00:03,500\n<i>Hello</i> & <b>you</b>\n\n2\n00:01:00,250 --> 00:01:02,000\n{\\an8}At the top\n'
    );
    const back = parseVtt(cuesToVtt(cues));
    expect(back.map((c) => c.text)).toEqual(['Hello & you', 'At the top']);
    expect(back[0]).toMatchObject({ start: 1, end: 3.5, vertical: 'bottom' });
    expect(back[0]!.spans).toEqual([
      expect.objectContaining({ text: 'Hello', italic: true }),
      expect.objectContaining({ text: ' & ' }),
      expect.objectContaining({ text: 'you', bold: true }),
    ]);
    expect(back[1]).toMatchObject({ start: 60.25, vertical: 'top' });
  });

  it('shifts every cue by the delay, dropping the ones before zero', () => {
    const cues = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\nGone\n\n2\n00:00:05,000 --> 00:00:06,000\nKept\n'
    );
    const back = parseVtt(cuesToVtt(cues, -2.5));
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ text: 'Kept', start: 2.5, end: 3.5 });
  });
});
