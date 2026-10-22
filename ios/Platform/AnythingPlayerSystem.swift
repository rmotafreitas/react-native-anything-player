import Foundation
import Intents

/// App-level hooks that run without JS, called from `AnythingPlayerModule.mm`:
///
/// - At `UIApplicationDidFinishLaunchingNotification` (observed from `+load`):
///   the Google Cast context, when compiled with Cast.
/// - Siri: the `RNAPIntents` extension answers `.handleInApp`, so iOS launches
///   the app (in the background if needed) and calls the app delegate's
///   `application(_:handle:completionHandler:)`, which the module installs on
///   the delegate's class and forwards `INPlayMediaIntent`s here. (In-app
///   intent handlers need multiple-scene support, which React Native apps lack.)
/// - App Intents (iOS 16+): the app target compiles
///   `ios/AppIntents/RNAPAppIntents.swift`, which plays through `RNAPVoice`.
///   Its `RNAPAppShortcuts` class (found by name: the pod cannot link against
///   the app) refreshes the App Shortcuts' phrases at launch and whenever the
///   catalog changes.
@objc(AnythingPlayerSystem)
public final class AnythingPlayerSystem: NSObject {
  /// The app-target class `ios/AppIntents/RNAPAppIntents.swift` defines.
  private static let appShortcutsClass = "RNAPAppShortcuts"

  /// Main thread.
  @objc public static func applicationDidFinishLaunching() {
    #if RNAP_CAST
    CastManager.shared.setUp()
    #endif
    // Off the launch path: an app updated to include the App Intents has a
    // catalog stored before they existed.
    DispatchQueue.main.async { refreshAppShortcuts() }
  }

  /// Main thread: after `setCatalog`.
  static func catalogDidChange() {
    NotificationCenter.default.post(name: RNAPVoice.catalogDidChangeNotification, object: nil)
    refreshAppShortcuts()
  }

  private static func refreshAppShortcuts() {
    guard let hook = NSClassFromString(appShortcutsClass) else { return }
    let selector = NSSelectorFromString("catalogDidChange")
    guard (hook as AnyObject).responds(to: selector) else { return }
    _ = (hook as AnyObject).perform(selector)
  }

  /// Plays the request on the voice player. Completes `.success` once audio
  /// starts (≤ 8 s), `.failureNoUnplayedContent` when nothing matched,
  /// `.failure` otherwise.
  @objc public static func handlePlayMediaIntent(
    _ intent: INPlayMediaIntent, completion: @escaping (INIntentResponse) -> Void
  ) {
    let request = searchRequest(from: intent)
    DispatchQueue.main.async {
      voice().handleSiri(request) { outcome in
        let code: INPlayMediaIntentResponseCode
        switch outcome {
        case .playing: code = .success
        case .failed: code = .failure
        case .noMatch: code = .failureNoUnplayedContent
        }
        completion(INPlayMediaIntentResponse(code: code, userActivity: nil))
      }
    }
  }

  /// Main thread: voice search, with the runtime started (the app may have
  /// been launched in the background for the request, before any JS).
  static func voice() -> VoiceSearch {
    let runtime = AnythingPlayerRuntime.shared
    runtime.startIfNeeded()
    return runtime.voice
  }

  /// `INMediaSearch` → `SearchRequest` (without `origin`).
  static func searchRequest(from intent: INPlayMediaIntent) -> [String: Any] {
    let search = intent.mediaSearch
    let item = intent.mediaItems?.first
    var request: [String: Any] = ["query": search?.mediaName ?? item?.title ?? ""]
    if let artist = search?.artistName, !artist.isEmpty { request["artist"] = artist }
    if let album = search?.albumName, !album.isEmpty { request["album"] = album }
    if let genre = search?.genreNames?.first, !genre.isEmpty { request["genre"] = genre }
    if let focus = focus(search?.mediaType ?? item?.type ?? .unknown) { request["focus"] = focus }
    return request
  }

  private static func focus(_ type: INMediaItemType) -> String? {
    switch type {
    case .radioStation, .musicStation, .station: return "station"
    case .song: return "song"
    case .album: return "album"
    case .artist: return "artist"
    case .genre: return "genre"
    case .playlist: return "playlist"
    case .podcastEpisode, .podcastShow, .podcastStation, .podcastPlaylist: return "podcast"
    default: return nil
    }
  }

  /// Teaches Siri the catalog's titles and keywords (best effort; only for
  /// apps set up for Siri).
  static func updateVocabulary(_ strings: [String]) {
    guard Bundle.main.object(forInfoDictionaryKey: "NSSiriUsageDescription") != nil else { return }
    INVocabulary.shared().setVocabularyStrings(NSOrderedSet(array: strings), of: .mediaPlaylistTitle)
  }
}
