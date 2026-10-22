import Foundation

/// A catalog item as `setCatalog` stored it: what App Intents (Siri
/// shortcuts, Spotlight, the Shortcuts app, the Action button) list and play.
@objc(RNAPCatalogItem)
public final class RNAPCatalogItem: NSObject {
  @objc(identifier) public let id: String
  @objc public let title: String
  @objc public let artist: String?
  @objc public let album: String?
  @objc public let genre: String?
  /// `station`, `song`, `album`, `podcast`, `audiobook` or `other`.
  @objc public let kind: String
  /// Other names people say.
  @objc public let keywords: [String]
  /// The artwork's URL (remote, or a file in the app).
  @objc public let artwork: URL?

  init?(_ raw: [String: Any]) {
    guard let id = raw["id"] as? String, let title = raw["title"] as? String else { return nil }
    self.id = id
    self.title = title
    artist = raw["artist"] as? String
    album = raw["album"] as? String
    genre = raw["genre"] as? String
    kind = raw["kind"] as? String ?? "station"
    keywords = raw["keywords"] as? [String] ?? []
    artwork = (raw["artwork"] as? String).flatMap(URL.init(string:))
  }

  public override var description: String { "RNAPCatalogItem(\(id): \(title))" }
}

/// How a voice request ended.
@objc(RNAPVoiceOutcome)
public enum RNAPVoiceOutcome: Int {
  /// Audio started (within 8 s).
  case playing
  /// It could not play: a load error, an interruption, or no audio within 8 s.
  case failed
  /// Nothing in the catalog (or the app's search handler) matched.
  case noMatch
}

/// The voice catalog and its playback, for native code in the app: the App
/// Intents of `ios/AppIntents/RNAPAppIntents.swift`, or the app's own. Works
/// without JavaScript (the app launched in the background for a request): the
/// catalog is the one `setCatalog` stored, and requests play like a Siri
/// request — on the lock-screen player, else the catalog's `playerId`, with
/// `origin: 'siri'` in the player's `searchPlay` event.
///
/// Any thread; completions run on the main thread.
@objc(RNAPVoice)
public final class RNAPVoice: NSObject {
  /// Posted on the main thread after `setCatalog` changes the catalog.
  @objc public static let catalogDidChangeNotification = Notification.Name("RNAPCatalogDidChange")

  /// Every item, in the order the app gave them.
  @objc public static func catalogItems() -> [RNAPCatalogItem] {
    onMain { AnythingPlayerRuntime.shared.voice.catalog.all().compactMap(RNAPCatalogItem.init) }
  }

  /// Ranked matches for what the user said or typed, best first (the
  /// matcher `searchCatalog` uses).
  @objc public static func search(_ query: String) -> [RNAPCatalogItem] {
    onMain {
      AnythingPlayerRuntime.shared.voice.search(["query": query]).compactMap(RNAPCatalogItem.init)
    }
  }

  @objc public static func item(withId id: String) -> RNAPCatalogItem? {
    onMain { AnythingPlayerRuntime.shared.voice.catalog.item(id: id).flatMap(RNAPCatalogItem.init) }
  }

  /// Plays the catalog item `itemId`; completes once audio starts (≤ 8 s).
  @objc public static func play(itemId: String, completion: @escaping (RNAPVoiceOutcome) -> Void) {
    DispatchQueue.main.async {
      AnythingPlayerSystem.voice().handleSiri(itemId: itemId) { completion(outcome($0)) }
    }
  }

  /// Plays the best match for `query` (`""`: the last item played, else the
  /// first; no match: the app's search handler, if JS is running); completes
  /// once audio starts (≤ 8 s).
  @objc public static func play(query: String, completion: @escaping (RNAPVoiceOutcome) -> Void) {
    DispatchQueue.main.async {
      AnythingPlayerSystem.voice().handleSiri(["query": query]) { completion(outcome($0)) }
    }
  }

  public static func play(itemId: String) async -> RNAPVoiceOutcome {
    await withCheckedContinuation { done in play(itemId: itemId) { done.resume(returning: $0) } }
  }

  public static func play(query: String) async -> RNAPVoiceOutcome {
    await withCheckedContinuation { done in play(query: query) { done.resume(returning: $0) } }
  }

  // MARK: - Internals

  private static func outcome(_ outcome: VoiceSearch.SiriOutcome) -> RNAPVoiceOutcome {
    switch outcome {
    case .playing: return .playing
    case .failed: return .failed
    case .noMatch: return .noMatch
    }
  }

  /// The catalog is main-thread state.
  private static func onMain<T>(_ body: () -> T) -> T {
    Thread.isMainThread ? body() : DispatchQueue.main.sync(execute: body)
  }
}
