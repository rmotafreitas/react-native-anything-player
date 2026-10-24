// The JavaScript side of video, shared by every platform: validating the
// video parts of a source, loading the app's subtitle files (fetch, encoding,
// parse, retry with backoff) and handing their cues to the engine module, the
// thumbnail track behind `getThumbnail`, and answering a source refresh.
// Playback decisions stay native (the engine); this is what only JavaScript
// can do (call the app's `refresh`) or does once for every platform (parse).

import { PlayerError } from '../errors';
import type {
  PlayerErrorCode,
  Rendition,
  Source,
  SourceRefreshRequest,
  SubtitleSource,
  Thumbnail,
} from '../types';
import { host } from './host';
import { formatFromName, parseSubtitles } from './subtitles/parse';
import { parseVtt } from './subtitles/vtt';
import type { SubtitleCue } from './subtitles/types';

function invalid(message: string): PlayerError {
  return new PlayerError({
    code: 'INVALID_ARGUMENT',
    message,
    recoverable: false,
  });
}

function positive(name: string, value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw invalid(`${name} must be a positive number.`);
  return value;
}

/** The renditions as the engine module takes them. */
export function normalizeRenditions(
  list: Rendition[]
): Record<string, unknown>[] {
  if (!Array.isArray(list) || list.length === 0)
    throw invalid('`renditions` must be a non-empty array.');
  return list.map((r, i) => {
    if (!r || typeof r.uri !== 'string' || r.uri.trim() === '')
      throw invalid(`renditions[${i}] needs a non-empty \`uri\`.`);
    const out: Record<string, unknown> = { uri: r.uri.trim() };
    if (r.headers) out.headers = { ...r.headers };
    const height = positive(`renditions[${i}].height`, r.height);
    const bitrate = positive(`renditions[${i}].bitrate`, r.bitrate);
    if (height != null) out.height = height;
    if (bitrate != null) out.bitrate = bitrate;
    if (r.label != null) out.label = String(r.label);
    if (r.audioOnly === true) out.audioOnly = true;
    return out;
  });
}

/** A subtitle file's id, kind and flags, as the engine module lists it. */
export interface SubtitleTrackInfo {
  id: string;
  kind: 'subtitles' | 'captions';
  language: string | null;
  label: string | null;
  forced: boolean;
  default: boolean;
}

/** Ids the app did not give are `sub:<n>`, numbered across the player's files. */
export function subtitleTracks(
  list: SubtitleSource[],
  firstIndex = 0
): Array<{ info: SubtitleTrackInfo; source: SubtitleSource }> {
  if (!Array.isArray(list)) throw invalid('`subtitles` must be an array.');
  return list.map((s, i) => {
    if (!s || (typeof s.uri !== 'string' && typeof s.text !== 'string'))
      throw invalid(`subtitles[${i}] needs a \`uri\` or a \`text\`.`);
    return {
      source: s,
      info: {
        id: s.id ?? `sub:${firstIndex + i}`,
        kind: s.kind === 'captions' ? 'captions' : 'subtitles',
        language: s.language ?? null,
        label: s.label ?? null,
        forced: s.forced === true,
        default: s.default === true,
      },
    };
  });
}

/** The video parts of a source (the rest is `normalizeSource`'s). */
export function normalizeVideoSource(
  source: Source,
  resolveArtwork: (art: NonNullable<Source['poster']>) => string | null
): Record<string, unknown> {
  if (source.drm != null) {
    throw new PlayerError({
      code: 'DRM_UNSUPPORTED',
      message:
        'DRM is not supported yet. See the video design notes for when it ships.',
      recoverable: false,
    });
  }
  const out: Record<string, unknown> = {};
  if (source.renditions != null)
    out.renditions = normalizeRenditions(source.renditions);
  if (source.subtitles != null)
    out.subtitles = subtitleTracks(source.subtitles).map((t) => t.info);
  if (source.refresh != null) {
    if (typeof source.refresh !== 'function')
      throw invalid('`refresh` must be a function that returns a source.');
    out.refreshable = true;
  }
  if (source.expiresAt != null) {
    if (!Number.isFinite(source.expiresAt))
      throw invalid('`expiresAt` must be epoch milliseconds.');
    out.expiresAt = source.expiresAt;
  }
  if (source.poster != null) {
    const poster = resolveArtwork(source.poster);
    if (poster != null) out.poster = poster;
  }
  if (source.thumbnails != null) out.thumbnails = String(source.thumbnails);
  return out;
}

// ── Fetching text ──

/** A fetched text file and the encoding it was read in. */
interface FetchedText {
  text: string;
  charset: string;
}

/** 408 and 429 are worth retrying; other client errors are not. */
function retryable(error: PlayerError): boolean {
  const status = error.httpStatus;
  if (status == null)
    return error.recoverable || error.code === 'NETWORK_ERROR';
  return status >= 500 || status === 408 || status === 429;
}

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One fetch through the platform; a failure as a `PlayerError`. */
async function fetchOnce(
  uri: string,
  headers: Record<string, string>,
  encoding: string | null
): Promise<FetchedText> {
  try {
    return (await host()
      .module()
      .fetchText(uri, headers, encoding)) as FetchedText;
  } catch (error) {
    if (error instanceof PlayerError) throw error;
    const e = error as {
      code?: string;
      message?: string;
      userInfo?: { httpStatus?: number };
    };
    throw new PlayerError({
      code: (e.code ?? 'NETWORK_ERROR') as PlayerErrorCode,
      message: String(e.message ?? error),
      recoverable: true,
      httpStatus: e.userInfo?.httpStatus,
    });
  }
}

/** Fetches through the platform (native decodes any charset), with backoff. */
async function fetchText(
  uri: string,
  headers: Record<string, string>,
  encoding: string | null,
  alive: () => boolean
): Promise<FetchedText> {
  let attempt = 0;
  for (;;) {
    if (!alive()) {
      throw new PlayerError({
        code: 'NO_SOURCE',
        message: 'Superseded.',
        recoverable: false,
      });
    }
    try {
      return await fetchOnce(uri, headers, encoding);
    } catch (error) {
      const failure = error as PlayerError;
      const delay = RETRY_DELAYS_MS[attempt];
      if (!retryable(failure) || delay == null) throw failure;
      attempt += 1;
      await sleep(delay);
    }
  }
}

// ── Subtitle files ──

/** What the loader needs from its player. */
export interface SubtitleSink {
  /** Hands a file's cues to the engine module. */
  sendCues(
    session: string,
    trackId: string,
    cues: SubtitleCue[]
  ): Promise<void>;
  /** A file could not be loaded (a non-fatal `error` event). */
  failed(error: PlayerError): void;
}

let sessions = 0;

/** Loads one load's subtitle files; a new load (or release) cancels it. */
export class SubtitleLoader {
  private session: string | null = null;
  private count = 0;

  constructor(private readonly sink: SubtitleSink) {}

  /** Starts a new load's files; returns the session id the module is given. */
  begin(): string {
    sessions += 1;
    this.session = `s${sessions}`;
    this.count = 0;
    return this.session;
  }

  /** The number of files so far (for `sub:<n>` ids). */
  get size(): number {
    return this.count;
  }

  cancel(): void {
    this.session = null;
  }

  /** Loads `tracks` into the current session (from `load` or `addSubtitles`). */
  add(
    tracks: Array<{ info: SubtitleTrackInfo; source: SubtitleSource }>,
    headers: Record<string, string>
  ): void {
    const session = this.session;
    if (session == null) return;
    this.count += tracks.length;
    for (const track of tracks) {
      this.loadOne(session, track.info.id, track.source, headers).catch(
        () => undefined
      );
    }
  }

  private async loadOne(
    session: string,
    id: string,
    source: SubtitleSource,
    headers: Record<string, string>
  ): Promise<void> {
    const alive = () => this.session === session;
    try {
      const text =
        source.text ??
        (
          await fetchText(
            source.uri!,
            { ...headers, ...source.headers },
            source.encoding ?? null,
            alive
          )
        ).text;
      if (!alive()) return;
      const format = source.format ?? formatFromName(source.uri);
      const cues = parseSubtitles(text, format);
      if (cues.length === 0 && text.trim() !== '') {
        throw new PlayerError({
          code: 'UNSUPPORTED_FORMAT',
          message: `The subtitle file ${source.uri ?? id} is in no format RNAP reads (SubRip, WebVTT, ASS, TTML).`,
          recoverable: false,
        });
      }
      await this.sink.sendCues(session, id, cues);
    } catch (error) {
      if (!alive()) return;
      const cause = error instanceof PlayerError ? error : null;
      this.sink.failed(
        new PlayerError({
          code: 'SUBTITLE_LOAD_FAILED',
          message: `Subtitles "${id}" could not be loaded: ${cause?.message ?? String(error)}`,
          recoverable: false,
          httpStatus: cause?.httpStatus,
          cause: cause?.code,
        })
      );
    }
  }
}

// ── Thumbnails ──

interface ThumbnailCue {
  start: number;
  end: number;
  thumbnail: Thumbnail;
}

function resolveUrl(relative: string, base: string): string {
  try {
    return new URL(relative, base).toString();
  } catch {
    return relative;
  }
}

/** `sprite.jpg#xywh=0,0,160,90` (relative to the track) → a thumbnail. */
function thumbnailOf(text: string, base: string): Thumbnail {
  const [path = '', fragment] = text.trim().split('#');
  const xywh = /^xywh=(\d+),(\d+),(\d+),(\d+)$/.exec(fragment ?? '');
  return {
    uri: resolveUrl(path, base),
    x: xywh ? Number(xywh[1]) : null,
    y: xywh ? Number(xywh[2]) : null,
    width: xywh ? Number(xywh[3]) : null,
    height: xywh ? Number(xywh[4]) : null,
  };
}

/** A WebVTT thumbnail track, fetched once on first use. */
export class ThumbnailTrack {
  private cues: Promise<ThumbnailCue[]> | null = null;

  constructor(
    private readonly uri: string,
    private readonly headers: Record<string, string>
  ) {}

  async at(time: number): Promise<Thumbnail | null> {
    this.cues ??= fetchText(this.uri, this.headers, null, () => true).then(
      ({ text }) =>
        parseVtt(text).map((cue) => ({
          start: cue.start,
          end: cue.end,
          thumbnail: thumbnailOf(cue.text, this.uri),
        })),
      (error: unknown) => {
        this.cues = null;
        throw error;
      }
    );
    const cues = await this.cues;
    return cues.find((c) => time >= c.start && time < c.end)?.thumbnail ?? null;
  }
}

// ── Refresh ──

/** Calls the app's `refresh` and returns its new source, or `null` when it failed. */
export async function callRefresh(
  refresh: (request: SourceRefreshRequest) => Promise<unknown>,
  reason: SourceRefreshRequest['reason']
): Promise<unknown> {
  try {
    return await refresh({ reason });
  } catch (error) {
    // The engine falls back to the original failure; the app hears about it.
    console.warn('react-native-anything-player: `refresh` failed:', error);
    return null;
  }
}
