import Foundation

/// The Objective-C–visible surface the TurboModule shim (`AirwaveModule.mm`)
/// calls. Commands hop to the main thread in call order; getters read the
/// controllers' lock-protected snapshots on the calling (JS) thread.
@objc(AirwaveBridge)
public final class AirwaveBridge: NSObject {
  /// Set to nil (synchronously) when the module is invalidated; events after
  /// that are dropped instead of reaching a torn-down emitter.
  @objc public var eventSink: ((NSDictionary) -> Void)? {
    get { sinkLock.sync { _eventSink } }
    set { sinkLock.sync { _eventSink = newValue } }
  }
  private var _eventSink: ((NSDictionary) -> Void)?
  private let sinkLock = NSLock()

  /// Emits under the lock, so once `eventSink` is cleared no emission is in flight.
  private func send(_ event: NSDictionary) {
    sinkLock.sync { _eventSink?(event) }
  }

  private let lock = NSLock()
  private var owned = Set<String>()
  private static let counterLock = NSLock()
  private static var counter = 0

  private var runtime: AirwaveRuntime { AirwaveRuntime.shared }

  @objc public func createPlayer(_ options: NSDictionary) -> String {
    let n = Self.counterLock.sync { () -> Int in
      Self.counter += 1
      return Self.counter
    }
    let id = "ios-\(n)-\(String(UInt64(Date().timeIntervalSince1970 * 1000), radix: 36))"
    let parsed = PlayerOptions(options)
    lock.sync { _ = owned.insert(id) }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let runtime = self.runtime
      runtime.startIfNeeded()
      let controller = PlayerController(id: id, options: parsed, runtime: runtime) { [weak self] event in
        self?.send(event as NSDictionary)
      }
      runtime.register(controller)
      controller.engine.networkChanged(runtime.networkState, interfaceChanged: false)
    }
    return id
  }

  @objc public func releasePlayer(
    _ id: String, resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void
  ) {
    lock.sync { _ = owned.remove(id) }
    DispatchQueue.main.async { [weak self] in
      if let controller = self?.runtime.player(id) {
        controller.release()
        self?.runtime.unregister(controller)
      }
      resolve(nil)
    }
  }

  @objc public func load(
    _ id: String, source: NSDictionary, options: NSDictionary,
    resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void
  ) {
    var headers: [String: String] = [:]
    (source["headers"] as? NSDictionary)?.forEach { key, value in
      if let k = key as? String, let v = value as? String { headers[k] = v }
    }
    let descriptor = SourceDescriptor(
      uri: source["uri"] as? String ?? "", headers: headers, liveHint: source["live"] as? Bool)
    let fields = NowPlayingFields(source["metadata"] as? NSDictionary)
    let autoplay = options["autoplay"] as? Bool
    let start = (options["startPosition"] as? NSNumber)?.doubleValue
    DispatchQueue.main.async { [weak self] in
      guard let controller = self?.runtime.player(id) else {
        return Self.reject(reject, PlayerError.code(.playerReleased, "The player was released.", recoverable: false))
      }
      do {
        try controller.load(descriptor, fields: fields, autoplay: autoplay, start: start, resolve: resolve, reject: reject)
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

  /// JS reload / bridge teardown: no JS can control these players any more.
  @objc public func invalidate() {
    let ids = lock.sync { () -> [String] in
      let ids = Array(owned)
      owned.removeAll()
      return ids
    }
    DispatchQueue.main.async { [weak self] in
      guard let runtime = self?.runtime else { return }
      for id in ids {
        if let controller = runtime.player(id) {
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
