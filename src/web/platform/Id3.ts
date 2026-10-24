/* eslint-disable no-bitwise -- ID3 sizes are syncsafe bit fields. */
// The text frames of an ID3v2 tag (the timed metadata of an HLS audio
// stream), as stream metadata. Twin of the Android driver's
// `TextInformationFrame` mapping: TIT2 is the title, TPE1 the artist, TALB the
// album, any other text frame is kept in `raw`.

import { IcyParser, type StreamMetadata } from '../engine/StreamMetadata';

const HEADER = 10;
const FLAG_EXTENDED_HEADER = 0x40;

function syncsafe(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at]! << 21) |
    (bytes[at + 1]! << 14) |
    (bytes[at + 2]! << 7) |
    bytes[at + 3]!
  );
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  return String.fromCodePoint(...bytes.subarray(at, at + length));
}

function utf16(bytes: Uint8Array, bigEndianByDefault: boolean): string {
  let big = bigEndianByDefault;
  let start = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    big = false;
    start = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    big = true;
    start = 2;
  } else {
    // No byte order mark: the encoding's default stands.
  }
  let out = '';
  for (let i = start; i + 1 < bytes.length; i += 2) {
    const unit = big
      ? (bytes[i]! << 8) | bytes[i + 1]!
      : (bytes[i + 1]! << 8) | bytes[i]!;
    out += String.fromCodePoint(unit);
  }
  return out;
}

/** The first string of a text frame's body (encoding byte, then NUL-separated values). */
function textOf(body: Uint8Array): string {
  const encoding = body[0];
  const text = body.subarray(1);
  const wide = encoding === 1 || encoding === 2;
  let end = text.length;
  for (let i = 0; i < text.length; i += wide ? 2 : 1) {
    if (text[i] === 0 && (!wide || text[i + 1] === 0)) {
      end = i;
      break;
    }
  }
  const value = text.subarray(0, end);
  if (encoding === 0) return String.fromCodePoint(...value);
  if (encoding === 3) return IcyParser.decode(value);
  return utf16(value, encoding === 2);
}

interface FrameLayout {
  idLength: number;
  sizeOf(bytes: Uint8Array, at: number): number;
  /** Bytes of header after the id and size. */
  flagBytes: number;
}

/** Frame headers by major version: 2.2 has 3-char ids and no flags; 2.4 sizes are syncsafe. */
function layoutOf(major: number): FrameLayout | null {
  const u32 = (b: Uint8Array, at: number) =>
    ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>>
    0;
  if (major === 2) {
    return {
      idLength: 3,
      sizeOf: (b, at) => (b[at]! << 16) | (b[at + 1]! << 8) | b[at + 2]!,
      flagBytes: 0,
    };
  }
  if (major === 3) return { idLength: 4, sizeOf: u32, flagBytes: 2 };
  if (major === 4) return { idLength: 4, sizeOf: syncsafe, flagBytes: 2 };
  return null;
}

/** Where the frames start: past the header and an extended header, if any. */
function framesStart(tag: Uint8Array, major: number): number {
  if ((tag[5]! & FLAG_EXTENDED_HEADER) === 0 || major === 2) return HEADER;
  // 2.4 counts its own four bytes; 2.3 does not.
  const size =
    major === 4
      ? syncsafe(tag, HEADER)
      : 4 + new DataView(tag.buffer, tag.byteOffset).getUint32(HEADER);
  return HEADER + size;
}

/**
 * The title, artist and album of an ID3v2 tag (2.2–2.4), or `null` when it has
 * no text frames. Unsynchronisation and compressed or encrypted frames are not
 * handled (HLS timed metadata does not use them).
 */
export function id3Metadata(tag: Uint8Array): StreamMetadata | null {
  if (tag.length < HEADER || ascii(tag, 0, 3) !== 'ID3') return null;
  const layout = layoutOf(tag[3]!);
  if (!layout) return null;
  const end = Math.min(tag.length, HEADER + syncsafe(tag, 6));
  const header = layout.idLength + (layout.idLength === 3 ? 3 : 4);
  const raw: Record<string, string> = {};
  let at = framesStart(tag, tag[3]!);
  while (at + header + layout.flagBytes <= end && tag[at] !== 0) {
    const id = ascii(tag, at, layout.idLength);
    const size = layout.sizeOf(tag, at + layout.idLength);
    const body = at + header + layout.flagBytes;
    if (size <= 0 || body + size > end) break;
    // Text frames are T…, except the user-defined TXXX/TXX (a description and a value).
    if (id.startsWith('T') && id !== 'TXXX' && id !== 'TXX') {
      const value = textOf(tag.subarray(body, body + size)).trim();
      if (value !== '' && !(id in raw)) raw[id] = value;
    }
    at = body + size;
  }
  if (Object.keys(raw).length === 0) return null;
  return {
    title: raw.TIT2 ?? raw.TT2 ?? null,
    artist: raw.TPE1 ?? raw.TP1 ?? null,
    album: raw.TALB ?? raw.TAL ?? null,
    station: null,
    genre: null,
    artworkUri: null,
    raw,
  };
}
