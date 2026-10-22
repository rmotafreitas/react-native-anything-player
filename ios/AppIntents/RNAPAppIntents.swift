import AnythingPlayer
import AppIntents
import Foundation

// Siri shortcuts (App Intents, iOS 16+) of an app using
// react-native-anything-player. This file belongs to the APP target: iOS reads
// App Intents from the app's own code, not from a library. The Expo plugin
// (`siri: true`) adds it; without Expo, add this file to the app target in
// Xcode (see the Voice assistants guide).
//
// With it, people can say "Play Jazz FM in MyRadio" or "Play MyRadio" with no
// setup, find the same actions in Spotlight and the Shortcuts app, and put one
// on the Action button. The items are the catalog the app gave `setCatalog`;
// they play natively, even when the app is not running.
//
// An app has a single AppShortcutsProvider: if yours has one, move the
// shortcuts below into it and delete `RNAPShortcuts`.

/// A catalog item, as Siri and Shortcuts see it.
@available(iOS 16, *)
struct RNAPCatalogEntity: AppEntity {
  static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Audio")
  static let defaultQuery = RNAPCatalogQuery()

  let id: String
  let title: String
  let subtitle: String?
  let artwork: URL?

  init(_ item: RNAPCatalogItem) {
    id = item.id
    title = item.title
    subtitle = item.artist ?? item.genre
    artwork = item.artwork
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(
      title: "\(title)",
      subtitle: subtitle.map { (text: String) -> LocalizedStringResource in "\(text)" },
      image: artwork.map { DisplayRepresentation.Image(url: $0) })
  }
}

/// Finds items with the library's matcher (the one `searchCatalog` uses).
@available(iOS 16, *)
struct RNAPCatalogQuery: EntityStringQuery {
  /// What Siri learns as phrases ("Play <item> in MyRadio"): keep it short.
  static let suggestionLimit = 50

  func entities(for identifiers: [String]) async throws -> [RNAPCatalogEntity] {
    identifiers.compactMap { RNAPVoice.item(withId: $0) }.map(RNAPCatalogEntity.init)
  }

  func entities(matching string: String) async throws -> [RNAPCatalogEntity] {
    RNAPVoice.search(string).map(RNAPCatalogEntity.init)
  }

  func suggestedEntities() async throws -> [RNAPCatalogEntity] {
    RNAPVoice.catalogItems().prefix(Self.suggestionLimit).map(RNAPCatalogEntity.init)
  }
}

@available(iOS 16, *)
enum RNAPPlayError: Error, CustomLocalizedStringResourceConvertible {
  case notFound
  case failed

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .notFound: return "There is nothing like that to play."
    case .failed: return "That can't be played right now."
    }
  }
}

/// Plays a catalog item. `AudioStartingIntent` (renamed `AudioPlaybackIntent`
/// in iOS 17, the same thing) runs it without opening the app.
@available(iOS 16, *)
struct PlayCatalogItemIntent: AudioStartingIntent {
  static let title: LocalizedStringResource = "Play"
  static let description: IntentDescription? = IntentDescription("Plays a station, a show or a song.")

  @Parameter(title: "Audio", requestValueDialog: "What would you like to play?")
  var item: RNAPCatalogEntity

  static var parameterSummary: some ParameterSummary {
    Summary("Play \(\.$item)")
  }

  init() {}

  init(item: RNAPCatalogEntity) {
    self.item = item
  }

  func perform() async throws -> some IntentResult {
    let outcome = await RNAPVoice.play(itemId: item.id)
    try RNAPPlay.check(outcome)
    return .result()
  }
}

/// Plays the last item played, else the first.
@available(iOS 16, *)
struct PlaySomethingIntent: AudioStartingIntent {
  static let title: LocalizedStringResource = "Play Something"
  static let description: IntentDescription? = IntentDescription("Plays what you listened to last.")

  func perform() async throws -> some IntentResult {
    let outcome = await RNAPVoice.play(query: "")
    try RNAPPlay.check(outcome)
    return .result()
  }
}

@available(iOS 16, *)
enum RNAPPlay {
  static func check(_ outcome: RNAPVoiceOutcome) throws {
    switch outcome {
    case .playing: return
    case .noMatch: throw RNAPPlayError.notFound
    default: throw RNAPPlayError.failed
    }
  }
}

/// Every phrase names the app; `\(\.$item)` stands for each item
/// `RNAPCatalogQuery.suggestedEntities()` returns.
@available(iOS 16, *)
struct RNAPShortcuts: AppShortcutsProvider {
  @AppShortcutsBuilder
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: PlayCatalogItemIntent(),
      phrases: [
        "Play \(\.$item) in \(.applicationName)",
        "Play \(\.$item) on \(.applicationName)",
        "Listen to \(\.$item) in \(.applicationName)",
        "Listen to \(\.$item) on \(.applicationName)",
        "Put on \(\.$item) in \(.applicationName)",
      ])
    AppShortcut(
      intent: PlaySomethingIntent(),
      phrases: [
        "Play \(.applicationName)",
        "Play something on \(.applicationName)",
        "Listen to \(.applicationName)",
        "Start \(.applicationName)",
      ])
  }
}

/// Called by the library at launch and whenever `setCatalog` changes the
/// catalog (it finds this class by name): Siri relearns the item phrases.
@objc(RNAPAppShortcuts)
final class RNAPAppShortcuts: NSObject {
  @objc static func catalogDidChange() {
    if #available(iOS 16, *) {
      RNAPShortcuts.updateAppShortcutParameters()
    }
  }
}
