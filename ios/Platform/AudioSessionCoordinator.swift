import AVFoundation
import Foundation

protocol AudioSessionListener: AnyObject {
  func sessionInterruptionBegan()
  func sessionInterruptionEnded(shouldResume: Bool)
  func sessionOutputDisconnected()
  func sessionMediaServicesReset()
}

/// Owns the shared `AVAudioSession`. Main thread only (notifications that
/// Apple posts on secondary threads are hopped to main so they can never race
/// each other or a JS command).
///
/// Production lessons encoded here:
/// - The session stays active while paused: an inactive session lets iOS
///   suspend a backgrounded app, freezing recovery with it. It is deactivated
///   (notifying other apps) only when nothing is loaded/paused any more.
/// - An interruption `.began` delivered late for a session the system already
///   deactivated while the app was suspended (`.appWasSuspended`) does not
///   pause: nothing was rendering, and pausing would cancel the app's own
///   recovery. The session is only marked inactive, so the next play
///   re-activates it.
/// - Resuming after an interruption requires `.shouldResume` AND that no other
///   app became the primary audio source meanwhile
///   (`secondaryAudioShouldBeSilencedHint`), otherwise we would steal audio
///   back from the app the user switched to.
/// - Losing the output device (headphones unplugged, Bluetooth gone) pauses
///   anything that *wants* playback, not only what is audible — a buffering
///   stream would otherwise start on the loudspeaker.
final class AudioSessionCoordinator {
  weak var listener: AudioSessionListener?
  private var observers: [NSObjectProtocol] = []
  private var configured: (category: String, speech: Bool, mix: Bool)?
  private(set) var active = false

  init() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) {
        [weak self] note in Self.onMain { self?.handleInterruption(note) }
      },
      center.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) {
        [weak self] note in Self.onMain { self?.handleRouteChange(note) }
      },
      center.addObserver(
        forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil
      ) { [weak self] _ in
        Self.onMain {
          self?.configured = nil
          self?.active = false
          self?.listener?.sessionMediaServicesReset()
        }
      },
    ]
  }

  deinit {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
  }

  private static func onMain(_ block: @escaping () -> Void) {
    if Thread.isMainThread { block() } else { DispatchQueue.main.async(execute: block) }
  }

  /// Configures and activates the session for playback.
  func activate(speech: Bool, mixWithOthers: Bool) -> FocusResult {
    let session = AVAudioSession.sharedInstance()
    do {
      if configured == nil || configured?.speech != speech || configured?.mix != mixWithOthers {
        let mode: AVAudioSession.Mode = speech ? .spokenAudio : .default
        if mixWithOthers {
          // `.longFormAudio` cannot be combined with mixing.
          try session.setCategory(.playback, mode: mode, options: [.mixWithOthers])
        } else {
          // Long-form audio: AirPlay 2 routing like Music/Podcasts.
          try session.setCategory(.playback, mode: mode, policy: .longFormAudio, options: [])
        }
        configured = (AVAudioSession.Category.playback.rawValue, speech, mixWithOthers)
      }
      // Every time (only play and autoplay-load ask): the system can deactivate
      // the session of a suspended app without telling it, so `active` may lie.
      try session.setActive(true)
      active = true
      return .granted
    } catch {
      // `.insufficientPriority` ('!pri'): another app (a call) owns the session.
      active = false
      return .denied
    }
  }

  /// Deactivates the session and lets interrupted apps resume.
  func deactivate() {
    guard active else { return }
    active = false
    try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
  }

  private func handleInterruption(_ note: Notification) {
    guard let info = note.userInfo,
      let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
      let type = AVAudioSession.InterruptionType(rawValue: raw)
    else { return }
    switch type {
    case .began:
      if let reasonRaw = info[AVAudioSessionInterruptionReasonKey] as? UInt,
        AVAudioSession.InterruptionReason(rawValue: reasonRaw) == .appWasSuspended
      {
        // Not a pause, but the session *is* inactive now: the next play
        // (from the app or Control Center) must activate it again.
        active = false
        return
      }
      active = false
      listener?.sessionInterruptionBegan()
    case .ended:
      let optionsRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
      let options = AVAudioSession.InterruptionOptions(rawValue: optionsRaw)
      let session = AVAudioSession.sharedInstance()
      var resume = options.contains(.shouldResume) && !session.secondaryAudioShouldBeSilencedHint
      if resume {
        do {
          try session.setActive(true)
          active = true
        } catch {
          resume = false
        }
      }
      listener?.sessionInterruptionEnded(shouldResume: resume)
    @unknown default:
      break
    }
  }

  private func handleRouteChange(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
      let reason = AVAudioSession.RouteChangeReason(rawValue: raw)
    else { return }
    if reason == .oldDeviceUnavailable {
      listener?.sessionOutputDisconnected()
    }
  }

  /// Short description of the current output route (diagnostics).
  static var routeDescription: String {
    AVAudioSession.sharedInstance().currentRoute.outputs
      .map { "\($0.portType.rawValue):\($0.portName)" }.joined(separator: ",")
  }
}
