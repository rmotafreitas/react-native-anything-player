// Playlist files: M3U / extended M3U, PLS and XSPF, read into queue items.
// One parser for every platform (it runs in JavaScript; the engine gets the
// resolved items). An `.m3u8` that turns out to be an HLS playlist is one
// item: the stream itself.

import { PlayerError } from '../errors';
import type { NowPlayingMetadata, Source } from '../types';
import { fetchText } from './video';

/** A playlist file's format. */
export type PlaylistFormat = 'm3u' | 'pls' | 'xspf';

/** An entry of a playlist file: a source to give `player.queue` or `load()`. */
export type PlaylistItem = Source & {
  uri: string;
  metadata?: NowPlayingMetadata;
};

/** `Playlists.parse` / `Playlists.fetch` options. */
export interface PlaylistOptions {
  /** Relative entries resolve against it (`fetch` uses the file's URL). */
  baseUrl?: string;
  /** Default: from the contents. */
  format?: PlaylistFormat;
}

const PLAYLIST_PATH = /\.(pls|m3u|xspf)$/i;
/** Tags only an HLS playlist has. */
const HLS_TAGS = [
  '#EXT-X-TARGETDURATION',
  '#EXT-X-STREAM-INF',
  '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-MEDIA:',
  '#EXT-X-KEY',
  '#EXT-X-INDEPENDENT-SEGMENTS',
];

function isHls(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => HLS_TAGS.some((tag) => line.trim().startsWith(tag)));
}

function invalid(message: string): PlayerError {
  return new PlayerError({
    code: 'INVALID_SOURCE',
    message,
    recoverable: false,
  });
}

/** Whether a URL names a playlist file (`.pls`, `.m3u`, `.xspf`; not `.m3u8`, which is HLS). */
export function isPlaylistUri(uri: string): boolean {
  const path = uri.split('#')[0]!.split('?')[0]!;
  return PLAYLIST_PATH.test(path);
}

/** A relative entry against the playlist's URL (absolute ones, and `file:` paths, as they are). */
function resolve(entry: string, base: string | undefined): string {
  const trimmed = entry.trim();
  if (base == null || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return trimmed;
  }
}

function detect(text: string): PlaylistFormat {
  const head = text.trimStart().slice(0, 200).toLowerCase();
  if (head.startsWith('[playlist]')) return 'pls';
  if (head.startsWith('<?xml') || head.includes('<playlist')) return 'xspf';
  return 'm3u';
}

/** `Artist - Title` (the M3U / PLS convention); a title alone otherwise. */
function splitTitle(raw: string): { artist?: string; title?: string } {
  const text = raw.trim();
  if (text === '') return {};
  const dash = text.indexOf(' - ');
  if (dash > 0)
    return {
      artist: text.slice(0, dash).trim(),
      title: text.slice(dash + 3).trim(),
    };
  return { title: text };
}

function makeItem(
  uri: string,
  seconds: number | null,
  metadata: NowPlayingMetadata,
  headers?: Record<string, string>
): PlaylistItem {
  const item: PlaylistItem = { uri };
  // -1 (or 0 in some players' PLS files): an endless stream.
  if (seconds != null && seconds <= 0) item.live = true;
  if (seconds != null && seconds > 0) metadata.duration ??= seconds;
  const meta = Object.fromEntries(
    Object.entries(metadata).filter(([, v]) => v != null && v !== '')
  ) as NowPlayingMetadata;
  if (Object.keys(meta).length > 0) item.metadata = meta;
  if (headers != null && Object.keys(headers).length > 0)
    item.headers = headers;
  return item;
}

function attribute(line: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`, 'i').exec(line);
  return match?.[1];
}

/** `#EXTINF:<length> <attributes>,<Artist - Title>`: the comma after the attributes. */
function infoComma(body: string): number {
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === ',' && !quoted) return i;
    if (c === '"') quoted = !quoted;
  }
  return -1;
}

/** What the tags before an M3U entry said about it. */
class M3uEntry {
  seconds: number | null = null;
  metadata: NowPlayingMetadata = {};
  image: string | null = null;
  userAgent: string | null = null;

  info(body: string): void {
    const comma = infoComma(body);
    const head = comma >= 0 ? body.slice(0, comma) : body;
    const seconds = Number.parseFloat(head);
    this.seconds = Number.isFinite(seconds) ? seconds : null;
    this.metadata = {
      ...splitTitle(comma >= 0 ? body.slice(comma + 1) : ''),
      artwork: attribute(head, 'tvg-logo'),
    };
  }

  /** A tag line; `false` for a tag it does not know. */
  tag(line: string, album: { value: string | null }): void {
    const upper = line.toUpperCase();
    if (upper.startsWith('#EXTINF:')) this.info(line.slice(8));
    else if (upper.startsWith('#EXTALB:')) album.value = line.slice(8).trim();
    else if (upper.startsWith('#EXTIMG:')) this.image = line.slice(8).trim();
    else if (upper.startsWith('#EXTVLCOPT:HTTP-USER-AGENT='))
      this.userAgent = line.slice(line.indexOf('=') + 1).trim();
    else return;
  }

  item(
    uri: string,
    base: string | undefined,
    album: string | null
  ): PlaylistItem {
    const metadata = { ...this.metadata };
    if (album != null) metadata.album ??= album;
    if (metadata.artwork == null && this.image != null)
      metadata.artwork = resolve(this.image, base);
    const headers =
      this.userAgent != null ? { 'User-Agent': this.userAgent } : undefined;
    return makeItem(resolve(uri, base), this.seconds, metadata, headers);
  }
}

function parseM3u(text: string, base: string | undefined): PlaylistItem[] {
  if (isHls(text)) {
    if (base == null)
      throw invalid(
        'An HLS playlist plays from its URL: pass it as the source.'
      );
    return [{ uri: base }];
  }
  const items: PlaylistItem[] = [];
  const album = { value: null as string | null };
  let pending = new M3uEntry();
  const lines = text.split(/\r?\n/).map((raw) => raw.trim());
  for (const line of lines.filter((l) => l !== '')) {
    if (line.startsWith('#')) {
      pending.tag(line, album);
      continue;
    }
    items.push(pending.item(line, base, album.value));
    pending = new M3uEntry();
  }
  return items;
}

function parsePls(text: string, base: string | undefined): PlaylistItem[] {
  const fields = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (eq <= 0 || line.startsWith(';')) continue;
    fields.set(
      line.slice(0, eq).trim().toLowerCase(),
      line.slice(eq + 1).trim()
    );
  }
  const numbers = [...fields.keys()]
    .map((k) => /^file(\d+)$/.exec(k)?.[1])
    .filter((n): n is string => n != null)
    .map(Number)
    .sort((a, b) => a - b);
  return numbers.map((n) => {
    const length = Number.parseFloat(fields.get(`length${n}`) ?? '');
    return makeItem(
      resolve(fields.get(`file${n}`)!, base),
      Number.isFinite(length) ? length : null,
      splitTitle(fields.get(`title${n}`) ?? '')
    );
  });
}

const XML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function xmlText(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const text = value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X'))
        return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      if (code.startsWith('#'))
        return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
      return XML_ENTITIES[code.toLowerCase()] ?? m;
    })
    .trim();
  return text === '' ? undefined : text;
}

function xmlField(track: string, name: string): string | undefined {
  const match = new RegExp(
    `<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`,
    'i'
  ).exec(track);
  return xmlText(match?.[1]);
}

function parseXspf(text: string, base: string | undefined): PlaylistItem[] {
  const items: PlaylistItem[] = [];
  for (const match of text.matchAll(
    /<track(?:\s[^>]*)?>([\s\S]*?)<\/track>/gi
  )) {
    const track = match[1]!;
    const location = xmlField(track, 'location');
    if (location == null) continue;
    const ms = Number.parseFloat(xmlField(track, 'duration') ?? '');
    const image = xmlField(track, 'image');
    items.push(
      makeItem(
        resolve(location, base),
        Number.isFinite(ms) ? ms / 1000 : null,
        {
          title: xmlField(track, 'title'),
          artist: xmlField(track, 'creator'),
          album: xmlField(track, 'album'),
          artwork: image != null ? resolve(image, base) : undefined,
        }
      )
    );
  }
  return items;
}

/**
 * Reads a playlist file's text into queue items: M3U and extended M3U
 * (`#EXTINF` length, `Artist - Title`, `tvg-logo`, `#EXTIMG`, `#EXTALB`,
 * `#EXTVLCOPT:http-user-agent`), PLS and XSPF. An endless entry (length
 * `-1`) is `live`. Relative entries resolve against `baseUrl`.
 */
function parse(text: string, options: PlaylistOptions = {}): PlaylistItem[] {
  const format = options.format ?? detect(text);
  switch (format) {
    case 'pls':
      return parsePls(text, options.baseUrl);
    case 'xspf':
      return parseXspf(text, options.baseUrl);
    default:
      return parseM3u(text, options.baseUrl);
  }
}

/** Fetches a playlist file (through the platform: any text encoding) and reads it. */
async function fetchPlaylist(
  url: string,
  options: { headers?: Record<string, string>; format?: PlaylistFormat } = {}
): Promise<PlaylistItem[]> {
  const { text } = await fetchText(
    url,
    options.headers ?? {},
    null,
    () => true
  );
  return parse(text, { baseUrl: url, format: options.format });
}

/**
 * The first entry of the playlist file `source` names (a radio station's
 * `listen.pls`), with the source's own options on top; other sources as
 * they are.
 */
export async function resolvePlaylistSource<T extends Source>(
  source: T
): Promise<T> {
  const uri = source.uri;
  if (uri == null || !isPlaylistUri(uri)) return source;
  const items = await fetchPlaylist(uri, { headers: source.headers });
  const first = items[0];
  if (first == null) throw invalid(`The playlist ${uri} has no entries.`);
  const resolved: T = { ...first, ...source, uri: first.uri };
  const headers = { ...first.headers, ...source.headers };
  if (Object.keys(headers).length > 0) resolved.headers = headers;
  const metadata = { ...first.metadata, ...source.metadata };
  if (Object.keys(metadata).length > 0) resolved.metadata = metadata;
  const live = source.live ?? first.live;
  if (live != null) resolved.live = live;
  return resolved;
}

/** Playlist files (see the Queue guide). */
export const Playlists = {
  parse,
  fetch: fetchPlaylist,
  isPlaylistUri,
};
