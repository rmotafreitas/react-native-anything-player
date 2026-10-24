// One entry point for every format: `parseSubtitles(text, format?)`, the
// format taken from the hint, else from the text itself.

import { parseAss } from './ass';
import { parseSrt } from './srt';
import { parseTtml } from './ttml';
import type { SubtitleCue, SubtitleFormat } from './types';
import { parseVtt } from './vtt';

/** The format a file's extension or MIME type names, if any. */
export function formatFromName(
  name: string | null | undefined
): SubtitleFormat | null {
  if (name == null) return null;
  const lower = name.toLowerCase().split(/[?#]/)[0]!;
  if (/(\.srt|subrip)$/.test(lower)) return 'srt';
  if (/(\.vtt|text\/vtt)$/.test(lower)) return 'vtt';
  if (/(\.ass|\.ssa|x-ssa|x-ass)$/.test(lower)) return 'ass';
  if (/(\.ttml|\.dfxp|\.xml|ttml\+xml)$/.test(lower)) return 'ttml';
  return null;
}

/** The format the text looks like (`null`: none RNAP knows). */
export function sniffFormat(text: string): SubtitleFormat | null {
  const head = text
    .replace(/^\uFEFF/, '')
    .trimStart()
    .slice(0, 2048);
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (/^\[Script Info\]/i.test(head) || /\n\[Events\]/i.test(head))
    return 'ass';
  if (/^<(\?xml|tt[\s>:])/.test(head) || /<tt[\s>]/.test(head)) return 'ttml';
  if (/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return 'srt';
  return null;
}

/** Parses a subtitle file; `[]` when it has no cue RNAP can read. */
export function parseSubtitles(
  text: string,
  format?: SubtitleFormat | null
): SubtitleCue[] {
  switch (format ?? sniffFormat(text)) {
    case 'srt':
      return parseSrt(text);
    case 'vtt':
      return parseVtt(text);
    case 'ass':
      return parseAss(text);
    case 'ttml':
      return parseTtml(text);
    default:
      return [];
  }
}
