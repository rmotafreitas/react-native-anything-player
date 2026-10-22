import Foundation
import GoogleCast
import UIKit

/// Google Cast, app-wide (compiled only with `RNAP_CAST`; see the podspec).
///
/// - The `GCKCastContext` is set up once, on the main thread, at launch
///   (`AnythingPlayerSystem.applicationDidFinishLaunching`), with the receiver
///   id from Info.plist `RNAPCastReceiverId` (default: the Default Media
///   Receiver). An app that set the context up itself keeps its own.
/// - Discovery starts lazily, when JS first shows Cast UI (`getCastState`,
///   `configureCast`, `showCastPicker`): it triggers the local-network prompt.
/// - RNAP owns the session's media: no GCK UI besides the device dialogs.
/// - Session starts and ends go to the runtime, which hands players off;
///   every `CastDriver` is re-bound to the session's media client.
///
/// Main thread only.
class CastManager: NSObject {
  static let shared = CastManager()

  private var ready = false
  private var discovering = false
  /// Drivers to re-bind when the session (and its media client) changes.
  private let drivers = NSHashTable<CastDriver>.weakObjects()

  /// The current session's media client, if connected.
  var client: GCKRemoteMediaClient? {
    guard ready else { return nil }
    return GCKCastContext.sharedInstance().sessionManager.currentCastSession?.remoteMediaClient
  }

  func setUp() {
    guard !ready else { return }
    if !GCKCastContext.isSharedInstanceInitialized() {
      let configured = Bundle.main.object(forInfoDictionaryKey: "RNAPCastReceiverId") as? String
      let receiver = configured.flatMap { $0.isEmpty ? nil : $0 } ?? kGCKDefaultMediaReceiverApplicationID
      let options = GCKCastOptions(discoveryCriteria: GCKDiscoveryCriteria(applicationID: receiver))
      options.disableDiscoveryAutostart = true
      options.startDiscoveryAfterFirstTapOnCastButton = false
      options.physicalVolumeButtonsWillControlDeviceVolume = true
      GCKCastContext.setSharedInstanceWith(options)
    }
    ready = true
    CastObjC.adopt(CastManager.self, "GCKSessionManagerListener")
    let context = GCKCastContext.sharedInstance()
    CastObjC.send(context.sessionManager, "addListener:", self)
    NotificationCenter.default.addObserver(
      self, selector: #selector(castStateDidChange), name: .gckCastStateDidChange,
      object: nil)
    publishState()
    // A session the SDK resumes at launch reports through the listener.
  }

  func startDiscovery() {
    guard ready, !discovering else { return }
    discovering = true
    GCKCastContext.sharedInstance().discoveryManager.startDiscovery()
  }

  /// The device chooser, or (while connected) the dialog to stop casting.
  func presentDialog() -> Bool {
    guard ready else { return false }
    startDiscovery()
    GCKCastContext.sharedInstance().presentCastDialog()
    return true
  }

  func stopCasting() {
    guard ready else { return }
    GCKCastContext.sharedInstance().sessionManager.endSessionAndStopCasting(true)
  }

  func register(_ driver: CastDriver) {
    drivers.add(driver)
  }

  // MARK: - State

  @objc private func castStateDidChange() {
    publishState()
  }

  private func publishState() {
    let context = GCKCastContext.sharedInstance()
    let state: String
    switch context.castState {
    case .noDevicesAvailable: state = "noDevices"
    case .notConnected: state = "notConnected"
    case .connecting: state = "connecting"
    case .connected: state = "connected"
    }
    let device = state == "connecting" || state == "connected"
      ? context.sessionManager.currentCastSession?.device.friendlyName : nil
    AnythingPlayerRuntime.shared.castStateChanged(state, device: device)
  }

  private func sessionBegan(_ session: GCKCastSession) {
    drivers.allObjects.forEach { $0.bind(session.remoteMediaClient) }
    publishState()
    AnythingPlayerRuntime.shared.castSessionStarted(
      deviceId: session.device.deviceID, name: session.device.friendlyName)
  }

  private func sessionFinished() {
    drivers.allObjects.forEach { $0.bind(nil) }
    publishState()
    AnythingPlayerRuntime.shared.castSessionEnded()
  }

  // MARK: - GCKSessionManagerListener (by selector, see `CastObjC`)

  @objc(sessionManager:didStartCastSession:)
  func castSessionDidStart(_ manager: GCKSessionManager, session: GCKCastSession) {
    sessionBegan(session)
  }

  @objc(sessionManager:didResumeCastSession:)
  func castSessionDidResume(_ manager: GCKSessionManager, session: GCKCastSession) {
    sessionBegan(session)
  }

  @objc(sessionManager:didEndCastSession:withError:)
  func castSessionDidEnd(_ manager: GCKSessionManager, session: GCKCastSession, error: NSError?) {
    sessionFinished()
  }
}

/// Where the Swift name of a Google Cast method depends on the importer's
/// word-pruning rules (`addListener:`, `addImage:`, `loadMediaWith…:`), RNAP
/// uses the Objective-C selector, exactly as the SDK headers declare it.
///
/// The listener protocols are Objective-C protocols made of optional methods:
/// RNAP implements them by selector too (`@objc(…)`) and adds the conformance
/// at run time — a static conformance would make Swift match the methods by
/// the importer-generated names instead.
enum CastObjC {
  private static var adopted = Set<String>()

  static func adopt(_ cls: AnyClass, _ protocolNames: String...) {
    for name in protocolNames {
      let key = "\(NSStringFromClass(cls)):\(name)"
      guard !adopted.contains(key), let proto = NSProtocolFromString(name) else { continue }
      adopted.insert(key)
      class_addProtocol(cls, proto)
    }
  }

  /// Sends a message whose result is ignored (void, or an object not needed).
  static func send(_ target: NSObject, _ selectorName: String, _ first: Any, _ second: Any? = nil) {
    let selector = NSSelectorFromString(selectorName)
    guard target.responds(to: selector) else { return }
    if second != nil {
      _ = target.perform(selector, with: first, with: second)
    } else {
      _ = target.perform(selector, with: first)
    }
  }

  /// Sends a one-argument message that returns an object.
  static func call(_ target: NSObject, _ selectorName: String, _ argument: Any) -> AnyObject? {
    let selector = NSSelectorFromString(selectorName)
    guard target.responds(to: selector) else { return nil }
    return target.perform(selector, with: argument)?.takeUnretainedValue()
  }
}
