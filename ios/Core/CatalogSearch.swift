import Foundation

// Catalog search: what voice assistants and `playFromSearch()` match a request
// against. Pure and deterministic. Twins: `src/core/catalog.ts` and
// `android/.../core/CatalogSearch.kt`; all three run `conformance/catalog/*.json`
// (the fixtures are the specification).
//
// Text is compared as tokens: NFKD, lowercase, NFKD again, combining marks
// removed, a few fix-ups so every platform's casing agrees (ß → ss, final
// sigma → σ, dotless ı → i, & → "and"), then everything that is not a letter or
// a number separates tokens. Everything works on Unicode scalars, never on
// grapheme clusters: a token's length and every edit distance are scalar based.
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

/// The fields search reads.
struct SearchableItem: Equatable {
  let title: String
  var artist: String? = nil
  var album: String? = nil
  var genre: String? = nil
  var keywords: [String]? = nil
  var kind: String? = nil
  /// The browse group; only filtered by `CatalogQuery.group`, never matched by text.
  var group: String? = nil
}

/// A search request (`query` may be empty when structured fields are given).
struct CatalogQuery: Equatable {
  let query: String
  var title: String? = nil
  var artist: String? = nil
  var album: String? = nil
  var genre: String? = nil
  var focus: String? = nil
  /// Only items in this group or its subgroups are searched (`BrowseTree.isInGroup`).
  var group: String? = nil
}

/// The outcome of a search.
struct SearchOutcome: Equatable {
  /// Indices into the catalog, best match first.
  let matches: [Int]
  /// Nothing matched and the request said nothing beyond filler words ("play",
  /// "play the radio"): the platform plays the last item played, else the first.
  let emptyQuery: Bool
}

enum CatalogSearch {
  /// Minimum score to be a match, after weighting.
  static let matchThreshold = 40

  /// Splits text into normalized tokens. Exposed for the conformance tests.
  static func tokenize(_ text: String) -> [String] {
    let folded =
      text.decomposedStringWithCompatibilityMapping
      .lowercased()
      .decomposedStringWithCompatibilityMapping
    var tokens: [String] = []
    var token = String.UnicodeScalarView()
    for scalar in folded.unicodeScalars {
      switch scalar.properties.generalCategory {
      case .nonspacingMark, .spacingMark, .enclosingMark:
        continue
      default:
        break
      }
      switch scalar {
      case "ß":
        token.append(contentsOf: "ss".unicodeScalars)
      case "ς":
        token.append("σ")
      case "ı":
        token.append("i")
      case "&":
        // A separator that reads as a word (splitting "and" along the way).
        if !token.isEmpty {
          tokens.append(String(token))
          token = String.UnicodeScalarView()
        }
        tokens.append("and")
      case _ where isLetter(scalar) || isNumber(scalar):
        token.append(scalar)
      default:
        if !token.isEmpty {
          tokens.append(String(token))
          token = String.UnicodeScalarView()
        }
      }
    }
    if !token.isEmpty { tokens.append(String(token)) }
    return tokens
  }

  /// Ranks `items` against `request`.
  static func search(_ items: [SearchableItem], _ request: CatalogQuery) -> SearchOutcome {
    let tokens = tokenize(request.query)
    let queries = tokens.isEmpty ? [] : variants(tokens)
    let structured = Structured(
      title: tokenize(request.title ?? ""),
      artist: tokenize(request.artist ?? ""),
      album: tokenize(request.album ?? ""),
      genre: tokenize(request.genre ?? ""))
    let hasStructured =
      !structured.title.isEmpty || !structured.artist.isEmpty
      || !structured.album.isEmpty || !structured.genre.isEmpty
    var scored: [(index: Int, score: Int)] = []
    let scoped = !BrowseTree.groupSegments(request.group).isEmpty
    for (index, raw) in items.enumerated() {
      if scoped && !BrowseTree.isInGroup(raw.group, request.group) { continue }
      let item = tokenizeItem(raw)
      let extra = structuredScores(structured, item)
      let score: Int
      if queries.isEmpty {
        score = extra.reduce(0, +)
      } else {
        score =
          max(0, queries.map { freeTextScore($0, item) }.max() ?? 0)
          + structuredBonus * extra.count
      }
      if score >= matchThreshold { scored.append((index: index, score: score)) }
    }
    var ranked = scored
    if let focus = request.focus, let kind = focusKinds[focus] {
      let focused = scored.filter { (items[$0.index].kind ?? "station") == kind }
      if !focused.isEmpty { ranked = focused }
    }
    ranked.sort { a, b in a.score == b.score ? a.index < b.index : a.score > b.score }
    let remaining = stripTrailing(stripLeading(tokens))
    return SearchOutcome(
      matches: ranked.map(\.index),
      emptyQuery: ranked.isEmpty && !hasStructured && remaining.isEmpty)
  }

  // MARK: - Normalization

  private static func isLetter(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter, .modifierLetter, .otherLetter:
      return true
    default:
      return false
    }
  }

  private static func isNumber(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.properties.generalCategory {
    case .decimalNumber, .letterNumber, .otherNumber:
      return true
    default:
      return false
    }
  }

  // MARK: - Query variants

  private static let leadingFillers: [[String]] = [
    ["play"],
    ["listen", "to"],
    ["put", "on"],
    ["start"],
    ["the"],
  ]
  private static let trailingFillers: Set<String> = ["radio", "station"]

  private static func startsWithTokens(_ tokens: [String], _ prefix: [String]) -> Bool {
    prefix.count <= tokens.count && zip(prefix, tokens).allSatisfy { $0.0 == $0.1 }
  }

  private static func stripLeading(_ tokens: [String]) -> [String] {
    var rest = tokens
    while let filler = leadingFillers.first(where: { startsWithTokens(rest, $0) }) {
      rest.removeFirst(filler.count)
    }
    return rest
  }

  private static func stripTrailing(_ tokens: [String]) -> [String] {
    var end = tokens.count
    while end > 0 && trailingFillers.contains(tokens[end - 1]) { end -= 1 }
    return Array(tokens[0..<end])
  }

  /// The query as said, then without leading fillers, then without trailing ones.
  private static func variants(_ tokens: [String]) -> [[String]] {
    var out = [tokens]
    let leading = stripLeading(tokens)
    if !leading.isEmpty && leading.count != tokens.count { out.append(leading) }
    let trailing = stripTrailing(leading)
    if !trailing.isEmpty && trailing.count != leading.count { out.append(trailing) }
    return out
  }

  // MARK: - Scoring

  /// Levenshtein distance over Unicode scalars, capped: `true` means ≤ 1 edit.
  private static func withinOneEdit(_ a: String, _ b: String) -> Bool {
    let x = Array(a.unicodeScalars)
    let y = Array(b.unicodeScalars)
    if abs(x.count - y.count) > 1 { return false }
    var i = 0
    var j = 0
    var edits = 0
    while i < x.count && j < y.count {
      if x[i] == y[j] {
        i += 1
        j += 1
        continue
      }
      edits += 1
      if edits > 1 { return false }
      if x.count > y.count {
        i += 1
      } else if y.count > x.count {
        j += 1
      } else {
        i += 1
        j += 1
      }
    }
    return edits + (x.count - i) + (y.count - j) <= 1
  }

  /// Equal; or a prefix of 3+ letters; or one edit away, for 5+ letters.
  private static func looseTokenMatch(_ query: String, _ length: Int, _ token: String) -> Bool {
    if token == query { return true }
    if length >= 3 && token.hasPrefix(query) { return true }
    return length >= 5 && withinOneEdit(query, token)
  }

  private static func looselyMatches(_ query: String, _ field: [String]) -> Bool {
    let length = query.unicodeScalars.count
    return field.contains { looseTokenMatch(query, length, $0) }
  }

  /// 100 exact, 80 prefix, 60 every token present, 40 loosely present, else 0.
  private static func fieldScore(_ query: [String], _ field: [String]) -> Int {
    if query.isEmpty || field.isEmpty { return 0 }
    if query.count == field.count && startsWithTokens(field, query) { return 100 }
    if startsWithTokens(field, query) { return 80 }
    if query.allSatisfy({ field.contains($0) }) { return 60 }
    if query.allSatisfy({ looselyMatches($0, field) }) { return 40 }
    return 0
  }

  /// Field weights, in percent (so every score stays an integer).
  private static let titleWeight = 100
  private static let keywordWeight = 100
  private static let artistWeight = 80
  private static let albumWeight = 60
  private static let genreWeight = 50
  private static let structuredBonus = 10

  private struct Tokenized {
    let title: [String]
    let keywords: [[String]]
    let artist: [String]
    let album: [String]
    let genre: [String]
  }

  private static func tokenizeItem(_ item: SearchableItem) -> Tokenized {
    Tokenized(
      title: tokenize(item.title),
      keywords: (item.keywords ?? []).map(tokenize),
      artist: tokenize(item.artist ?? ""),
      album: tokenize(item.album ?? ""),
      genre: tokenize(item.genre ?? ""))
  }

  private static func weighted(_ score: Int, _ weight: Int) -> Int {
    score * weight / 100
  }

  private static func freeTextScore(_ variant: [String], _ item: Tokenized) -> Int {
    var best = weighted(fieldScore(variant, item.title), titleWeight)
    for keyword in item.keywords {
      best = max(best, weighted(fieldScore(variant, keyword), keywordWeight))
    }
    best = max(best, weighted(fieldScore(variant, item.artist), artistWeight))
    best = max(best, weighted(fieldScore(variant, item.album), albumWeight))
    best = max(best, weighted(fieldScore(variant, item.genre), genreWeight))
    return best
  }

  private struct Structured {
    let title: [String]
    let artist: [String]
    let album: [String]
    let genre: [String]
  }

  /// Raw scores of the structured fields that match (each ≥ the threshold).
  private static func structuredScores(_ structured: Structured, _ item: Tokenized) -> [Int] {
    var scores = [
      item.keywords.reduce(fieldScore(structured.title, item.title)) {
        max($0, fieldScore(structured.title, $1))
      },
      fieldScore(structured.artist, item.artist),
      fieldScore(structured.album, item.album),
      fieldScore(structured.genre, item.genre),
    ]
    scores.removeAll { $0 < matchThreshold }
    return scores
  }

  private static let focusKinds: [String: String] = [
    "station": "station",
    "song": "song",
    "album": "album",
    "podcast": "podcast",
  ]
}
