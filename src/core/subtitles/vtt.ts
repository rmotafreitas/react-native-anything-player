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

// ── Writing ──

function clock(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

const escapeText = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const WRITE_ALIGN: Record<SubtitleCue['align'], string> = {
  left: 'start',
  center: 'center',
  right: 'end',
};

/** Where the cue sits, as WebVTT settings. */
function settingsFor(cue: SubtitleCue): string {
  const out = [`align:${WRITE_ALIGN[cue.align]}`];
  if (cue.y != null) {
    const anchor = { top: 'start', middle: 'center', bottom: 'end' }[
      cue.vertical
    ];
    out.push(`line:${(cue.y * 100).toFixed(1)}%,${anchor}`);
  } else if (cue.vertical === 'top') {
    out.push('line:0');
  } else if (cue.vertical === 'middle') {
    out.push('line:50%,center');
  } else {
    // The bottom: WebVTT's default place.
  }
  if (cue.x != null) out.push(`position:${(cue.x * 100).toFixed(1)}%`);
  return out.join(' ');
}

/**
 * Cues as a WebVTT file (bold, italic, underline and placement kept;
 * colours need a stylesheet WebVTT players rarely read, so they go). How an
 * app's subtitle file, whatever its format, reaches a Cast receiver.
 * `delay` shifts every cue (`setSubtitleDelay`).
 */
export function cuesToVtt(cues: readonly SubtitleCue[], delay = 0): string {
  const blocks = cues
    .filter((cue) => cue.end + delay > 0)
    .map((cue) => {
      const text = cue.spans
        .map((span) => {
          let t = escapeText(span.text);
          if (span.underline) t = `<u>${t}</u>`;
          if (span.italic) t = `<i>${t}</i>`;
          if (span.bold) t = `<b>${t}</b>`;
          return t;
        })
        .join('');
      const timing = `${clock(cue.start + delay)} --> ${clock(cue.end + delay)}`;
      return `${timing} ${settingsFor(cue)}\n${text}`;
    });
  return ['WEBVTT', ...blocks].join('\n\n') + '\n';
}
