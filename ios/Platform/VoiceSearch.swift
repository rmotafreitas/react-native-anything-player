import Foundation

/// Search requests — `playFromSearch()` and Siri — and the catalog they
/// search. Semantics mirror the web reference (`src/web/platform/WebModule.ts`):
///
/// - The item: the catalog's best match; for a request with nothing in it,
///   the last item played (else the first); with no match, the app's search
///   handler when JS is running and enabled one (a `searchRequest` event,
///   answered by `resolveSearchRequest` within 5.5 s).
/// - The player: the one given, else the active (lock-screen) player, else
///   the catalog's player (`playerId`), created natively from the persisted
///   `playerOptions` when it does not exist — that is how a request plays
///   when JS is not running.
/// - The player emits `searchPlay` with the request and the item.
///
/// Main thread only.
final class VoiceSearch {
  enum SiriOutcome {
    case playing
    case failed
    case noMatch
  }

  private unowned let runtime: AnythingPlayerRuntime
  let catalog = CatalogStore()
  /// Whether the app answers what the catalog does not have.
  var handlerEnabled = false
  private var pending: [String: ([String: Any]?) -> Void] = [:]
  private var counter = 0
  /// Siri requests waiting for their player to start.
  private var startWaiters: [Int: (playerId: String, done: (Bool) -> Void)] = [:]

  /// The app's search handler gets 5 s in JS; this covers the bridge both ways.
  private static let handlerTimeout: TimeInterval = 5.5
  /// How long Siri waits for audio before it is told the request failed.
  private static let siriStartTimeout: TimeInterval = 8
  /// States that keep an opened source: a pick of it plays on instead of
  /// opening again (one still loading has not proved it opens: it is opened again).
  private static let holdsSource: Set<PlaybackState> = [.buffering, .playing, .paused, .stopped, .reconnecting]

  init(runtime: AnythingPlayerRuntime) {
    self.runtime = runtime
  }

  func setCatalog(items: [[String: Any]], playerId: String, playerOptions: [String: Any], browse: [String: Any] = [:]) {
    catalog.set(items: items, playerId: playerId, playerOptions: playerOptions, browse: browse)
    AnythingPlayerSystem.updateVocabulary(catalog.vocabulary)
    AnythingPlayerSystem.catalogDidChange()
  }

  func setFavorites(_ ids: [String]) {
    catalog.setFavorites(ids)
    AnythingPlayerSystem.catalogDidChange()
  }

  /// A person picked a catalog item in the car or on a watch: plays it on the
  /// voice player and reports `searchPlay` with `origin: 'browse'`. Completes
  /// once audio starts (≤ 8 s).
  func handleBrowse(itemId: String, completion: @escaping (SiriOutcome) -> Void) {
    guard let item = catalog.item(id: itemId) else { return completion(.noMatch) }
    let request: [String: Any] = ["query": item["title"] as? String ?? "", "origin": "browse"]
    playForSiri(item, request: request, completion: completion)
  }

  func search(_ request: [String: Any]) -> [[String: Any]] {
    catalog.search(Self.query(request))
  }

  /// Resolves the item played (`nil`: nothing matched) once its load settles.
  func playFromSearch(
    _ request: [String: Any], playerId: String?,
    completion: @escaping (Result<[String: Any]?, PlayerError>) -> Void
  ) {
    var asked = request
    asked["query"] = request["query"] as? String ?? ""
    asked["origin"] = "app"
    resolveItem(asked) { [weak self] item in
      guard let self else { return }
      guard let item else { return completion(.success(nil)) }
      self.voicePlayer(playerId) { controller in
        guard let controller else {
          return completion(.failure(.code(.playerReleased, "The player was released.", recoverable: false)))
        }
        self.play(item, on: controller, request: asked) { result in
          completion(result.map { _ in item })
        }
      }
    }
  }

  /// An `INPlayMediaIntent` the app was asked to handle: plays on the voice
  /// player, then reports whether audio started within 8 s.
  func handleSiri(_ request: [String: Any], completion: @escaping (SiriOutcome) -> Void) {
    var asked = request
    asked["origin"] = "siri"
    resolveItem(asked) { [weak self] item in
      guard let self else { return }
      guard let item else { return completion(.noMatch) }
      self.playForSiri(item, request: asked, completion: completion)
    }
  }

  /// A catalog item picked by id (an App Intent's entity), played like a Siri
  /// request.
  func handleSiri(itemId: String, completion: @escaping (SiriOutcome) -> Void) {
    guard let item = catalog.item(id: itemId) else { return completion(.noMatch) }
    let request: [String: Any] = ["query": item["title"] as? String ?? "", "origin": "siri"]
    playForSiri(item, request: request, completion: completion)
  }

  /// Answers a `searchRequest` event.
  func answer(_ requestId: String, result: [String: Any]) {
    guard let settle = pending.removeValue(forKey: requestId) else { return }
    settle(result["item"] as? [String: Any])
  }

  /// Runtime fan-in of every status change.
  func statusChanged(_ controller: PlayerController) {
    guard !startWaiters.isEmpty else { return }
    let status = controller.status
    let started = status.state == .playing || (status.state == .buffering && status.playWhenReady)
    let refused = status.state == .error || (!status.playWhenReady && status.interruption != nil)
    guard started || refused else { return }
    for (key, waiter) in startWaiters where waiter.playerId == controller.id {
      startWaiters.removeValue(forKey: key)
      waiter.done(started)
    }
  }

  // MARK: - Internals

  private static func query(_ request: [String: Any]) -> CatalogQuery {
    CatalogQuery(
      query: request["query"] as? String ?? "", title: request["title"] as? String,
      artist: request["artist"] as? String, album: request["album"] as? String,
      genre: request["genre"] as? String, focus: request["focus"] as? String,
      group: request["group"] as? String)
  }

  private func resolveItem(_ request: [String: Any], completion: @escaping ([String: Any]?) -> Void) {
    if let item = catalog.resolve(Self.query(request)) { return completion(item) }
    guard handlerEnabled, runtime.jsAttached else { return completion(nil) }
    ask(request, completion: completion)
  }

  /// Asks the app's search handler (a `searchRequest` event) and waits for its answer.
  private func ask(_ request: [String: Any], completion: @escaping ([String: Any]?) -> Void) {
    counter += 1
    let requestId = "search-\(counter)"
    let timeout = DispatchWorkItem { [weak self] in
      guard self?.pending.removeValue(forKey: requestId) != nil else { return }
      completion(nil)
    }
    pending[requestId] = { item in
      timeout.cancel()
      completion(item)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.handlerTimeout, execute: timeout)
    runtime.emit(["type": "searchRequest", "requestId": requestId, "request": request])
  }

  /// The given player, else the one on the lock screen, else the catalog's
  /// (created natively when it does not exist yet).
  private func voicePlayer(_ playerId: String?, completion: @escaping (PlayerController?) -> Void) {
    if let playerId { return completion(runtime.player(playerId)) }
    // Not one JS let go of (its release is queued).
    if let active = runtime.active, runtime.isCurrent(active), !active.isReleased { return completion(active) }
    let id = catalog.playerId
    if let existing = runtime.player(id) { return completion(existing) }
    if let slot = runtime.claim(id) {
      var options = PlayerOptions(catalog.playerOptions as NSDictionary)
      // Voice playback is controlled from the lock screen.
      options.mediaSession = true
      let controller = runtime.createPlayer(id: id, options: options, detachable: true, slot: slot)
      // JS attached to it and let go of it meanwhile: not one to play on.
      return completion(runtime.isCurrent(controller) ? controller : nil)
    }
    // JS is creating it right now (its creation is queued on main): use it once it exists.
    DispatchQueue.main.async { [weak self] in completion(self?.runtime.player(id)) }
  }

  private func play(
    _ item: [String: Any], on controller: PlayerController, request: [String: Any],
    completion: @escaping (Result<Void, PlayerError>) -> Void
  ) {
    let (descriptor, fields) = SourceDescriptor.parse((item["source"] as? NSDictionary) ?? [:])
    do {
      if let loaded = controller.engine.source, Self.holdsSource.contains(controller.engine.state),
        loaded.sameMedia(descriptor)
      {
        // Already loaded (the app's own load, or an earlier pick): no gap, and
        // the app's now-playing stays.
        let flowing = controller.engine.state == .playing || controller.engine.state == .buffering
        try controller.engine.play()
        completion(.success(()))
        // Already playing: no status change follows, so a Siri request waiting
        // for audio to start is told now.
        if flowing { statusChanged(controller) }
      } else {
        // The item's `quality`: an id, `'auto'` for automatic; absent: keep the pick.
        let quality = (item["quality"] as? String).flatMap { $0 == "auto" ? nil : $0 }
        try controller.load(
          descriptor, fields: fields, autoplay: true, start: nil, qualityGiven: item["quality"] is String,
          quality: quality
        ) { result in
          completion(result.map { _ in () })
        }
      }
    } catch let error as PlayerError {
      return completion(.failure(error))
    } catch {
      return completion(.failure(.code(.internalError, "\(error)", recoverable: false)))
    }
    catalog.played(item)
    controller.emitSearchPlay(request: request, item: item)
  }

  /// Plays on the voice player, then reports whether audio started within 8 s.
  private func playForSiri(
    _ item: [String: Any], request: [String: Any], completion: @escaping (SiriOutcome) -> Void
  ) {
    voicePlayer(nil) { [weak self] controller in
      guard let self, let controller else { return completion(.failed) }
      var settled = false
      let finish: (Bool) -> Void = { started in
        guard !settled else { return }
        settled = true
        completion(started ? .playing : .failed)
      }
      self.waitForStart(of: controller, done: finish)
      self.play(item, on: controller, request: request) { result in
        if case .failure = result { finish(false) }
      }
    }
  }

  private func waitForStart(of controller: PlayerController, done: @escaping (Bool) -> Void) {
    counter += 1
    let key = counter
    startWaiters[key] = (controller.id, done)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.siriStartTimeout) { [weak self] in
      guard let waiter = self?.startWaiters.removeValue(forKey: key) else { return }
      waiter.done(false)
    }
  }
}
