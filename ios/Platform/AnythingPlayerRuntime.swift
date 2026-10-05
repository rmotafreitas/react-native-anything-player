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
/// Playing + remote commands, connectivity, app lifecycle and the background
/// keepalive. Mutations happen on the main thread; `players` is also read by
/// the synchronous JS getters, hence the lock.
final class AnythingPlayerRuntime: AudioSessionListener, RemoteCommandTarget {
  static let shared = AnythingPlayerRuntime()

  private let lock = NSLock()
  private var registry: [String: PlayerController] = [:]
  private var order: [String] = []
  private var started = false

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

  var networkState: NetworkState { network.state }

  private var all: [PlayerController] { lock.sync { order.compactMap { registry[$0] } } }

  func player(_ id: String) -> PlayerController? { lock.sync { registry[id] } }

  /// Main thread.
  func startIfNeeded() {
    guard !started else { return }
    started = true
    session.listener = self
    nowPlaying.target = self
    network.start()
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
        self.all.forEach { $0.engine.appForegrounded() }
        self.keepaliveCheck()
      },
    ]
  }

  /// Main thread.
  func register(_ controller: PlayerController) {
    lock.sync {
      registry[controller.id] = controller
      order.append(controller.id)
    }
    // Answer the system controls from the start (see `publishNowPlaying`).
    refresh()
  }

  /// Main thread.
  func unregister(_ controller: PlayerController) {
    lock.sync {
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
    refresh()
  }

  func nowPlayingChanged(_ controller: PlayerController) {
    if controller === active { publishNowPlaying() }
  }

  private func refresh() {
    // Keep the session while anything is loaded or wanted; deactivate (and
    // let interrupted apps resume) once everything is stopped/idle.
    let holdsSession = all.contains {
      !$0.options.mixWithOthers
        && ($0.engine.needsAudioFocus
          || [.loading, .buffering, .playing, .paused, .reconnecting].contains($0.status.state))
    }
    if !holdsSession && session.active && !all.contains(where: { $0.engine.playWhenReady }) {
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
    let wanted = inBackground && all.contains { $0.engine.wantsKeepalive }
    if wanted && !keepalive.running {
      keepalive.start()
    } else if !wanted && keepalive.running {
      keepalive.stop()
    }
  }

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
