// SubRip (`.srt`): numbered blocks of a timing line and the text. Read
// leniently, as players do: the number is optional, `.` works for `,`, hours
// may be missing, and fansub files' `{\an8}` / `{\i1}` overrides apply.

import { numpad, parseTaggedText, PLAIN, SpanBuilder } from './markup';
import type { SubtitleCue } from './types';

const TIMING =
  /^\s*((?:\d+:)?\d{1,2}:\d{1,2}[,.]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}[,.]\d{1,3})/;

/** `01:02:03,456`, `02:03.456`: integer milliseconds, or `null`. */
export function clockMs(value: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1] ?? 0);
  const fraction = m[4]!;
  const ms = Math.round((Number(fraction) * 1000) / 10 ** fraction.length);
  return ((hours * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms;
}

/** Text with Unix line ends and no byte-order mark. */
export function normalizeText(text: string): string {
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** A cue from its timing (ms), its text and the styling parsed from it. */
export function cueOf(
  startMs: number,
  endMs: number,
  out: SpanBuilder
): SubtitleCue {
  const spans = out.build();
  const place = numpad(out.placement.an ?? 2);
  return {
    start: startMs / 1000,
    end: endMs / 1000,
    text: spans.map((s) => s.text).join(''),
    spans,
    align: place.align,
    vertical: place.vertical,
    x: null,
    y: null,
  };
}

function parseBlock(lines: string[]): SubtitleCue | null {
  const at = lines.findIndex((l) => TIMING.test(l));
  if (at < 0 || at > 1) return null;
  const m = TIMING.exec(lines[at]!)!;
  const start = clockMs(m[1]!);
  const end = clockMs(m[2]!);
  if (start == null || end == null || end <= start) return null;
  const out = new SpanBuilder(PLAIN);
  parseTaggedText(lines.slice(at + 1).join('\n'), out, {
    overrides: true,
    entities: false,
  });
  const cue = cueOf(start, end, out);
  return cue.text === '' ? null : cue;
}

export function parseSrt(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of normalizeText(text).split(/\n[ \t]*\n/)) {
    const lines = block.split('\n').filter((l, i) => i > 0 || l.trim() !== '');
    const cue = parseBlock(lines);
    if (cue) cues.push(cue);
  }
  return sortCues(cues);
}

/** By start (stable: equal starts keep the file's order). */
export function sortCues(cues: SubtitleCue[]): SubtitleCue[] {
  return cues
    .map((cue, i) => ({ cue, i }))
    .sort((a, b) => a.cue.start - b.cue.start || a.i - b.i)
    .map((e) => e.cue);
}
