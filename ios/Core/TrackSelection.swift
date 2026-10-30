import Foundation

// Which audio and text tracks a video starts with, before the app picks any:
// the preferred languages, the OS's captions and audio-description settings,
// forced subtitles for the audio's language, subtitles when the audio is in
// another language, and the file's default flags. Twins:
// `src/core/subtitles/tracks.ts`, `android/.../core/TrackSelection.kt`, held
// to `conformance/tracks/select.json`.

enum TrackKind: String {
  case audio
  case subtitles
  case captions
}

struct MediaTrack: Equatable {
  let id: String
  let kind: TrackKind
  /// BCP 47 or ISO 639 (`pt-BR`, `jpn`); `nil` when unknown.
  var language: String? = nil
  var label: String? = nil
  /// Subtitles only for what is not in the audio's language (signs, foreign lines).
  var forced = false
  /// The file marks it as the default.
  var isDefault = false
  /// Subtitles for the deaf and hard of hearing (closed captions, SDH).
  var sdh = false
  /// An audio description of the picture.
  var describesVideo = false
}

struct TrackPreferences: Equatable {
  /// The app's languages, in order.
  var languages: [String] = []
  /// Follow the OS's accessibility settings.
  var followSystem = true
  /// The device's languages, in order.
  var systemLanguages: [String] = []
  var systemCaptions = false
  var systemAudioDescriptions = false
}

struct TrackChoice: Equatable {
  let audio: String?
  let text: String?
}

enum TrackSelection {
  /// ISO 639-2 (bibliographic and terminology) → 639-1, for the common languages.
  private static let iso6392: [String: String] = [
    "ara": "ar", "ben": "bn", "bul": "bg", "cat": "ca", "ces": "cs", "cze": "cs",
    "chi": "zh", "zho": "zh", "dan": "da", "deu": "de", "ger": "de", "dut": "nl",
    "nld": "nl", "ell": "el", "gre": "el", "eng": "en", "est": "et", "fas": "fa",
    "per": "fa", "fin": "fi", "fra": "fr", "fre": "fr", "heb": "he", "hin": "hi",
    "hrv": "hr", "hun": "hu", "ind": "id", "ita": "it", "jpn": "ja", "kor": "ko",
    "lav": "lv", "lit": "lt", "may": "ms", "msa": "ms", "nor": "no", "nob": "nb",
    "pol": "pl", "por": "pt", "ron": "ro", "rum": "ro", "rus": "ru", "slk": "sk",
    "slo": "sk", "slv": "sl", "spa": "es", "srp": "sr", "swe": "sv", "tha": "th",
    "tur": "tr", "ukr": "uk", "vie": "vi",
  ]

  /// The primary language, two letters where there are (`pt-BR` → `pt`, `jpn` → `ja`).
  static func primaryLanguage(_ tag: String?) -> String? {
    guard let tag else { return nil }
    let lower = tag.trimmingCharacters(in: .whitespaces).lowercased()
    let primary = String(lower.split(whereSeparator: { $0 == "-" || $0 == "_" }).first ?? "")
    if primary.isEmpty || primary == "und" || primary == "mul" { return nil }
    return iso6392[primary] ?? primary
  }

  /// The languages to look for, in order, without repeats.
  private static func wanted(_ p: TrackPreferences) -> [String] {
    var order: [String] = []
    for tag in p.languages + p.systemLanguages {
      if let lang = primaryLanguage(tag), !order.contains(lang) { order.append(lang) }
    }
    return order
  }

  /// Stable: equal ranks keep the original order.
  private static func sorted(_ tracks: [MediaTrack], by rank: (MediaTrack) -> Int) -> [MediaTrack] {
    tracks.enumerated()
      .sorted { a, b in
        let (ra, rb) = (rank(a.element), rank(b.element))
        return ra != rb ? ra < rb : a.offset < b.offset
      }
      .map(\.element)
  }

  /// The first track by language preference, then by `rank` (lower first).
  private static func best(
    _ tracks: [MediaTrack], _ languages: [String], _ rank: (MediaTrack) -> Int
  ) -> MediaTrack? {
    for lang in languages {
      let matches = tracks.filter { primaryLanguage($0.language) == lang }
      if !matches.isEmpty { return sorted(matches, by: rank).first }
    }
    return nil
  }

  private static func chooseAudio(
    _ audio: [MediaTrack], _ p: TrackPreferences, _ languages: [String]
  ) -> MediaTrack? {
    guard let first = audio.first else { return nil }
    let describe = p.followSystem && p.systemAudioDescriptions
    // With audio descriptions asked for they come first; otherwise last.
    let rank = { (t: MediaTrack) in (t.describesVideo == describe ? 0 : 2) + (t.isDefault ? 0 : 1) }
    return best(audio, languages, rank)
      ?? sorted(audio.filter { !$0.describesVideo || describe }, by: { $0.isDefault ? 0 : 1 }).first
      ?? first
  }

  private static func chooseText(
    _ text: [MediaTrack], _ audioLanguage: String?, _ p: TrackPreferences, _ languages: [String]
  ) -> MediaTrack? {
    let full = text.filter { !$0.forced }
    if p.followSystem && p.systemCaptions {
      let rank = { (t: MediaTrack) in t.sdh || t.kind == .captions ? 0 : 1 }
      if let captions = best(full, languages, rank) ?? sorted(full, by: rank).first { return captions }
    }
    if let top = languages.first, let audioLanguage, audioLanguage != top,
      let foreign = best(full, languages, { $0.sdh ? 1 : 0 })
    {
      return foreign
    }
    if let forced = text.first(where: { $0.forced && primaryLanguage($0.language) == audioLanguage }) {
      return forced
    }
    return full.first(where: \.isDefault)
  }

  /// The tracks to start with (`nil`: none of that kind, or no subtitles).
  static func select(_ tracks: [MediaTrack], _ preferences: TrackPreferences) -> TrackChoice {
    let languages = wanted(preferences)
    let audio = chooseAudio(tracks.filter { $0.kind == .audio }, preferences, languages)
    let text = chooseText(
      tracks.filter { $0.kind != .audio }, primaryLanguage(audio?.language), preferences, languages)
    return TrackChoice(audio: audio?.id, text: text?.id)
  }
}
