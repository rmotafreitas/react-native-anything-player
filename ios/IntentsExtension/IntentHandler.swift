import Intents

// The Siri extension of an app using react-native-anything-player: the target
// `RNAPIntents` (an Intents Extension, no UI). The Expo plugin (`siri: true`)
// adds it; without Expo, copy this file and the Info.plist next to it into the
// target (see the Voice assistants guide).
//
// It does not search or play anything: the catalog lives in the app. It hands
// every media request to the app (`.handleInApp`); iOS then launches the app
// in the background if needed and the library plays the request there.

class IntentHandler: INExtension, INPlayMediaIntentHandling {
  override func handler(for intent: INIntent) -> Any { self }

  /// Passes the request through: the app matches it against its catalog.
  func resolveMediaItems(
    for intent: INPlayMediaIntent, with completion: @escaping ([INPlayMediaMediaItemResolutionResult]) -> Void
  ) {
    let search = intent.mediaSearch
    let item = INMediaItem(
      identifier: nil, title: search?.mediaName, type: search?.mediaType ?? .unknown, artwork: nil)
    completion(INPlayMediaMediaItemResolutionResult.successes(with: [item]))
  }

  func handle(intent: INPlayMediaIntent, completion: @escaping (INPlayMediaIntentResponse) -> Void) {
    completion(INPlayMediaIntentResponse(code: .handleInApp, userActivity: nil))
  }
}
