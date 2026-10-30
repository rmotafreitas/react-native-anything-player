// The text encoding of a subtitle file nobody declared. Fansub and DVD-rip
// SubRip files are often Windows-1252, Windows-1251 or Shift-JIS; reading
// them as UTF-8 shows mojibake. Twins: `ios/Core/SubtitleCharset.swift`,
// `android/.../core/SubtitleCharset.kt`, held to
// `conformance/subtitles/charset.json`. Names are WHATWG encoding labels.

/* eslint-disable no-bitwise -- UTF-8 continuation bytes are a bit pattern. */

export type SubtitleCharset =
  | 'utf-8'
  | 'utf-16le'
  | 'utf-16be'
  | 'shift_jis'
  | 'windows-1251'
  | 'windows-1252';

/** Length of a UTF-8 sequence from its lead byte (0: not a lead byte). */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0;
}

export function isValidUtf8(bytes: Uint8Array): boolean {
  let i = 0;
  while (i < bytes.length) {
    const length = sequenceLength(bytes[i]!);
    if (length === 0 || i + length > bytes.length) return false;
    for (let k = 1; k < length; k += 1) {
      if ((bytes[i + k]! & 0xc0) !== 0x80) return false;
    }
    i += length;
  }
  return true;
}

/** UTF-16 without a byte-order mark: ASCII text leaves every other byte zero. */
function utf16Without(bytes: Uint8Array): SubtitleCharset | null {
  if (bytes.length < 4) return null;
  let even = 0;
  let odd = 0;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (bytes[i] === 0) even += 1;
    if (bytes[i + 1] === 0) odd += 1;
  }
  const pairs = Math.floor(bytes.length / 2);
  if (odd > pairs * 0.4 && even < pairs * 0.05) return 'utf-16le';
  if (even > pairs * 0.4 && odd < pairs * 0.05) return 'utf-16be';
  return null;
}

/** Whether the bytes are valid Shift-JIS with the lead bytes of Japanese text. */
function looksShiftJis(bytes: Uint8Array): boolean {
  let pairs = 0;
  let kana = 0;
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i]!;
    // ASCII and half-width katakana are one byte.
    if (b < 0x80 || (b >= 0xa1 && b <= 0xdf)) {
      i += 1;
    } else {
      const lead = (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
      const trail = bytes[i + 1];
      if (!lead || trail == null || !isTrail(trail)) return false;
      // Hiragana, katakana and most kanji lead with 0x81–0x9F: Cyrillic in
      // Windows-1251 almost never does.
      if (b <= 0x9f) kana += 1;
      pairs += 1;
      i += 2;
    }
  }
  return pairs > 0 && kana >= pairs * 0.5;
}

function isTrail(b: number): boolean {
  return (b >= 0x40 && b <= 0x7e) || (b >= 0x80 && b <= 0xfc);
}

function isAsciiLetter(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
}

/** Cyrillic text is mostly non-ASCII letters; Western text mostly ASCII ones. */
function singleByte(bytes: Uint8Array): SubtitleCharset {
  let ascii = 0;
  let high = 0;
  for (const b of bytes) {
    if (isAsciiLetter(b)) ascii += 1;
    else if (b >= 0xc0) high += 1;
    else {
      // Digits, punctuation, controls.
    }
  }
  return high > (ascii + high) * 0.4 ? 'windows-1251' : 'windows-1252';
}

/** The encoding the bytes are most likely in. */
export function detectCharset(bytes: Uint8Array): SubtitleCharset {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  const wide = utf16Without(bytes);
  if (wide != null) return wide;
  if (isValidUtf8(bytes)) return 'utf-8';
  if (looksShiftJis(bytes)) return 'shift_jis';
  return singleByte(bytes);
}
