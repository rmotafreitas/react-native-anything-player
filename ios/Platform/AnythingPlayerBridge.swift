import Foundation

/// The Objective-C–visible surface the TurboModule shim (`AnythingPlayerModule.mm`)
/// calls. Commands hop to the main thread in call order; getters read the
/// controllers' lock-protected snapshots on the calling (JS) thread.
///
/// One bridge per TurboModule instance (a JS reload makes a new one). The
/// players live in the runtime: the bridge remembers which ones its JS
/// created or attached to, for `invalidate()`.
@objc(AnythingPlayerBridge)
public final class AnythingPlayerBridge: NSObject {
  private let lock = NSLock()
  private var owned = Set<String>()
  private static let counterLock = NSLock()
  private static var counter = 0

  private var runtime: AnythingPlayerRuntime { AnythingPlayerRuntime.shared }

  /// Routes every event (players and app-global) to `sink` until `invalidate()`.
  @objc public func attachEvents(_ sink: @escaping (NSDictionary) -> Void) {
    runtime.attachEvents(owner: self) { event in sink(event as NSDictionary) }
  }

  /// `options.id` names the player: if a native player already has it (Siri
  /// started it, or JS reloaded), this attaches to it — options ignored, the
  /// first creator wins — and JS mirrors its status (`getStatus`).
  @objc public func createPlayer(_ options: NSDictionary) -> String {
    let parsed = PlayerOptions(options)
    let id: String
    let detachable: Bool
    if let requested = options["id"] as? String, !requested.isEmpty {
      guard runtime.claim(requested) else {
        lock.sync { _ = owned.insert(requested) }
        let runtime = self.runtime
        DispatchQueue.main.async { runtime.player(requested)?.note("attach", ["note": "options ignored"]) }
        return requested
      }
      id = requested
      detachable = true
    } else {
      let n = Self.counterLock.sync { () -> Int in
        Self.counter += 1
        return Self.counter
      }
      id = "ios-\(n)-\(String(UInt64(Date().timeIntervalSince1970 * 1000), radix: 36))"
      _ = runtime.claim(id)
      detachable = false
    }
    lock.sync { _ = owned.insert(id) }
    let runtime = self.runtime
    DispatchQueue.main.async { runtime.createPlayer(id: id, options: parsed, detachable: detachable) }
    return id
  }

  @objc public func releasePlayer(
    _ id: String, resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void
  ) {
    lock.sync { _ = owned.remove(id) }
    let runtime = self.runtime
    runtime.willRelease(id)
    DispatchQueue.main.async {
      if let controller = runtime.player(id) {
        controller.release()
        runtime.unregister(controller)
      }
      resolve(nil)
    }
  }

  @objc public func load(
    _ id: String, source: NSDictionary, options: NSDictionary,
    resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void
  ) {
    let (descriptor, fields) = SourceDescriptor.parse(source)
    let autoplay = options["autoplay"] as? Bool
    let start = (options["startPosition"] as? NSNumber)?.doubleValue
    DispatchQueue.main.async { [weak self] in
      guard let controller = self?.runtime.player(id) else {
        return Self.reject(reject, PlayerError.code(.playerReleased, "The player was released.", recoverable: false))
      }
      do {
        try controller.load(descriptor, fields: fields, autoplay: autoplay, start: start) { result in
          switch result {
          case .success(let status): resolve(status)
          case .failure(let error): Self.reject(reject, error)
          }
        }
      } catch let error as PlayerError {
        Self.reject(reject, error)
      } catch {
        Self.reject(reject, PlayerError.code(.internalError, "\(error)", recoverable: false))
      }
    }
  }

  /// play / pause / stop / reset / seekTo / setVolume / setMuted / setRate.
  @objc public func command(
    _ name: String, id: String, value: NSNumber?,
    resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void
  ) {
    DispatchQueue.main.async { [weak self] in
      guard let controller = self?.runtime.player(id) else {
        return Self.reject(reject, PlayerError.code(.playerReleased, "The player was released.", recoverable: false))
      }
      let engine = controller.engine
      do {
        switch name {
        case "play": try engine.play()
        case "pause": try engine.pause()
        case "stop": try engine.stop()
        case "reset": try engine.reset()
        case "seekTo": try engine.seek(to: value?.doubleValue ?? 0)
        case "setVolume": try engine.setVolume(value?.doubleValue ?? 1)
        case "setMuted": try engine.setMuted(value?.boolValue ?? false)
        case "setRate": try engine.setRate(value?.doubleValue ?? 1)
        default: throw PlayerError.code(.invalidArgument, "Unknown command \(name).", recoverable: false)
        }
        resolve(controller.statusDictionary())
      } catch let error as PlayerError {
        Self.reject(reject, error)
      } catch {
        Self.reject(reject, PlayerError.code(.internalError, "\(error)", recoverable: false))
      }
    }
  }

  @objc public func updateNowPlaying(
    _ id: String, metadata: NSDictionary,
    resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void
  ) {
    let fields = NowPlayingFields(metadata)
    DispatchQueue.main.async { [weak self] in
      guard let controller = self?.runtime.player(id) else {
        return Self.reject(reject, PlayerError.code(.playerReleased, "The player was released.", recoverable: false))
      }
      controller.updateNowPlaying(fields)
      resolve(nil)
    }
  }

  @objc public func status(_ id: String) -> NSDictionary {
    (runtime.player(id)?.statusDictionary() ?? Serialization.status(Status(), seq: 0)) as NSDictionary
  }

  @objc public func progress(_ id: String) -> NSDictionary {
    if let controller = runtime.player(id) { return controller.progressDictionary() as NSDictionary }
    return Serialization.progress(ProgressReading(), takenAt: 0, now: 0, wall: SystemClock.shared.wallMs) as NSDictionary
  }

  @objc public func metadata(_ id: String) -> NSDictionary {
    (runtime.player(id)?.metadataDictionary() ?? ["metadata": NSNull()]) as NSDictionary
  }

  @objc public func diagnostics(_ id: String) -> NSArray {
    (runtime.player(id)?.diagnosticsArray() ?? []) as NSArray
  }

  @objc public func setDiagnosticsEnabled(_ id: String, enabled: Bool) {
    runtime.player(id)?.diagnosticsEnabled = enabled
  }

  @objc public func setAudioSampling(_ id: String, enabled: Bool, points: Int) -> Bool {
    let clamped = min(max(points, 16), 4096)
    DispatchQueue.main.async { [weak self] in
      self?.runtime.player(id)?.setAudioSampling(enabled: enabled, points: clamped)
    }
    return AudioTap.isSupported
  }

  // MARK: - Outputs

  @objc(showRoutePicker:resolve:reject:)
  public func showRoutePicker(
    _ playerId: String?, resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void
  ) {
    DispatchQueue.main.async {
      guard RoutePickerTrigger.show() else {
        return Self.reject(
          reject,
          PlayerError.code(
            .routePickerUnavailable, "The output picker could not be opened; render <RoutePicker /> instead.",
            recoverable: false))
      }
      resolve(nil)
    }
  }

  @objc public func isRoutePickerAvailable() -> Bool { true }

  // MARK: - Google Cast

  @objc public func castState() -> NSDictionary {
    #if RNAP_CAST
    // Someone is showing Cast UI: start looking for devices.
    DispatchQueue.main.async { CastManager.shared.startDiscovery() }
    #endif
    return runtime.castStatusDictionary as NSDictionary
  }

  /// Native reads the receiver id at build time (Info.plist `RNAPCastReceiverId`).
  @objc(configureCast:reject:)
  public func configureCast(resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void) {
    DispatchQueue.main.async {
      #if RNAP_CAST
      CastManager.shared.startDiscovery()
      #endif
      resolve(nil)
    }
  }

  @objc(showCastPicker:reject:)
  public func showCastPicker(resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void) {
    DispatchQueue.main.async {
      #if RNAP_CAST
      if CastManager.shared.presentDialog() { return resolve(nil) }
      #endif
      Self.reject(reject, Self.castUnavailable)
    }
  }

  @objc(stopCasting:reject:)
  public func stopCasting(resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void) {
    DispatchQueue.main.async {
      #if RNAP_CAST
      CastManager.shared.stopCasting()
      #endif
      resolve(nil)
    }
  }

  private static let castUnavailable = PlayerError.code(
    .castUnavailable, "Google Cast is not available: install the pods with RNAP_CAST=1 (or the Expo plugin's `cast` option).",
    recoverable: false)

  // MARK: - Catalog & voice

  @objc(setCatalog:options:resolve:reject:)
  public func setCatalog(
    _ items: NSArray, options: NSDictionary,
    resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void
  ) {
    let parsed = items.compactMap { $0 as? [String: Any] }
    let playerId = (options["playerId"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "default"
    let playerOptions = options["playerOptions"] as? [String: Any] ?? [:]
    let runtime = self.runtime
    DispatchQueue.main.async {
      runtime.voice.setCatalog(items: parsed, playerId: playerId, playerOptions: playerOptions)
      resolve(nil)
    }
  }

  @objc(searchCatalog:resolve:reject:)
  public func searchCatalog(
    _ request: NSDictionary, resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void
  ) {
    let parsed = request as? [String: Any] ?? [:]
    let runtime = self.runtime
    DispatchQueue.main.async { resolve(runtime.voice.search(parsed)) }
  }

  @objc(playFromSearch:playerId:resolve:reject:)
  public func playFromSearch(
    _ request: NSDictionary, playerId: String?,
    resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void
  ) {
    let parsed = request as? [String: Any] ?? [:]
    let runtime = self.runtime
    DispatchQueue.main.async {
      runtime.voice.playFromSearch(parsed, playerId: playerId) { result in
        switch result {
        case .success(let item): resolve(["item": item.map { $0 as Any } ?? NSNull()])
        case .failure(let error): Self.reject(reject, error)
        }
      }
    }
  }

  @objc public func setSearchHandlerEnabled(_ enabled: Bool) {
    let runtime = self.runtime
    DispatchQueue.main.async { runtime.voice.handlerEnabled = enabled }
  }

  @objc(resolveSearchRequest:result:)
  public func resolveSearchRequest(_ requestId: String, result: NSDictionary) {
    let parsed = result as? [String: Any] ?? [:]
    let runtime = self.runtime
    DispatchQueue.main.async { runtime.voice.answer(requestId, result: parsed) }
  }

  // MARK: - Lifetime

  /// JS reload / bridge teardown: events stop at once. Players with an
  /// app-chosen id are detached (they keep playing; the next JS attaches);
  /// the others can no longer be controlled and are released.
  @objc public func invalidate() {
    runtime.detachEvents(owner: self)
    let ids = lock.sync { () -> [String] in
      let ids = Array(owned)
      owned.removeAll()
      return ids
    }
    let runtime = self.runtime
    DispatchQueue.main.async {
      runtime.voice.handlerEnabled = false
      for id in ids {
        if let controller = runtime.player(id), !controller.detachable {
          controller.release()
          runtime.unregister(controller)
        }
      }
    }
  }

  private static func reject(_ reject: (String, String, NSError?) -> Void, _ error: PlayerError) {
    reject(error.code.rawValue, error.message, Serialization.nsError(error))
  }
}
