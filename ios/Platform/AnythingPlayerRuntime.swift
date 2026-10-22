import AVFoundation
import Foundation
import UIKit

extension NSLock {
  /// `withLock` is iOS 16+; React Native supports iOS 15.1.
  @discardableResult
  func sync<T>(_ body: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try body()
  }
}

/// Process-wide coordination shared by every player: the audio session, Now
/// Playing + remote commands, connectivity, app lifecycle, the background
/// keepalive, the output route, Google Cast and voice search. Mutations
/// happen on the main thread; `players` is also read by the synchronous JS
/// getters, hence the lock.
///
/// Players belong to the runtime, not to the TurboModule: events go to a
/// replaceable sink the module sets while JS is attached, and a player with
/// an app-chosen id keeps playing across a JS reload (see the bridge).
final class AnythingPlayerRuntime: AudioSessionListener, RemoteCommandTarget {
  static let shared = AnythingPlayerRuntime()

  private let lock = NSLock()
  private var registry: [String: PlayerController] = [:]
  private var order: [String] = []
  /// Ids handed out whose controller is still being created on main.
  private var reserved = Set<String>()
  /// Ids JS released whose controller is still being released on main.
  private var releasing = Set<String>()
  private var started = false

  private let sinkLock = NSLock()
  private var sink: (owner: ObjectIdentifier, send: ([String: Any]) -> Void)?

  private let session = AudioSessionCoordinator()
  private let nowPlaying = NowPlayingController()
  private let keepalive = BackgroundKeepalive()
  private lazy var network = NetworkMonitor { [weak self] state, changed in
    self?.all.forEach { $0.engine.networkChanged(state, interfaceChanged: changed) }
  }
  private var lifecycleObservers: [NSObjectProtocol] = []
  private var inBackground = false

  /// The player the system media controls show and control.
  private(set) weak var active: PlayerController?

  /// The device's own output: what players report, and what a player returns
  /// to when casting ends.
  private(set) var localRoute: AudioRoute = .unknown

  /// Search requests and the persisted catalog. Main thread.
  private(set) lazy var voice = VoiceSearch(runtime: self)

  #if RNAP_CAST
  /// The connected Cast receiver's output id (`cast:<device>`) and route.
  private var castOutput: (id: String, route: AudioRoute)?
  private var castFollowScheduled = false
  private var castStatus: (state: String, device: String?) = ("initializing", nil)
  #else
  private var castStatus: (state: String, device: String?) = ("unavailable", nil)
  #endif

  var networkState: NetworkState { network.state }

  private var all: [PlayerController] { lock.sync { order.compactMap { registry[$0] } } }

  func player(_ id: String) -> PlayerController? { lock.sync { registry[id] } }

  // MARK: - JS events (any thread)

  /// Events go to `send` until `detachEvents(owner:)` (module invalidation).
  func attachEvents(owner: AnyObject, _ send: @escaping ([String: Any]) -> Void) {
    sinkLock.sync { sink = (ObjectIdentifier(owner), send) }
  }

  /// Only the current owner detaches: a reloaded module may attach before
  /// the previous one is invalidated.
  func detachEvents(owner: AnyObject) {
    sinkLock.sync {
      if sink?.owner == ObjectIdentifier(owner) { sink = nil }
    }
  }

  /// Whether JS is running and listening.
  var jsAttached: Bool { sinkLock.sync { sink != nil } }

  /// Emits under the lock, so once the sink is detached no emission is in flight.
  func emit(_ event: [String: Any]) {
    sinkLock.sync { sink?.send(event) }
  }

  // MARK: - Players

  /// Any thread. Claims `id` for a new player: false when a player has it
  /// (or is being created with it). A released id is free at once (React
  /// may re-create a player right after releasing it): the main queue runs
  /// the release before the creation.
  func claim(_ id: String) -> Bool {
    lock.sync {
      guard registry[id] == nil || releasing.contains(id), !reserved.contains(id) else { return false }
      reserved.insert(id)
      return true
    }
  }

  /// Any thread: JS released `id` (the controller goes on main).
  func willRelease(_ id: String) {
    lock.sync { _ = releasing.insert(id) }
  }

  /// Main thread. Creates a claimed id's player: from JS, or natively for a
  /// voice request (`detachable`: it outlives JS).
  @discardableResult
  func createPlayer(id: String, options: PlayerOptions, detachable: Bool) -> PlayerController {
    startIfNeeded()
    let controller = PlayerController(id: id, options: options, detachable: detachable, runtime: self)
    #if RNAP_CAST
    controller.routing.makeRemote = { outputId in CastDriver(outputId: outputId) }
    #endif
    register(controller)
    controller.engine.networkChanged(networkState, interfaceChanged: false)
    controller.engine.routeChanged(localRoute)
    return controller
  }

  /// Main thread.
  func startIfNeeded() {
    guard !started else { return }
    started = true
    session.listener = self
    nowPlaying.target = self
    network.start()
    localRoute = AudioRoute.current()
    inBackground = UIApplication.shared.applicationState == .background
    let center = NotificationCenter.default
    lifecycleObservers = [
      center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) {
        [weak self] _ in
        self?.inBackground = true
        self?.keepaliveCheck()
      },
      center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) {
        [weak self] _ in
        guard let self else { return }
        self.inBackground = false
        // A suspension may have reclaimed the stream proxy's socket.
        StreamProxy.shared.revalidate()
        self.all.forEach { $0.appForegrounded() }
        self.keepaliveCheck()
      },
    ]
  }

  /// Main thread.
  func register(_ controller: PlayerController) {
    lock.sync {
      reserved.remove(controller.id)
      // A release of this id (queued before this creation) has already run.
      releasing.remove(controller.id)
      registry[controller.id] = controller
      order.removeAll { $0 == controller.id }
      order.append(controller.id)
    }
    // Answer the system controls from the start (see `publishNowPlaying`).
    refresh()
  }

  /// Main thread.
  func unregister(_ controller: PlayerController) {
    lock.sync {
      releasing.remove(controller.id)
      guard registry[controller.id] === controller else { return }
      registry.removeValue(forKey: controller.id)
      order.removeAll { $0 == controller.id }
    }
    if active === controller {
      active = all.last { $0.options.mediaSession && $0.status.state != .idle }
    }
    refresh()
  }

  // MARK: - Focus

  func requestFocus(for controller: PlayerController) -> FocusResult {
    session.activate(speech: controller.options.speech, mixWithOthers: controller.options.mixWithOthers)
  }

  func sessionInterruptionBegan() {
    all.forEach { $0.engine.interruptionBegan(reason: .interruption, resumable: true) }
  }

  func sessionInterruptionEnded(shouldResume: Bool) {
    all.forEach { $0.engine.interruptionEnded(shouldResume: shouldResume) }
  }

  func sessionOutputDisconnected() {
    all.forEach { $0.engine.interruptionBegan(reason: .outputDisconnected, resumable: false) }
  }

  func sessionRouteChanged() {
    let route = AudioRoute.current()
    guard route != localRoute else { return }
    localRoute = route
    // Engines on a Cast receiver ignore it (the cast route wins).
    all.forEach { $0.engine.routeChanged(route) }
  }

  func sessionMediaServicesReset() {
    // Every AVPlayer is dead and the session forgot its configuration.
    let wanted = all.contains { $0.engine.needsAudioFocus }
    if wanted, let first = all.first { _ = session.activate(speech: first.options.speech, mixWithOthers: first.options.mixWithOthers) }
    keepalive.stop()
    all.forEach { $0.mediaServicesReset() }
    nowPlaying.clear()
    refresh()
  }

  // MARK: - State fan-in (main)

  func statusChanged(_ controller: PlayerController) {
    let status = controller.status
    if controller.options.mediaSession && status.playWhenReady { active = controller }
    if active == nil && controller.options.mediaSession && status.state != .idle { active = controller }
    voice.statusChanged(controller)
    #if RNAP_CAST
    scheduleCastFollow()
    #endif
    refresh()
  }

  func nowPlayingChanged(_ controller: PlayerController) {
    if controller === active { publishNowPlaying() }
  }

  private func refresh() {
    // Keep the session while anything is loaded or wanted; deactivate (and
    // let interrupted apps resume) once everything is stopped/idle. A player
    // on a Cast receiver plays nothing here: it holds nothing.
    let local = all.filter { !$0.isRemote }
    let holdsSession = local.contains {
      !$0.options.mixWithOthers
        && ($0.engine.needsAudioFocus
          || [.loading, .buffering, .playing, .paused, .reconnecting].contains($0.status.state))
    }
    if !holdsSession && session.active && !local.contains(where: { $0.engine.playWhenReady }) {
      session.deactivate()
    }
    keepaliveCheck()
    publishNowPlaying()
  }

  /// Who gets remote commands when no player is active: the newest player
  /// that shows on the system controls, even with nothing loaded.
  private var standby: PlayerController? { all.last { $0.options.mediaSession && !$0.options.mixWithOthers } }

  private func publishNowPlaying() {
    guard let active, active.options.mediaSession,
      ![.idle, .stopped, .error].contains(active.status.state)
    else {
      nowPlaying.update(nil)
      // Nothing to show, but keep answering the system controls: iOS relaunches
      // (or wakes) the last Now Playing app in the background when Play is
      // pressed in Control Center / on the lock screen, and the command is
      // dropped unless a target is registered by then.
      if let standby {
        nowPlaying.configureCommands(forwarded: standby.options.remoteCommands, seekable: false)
      } else {
        nowPlaying.clear()
      }
      return
    }
    nowPlaying.configureCommands(forwarded: active.options.remoteCommands, seekable: active.status.seekable)
    nowPlaying.update(active.nowPlaying())
  }

  /// Runs the keepalive while backgrounded and some player wants audio it is
  /// not getting (see `BackgroundKeepalive`).
  func keepaliveCheck() {
    // Never for a Cast receiver's buffering: the phone has nothing to keep alive.
    let wanted = inBackground && all.contains { !$0.isRemote && $0.engine.wantsKeepalive }
    if wanted && !keepalive.running {
      keepalive.start()
    } else if !wanted && keepalive.running {
      keepalive.stop()
    }
  }

  // MARK: - Google Cast (main)

  /// `{ state, device }` for the synchronous `getCastState()`; any thread.
  var castStatusDictionary: [String: Any] {
    let status = lock.sync { castStatus }
    return ["state": status.state, "device": status.device ?? NSNull()]
  }

  /// The Cast state changed (`unavailable` without the Cast SDK).
  func castStateChanged(_ state: String, device: String?) {
    let changed = lock.sync { () -> Bool in
      guard castStatus.state != state || castStatus.device != device else { return false }
      castStatus = (state, device)
      return true
    }
    if changed { emit(["type": "castState", "state": state, "device": device ?? NSNull()]) }
  }

  #if RNAP_CAST
  /// A Cast session started or resumed: the active player moves to the
  /// receiver (same device: nothing reloads).
  func castSessionStarted(deviceId: String, name: String?) {
    castOutput = ("cast:" + deviceId, AudioRoute(kind: .cast, name: name))
    followCast()
  }

  /// The session ended: every player on the receiver returns to the device,
  /// paused (it never suddenly plays from the phone's speaker).
  func castSessionEnded() {
    castOutput = nil
    for controller in all where controller.isRemote {
      controller.engine.handoff(route: localRoute, outputId: RoutingDriver.localOutput, resume: false)
    }
  }

  /// Status changes arrive from inside engine transitions: follow afterwards.
  private func scheduleCastFollow() {
    guard castOutput != nil, !castFollowScheduled else { return }
    castFollowScheduled = true
    DispatchQueue.main.async { [weak self] in
      self?.castFollowScheduled = false
      self?.followCast()
    }
  }

  /// Cast follows the active player: any other player on the receiver comes
  /// back (paused), the active one goes over keeping its intent — unless the
  /// receiver cannot fetch its source, which then plays here (reported once).
  private func followCast() {
    guard let cast = castOutput else { return }
    let target = active
    for controller in all where controller !== target && controller.isRemote {
      controller.engine.handoff(route: localRoute, outputId: RoutingDriver.localOutput, resume: false)
    }
    guard let target else { return }
    if let source = target.engine.source, !source.isCastable {
      if target.isRemote {
        target.engine.handoff(route: localRoute, outputId: RoutingDriver.localOutput, resume: true)
      }
      target.reportUncastable()
      return
    }
    if target.routing.outputId != cast.id {
      target.engine.handoff(route: cast.route, outputId: cast.id, resume: true)
    }
  }
  #endif

  // MARK: - Remote commands (lock screen, Control Center, headphones, CarPlay)

  func remote(_ command: String, position: Double?) {
    guard let target = active ?? standby else { return }
    var nothingLoaded = false
    do {
      switch command {
      case "play": try target.engine.play()
      case "pause": try target.engine.pause()
      case "togglePlayPause":
        if target.engine.playWhenReady { try target.engine.pause() } else { try target.engine.play() }
      case "stop": try target.engine.stop()
      case "seek": if let position { try target.engine.seek(to: position) }
      default: break
      }
    } catch let error as PlayerError where error.code == .noSource {
      // Play with nothing loaded (the app was just relaunched for it): only
      // the app knows what to load, so the command always goes to JS.
      nothingLoaded = true
    } catch {
      // Refusals (e.g. focus denied during a call) are reported through status.
    }
    if nothingLoaded || target.options.remoteCommands.contains(command) {
      target.emitRemoteCommand(command, position: position)
    }
  }
}
