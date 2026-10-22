package com.anythingplayer.core

import java.text.Normalizer
import java.util.Locale
import kotlin.math.abs

// Catalog search: what voice assistants and `playFromSearch()` match a request
// against. Pure and deterministic. Twin: `src/core/catalog.ts`; both run
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

/** The fields search reads, in the shape every platform stores. */
data class SearchableItem(
  val title: String,
  val artist: String? = null,
  val album: String? = null,
  val genre: String? = null,
  val keywords: List<String>? = null,
  val kind: String? = null,
)

/** A search request (`query` may be empty when structured fields are given). */
data class CatalogQuery(
  val query: String = "",
  val title: String? = null,
  val artist: String? = null,
  val album: String? = null,
  val genre: String? = null,
  val focus: String? = null,
)

/** The outcome of a search. */
data class SearchOutcome(
  /** Indices into the catalog, best match first. */
  val matches: List<Int>,
  /**
   * Nothing matched and the request said nothing beyond filler words ("play",
   * "play the radio"): the platform plays the last item played, else the first.
   */
  val emptyQuery: Boolean,
)

object CatalogSearch {
  /** Splits text into normalized tokens. Exposed for the conformance tests. */
  fun tokenize(text: String): List<String> {
    var folded = Normalizer.normalize(text, Normalizer.Form.NFKD)
    folded = folded.lowercase(Locale.ROOT)
    folded = Normalizer.normalize(folded, Normalizer.Form.NFKD)
    folded = dropMarks(folded)
    folded = folded
      .replace("ß", "ss")
      .replace("ς", "σ")
      .replace("ı", "i")
      .replace("&", " and ")
    // Iterate by code point: supplementary-plane letters are one character.
    val tokens = mutableListOf<String>()
    val token = StringBuilder()
    var i = 0
    while (i < folded.length) {
      val cp = folded.codePointAt(i)
      if (isSeparator(cp)) {
        if (token.isNotEmpty()) {
          tokens.add(token.toString())
          token.setLength(0)
        }
      } else {
        token.appendCodePoint(cp)
      }
      i += Character.charCount(cp)
    }
    if (token.isNotEmpty()) tokens.add(token.toString())
    return tokens
  }

  /** Combining marks Mn/Mc/Me are removed (diacritics, kana voicing, …). */
  private fun dropMarks(folded: String): String {
    val kept = StringBuilder(folded.length)
    var i = 0
    while (i < folded.length) {
      val cp = folded.codePointAt(i)
      val type = Character.getType(cp).toInt()
      if (type != Character.NON_SPACING_MARK.toInt() &&
        type != Character.COMBINING_SPACING_MARK.toInt() &&
        type != Character.ENCLOSING_MARK.toInt()
      ) {
        kept.appendCodePoint(cp)
      }
      i += Character.charCount(cp)
    }
    return kept.toString()
  }

  /** Everything that is neither a letter nor a number separates tokens. */
  private fun isSeparator(cp: Int): Boolean {
    if (Character.isLetter(cp)) return false
    val type = Character.getType(cp).toInt()
    return type != Character.DECIMAL_DIGIT_NUMBER.toInt() &&
      type != Character.LETTER_NUMBER.toInt() &&
      type != Character.OTHER_NUMBER.toInt()
  }

  private val LEADING_FILLERS: List<List<String>> = listOf(
    listOf("play"),
    listOf("listen", "to"),
    listOf("put", "on"),
    listOf("start"),
    listOf("the"),
  )
  private val TRAILING_FILLERS = setOf("radio", "station")

  private fun startsWithTokens(tokens: List<String>, prefix: List<String>): Boolean =
    prefix.size <= tokens.size && prefix.indices.all { tokens[it] == prefix[it] }

  private fun stripLeading(tokens: List<String>): List<String> {
    var rest = tokens
    while (true) {
      val filler = LEADING_FILLERS.firstOrNull { startsWithTokens(rest, it) } ?: return rest
      rest = rest.subList(filler.size, rest.size)
    }
  }

  private fun stripTrailing(tokens: List<String>): List<String> {
    var end = tokens.size
    while (end > 0 && tokens[end - 1] in TRAILING_FILLERS) end -= 1
    return tokens.subList(0, end)
  }

  /** The query as said, then without leading fillers, then without trailing ones. */
  private fun variants(tokens: List<String>): List<List<String>> {
    val out = mutableListOf(tokens)
    val leading = stripLeading(tokens)
    if (leading.isNotEmpty() && leading.size != tokens.size) out.add(leading)
    val trailing = stripTrailing(leading)
    if (trailing.isNotEmpty() && trailing.size != leading.size) out.add(trailing)
    return out
  }

  private fun codePoints(token: String): List<Int> {
    val out = ArrayList<Int>(token.length)
    var i = 0
    while (i < token.length) {
      val cp = token.codePointAt(i)
      out.add(cp)
      i += Character.charCount(cp)
    }
    return out
  }

  private fun scalarLength(token: String): Int = token.codePointCount(0, token.length)

  /** Levenshtein distance over code points, capped: `> 1` means "more than one". */
  private fun withinOneEdit(a: String, b: String): Boolean {
    val x = codePoints(a)
    val y = codePoints(b)
    if (abs(x.size - y.size) > 1) return false
    var i = 0
    var j = 0
    var edits = 0
    while (i < x.size && j < y.size) {
      if (x[i] == y[j]) {
        i += 1
        j += 1
        continue
      }
      edits += 1
      if (edits > 1) return false
      if (x.size > y.size) i += 1
      else if (y.size > x.size) j += 1
      else {
        i += 1
        j += 1
      }
    }
    return edits + (x.size - i) + (y.size - j) <= 1
  }

  /** Equal; or a prefix of 3+ letters; or one edit away, for 5+ letters. */
  private fun looseTokenMatch(q: String, length: Int, f: String): Boolean {
    if (f == q) return true
    if (length >= 3 && f.startsWith(q)) return true
    return length >= 5 && withinOneEdit(q, f)
  }

  private fun looselyMatches(q: String, field: List<String>): Boolean {
    val length = scalarLength(q)
    return field.any { looseTokenMatch(q, length, it) }
  }

  /** 100 exact, 80 prefix, 60 every token present, 40 loosely present, else 0. */
  private fun fieldScore(q: List<String>, field: List<String>): Int {
    if (q.isEmpty() || field.isEmpty()) return 0
    if (q.size == field.size && startsWithTokens(field, q)) return 100
    if (startsWithTokens(field, q)) return 80
    if (q.all { field.contains(it) }) return 60
    if (q.all { looselyMatches(it, field) }) return 40
    return 0
  }

  /** Field weights, in percent (so every score stays an integer). */
  private const val TITLE = 100
  private const val KEYWORD = 100
  private const val ARTIST = 80
  private const val ALBUM = 60
  private const val GENRE = 50
  /** Minimum score to be a match, after weighting. */
  const val MATCH_THRESHOLD = 40
  private const val STRUCTURED_BONUS = 10

  private class Tokenized(
    val title: List<String>,
    val keywords: List<List<String>>,
    val artist: List<String>,
    val album: List<String>,
    val genre: List<String>,
  )

  private fun tokenizeItem(item: SearchableItem): Tokenized = Tokenized(
    tokenize(item.title),
    (item.keywords ?: emptyList()).map(::tokenize),
    tokenize(item.artist ?: ""),
    tokenize(item.album ?: ""),
    tokenize(item.genre ?: ""),
  )

  private fun weighted(score: Int, weight: Int): Int = score * weight / 100

  private fun freeTextScore(variant: List<String>, item: Tokenized): Int {
    var best = weighted(fieldScore(variant, item.title), TITLE)
    for (keyword in item.keywords) {
      val score = weighted(fieldScore(variant, keyword), KEYWORD)
      if (score > best) best = score
    }
    for (pair in listOf(item.artist to ARTIST, item.album to ALBUM, item.genre to GENRE)) {
      val score = weighted(fieldScore(variant, pair.first), pair.second)
      if (score > best) best = score
    }
    return best
  }

  private class Structured(
    val title: List<String>,
    val artist: List<String>,
    val album: List<String>,
    val genre: List<String>,
  )

  /** Raw scores of the structured fields that match (each ≥ the threshold). */
  private fun structuredScores(s: Structured, item: Tokenized): List<Int> {
    val title = maxOf(
      fieldScore(s.title, item.title),
      item.keywords.maxOfOrNull { fieldScore(s.title, it) } ?: 0,
    )
    return listOf(title, fieldScore(s.artist, item.artist), fieldScore(s.album, item.album), fieldScore(s.genre, item.genre))
      .filter { it >= MATCH_THRESHOLD }
  }

  private val FOCUS_KINDS = mapOf("station" to "station", "song" to "song", "album" to "album", "podcast" to "podcast")

  /** Ranks `items` against `request`. */
  fun search(items: List<SearchableItem>, request: CatalogQuery): SearchOutcome {
    val tokens = tokenize(request.query)
    val queries = if (tokens.isNotEmpty()) variants(tokens) else emptyList()
    val structured = Structured(
      tokenize(request.title ?: ""),
      tokenize(request.artist ?: ""),
      tokenize(request.album ?: ""),
      tokenize(request.genre ?: ""),
    )
    val hasStructured = structured.title.isNotEmpty() || structured.artist.isNotEmpty() ||
      structured.album.isNotEmpty() || structured.genre.isNotEmpty()
    val scored = mutableListOf<Pair<Int, Int>>()
    items.forEachIndexed { index, raw ->
      val item = tokenizeItem(raw)
      val extra = structuredScores(structured, item)
      val score =
        if (queries.isNotEmpty()) {
          var best = 0
          for (q in queries) {
            val candidate = freeTextScore(q, item)
            if (candidate > best) best = candidate
          }
          best + STRUCTURED_BONUS * extra.size
        } else {
          extra.sum()
        }
      if (score >= MATCH_THRESHOLD) scored.add(index to score)
    }
    var ranked: List<Pair<Int, Int>> = scored
    val kind = if (!request.focus.isNullOrEmpty()) FOCUS_KINDS[request.focus] else null
    if (kind != null) {
      val focused = scored.filter { (items[it.first].kind ?: "station") == kind }
      if (focused.isNotEmpty()) ranked = focused
    }
    val matches = ranked
      .sortedWith(compareByDescending<Pair<Int, Int>> { it.second }.thenBy { it.first })
      .map { it.first }
    val remaining = stripTrailing(stripLeading(tokens))
    return SearchOutcome(matches, ranked.isEmpty() && !hasStructured && remaining.isEmpty())
  }
}
