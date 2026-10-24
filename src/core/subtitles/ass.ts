// ASS / SSA (`.ass`, `.ssa`), basic: the styles' bold, italic, underline,
// colour and alignment, and the overrides that change them (`\b`, `\i`, `\u`,
// `\c`, `\an`, `\a`, `\pos`, `\r`), with `\N` line breaks. Fonts, sizes,
// outlines, karaoke, animation and drawings need libass: drawings are
// dropped, the rest is ignored.

import {
  assColor,
  legacyAlignment,
  numpad,
  parseAssText,
  PLAIN,
  SpanBuilder,
  type SpanStyle,
} from './markup';
import { normalizeText, sortCues } from './srt';
import type { SubtitleCue } from './types';

interface AssStyle {
  span: SpanStyle;
  /** Numpad alignment. */
  an: number;
}

/** What an ASS file's sections tell the events. */
export interface AssScript {
  playResX: number;
  playResY: number;
  /** SSA (v4) styles number their alignment the legacy way. */
  legacy: boolean;
  styles: Map<string, AssStyle>;
}

const DEFAULT_STYLE: AssStyle = { span: PLAIN, an: 2 };

/** `H:MM:SS.cc` → integer milliseconds, or `null`. */
export function assTimeMs(value: string): number | null {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/.exec(value.trim());
  if (!m) return null;
  const fraction = m[4]!;
  const ms = Math.round((Number(fraction) * 1000) / 10 ** fraction.length);
  return ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + ms;
}

/** `-1` and `1` are on (`0` off); weights from 700 are bold. */
function flag(value: string | undefined): boolean {
  const n = Number(value ?? 0);
  return n === -1 || n === 1 || n >= 700;
}

function styleOf(
  fields: string[],
  parts: string[],
  legacy: boolean
): [string, AssStyle] {
  const get = (name: string) => parts[fields.indexOf(name)]?.trim();
  const alignment = Number(get('alignment') ?? 2);
  const an = legacy ? legacyAlignment(alignment) : alignment;
  const color = get('primarycolour');
  return [
    get('name') ?? 'Default',
    {
      span: {
        bold: flag(get('bold')),
        italic: flag(get('italic')),
        underline: flag(get('underline')),
        color: color != null ? assColor(color) : null,
      },
      an: an != null && an >= 1 && an <= 9 ? an : 2,
    },
  ];
}

/** Splits `Key: a, b, c` into its values (the last keeps its commas when `count` is given). */
function values(line: string, count?: number): string[] {
  const rest = line.slice(line.indexOf(':') + 1);
  const parts = rest.split(',');
  if (count == null || parts.length <= count) return parts;
  return [...parts.slice(0, count - 1), parts.slice(count - 1).join(',')];
}

function lowerFields(line: string): string[] {
  return values(line).map((f) => f.trim().toLowerCase());
}

interface Section {
  name: string;
  format: string[];
}

function scriptInfo(line: string, script: AssScript): void {
  const colon = line.indexOf(':');
  if (colon < 0) return;
  const key = line.slice(0, colon).trim().toLowerCase();
  const value = line.slice(colon + 1).trim();
  if (key === 'playresx') script.playResX = Number(value) || 0;
  else if (key === 'playresy') script.playResY = Number(value) || 0;
  else if (key === 'scripttype') script.legacy = /^v4\.00$/i.test(value);
  else {
    // Title, WrapStyle, ScaledBorderAndShadow…: not part of the cue model.
  }
}

/** Reads the `[Script Info]` and `[V4+ Styles]` sections. */
export function parseAssHeader(text: string): AssScript {
  const script: AssScript = {
    playResX: 0,
    playResY: 0,
    legacy: false,
    styles: new Map(),
  };
  let section: Section = { name: '', format: [] };
  for (const raw of normalizeText(text).split('\n')) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = { name: header[1]!.toLowerCase(), format: [] };
      continue;
    }
    if (section.name === 'script info') scriptInfo(line, script);
    else if (section.name.includes('styles')) styleLine(line, section, script);
    else {
      // Events and fonts: read by `parseAss`.
    }
  }
  fillPlayRes(script);
  return script;
}

function styleLine(line: string, section: Section, script: AssScript): void {
  if (/^format\s*:/i.test(line)) section.format = lowerFields(line);
  else if (/^style\s*:/i.test(line)) {
    const [name, style] = styleOf(section.format, values(line), script.legacy);
    script.styles.set(name, style);
  } else {
    // Comments and blank lines.
  }
}

/** libass's defaults when the script gives none (or one) of them. */
function fillPlayRes(script: AssScript): void {
  if (script.playResX <= 0 && script.playResY <= 0) {
    script.playResX = 384;
    script.playResY = 288;
  } else if (script.playResY <= 0) {
    script.playResY =
      script.playResX === 1280 ? 1024 : (script.playResX * 3) / 4;
  } else if (script.playResX <= 0) {
    script.playResX =
      script.playResY === 1024 ? 1280 : (script.playResY * 4) / 3;
  } else {
    // Both given.
  }
}

/**
 * One event's text with its style: the text, styling and placement of a cue
 * (`startMs`/`endMs` from the event, or from a container such as Matroska).
 */
export function assEventCue(
  script: AssScript,
  styleName: string,
  text: string,
  startMs: number,
  endMs: number
): SubtitleCue | null {
  const style =
    script.styles.get(styleName) ??
    script.styles.get(styleName.replace(/^\*/, '')) ??
    script.styles.get('Default') ??
    DEFAULT_STYLE;
  const out = new SpanBuilder(style.span);
  parseAssText(text, out);
  const spans = out.build();
  const joined = spans.map((s) => s.text).join('');
  if (joined.trim() === '' || endMs <= startMs) return null;
  const place = numpad(out.placement.an ?? style.an);
  const pos = out.placement.pos;
  return {
    start: startMs / 1000,
    end: endMs / 1000,
    text: joined,
    spans,
    align: place.align,
    vertical: place.vertical,
    x: pos != null ? pos.x / script.playResX : null,
    y: pos != null ? pos.y / script.playResY : null,
  };
}

/** The fields an `[Events]` section's `Format:` line names (ASS's default when it has none). */
const DEFAULT_EVENT_FORMAT = [
  'layer',
  'start',
  'end',
  'style',
  'name',
  'marginl',
  'marginr',
  'marginv',
  'effect',
  'text',
];

function eventCue(
  line: string,
  format: string[],
  script: AssScript
): SubtitleCue | null {
  const fields = values(line, format.length);
  const get = (name: string) => fields[format.indexOf(name)];
  const start = assTimeMs(get('start') ?? '');
  const end = assTimeMs(get('end') ?? '');
  if (start == null || end == null) return null;
  return assEventCue(
    script,
    (get('style') ?? 'Default').trim(),
    get('text') ?? '',
    start,
    end
  );
}

export function parseAss(text: string): SubtitleCue[] {
  const script = parseAssHeader(text);
  const cues: SubtitleCue[] = [];
  let inEvents = false;
  let format = DEFAULT_EVENT_FORMAT;
  for (const raw of normalizeText(text).split('\n')) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) inEvents = header[1]!.toLowerCase() === 'events';
    else if (!inEvents) {
      // Read by `parseAssHeader`.
    } else if (/^format\s*:/i.test(line)) format = lowerFields(line);
    else if (/^dialogue\s*:/i.test(line)) {
      const cue = eventCue(line, format, script);
      if (cue) cues.push(cue);
    } else {
      // `Comment:`, `Picture:`, `Sound:`, `Movie:`, `Command:`.
    }
  }
  return sortCues(cues);
}
