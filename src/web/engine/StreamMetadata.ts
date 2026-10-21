// Normalization of in-stream metadata (ICY / Shoutcast / Icecast) into one
// shape, and the byte-level ICY de-interleaver the web stream reader uses.
// Twins: `ios/Core/StreamMetadata.swift`, `android/.../core/StreamMetadata.kt`;
// all three run `conformance/metadata/icy.json`.

export interface StreamMetadata {
  title: string | null;
  artist: string | null;
  album: string | null;
  /** Station name (ICY `icy-name` header). */
  station: string | null;
  genre: string | null;
  /** Artwork URL carried by the stream (ICY `StreamUrl` when it is an image). */
  artworkUri: string | null;
  /** Every raw field, untouched. */
  raw: Record<string, string>;
}

export const EMPTY_METADATA: StreamMetadata = {
  title: null,
  artist: null,
  album: null,
  station: null,
  genre: null,
  artworkUri: null,
  raw: {},
};

/** How a station formats ICY `StreamTitle`. */
export type StreamTitleFormat = 'artist-title' | 'title-artist' | 'title';

const SEPARATORS = [' - ', ' – ', ' — ', ' ~ '];
const SEPARATOR_CHARS = '-–—~ ';
const LETTER_OR_DIGIT = /^[\p{L}\p{Nd}]$/u;

/** Windows-1252 0x80–0x9F → Unicode (undefined bytes map to C1 controls). */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c,
  0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d,
  0x017e, 0x0178,
];

interface Utf8Decoder {
  decode(bytes: Uint8Array): string;
}
type DecoderConstructor = new (
  label: string,
  options: { fatal: boolean; ignoreBOM: boolean }
) => Utf8Decoder;
let utf8: Utf8Decoder | null = null;

function strictUtf8(bytes: Uint8Array): string | null {
  // Strict: invalid UTF-8 throws, so Windows-1252 can take over (the BOM is kept, as on the twins).
  utf8 ??= new (
    globalThis as unknown as { TextDecoder: DecoderConstructor }
  ).TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  });
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

function cp1252CodePoint(byte: number): number {
  return byte >= 0x80 && byte <= 0x9f ? CP1252_HIGH[byte - 0x80]! : byte;
}

/**
 * The byte a platform decoder turned into `codePoint`: Windows-1252 maps
 * 0x80–0x9F to typographic characters, ISO-8859-1 to the C1 controls
 * U+0080–U+009F — both are taken back (UTF-8 continuation bytes land there
 * for most CJK text).
 */
function cp1252Byte(codePoint: number): number | null {
  if (codePoint <= 0xff) return codePoint;
  const index = CP1252_HIGH.indexOf(codePoint);
  return index >= 0 ? 0x80 + index : null;
}

function nonEmpty(s: string): string | null {
  const trimmed = s.trim();
  return trimmed === '' ? null : trimmed;
}

function startsKey(text: string, index: number): boolean {
  let i = index;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch !== '_' && ch !== '-' && !LETTER_OR_DIGIT.test(ch)) break;
    i += 1;
  }
  return (
    i > index && i + 1 < text.length && text[i] === '=' && text[i + 1] === "'"
  );
}

/** Where a field's value ends, and where the next field starts. */
function fieldEnd(text: string, valueStart: number): [number, number] {
  // The value ends at the first `';` that is followed by another key (or the end).
  let candidate = text.indexOf("';", valueStart);
  while (candidate >= 0) {
    const after = candidate + 2;
    if (after >= text.length || startsKey(text, after))
      return [candidate, after];
    candidate = text.indexOf("';", candidate + 1);
  }
  // Unterminated: the rest, without trailing quotes and semicolons.
  let stop = text.length;
  while (stop > valueStart && "';".includes(text[stop - 1]!)) stop -= 1;
  return [stop, text.length];
}

export const IcyParser = {
  /** Decodes a raw block: NUL padding stripped, UTF-8 if valid, else Windows-1252. */
  decode(bytes: Uint8Array): string {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    const trimmed = bytes.subarray(0, end);
    const text = strictUtf8(trimmed);
    if (text != null) return text;
    let out = '';
    for (const b of trimmed) out += String.fromCodePoint(cp1252CodePoint(b));
    return out;
  },

  /** Repairs UTF-8 text a platform decoded as Latin-1/Windows-1252 ("CafÃ©" → "Café"). */
  repairMojibake(text: string): string {
    const out: number[] = [];
    let sawHigh = false;
    for (const ch of text) {
      const byte = cp1252Byte(ch.codePointAt(0)!);
      if (byte == null) return text;
      if (byte >= 0x80) sawHigh = true;
      out.push(byte);
    }
    if (!sawHigh) return text;
    return strictUtf8(Uint8Array.from(out)) ?? text;
  },

  /** Parses `StreamTitle='…';StreamUrl='…';` into fields (quotes/semicolons in values allowed). */
  parseFields(block: string): Map<string, string> {
    const result = new Map<string, string>();
    let i = 0;
    while (i < block.length) {
      const eq = block.indexOf("='", i);
      if (eq < 0) break;
      const key = block.substring(i, eq).trim();
      let valueStart = eq + 2;
      const [end, next] = fieldEnd(block, valueStart);
      if (valueStart > end) valueStart = end;
      if (key !== '' && !result.has(key))
        result.set(key, block.substring(valueStart, end));
      i = next;
    }
    return result;
  },

  /** Splits a StreamTitle per `format`. Returns [artist, title]. */
  splitStreamTitle(
    raw: string,
    format: StreamTitleFormat
  ): [string | null, string | null] {
    const trimmed = raw.trim();
    if ([...trimmed].every((c) => SEPARATOR_CHARS.includes(c)))
      return [null, null];
    if (format === 'title') return [null, trimmed];
    for (const separator of SEPARATORS) {
      const at = trimmed.indexOf(separator);
      if (at >= 0) {
        const left = nonEmpty(trimmed.substring(0, at));
        const right = nonEmpty(trimmed.substring(at + separator.length));
        if (left == null && right == null) return [null, null];
        return format === 'artist-title' ? [left, right] : [right, left];
      }
    }
    return [null, trimmed];
  },

  metadataFromFields(
    rawFields: Map<string, string> | Record<string, string>,
    format: StreamTitleFormat
  ): StreamMetadata {
    const entries =
      rawFields instanceof Map ? [...rawFields] : Object.entries(rawFields);
    const fields = new Map<string, string>();
    for (const [key, value] of entries)
      fields.set(key, IcyParser.repairMojibake(value));
    const lower = new Map<string, string>();
    for (const [key, value] of fields) {
      const k = key.toLowerCase();
      if (!lower.has(k)) lower.set(k, value);
    }
    let artist: string | null = null;
    let title: string | null = null;
    const streamTitle = lower.get('streamtitle');
    if (streamTitle != null)
      [artist, title] = IcyParser.splitStreamTitle(streamTitle, format);
    const streamUrl = lower.get('streamurl');
    const name = lower.get('icy-name');
    const genre = lower.get('icy-genre');
    return {
      title,
      artist,
      album: null,
      station: name != null ? nonEmpty(name) : null,
      genre: genre != null ? nonEmpty(genre) : null,
      artworkUri:
        streamUrl != null && IcyParser.looksLikeImage(streamUrl)
          ? streamUrl
          : null,
      raw: Object.fromEntries(fields),
    };
  },

  /** A block without `StreamTitle`/`StreamUrl` (corrupted framing, garbage) yields empty metadata. */
  metadataFromBlock(
    bytes: Uint8Array,
    format: StreamTitleFormat
  ): StreamMetadata {
    const fields = IcyParser.parseFields(IcyParser.decode(bytes));
    const known = [...fields.keys()].some((k) => {
      const lower = k.toLowerCase();
      return lower === 'streamtitle' || lower === 'streamurl';
    });
    return known
      ? IcyParser.metadataFromFields(fields, format)
      : EMPTY_METADATA;
  },

  looksLikeImage(url: string): boolean {
    const lower = url.toLowerCase();
    if (!lower.startsWith('http://') && !lower.startsWith('https://'))
      return false;
    const path = lower.split('?')[0]!;
    return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].some((ext) =>
      path.endsWith(ext)
    );
  },
};

/** One ICY metadata block and where it sits in the audio. */
export interface IcyBlock {
  /** Audio bytes delivered before this block (its position in the audio). */
  audioOffset: number;
  bytes: Uint8Array;
}

interface Output {
  audio: Uint8Array;
  length: number;
  blocks: IcyBlock[];
}

type Phase =
  | { kind: 'audio'; remaining: number }
  | { kind: 'length' }
  | { kind: 'metadata'; remaining: number };

/**
 * Incremental de-interleaver for an ICY body: every `metaint` audio bytes are
 * followed by one length byte `L` and `L × 16` bytes of metadata (NUL-padded);
 * `L == 0` means "no change". Chunk boundaries may fall anywhere.
 */
export class IcyDeinterleaver {
  private phase: Phase;
  private pending: number[] = [];
  private _audioBytes = 0;

  /** `metaint <= 0` passes everything through as audio. */
  constructor(readonly metaint: number) {
    this.phase = { kind: 'audio', remaining: Math.max(metaint, 0) };
  }

  get audioBytes(): number {
    return this._audioBytes;
  }

  consume(data: Uint8Array): { audio: Uint8Array; blocks: IcyBlock[] } {
    if (this.metaint <= 0) {
      this._audioBytes += data.length;
      return { audio: data, blocks: [] };
    }
    const out: Output = {
      audio: new Uint8Array(data.length),
      length: 0,
      blocks: [],
    };
    let i = 0;
    while (i < data.length) i = this.step(data, i, out);
    return { audio: out.audio.subarray(0, out.length), blocks: out.blocks };
  }

  /** Consumes what the current phase can take from `data` at `i`; returns the next index. */
  private step(data: Uint8Array, i: number, out: Output): number {
    const phase = this.phase;
    if (phase.kind === 'audio')
      return this.takeAudio(data, i, phase.remaining, out);
    if (phase.kind === 'length') return this.takeLength(data, i);
    return this.takeMetadata(data, i, phase.remaining, out);
  }

  private takeAudio(
    data: Uint8Array,
    i: number,
    remaining: number,
    out: Output
  ): number {
    const take = Math.min(remaining, data.length - i);
    out.audio.set(data.subarray(i, i + take), out.length);
    out.length += take;
    this._audioBytes += take;
    const left = remaining - take;
    this.phase =
      left === 0 ? { kind: 'length' } : { kind: 'audio', remaining: left };
    return i + take;
  }

  private takeLength(data: Uint8Array, i: number): number {
    const length = data[i]! * 16;
    if (length === 0) {
      this.phase = { kind: 'audio', remaining: this.metaint };
    } else {
      this.pending = [];
      this.phase = { kind: 'metadata', remaining: length };
    }
    return i + 1;
  }

  private takeMetadata(
    data: Uint8Array,
    i: number,
    remaining: number,
    out: Output
  ): number {
    const take = Math.min(remaining, data.length - i);
    for (let k = 0; k < take; k++) this.pending.push(data[i + k]!);
    const left = remaining - take;
    if (left === 0) {
      out.blocks.push({
        audioOffset: this._audioBytes,
        bytes: Uint8Array.from(this.pending),
      });
      this.pending = [];
      this.phase = { kind: 'audio', remaining: this.metaint };
    } else {
      this.phase = { kind: 'metadata', remaining: left };
    }
    return i + take;
  }
}
