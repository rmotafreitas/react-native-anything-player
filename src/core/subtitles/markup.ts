// Inline styling shared by the formats: SubRip and WebVTT tags (`<b>`, `<i>`,
// `<u>`, `<font color>`, `<c>`, `<v>`, `<ruby>`), ASS override blocks
// (`{\b1}`, `{\c&H0000FF&}`, `{\an8}`, `{\pos(x,y)}`), which fansub SubRip
// files use too, and the HTML entities WebVTT allows. The result is a list of
// styled runs plus the placement an override asked for.

import type { CueAlign, CueSpan, CueVertical } from './types';

/* eslint-disable no-bitwise -- ASS colours pack blue, green and red in one number. */

export interface SpanStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** `#rrggbb`, `null`: the renderer's. */
  color: string | null;
}

export const PLAIN: SpanStyle = {
  bold: false,
  italic: false,
  underline: false,
  color: null,
};

/** What an ASS override block asked for the whole cue. */
export interface Placement {
  /** Numpad alignment (1 bottom-left … 9 top-right), the first one wins. */
  an: number | null;
  /** `\pos(x, y)`, in the script's pixels. */
  pos: { x: number; y: number } | null;
}

const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff',
  black: '#000000',
  red: '#ff0000',
  green: '#008000',
  lime: '#00ff00',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  orange: '#ffa500',
  purple: '#800080',
  maroon: '#800000',
  navy: '#000080',
  olive: '#808000',
  teal: '#008080',
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '‎',
  rlm: '‏',
};

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

/** `#rrggbb` from an HTML color (`#f00`, `#ff0000`, a name), or `null`. */
export function htmlColor(value: string): string | null {
  const v = value.trim().toLowerCase();
  const named = NAMED_COLORS[v];
  if (named != null) return named;
  const short = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short)
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const long = /^#?([0-9a-f]{6})$/.exec(v);
  return long ? `#${long[1]}` : null;
}

/**
 * `#rrggbb` from an ASS colour: `&HAABBGGRR`, `&HBBGGRR&`, or a decimal BGR
 * number (SSA); the alpha is dropped.
 */
export function assColor(value: string): string | null {
  const v = value.trim();
  const hex = /^&?H([0-9A-Fa-f]{1,8})&?$/.exec(v);
  let bgr: number;
  if (hex) bgr = Number.parseInt(hex[1]!, 16) & 0xffffff;
  else if (/^-?\d+$/.test(v)) bgr = Number(v) & 0xffffff;
  else return null;
  const r = bgr & 0xff;
  const g = (bgr >> 8) & 0xff;
  const b = (bgr >> 16) & 0xff;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** Numpad alignment → the cue's alignment and vertical side. */
export function numpad(an: number): { align: CueAlign; vertical: CueVertical } {
  const aligns: CueAlign[] = ['left', 'center', 'right'];
  const align = aligns[(an - 1) % 3]!;
  if (an <= 3) return { align, vertical: 'bottom' };
  return { align, vertical: an <= 6 ? 'middle' : 'top' };
}

/** SSA's legacy `\a` / `Alignment` (1–3 bottom, 5–7 top, 9–11 middle) → numpad. */
export function legacyAlignment(a: number): number | null {
  if (a >= 1 && a <= 3) return a;
  if (a >= 5 && a <= 7) return a + 2;
  if (a >= 9 && a <= 11) return a - 5;
  return null;
}

/** Collects styled runs, merging neighbours with the same style. */
export class SpanBuilder {
  readonly spans: CueSpan[] = [];
  style: SpanStyle;
  readonly placement: Placement = { an: null, pos: null };
  /** Inside an ASS drawing (`\p1`): its commands are not text. */
  drawing = false;

  constructor(readonly base: SpanStyle) {
    this.style = { ...base };
  }

  push(text: string): void {
    if (text === '' || this.drawing) return;
    const last = this.spans.at(-1);
    const span = toSpan(text, this.style);
    if (last != null && sameStyle(last, span)) last.text += text;
    else this.spans.push(span);
  }

  /** The runs with the cue's outer whitespace trimmed and empty runs dropped. */
  build(): CueSpan[] {
    const spans = this.spans.map((s) => ({ ...s }));
    const first = spans[0];
    if (first) first.text = first.text.trimStart();
    const last = spans.at(-1);
    if (last) last.text = last.text.trimEnd();
    return spans.filter((s) => s.text !== '');
  }
}

function toSpan(text: string, style: SpanStyle): CueSpan {
  const span: CueSpan = { text };
  if (style.bold) span.bold = true;
  if (style.italic) span.italic = true;
  if (style.underline) span.underline = true;
  if (style.color != null) span.color = style.color;
  return span;
}

function sameStyle(a: CueSpan, b: CueSpan): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.color === b.color
  );
}

/** `\b1`, `\b0`, `\b700`: bold for 1 and weights from 700. */
function weight(value: string): boolean {
  const n = Number(value);
  return n === 1 || n >= 700;
}

/** Applies one ASS override tag (without its backslash). */
function overrideTag(tag: string, out: SpanBuilder): void {
  const toggle = /^([biu])(\d+)$/.exec(tag);
  if (toggle) {
    const on = toggle[1] === 'b' ? weight(toggle[2]!) : toggle[2] !== '0';
    if (toggle[1] === 'b') out.style.bold = on;
    else if (toggle[1] === 'i') out.style.italic = on;
    else out.style.underline = on;
    return;
  }
  const color = /^1?c(&H[0-9A-Fa-f]+&?)?$/.exec(tag);
  if (color) {
    out.style.color = color[1] ? assColor(color[1]) : out.base.color;
    return;
  }
  overridePlacement(tag, out);
}

function overridePlacement(tag: string, out: SpanBuilder): void {
  const an = /^an([1-9])$/.exec(tag);
  if (an) {
    out.placement.an ??= Number(an[1]);
    return;
  }
  const legacy = /^a(\d+)$/.exec(tag);
  if (legacy) {
    out.placement.an ??= legacyAlignment(Number(legacy[1]));
    return;
  }
  const pos = /^pos\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(tag);
  if (pos) {
    out.placement.pos ??= { x: Number(pos[1]), y: Number(pos[2]) };
    return;
  }
  const drawing = /^p(\d+)$/.exec(tag);
  if (drawing) {
    out.drawing = drawing[1] !== '0';
    return;
  }
  if (tag === 'r' || tag.startsWith('r')) out.style = { ...out.base };
}

/** The tags of one `{…}` override block (`\b1\i1` → `b1`, `i1`). */
function overrideTags(block: string): string[] {
  const tags: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of block) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === '\\' && depth === 0) {
      if (current !== '') tags.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim() !== '') tags.push(current.trim());
  return tags;
}

/** Applies a whole `{…}` block (its content, without the braces). */
export function applyOverrides(block: string, out: SpanBuilder): void {
  for (const tag of overrideTags(block)) overrideTag(tag, out);
}

/** ASS event text: override blocks, `\N` (line break), `\n` (a space), `\h`. */
export function parseAssText(text: string, out: SpanBuilder): void {
  let i = 0;
  let run = '';
  const flush = () => {
    out.push(run);
    run = '';
  };
  while (i < text.length) {
    const ch = text[i]!;
    const close = ch === '{' ? text.indexOf('}', i) : -1;
    const escaped = ch === '\\' ? assEscape(text[i + 1] ?? '') : null;
    if (close > i) {
      flush();
      applyOverrides(text.slice(i + 1, close), out);
      i = close + 1;
    } else if (escaped != null) {
      run += escaped;
      i += 2;
    } else {
      run += ch;
      i += 1;
    }
  }
  flush();
}

function assEscape(next: string): string | null {
  if (next === 'N') return '\n';
  if (next === 'n') return ' ';
  if (next === 'h') return ' ';
  return null;
}

/** Decodes `&amp;`, `&#38;`, `&#x26;` and the other WebVTT entities. */
export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, name: string) => {
      if (name.startsWith('#')) {
        const hex = name[1] === 'x' || name[1] === 'X';
        const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    }
  );
}

/** Applies an HTML-like tag (`b`, `/i`, `font color="red"`, `c.yellow`…). */
function htmlTag(raw: string, out: SpanBuilder, colors: string[]): void {
  const closing = raw.startsWith('/');
  const body = closing ? raw.slice(1) : raw;
  const name = (/^[a-zA-Z]+/.exec(body)?.[0] ?? '').toLowerCase();
  if (name === 'b') out.style.bold = !closing;
  else if (name === 'i') out.style.italic = !closing;
  else if (name === 'u') out.style.underline = !closing;
  else if (name === 'font') fontTag(body, closing, out, colors);
  else {
    // `<c>`, `<v>`, `<lang>`, `<ruby>`, `<span>`: the text stays, unstyled.
  }
}

function fontTag(
  body: string,
  closing: boolean,
  out: SpanBuilder,
  colors: string[]
): void {
  if (closing) {
    out.style.color = colors.pop() ?? out.base.color;
    return;
  }
  colors.push(out.style.color ?? '');
  const value = /color\s*=\s*["']?([^"'\s>]+)/i.exec(body)?.[1];
  const color = value != null ? htmlColor(value) : null;
  if (color != null) out.style.color = color;
}

/**
 * SubRip and WebVTT cue text: HTML-like tags, `{\…}` override blocks
 * (`overrides`), entities (`entities`), and WebVTT's `<rt>` annotations and
 * timestamps, which are dropped.
 */
export function parseTaggedText(
  text: string,
  out: SpanBuilder,
  options: { overrides: boolean; entities: boolean }
): void {
  const colors: string[] = [];
  let run = '';
  let skipUntil: string | null = null;
  const flush = () => {
    out.push(options.entities ? decodeEntities(run) : run);
    run = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const end = blockEnd(text, i, options.overrides);
    if (end < 0) {
      if (skipUntil == null) run += ch;
      i += 1;
    } else {
      flush();
      const inner = text.slice(i + 1, end);
      if (ch === '{') applyOverrides(inner, out);
      else skipUntil = tagEffect(inner, out, colors, skipUntil);
      i = end + 1;
    }
  }
  flush();
}

/** The index of the `>` or `}` closing a tag or override block at `i`, or -1. */
function blockEnd(text: string, i: number, overrides: boolean): number {
  const ch = text[i];
  if (ch === '<') return text.indexOf('>', i);
  if (ch === '{' && overrides && text[i + 1] === '\\')
    return text.indexOf('}', i);
  return -1;
}

/** A tag's effect; returns the closing tag text is skipped until, if any. */
function tagEffect(
  inner: string,
  out: SpanBuilder,
  colors: string[],
  skipUntil: string | null
): string | null {
  const name = inner.trim().toLowerCase();
  if (skipUntil != null) return name === skipUntil ? null : skipUntil;
  // A ruby annotation and a karaoke timestamp are not text.
  if (name === 'rt') return '/rt';
  if (/^\d/.test(name)) return null;
  htmlTag(inner.trim(), out, colors);
  return null;
}
