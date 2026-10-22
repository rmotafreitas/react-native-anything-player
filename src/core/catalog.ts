// Catalog search: what voice assistants and `playFromSearch()` match a
// request against. Pure and deterministic. Twins: `ios/Core/CatalogSearch.swift`
// and `android/.../core/CatalogSearch.kt`; all three run
// `conformance/catalog/*.json` (the fixtures are the specification).
//
// Text is compared as tokens: NFKD, lowercase, NFKD again, combining marks
// removed, a few fix-ups so every platform's casing agrees (ß → ss, final
// sigma → σ, dotless ı → i, & → "and"), then everything that is not a letter or
// a number separates tokens.
//
// Scoring. The query is tried as said, then without leading fillers ("play",
// "listen to", "put on", "start", "the"), then also without trailing "radio" /
// "station"; an item keeps its best score. A field scores 100 when its tokens
// equal the query's, 80 when they start with them, 60 when every query token
// is one of them, 40 when every query token is one of them, a prefix of one
// (3+ letters) or one edit away from one (5+ letters), else 0. Weights: title
// and keywords 100 %, artist 80 %, album 60 %, genre 50 %. Each structured
// request field (title, artist, album, genre) that scores ≥ 40 on its own
// field adds 10 (with no query, the item's score is their sum). Matches score
// ≥ 40 after weighting; `focus` keeps only items of that kind when any match;
// equal scores keep catalog order.

/**
 * The segments of a group path: `"Podcasts/Daily"` is `["Podcasts", "Daily"]`.
 * Segments are trimmed and empty ones dropped, so `" Jazz / "` is `["Jazz"]`
 * and `""` or `"/"` is no group. Comparison is exact (case-sensitive).
 * Twins: `BrowseTree.groupSegments` in Kotlin and Swift, held to
 * `conformance/catalog/browse.json`.
 */
export function groupSegments(group: string | null | undefined): string[] {
  if (typeof group !== 'string') return [];
  return group
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Whether an item filed under `itemGroup` is in `group` or in one of its subgroups. */
export function isInGroup(
  itemGroup: string | null | undefined,
  group: string | null | undefined
): boolean {
  const wanted = groupSegments(group);
  if (wanted.length === 0) return true;
  const own = groupSegments(itemGroup);
  return startsWithTokens(own, wanted);
}

/** The fields search reads, in the shape every platform stores. */
export interface SearchableItem {
  title: string;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  keywords?: readonly string[] | null;
  kind?: string | null;
  /** The browse group (`"Podcasts/Daily"`); not matched by text, only filtered by {@link CatalogQuery.group}. */
  group?: string | null;
}

/** A search request (`query` may be empty when structured fields are given). */
export interface CatalogQuery {
  query: string;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  focus?: string | null;
  /** Only items in this group or its subgroups are searched (see {@link isInGroup}). */
  group?: string | null;
}

/** The outcome of a search. */
export interface SearchOutcome {
  /** Indices into the catalog, best match first. */
  matches: number[];
  /**
   * Nothing matched and the request said nothing beyond filler words ("play",
   * "play the radio"): the platform plays the last item played, else the first.
   */
  emptyQuery: boolean;
}

const MARKS = /[\p{Mn}\p{Mc}\p{Me}]/gu;
const SEPARATORS = /[^\p{L}\p{N}]+/gu;

/** Splits text into normalized tokens. Exported for the conformance tests. */
export function tokenize(text: string): string[] {
  const folded = text
    .normalize('NFKD')
    .toLowerCase()
    .normalize('NFKD')
    .replace(MARKS, '')
    .replace(/ß/g, 'ss')
    .replace(/ς/g, 'σ')
    .replace(/ı/g, 'i')
    .replace(/&/g, ' and ');
  return folded.split(SEPARATORS).filter((token) => token.length > 0);
}

const LEADING_FILLERS: readonly (readonly string[])[] = [
  ['play'],
  ['listen', 'to'],
  ['put', 'on'],
  ['start'],
  ['the'],
];
const TRAILING_FILLERS: ReadonlySet<string> = new Set(['radio', 'station']);

function startsWithTokens(
  tokens: readonly string[],
  prefix: readonly string[]
): boolean {
  return (
    prefix.length <= tokens.length &&
    prefix.every((token, i) => tokens[i] === token)
  );
}

function stripLeading(tokens: string[]): string[] {
  let rest = tokens;
  for (;;) {
    const filler = LEADING_FILLERS.find((f) => startsWithTokens(rest, f));
    if (!filler) return rest;
    rest = rest.slice(filler.length);
  }
}

function stripTrailing(tokens: string[]): string[] {
  let end = tokens.length;
  while (end > 0 && TRAILING_FILLERS.has(tokens[end - 1]!)) end -= 1;
  return tokens.slice(0, end);
}

/** The query as said, then without leading fillers, then without trailing ones. */
function variants(tokens: string[]): string[][] {
  const out = [tokens];
  const leading = stripLeading(tokens);
  if (leading.length > 0 && leading.length !== tokens.length) out.push(leading);
  const trailing = stripTrailing(leading);
  if (trailing.length > 0 && trailing.length !== leading.length)
    out.push(trailing);
  return out;
}

function scalarLength(token: string): number {
  return Array.from(token).length;
}

/** Levenshtein distance over Unicode scalars, capped: `> 1` means "more than one". */
function withinOneEdit(a: string, b: string): boolean {
  const x = Array.from(a);
  const y = Array.from(b);
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (x.length > y.length) i += 1;
    else if (y.length > x.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
}

/** Equal; or a prefix of 3+ letters; or one edit away, for 5+ letters. */
function looseTokenMatch(q: string, length: number, f: string): boolean {
  if (f === q) return true;
  if (length >= 3 && f.startsWith(q)) return true;
  return length >= 5 && withinOneEdit(q, f);
}

function looselyMatches(q: string, field: readonly string[]): boolean {
  const length = scalarLength(q);
  return field.some((f) => looseTokenMatch(q, length, f));
}

/** 100 exact, 80 prefix, 60 every token present, 40 loosely present, else 0. */
function fieldScore(q: readonly string[], field: readonly string[]): number {
  if (q.length === 0 || field.length === 0) return 0;
  if (q.length === field.length && startsWithTokens(field, q)) return 100;
  if (startsWithTokens(field, q)) return 80;
  const present = new Set(field);
  if (q.every((token) => present.has(token))) return 60;
  if (q.every((token) => looselyMatches(token, field))) return 40;
  return 0;
}

/** Field weights, in percent (so every score stays an integer). */
const TITLE = 100;
const KEYWORD = 100;
const ARTIST = 80;
const ALBUM = 60;
const GENRE = 50;
/** Minimum score to be a match, after weighting. */
export const MATCH_THRESHOLD = 40;
const STRUCTURED_BONUS = 10;

interface Tokenized {
  title: string[];
  keywords: string[][];
  artist: string[];
  album: string[];
  genre: string[];
}

function tokenizeItem(item: SearchableItem): Tokenized {
  return {
    title: tokenize(item.title),
    keywords: (item.keywords ?? []).map(tokenize),
    artist: tokenize(item.artist ?? ''),
    album: tokenize(item.album ?? ''),
    genre: tokenize(item.genre ?? ''),
  };
}

function weighted(score: number, weight: number): number {
  return (score * weight) / 100;
}

function freeTextScore(variant: readonly string[], item: Tokenized): number {
  return Math.max(
    weighted(fieldScore(variant, item.title), TITLE),
    ...item.keywords.map((k) => weighted(fieldScore(variant, k), KEYWORD)),
    weighted(fieldScore(variant, item.artist), ARTIST),
    weighted(fieldScore(variant, item.album), ALBUM),
    weighted(fieldScore(variant, item.genre), GENRE)
  );
}

interface Structured {
  title: string[];
  artist: string[];
  album: string[];
  genre: string[];
}

/** Raw scores of the structured fields that match (each ≥ the threshold). */
function structuredScores(s: Structured, item: Tokenized): number[] {
  const scores = [
    Math.max(
      fieldScore(s.title, item.title),
      ...item.keywords.map((k) => fieldScore(s.title, k))
    ),
    fieldScore(s.artist, item.artist),
    fieldScore(s.album, item.album),
    fieldScore(s.genre, item.genre),
  ];
  return scores.filter((score) => score >= MATCH_THRESHOLD);
}

const FOCUS_KINDS: Readonly<Record<string, string>> = {
  station: 'station',
  song: 'song',
  album: 'album',
  podcast: 'podcast',
};

/** Ranks `items` against `request`. */
export function searchCatalog(
  items: readonly SearchableItem[],
  request: CatalogQuery
): SearchOutcome {
  const tokens = tokenize(request.query);
  const queries = tokens.length > 0 ? variants(tokens) : [];
  const structured: Structured = {
    title: tokenize(request.title ?? ''),
    artist: tokenize(request.artist ?? ''),
    album: tokenize(request.album ?? ''),
    genre: tokenize(request.genre ?? ''),
  };
  const hasStructured = Object.values(structured).some((t) => t.length > 0);
  const scored: Array<{ index: number; score: number }> = [];
  const inScope = groupSegments(request.group).length > 0;
  items.forEach((raw, index) => {
    if (inScope && !isInGroup(raw.group, request.group)) return;
    const item = tokenizeItem(raw);
    const extra = structuredScores(structured, item);
    const score =
      queries.length > 0
        ? Math.max(0, ...queries.map((q) => freeTextScore(q, item))) +
          STRUCTURED_BONUS * extra.length
        : extra.reduce((sum, s) => sum + s, 0);
    if (score >= MATCH_THRESHOLD) scored.push({ index, score });
  });
  let ranked = scored;
  const kind = request.focus ? FOCUS_KINDS[request.focus] : undefined;
  if (kind) {
    const focused = scored.filter(
      (s) => (items[s.index]!.kind ?? 'station') === kind
    );
    if (focused.length > 0) ranked = focused;
  }
  ranked.sort((a, b) => b.score - a.score || a.index - b.index);
  const remaining = stripTrailing(stripLeading(tokens));
  return {
    matches: ranked.map((s) => s.index),
    emptyQuery: ranked.length === 0 && !hasStructured && remaining.length === 0,
  };
}
