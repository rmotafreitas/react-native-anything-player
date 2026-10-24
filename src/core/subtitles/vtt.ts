// WebVTT (`.vtt`): the `WEBVTT` header, then cues of an optional id, a timing
// line with settings (`align`, `line`, `position`) and the text; `NOTE`,
// `STYLE` and `REGION` blocks are skipped.

import { parseTaggedText, PLAIN, SpanBuilder } from './markup';
import { clockMs, cueOf, normalizeText, sortCues } from './srt';
import type { CueAlign, CueVertical, SubtitleCue } from './types';

const TIMING =
  /^\s*((?:\d+:)?\d{2}:\d{2}\.\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}\.\d{3})(.*)$/;

const ALIGNS: Record<string, CueAlign> = {
  start: 'left',
  left: 'left',
  center: 'center',
  middle: 'center',
  end: 'right',
  right: 'right',
};

const LINE_ALIGNS: Record<string, CueVertical> = {
  start: 'top',
  center: 'middle',
  end: 'bottom',
};

interface Settings {
  align: CueAlign;
  vertical: CueVertical;
  x: number | null;
  y: number | null;
}

function percent(value: string): number | null {
  const m = /^(-?\d+(?:\.\d+)?)%$/.exec(value);
  return m ? Number(m[1]) / 100 : null;
}

/** `line:10%`, `line:0`, `line:-1`, with an optional `,start|center|end`. */
function lineSetting(value: string, s: Settings): void {
  const [where = '', anchor] = value.split(',');
  const fraction = percent(where);
  if (fraction != null) {
    s.y = fraction;
    s.vertical = LINE_ALIGNS[anchor ?? 'start'] ?? 'top';
    return;
  }
  const line = Number(where);
  if (Number.isFinite(line)) s.vertical = line >= 0 ? 'top' : 'bottom';
}

function settingsOf(text: string): Settings {
  const s: Settings = { align: 'center', vertical: 'bottom', x: null, y: null };
  for (const item of text.trim().split(/\s+/)) {
    const colon = item.indexOf(':');
    if (colon <= 0) continue;
    const key = item.slice(0, colon);
    const value = item.slice(colon + 1);
    if (key === 'align') s.align = ALIGNS[value] ?? s.align;
    else if (key === 'line') lineSetting(value, s);
    else if (key === 'position') s.x = percent(value.split(',')[0] ?? '');
    else {
      // `size`, `vertical`, `region`: not part of the cue model.
    }
  }
  return s;
}

function parseCue(lines: string[]): SubtitleCue | null {
  const at = lines.findIndex((l) => l.includes('-->'));
  if (at < 0 || at > 1) return null;
  const m = TIMING.exec(lines[at]!);
  if (!m) return null;
  const start = clockMs(m[1]!);
  const end = clockMs(m[2]!);
  if (start == null || end == null || end <= start) return null;
  return vttCue(start, end, m[3] ?? '', lines.slice(at + 1).join('\n'));
}

/**
 * One WebVTT cue from its parts: times (ms), the settings after the
 * timing (`align:start line:10%`) and the tagged text. Also how a browser's
 * own `VTTCue` (a source's text track) joins the cue model.
 */
export function vttCue(
  startMs: number,
  endMs: number,
  settings: string,
  text: string
): SubtitleCue | null {
  const out = new SpanBuilder(PLAIN);
  parseTaggedText(text, out, { overrides: false, entities: true });
  const cue = cueOf(startMs, endMs, out);
  if (cue.text === '') return null;
  const s = settingsOf(settings);
  return { ...cue, align: s.align, vertical: s.vertical, x: s.x, y: s.y };
}

function isMetaBlock(first: string): boolean {
  return /^(NOTE|STYLE|REGION)(\s|$)/.test(first) || first.startsWith('WEBVTT');
}

function blockCue(block: string): SubtitleCue | null {
  const lines = block.split('\n');
  while (lines.length > 0 && lines[0]!.trim() === '') lines.shift();
  const first = lines[0];
  if (first == null) return null;
  // A header block can hold a cue only when its timing follows the header.
  const timed = lines.slice(1).some((l) => l.includes('-->'));
  if (isMetaBlock(first) && !timed) return null;
  return parseCue(first.startsWith('WEBVTT') ? lines.slice(1) : lines);
}

export function parseVtt(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of normalizeText(text).split(/\n[ \t]*\n/)) {
    const cue = blockCue(block);
    if (cue) cues.push(cue);
  }
  return sortCues(cues);
}
