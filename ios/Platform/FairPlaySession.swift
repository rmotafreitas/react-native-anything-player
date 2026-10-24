import AVFoundation
import Foundation

/// A source's FairPlay keys. AVFoundation asks for each key (an `skd://`
/// URI); the app certificate makes the SPC, which goes to the license server
/// — or to the app's `getLicense` — and the CKC that comes back opens the key.
/// A failure is kept in `failure` (the item then fails, and the driver
/// reports it instead of AVFoundation's error).
final class FairPlaySession: NSObject, AVContentKeySessionDelegate {
  private let session = AVContentKeySession(keySystem: .fairPlayStreaming)
  private let server: FairPlayServer
  private let hook: Bool
  private let ask: (LicenseAsk) -> Void
  private let queue = DispatchQueue(label: "com.anythingplayer.fairplay")
  /// The app certificate, fetched once (queue).
  private var certificate: Data?
  /// Key requests waiting on the app's `getLicense` (queue).
  private var waiting = Set<Int>()
  private var closed = false
  private let lock = NSLock()
  private var _failure: PlayerError?

  /// Why a key could not be had (any thread).
  var failure: PlayerError? {
    lock.lock()
    defer { lock.unlock() }
    return _failure
  }

  init(server: FairPlayServer, hook: Bool, ask: @escaping (LicenseAsk) -> Void) {
    self.server = server
    self.hook = hook
    self.ask = ask
    super.init()
    session.setDelegate(self, queue: queue)
  }

  func attach(_ asset: AVURLAsset) {
    session.addContentKeyRecipient(asset)
  }

  /// The item is gone: no request waits on the app anymore.
  func close() {
    queue.async {
      self.closed = true
      for id in self.waiting { LicenseRequests.shared.cancel(id, "The source was closed.") }
      self.waiting = []
    }
  }

  // MARK: AVContentKeySessionDelegate (queue)

  func contentKeySession(_ session: AVContentKeySession, didProvide keyRequest: AVContentKeyRequest) {
    handle(keyRequest)
  }

  func contentKeySession(
    _ session: AVContentKeySession, didProvideRenewingContentKeyRequest keyRequest: AVContentKeyRequest
  ) {
    handle(keyRequest)
  }

  func contentKeySession(
    _ session: AVContentKeySession, contentKeyRequest keyRequest: AVContentKeyRequest, didFailWithError err: Error
  ) {
    record(
      PlayerError(
        code: .drmLicenseFailed, message: "FairPlay refused the key: \(err.localizedDescription)",
        recoverable: false, platformDomain: (err as NSError).domain, platformCode: (err as NSError).code))
  }

  private func handle(_ request: AVContentKeyRequest) {
    guard !closed else { return }
    let skd = request.identifier as? String ?? ""
    let contentId = server.contentId ?? fairPlayContentId(skd)
    loadCertificate { [weak self] result in
      guard let self, !self.closed else { return }
      switch result {
      case .failure(let error): self.refuse(request, error)
      case .success(let certificate):
        request.makeStreamingContentKeyRequestData(
          forApp: certificate, contentIdentifier: Data(contentId.utf8),
          options: [AVContentKeyRequestProtocolVersionsKey: [1]]
        ) { spc, error in
          self.queue.async {
            guard let spc else {
              let message = error?.localizedDescription ?? "no SPC"
              return self.refuse(request, Self.failed("FairPlay could not make the key request: \(message)."))
            }
            self.license(spc, contentId) { result in
              switch result {
              case .success(let ckc):
                request.processContentKeyResponse(AVContentKeyResponse(fairPlayStreamingKeyResponseData: ckc))
              case .failure(let error): self.refuse(request, error)
              }
            }
          }
        }
      }
    }
  }

  private func refuse(_ request: AVContentKeyRequest, _ error: PlayerError) {
    record(error)
    request.processContentKeyResponseError(
      NSError(domain: "AnythingPlayerDRM", code: error.httpStatus ?? -1, userInfo: [NSLocalizedDescriptionKey: error.message]))
  }

  private func record(_ error: PlayerError) {
    lock.lock()
    if _failure == nil { _failure = error }
    lock.unlock()
  }

  // MARK: Certificate and license (queue)

  private func loadCertificate(_ done: @escaping (Result<Data, PlayerError>) -> Void) {
    if let certificate { return done(.success(certificate)) }
    fetch(server.certificateUrl, body: nil, what: "certificate") { [weak self] result in
      if case .success(let data) = result { self?.certificate = data }
      done(result)
    }
  }

  private func license(_ spc: Data, _ contentId: String, _ done: @escaping (Result<Data, PlayerError>) -> Void) {
    guard hook else { return fetch(server.licenseUrl, body: spc, what: "license", done) }
    var id = 0
    id = LicenseRequests.shared.open { [weak self] result in
      guard let self else { return }
      self.queue.async {
        self.waiting.remove(id)
        done(result)
      }
    }
    waiting.insert(id)
    ask(
      LicenseAsk(
        requestId: id, keySystem: "fairplay", challenge: spc, contentId: contentId, licenseUrl: server.licenseUrl,
        headers: server.headers))
  }

  /// A GET (the certificate) or a POST of the SPC (the license), with the FairPlay headers.
  private func fetch(
    _ address: String, body: Data?, what: String, _ done: @escaping (Result<Data, PlayerError>) -> Void
  ) {
    guard let url = URL(string: address) else {
      return done(.failure(Self.failed("The FairPlay \(what) URL is not valid: \(address)")))
    }
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30)
    if let body {
      request.httpMethod = "POST"
      request.httpBody = body
      request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
    }
    for (name, value) in server.headers { request.setValue(value, forHTTPHeaderField: name) }
    URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
      guard let self else { return }
      self.queue.async {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if let data, error == nil, (200..<300).contains(status) { return done(.success(data)) }
        if status >= 300 {
          return done(
            .failure(
              PlayerError(
                code: .drmLicenseFailed, message: "The DRM server returned HTTP \(status) for the \(what).",
                recoverable: status >= 500 || status == 429, httpStatus: status)))
        }
        done(
          .failure(
            PlayerError(
              code: .drmLicenseFailed,
              message: "The FairPlay \(what) could not be fetched: \(error?.localizedDescription ?? "no data").",
              recoverable: true)))
      }
    }.resume()
  }

  private static func failed(_ message: String) -> PlayerError {
    PlayerError(code: .drmLicenseFailed, message: message, recoverable: false)
  }
}
