import Foundation

// A source's `drm` on Apple platforms: AVFoundation decrypts FairPlay only.
// The license comes from the FairPlay server, or from the app's `getLicense`
// (a `licenseRequest` event, answered by the `license` video command).

/// FairPlay's servers: the license (SPC in, CKC out) and the app certificate.
struct FairPlayServer: Equatable {
  let licenseUrl: String
  let certificateUrl: String
  var headers: [String: String] = [:]
  /// The content id the SPC is made for; `nil`: the `skd://` URI's host.
  var contentId: String? = nil
}

/// A source's `drm`, as JavaScript validated it. The other key systems are
/// named so iOS can say why it cannot play them.
struct DrmDescriptor: Equatable {
  var fairplay: FairPlayServer? = nil
  /// The key systems given besides FairPlay (`widevine`, `playready`, `clearkey`).
  var others: [String] = []
  /// The app's `getLicense` answers the license requests.
  var hook = false

  /// Why a source with this `drm` cannot play here; `nil`: it can.
  var unsupportedMessage: String? {
    guard fairplay == nil else { return nil }
    return "The source's drm gives \(others.joined(separator: ", ")), not FairPlay: "
      + "Apple platforms decrypt FairPlay only."
  }
}

/// The content id in a FairPlay key request's `skd://` URI: its host (the
/// rest, after `skd://`, when it has none).
func fairPlayContentId(_ skd: String) -> String {
  if let host = URL(string: skd)?.host, !host.isEmpty { return host }
  return skd.hasPrefix("skd://") ? String(skd.dropFirst("skd://".count)) : skd
}

/// What the app's `getLicense` is asked (the `licenseRequest` event).
struct LicenseAsk: Equatable {
  let requestId: Int
  let keySystem: String
  let challenge: Data
  let contentId: String?
  let licenseUrl: String?
  let headers: [String: String]
}

/// License requests waiting on the app's `getLicense`: each gets an id that
/// the `license` video command answers (from any player: the ids are unique).
/// Unanswered, a request fails after `timeout` seconds.
final class LicenseRequests {
  static let shared = LicenseRequests()
  typealias Answer = (Result<Data, PlayerError>) -> Void

  private let lock = NSLock()
  private var next = 1
  private var pending: [Int: Answer] = [:]
  let timeout: Double

  init(timeout: Double = 30) { self.timeout = timeout }

  /// A new request's id; `answer` runs once, on any thread.
  func open(_ answer: @escaping Answer) -> Int {
    lock.lock()
    let id = next
    next += 1
    pending[id] = answer
    lock.unlock()
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [weak self] in
      self?.finish(id, .failure(Self.failure("The app's getLicense did not answer within \(Int(self?.timeout ?? 30)) s.")))
    }
    return id
  }

  /// The app's answer: the license in base64, or why `getLicense` failed.
  func answer(_ requestId: Int, license: String?, error: String?) {
    if let license, let data = Data(base64Encoded: license) {
      finish(requestId, .success(data))
    } else {
      finish(requestId, .failure(Self.failure("The app's getLicense failed: \(error ?? "no license").")))
    }
  }

  func cancel(_ requestId: Int, _ reason: String) {
    finish(requestId, .failure(Self.failure(reason)))
  }

  private func finish(_ id: Int, _ result: Result<Data, PlayerError>) {
    lock.lock()
    let answer = pending.removeValue(forKey: id)
    lock.unlock()
    answer?(result)
  }

  static func failure(_ message: String) -> PlayerError {
    PlayerError(code: .drmLicenseFailed, message: message, recoverable: false)
  }
}
