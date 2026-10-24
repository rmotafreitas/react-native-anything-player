package com.anythingplayer.core

// Which audio and text tracks a video starts with, before the app picks any:
// the preferred languages, the OS's captions and audio-description settings,
// forced subtitles for the audio's language, subtitles when the audio is in
// another language, and the file's default flags. Twins:
// `src/core/subtitles/tracks.ts`, `ios/Core/TrackSelection.swift`, held to
// `conformance/tracks/select.json`.

enum class TrackKind(val wire: String) {
  AUDIO("audio"),
  SUBTITLES("subtitles"),
  CAPTIONS("captions");

  companion object {
    fun fromWire(value: String?): TrackKind = entries.firstOrNull { it.wire == value } ?: SUBTITLES
  }
}

data class MediaTrack(
  val id: String,
  val kind: TrackKind,
  /** BCP 47 or ISO 639 (`pt-BR`, `jpn`); `null` when unknown. */
  val language: String? = null,
  val label: String? = null,
  /** Subtitles only for what is not in the audio's language (signs, foreign lines). */
  val forced: Boolean = false,
  /** The file marks it as the default. */
  val isDefault: Boolean = false,
  /** Subtitles for the deaf and hard of hearing (closed captions, SDH). */
  val sdh: Boolean = false,
  /** An audio description of the picture. */
  val describesVideo: Boolean = false,
)

data class TrackPreferences(
  /** The app's languages, in order. */
  val languages: List<String> = emptyList(),
  /** Follow the OS's accessibility settings. */
  val followSystem: Boolean = true,
  /** The device's languages, in order. */
  val systemLanguages: List<String> = emptyList(),
  val systemCaptions: Boolean = false,
  val systemAudioDescriptions: Boolean = false,
)

data class TrackChoice(val audio: String?, val text: String?)

object TrackSelection {
  /** ISO 639-2 (bibliographic and terminology) → 639-1, for the common languages. */
  private val iso6392 =
    mapOf(
      "ara" to "ar", "ben" to "bn", "bul" to "bg", "cat" to "ca", "ces" to "cs", "cze" to "cs",
      "chi" to "zh", "zho" to "zh", "dan" to "da", "deu" to "de", "ger" to "de", "dut" to "nl",
      "nld" to "nl", "ell" to "el", "gre" to "el", "eng" to "en", "est" to "et", "fas" to "fa",
      "per" to "fa", "fin" to "fi", "fra" to "fr", "fre" to "fr", "heb" to "he", "hin" to "hi",
      "hrv" to "hr", "hun" to "hu", "ind" to "id", "ita" to "it", "jpn" to "ja", "kor" to "ko",
      "lav" to "lv", "lit" to "lt", "may" to "ms", "msa" to "ms", "nor" to "no", "nob" to "nb",
      "pol" to "pl", "por" to "pt", "ron" to "ro", "rum" to "ro", "rus" to "ru", "slk" to "sk",
      "slo" to "sk", "slv" to "sl", "spa" to "es", "srp" to "sr", "swe" to "sv", "tha" to "th",
      "tur" to "tr", "ukr" to "uk", "vie" to "vi",
    )

  /** The primary language, two letters where there are (`pt-BR` → `pt`, `jpn` → `ja`). */
  fun primaryLanguage(tag: String?): String? {
    if (tag == null) return null
    val primary = tag.trim().lowercase().split('-', '_').first()
    if (primary.isEmpty() || primary == "und" || primary == "mul") return null
    return iso6392[primary] ?: primary
  }

  /** The languages to look for, in order, without repeats. */
  private fun wanted(p: TrackPreferences): List<String> =
    (p.languages + p.systemLanguages).mapNotNull { primaryLanguage(it) }.distinct()

  /** The first track by language preference, then by `rank` (lower first). */
  private fun best(tracks: List<MediaTrack>, languages: List<String>, rank: (MediaTrack) -> Int): MediaTrack? {
    for (lang in languages) {
      val matches = tracks.filter { primaryLanguage(it.language) == lang }
      if (matches.isNotEmpty()) return matches.sortedBy(rank).first()
    }
    return null
  }

  private fun chooseAudio(audio: List<MediaTrack>, p: TrackPreferences, languages: List<String>): MediaTrack? {
    if (audio.isEmpty()) return null
    val describe = p.followSystem && p.systemAudioDescriptions
    // With audio descriptions asked for they come first; otherwise last.
    val rank = { t: MediaTrack -> (if (t.describesVideo == describe) 0 else 2) + (if (t.isDefault) 0 else 1) }
    return best(audio, languages, rank)
      ?: audio.filter { !it.describesVideo || describe }.sortedBy { if (it.isDefault) 0 else 1 }.firstOrNull()
      ?: audio.first()
  }

  private fun chooseText(
    text: List<MediaTrack>,
    audioLanguage: String?,
    p: TrackPreferences,
    languages: List<String>,
  ): MediaTrack? {
    val full = text.filter { !it.forced }
    if (p.followSystem && p.systemCaptions) {
      val rank = { t: MediaTrack -> if (t.sdh || t.kind == TrackKind.CAPTIONS) 0 else 1 }
      val captions = best(full, languages, rank) ?: full.sortedBy(rank).firstOrNull()
      if (captions != null) return captions
    }
    val top = languages.firstOrNull()
    if (top != null && audioLanguage != null && audioLanguage != top) {
      val foreign = best(full, languages) { if (it.sdh) 1 else 0 }
      if (foreign != null) return foreign
    }
    val forced = text.firstOrNull { it.forced && primaryLanguage(it.language) == audioLanguage }
    if (forced != null) return forced
    return full.firstOrNull { it.isDefault }
  }

  /** The tracks to start with (`null`: none of that kind, or no subtitles). */
  fun select(tracks: List<MediaTrack>, preferences: TrackPreferences): TrackChoice {
    val languages = wanted(preferences)
    val audio = chooseAudio(tracks.filter { it.kind == TrackKind.AUDIO }, preferences, languages)
    val text =
      chooseText(
        tracks.filter { it.kind != TrackKind.AUDIO },
        primaryLanguage(audio?.language),
        preferences,
        languages,
      )
    return TrackChoice(audio?.id, text?.id)
  }
}
