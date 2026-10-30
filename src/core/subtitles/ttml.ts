// TTML / IMSC text profiles (`.ttml`, `.dfxp`, `.xml`): `<p>` elements with
// their timing (clock, frame, tick and offset times, nested in time
// containers), `<span>` styling (weight, style, decoration, colour), `<br/>`,
// referenced and inline styles, and the region a cue sits in (origin,
// extent, text and display alignment).

import { htmlColor, PLAIN, SpanBuilder, type SpanStyle } from './markup';
import { sortCues } from './srt';
import type { CueAlign, CueVertical, SubtitleCue } from './types';
import {
  attribute,
  childElements,
  find,
  parseXml,
  type XmlElement,
} from './xml';

interface Timing {
  frameRate: number;
  subFrameRate: number;
  tickRate: number;
}

interface Region {
  originX: number | null;
  originY: number | null;
  extentX: number | null;
  extentY: number | null;
  displayAlign: string | null;
  textAlign: string | null;
}

interface Doc {
  timing: Timing;
  styles: Map<string, XmlElement[]>;
  regions: Map<string, Region>;
}

const UNITS: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1000,
  ms: 1,
};

/** A TTML time expression → milliseconds, or `null`. */
export function ttmlTimeMs(value: string, timing: Timing): number | null {
  const v = value.trim();
  const clock = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+)|:(\d+)(?:\.(\d+))?)?$/.exec(
    v
  );
  if (clock) return clockTime(clock, timing);
  const offset = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/.exec(v);
  if (!offset) return null;
  const n = Number(offset[1]);
  const unit = offset[2]!;
  if (unit === 'f') return Math.round((n * 1000) / timing.frameRate);
  if (unit === 't') return Math.round((n * 1000) / timing.tickRate);
  return Math.round(n * UNITS[unit]!);
}

function clockTime(m: RegExpExecArray, timing: Timing): number {
  const seconds = (Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3]);
  let ms = seconds * 1000;
  if (m[4] != null) ms += Math.round(Number(`0.${m[4]}`) * 1000);
  if (m[5] != null) {
    const frames = Number(m[5]) + Number(m[6] ?? 0) / timing.subFrameRate;
    ms += Math.round((frames * 1000) / timing.frameRate);
  }
  return ms;
}

function timingOf(tt: XmlElement): Timing {
  const frameRate = Number(attribute(tt, 'frameRate') ?? 30) || 30;
  const multiplier = (attribute(tt, 'frameRateMultiplier') ?? '1 1')
    .split(/\s+/)
    .map(Number);
  const effective =
    multiplier.length === 2 && multiplier[1]! > 0
      ? (frameRate * multiplier[0]!) / multiplier[1]!
      : frameRate;
  const subFrameRate = Number(attribute(tt, 'subFrameRate') ?? 1) || 1;
  const tick = Number(attribute(tt, 'tickRate'));
  return {
    frameRate: effective,
    subFrameRate,
    tickRate: tick > 0 ? tick : effective * subFrameRate,
  };
}

function percentPair(value: string | null): [number, number] | null {
  if (value == null) return null;
  const m = /^\s*(-?[\d.]+)%\s+(-?[\d.]+)%\s*$/.exec(value);
  return m ? [Number(m[1]) / 100, Number(m[2]) / 100] : null;
}

function regionOf(
  element: XmlElement,
  styles: Map<string, XmlElement[]>
): Region {
  const look = (name: string) => styleValue(element, name, styles);
  const origin = percentPair(look('origin'));
  const extent = percentPair(look('extent'));
  return {
    originX: origin?.[0] ?? null,
    originY: origin?.[1] ?? null,
    extentX: extent?.[0] ?? null,
    extentY: extent?.[1] ?? null,
    displayAlign: look('displayAlign'),
    textAlign: look('textAlign'),
  };
}

/** A style attribute on the element, or on the styles it references (in order). */
function styleValue(
  element: XmlElement,
  name: string,
  styles: Map<string, XmlElement[]>
): string | null {
  const inline = attribute(element, name);
  if (inline != null) return inline;
  for (const nested of childElements(element).filter(
    (c) => c.name === 'style'
  )) {
    const value = attribute(nested, name);
    if (value != null) return value;
  }
  for (const id of (attribute(element, 'style') ?? '').split(/\s+/)) {
    for (const style of styles.get(id) ?? []) {
      const value = styleValue(style, name, styles);
      if (value != null) return value;
    }
  }
  return null;
}

function docOf(tt: XmlElement): Doc {
  const styles = new Map<string, XmlElement[]>();
  const styling = find(tt, 'styling');
  for (const style of styling ? childElements(styling) : []) {
    const id = attribute(style, 'id');
    if (style.name === 'style' && id != null) styles.set(id, [style]);
  }
  const regions = new Map<string, Region>();
  const layout = find(tt, 'layout');
  for (const region of layout ? childElements(layout) : []) {
    const id = attribute(region, 'id');
    if (region.name === 'region' && id != null)
      regions.set(id, regionOf(region, styles));
  }
  return { timing: timingOf(tt), styles, regions };
}

interface Span {
  begin: number;
  end: number;
}

/** An element's interval inside its parent's (`begin`, `end`, `dur`, clipped). */
function intervalOf(element: XmlElement, parent: Span, doc: Doc): Span {
  const begin = ttmlTimeMs(attribute(element, 'begin') ?? '', doc.timing);
  const end = ttmlTimeMs(attribute(element, 'end') ?? '', doc.timing);
  const dur = ttmlTimeMs(attribute(element, 'dur') ?? '', doc.timing);
  const start = parent.begin + (begin ?? 0);
  let stop = parent.end;
  if (end != null) stop = Math.min(parent.end, parent.begin + end);
  else if (dur != null) stop = Math.min(parent.end, start + dur);
  else {
    // The parent's end.
  }
  return { begin: start, end: stop };
}

function spanStyle(element: XmlElement, base: SpanStyle, doc: Doc): SpanStyle {
  const look = (name: string) => styleValue(element, name, doc.styles);
  const weight = look('fontWeight');
  const fontStyle = look('fontStyle');
  const decoration = look('textDecoration');
  const color = look('color');
  return {
    bold: weight != null ? weight === 'bold' : base.bold,
    italic: fontStyle != null ? fontStyle !== 'normal' : base.italic,
    underline:
      decoration != null ? decoration.includes('underline') : base.underline,
    color: color != null ? (htmlColor(color) ?? base.color) : base.color,
  };
}

/** Collects a `<p>`'s text: spans, `<br/>`, whitespace collapsed. */
function collect(element: XmlElement, out: SpanBuilder, doc: Doc): void {
  const style = out.style;
  for (const child of element.children) {
    if (typeof child === 'string') {
      out.push(child.replace(/\s+/g, ' '));
    } else if (child.name === 'br') {
      out.push('\n');
    } else if (child.name === 'span') {
      out.style = spanStyle(child, style, doc);
      collect(child, out, doc);
      out.style = style;
    } else {
      // Metadata and other elements carry no text.
    }
  }
}

/** Spaces around line breaks go (default `xml:space`). */
function tidy(out: SpanBuilder): void {
  for (const span of out.spans) {
    span.text = span.text
      .split('\n')
      .map((line, i, all) => {
        const start = i > 0 ? line.trimStart() : line;
        return i < all.length - 1 ? start.trimEnd() : start;
      })
      .join('\n');
  }
}

const TEXT_ALIGNS: Record<string, CueAlign> = {
  left: 'left',
  start: 'left',
  center: 'center',
  right: 'right',
  end: 'right',
};

const DISPLAY_ALIGNS: Record<string, CueVertical> = {
  before: 'top',
  center: 'middle',
  after: 'bottom',
};

/** Where a region puts its text: the side of its box `align` and `vertical` name. */
function place(region: Region | null, textAlign: string | null) {
  const align =
    TEXT_ALIGNS[textAlign ?? region?.textAlign ?? 'center'] ?? 'center';
  if (region?.originX == null || region.originY == null) {
    return { align, vertical: 'bottom' as CueVertical, x: null, y: null };
  }
  const vertical = DISPLAY_ALIGNS[region.displayAlign ?? 'before'] ?? 'top';
  const width = region.extentX ?? 0;
  const height = region.extentY ?? 0;
  const xs: Record<CueAlign, number> = { left: 0, center: 0.5, right: 1 };
  const ys: Record<CueVertical, number> = { top: 0, middle: 0.5, bottom: 1 };
  return {
    align,
    vertical,
    x: region.originX + width * xs[align],
    y: region.originY + height * ys[vertical],
  };
}

function cueOf(p: XmlElement, span: Span, regionId: string | null, doc: Doc) {
  const out = new SpanBuilder(spanStyle(p, PLAIN, doc));
  collect(p, out, doc);
  tidy(out);
  const spans = out.build();
  const text = spans.map((s) => s.text).join('');
  if (text === '' || span.end <= span.begin) return null;
  const region = regionId != null ? (doc.regions.get(regionId) ?? null) : null;
  const where = place(region, styleValue(p, 'textAlign', doc.styles));
  const cue: SubtitleCue = {
    start: span.begin / 1000,
    end: span.end / 1000,
    text,
    spans,
    ...where,
  };
  return cue;
}

function walk(
  element: XmlElement,
  parent: Span,
  regionId: string | null,
  doc: Doc,
  cues: SubtitleCue[]
): void {
  for (const child of childElements(element)) {
    const span = intervalOf(child, parent, doc);
    const region = attribute(child, 'region') ?? regionId;
    if (child.name === 'p') {
      const cue = cueOf(child, span, region, doc);
      if (cue) cues.push(cue);
    } else if (child.name === 'div' || child.name === 'body') {
      walk(child, span, region, doc, cues);
    } else {
      // Head content, metadata.
    }
  }
}

export function parseTtml(text: string): SubtitleCue[] {
  const tt = parseXml(text);
  if (tt?.name !== 'tt') return [];
  const doc = docOf(tt);
  const body = find(tt, 'body');
  if (!body) return [];
  const cues: SubtitleCue[] = [];
  const whole = intervalOf(
    body,
    { begin: 0, end: Number.MAX_SAFE_INTEGER },
    doc
  );
  walk(body, whole, attribute(body, 'region'), doc, cues);
  return sortCues(cues);
}
