// Which audio and text tracks a video starts with, before the app picks any:
// the preferred languages, the OS's captions and audio-description settings,
// forced subtitles for the audio's language, subtitles when the audio is in
// another language, and the file's default flags. Twins:
// `ios/Core/TrackSelection.swift`, `android/.../core/TrackSelection.kt`, held
// to `conformance/tracks/select.json`.

export type TrackKind = 'audio' | 'subtitles' | 'captions';

export interface MediaTrack {
  id: string;
  kind: TrackKind;
  /** BCP 47 or ISO 639 (`pt-BR`, `jpn`); `null` when unknown. */
  language: string | null;
  label: string | null;
  /** Subtitles only for what is not in the audio's language (signs, foreign lines). */
  forced: boolean;
  /** The file marks it as the default. */
  default: boolean;
  /** Subtitles for the deaf and hard of hearing (closed captions, SDH). */
  sdh: boolean;
  /** An audio description of the picture. */
  describesVideo: boolean;
}

export interface TrackPreferences {
  /** The app's languages, in order (`video.tracks.languages`). */
  languages: readonly string[];
  /** Follow the OS's accessibility settings (`video.tracks.followSystem`). */
  followSystem: boolean;
  /** The device's languages, in order. */
  systemLanguages: readonly string[];
  /** The OS asks for captions (iOS "Closed Captions + SDH", Android caption settings). */
  systemCaptions: boolean;
  /** The OS asks for audio descriptions. */
  systemAudioDescriptions: boolean;
}

export interface TrackChoice {
  audio: string | null;
  text: string | null;
}

/** ISO 639-2 (bibliographic and terminology) → 639-1, for the common languages. */
const ISO639_2: Record<string, string> = {
  ara: 'ar',
  ben: 'bn',
  bul: 'bg',
  cat: 'ca',
  ces: 'cs',
  cze: 'cs',
  chi: 'zh',
  zho: 'zh',
  dan: 'da',
  deu: 'de',
  ger: 'de',
  dut: 'nl',
  nld: 'nl',
  ell: 'el',
  gre: 'el',
  eng: 'en',
  est: 'et',
  fas: 'fa',
  per: 'fa',
  fin: 'fi',
  fra: 'fr',
  fre: 'fr',
  heb: 'he',
  hin: 'hi',
  hrv: 'hr',
  hun: 'hu',
  ind: 'id',
  ita: 'it',
  jpn: 'ja',
  kor: 'ko',
  lav: 'lv',
  lit: 'lt',
  may: 'ms',
  msa: 'ms',
  nor: 'no',
  nob: 'nb',
  pol: 'pl',
  por: 'pt',
  ron: 'ro',
  rum: 'ro',
  rus: 'ru',
  slk: 'sk',
  slo: 'sk',
  slv: 'sl',
  spa: 'es',
  srp: 'sr',
  swe: 'sv',
  tha: 'th',
  tur: 'tr',
  ukr: 'uk',
  vie: 'vi',
};

/** The primary language, two letters where there are (`pt-BR` → `pt`, `jpn` → `ja`). */
export function primaryLanguage(tag: string | null | undefined): string | null {
  if (tag == null) return null;
  const primary = tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  if (primary === '' || primary === 'und' || primary === 'mul') return null;
  return ISO639_2[primary] ?? primary;
}

/** The languages to look for, in order, without repeats. */
function wanted(p: TrackPreferences): string[] {
  const order: string[] = [];
  for (const tag of [...p.languages, ...p.systemLanguages]) {
    const lang = primaryLanguage(tag);
    if (lang != null && !order.includes(lang)) order.push(lang);
  }
  return order;
}

/** The first track by language preference, then by `rank` (lower first). */
function best(
  tracks: MediaTrack[],
  languages: string[],
  rank: (t: MediaTrack) => number
): MediaTrack | null {
  for (const lang of languages) {
    const matches = tracks.filter((t) => primaryLanguage(t.language) === lang);
    if (matches.length > 0) return sortBy(matches, rank)[0]!;
  }
  return null;
}

function sortBy(
  tracks: MediaTrack[],
  rank: (t: MediaTrack) => number
): MediaTrack[] {
  return tracks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map((e) => e.t);
}

function chooseAudio(
  audio: MediaTrack[],
  p: TrackPreferences,
  languages: string[]
) {
  if (audio.length === 0) return null;
  const describe = p.followSystem && p.systemAudioDescriptions;
  // With audio descriptions asked for they come first; otherwise last.
  const rank = (t: MediaTrack) =>
    (t.describesVideo === describe ? 0 : 2) + (t.default ? 0 : 1);
  return (
    best(audio, languages, rank) ??
    sortBy(
      audio.filter((t) => !t.describesVideo || describe),
      (t) => (t.default ? 0 : 1)
    )[0] ??
    audio[0]!
  );
}

function chooseText(
  text: MediaTrack[],
  audioLanguage: string | null,
  p: TrackPreferences,
  languages: string[]
): MediaTrack | null {
  const full = text.filter((t) => !t.forced);
  if (p.followSystem && p.systemCaptions) {
    const rank = (t: MediaTrack) => (t.sdh || t.kind === 'captions' ? 0 : 1);
    const captions = best(full, languages, rank) ?? sortBy(full, rank)[0];
    if (captions != null) return captions;
  }
  const top = languages[0];
  if (top != null && audioLanguage != null && audioLanguage !== top) {
    const foreign = best(full, languages, (t) => (t.sdh ? 1 : 0));
    if (foreign != null) return foreign;
  }
  const forced = text.find(
    (t) => t.forced && primaryLanguage(t.language) === audioLanguage
  );
  if (forced != null) return forced;
  return full.find((t) => t.default) ?? null;
}

/** The tracks to start with (`null`: none of that kind, or no subtitles). */
export function selectTracks(
  tracks: readonly MediaTrack[],
  preferences: TrackPreferences
): TrackChoice {
  const languages = wanted(preferences);
  const audio = chooseAudio(
    tracks.filter((t) => t.kind === 'audio'),
    preferences,
    languages
  );
  const text = chooseText(
    tracks.filter((t) => t.kind !== 'audio'),
    primaryLanguage(audio?.language),
    preferences,
    languages
  );
  return { audio: audio?.id ?? null, text: text?.id ?? null };
}
