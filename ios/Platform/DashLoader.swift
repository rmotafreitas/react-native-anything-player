import AVFoundation
import Foundation

/// DASH for AVPlayer: the manifest is fetched and rewritten as HLS
/// (`DashToHls`), and the playlists are served to AVPlayer under a scheme of
/// RNAP's own (`rnap-dash://…/master.m3u8`) through the asset's resource
/// loader. The segments are the manifest's own https URLs: AVPlayer fetches
/// them itself. A live manifest is fetched again for every playlist reload.
final class DashLoader: NSObject, AVAssetResourceLoaderDelegate {
  static let scheme = "rnap-dash"

  /// A DASH manifest, by its extension.
  static func isDash(_ url: URL) -> Bool {
    url.pathExtension.lowercased() == "mpd"
  }

  let queue = DispatchQueue(label: "anythingplayer.dash")
  /// What AVPlayer opens: the converted master playlist.
  let masterURL: URL
  private let manifest: URL
  private let headers: [String: String]
  /// The last conversion (static manifests are converted once). Guarded by `queue`.
  private var converted: DashToHls.Output?
  private var tasks: [URLSessionDataTask] = []
  private let lock = NSLock()
  private var failureValue: PlayerError?

  /// Why the manifest could not be fetched or converted, if it could not:
  /// the item fails, and the driver reports this instead of AVFoundation's
  /// generic error. Any thread.
  var failure: PlayerError? { lock.sync { failureValue } }

  init(manifest: URL, headers: [String: String]) {
    self.manifest = manifest
    self.headers = headers
    masterURL = URL(string: "\(Self.scheme)://manifest/master.m3u8")!
    super.init()
  }

  /// Stops fetching (the item is gone).
  func cancel() {
    queue.async {
      self.tasks.forEach { $0.cancel() }
      self.tasks = []
    }
  }

  // MARK: - AVAssetResourceLoaderDelegate

  func resourceLoader(
    _ resourceLoader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
  ) -> Bool {
    guard let url = loadingRequest.request.url, url.scheme == Self.scheme else { return false }
    let name = url.lastPathComponent
    if let output = converted, !output.live {
      respond(loadingRequest, name: name, output: output)
      return true
    }
    fetch { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let output):
        self.converted = output
        self.respond(loadingRequest, name: name, output: output)
      case .failure(let error):
        self.lock.sync { if self.failureValue == nil { self.failureValue = error } }
        loadingRequest.finishLoading(
          with: NSError(domain: "RNAPDash", code: 1, userInfo: [NSLocalizedDescriptionKey: error.message]))
      }
    }
    return true
  }

  func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel loadingRequest: AVAssetResourceLoadingRequest) {}

  // MARK: - The playlists

  private func respond(_ request: AVAssetResourceLoadingRequest, name: String, output: DashToHls.Output) {
    let text = name == "master.m3u8" ? output.master : output.media.first { $0.name == name }?.playlist
    guard let text, let data = text.data(using: .utf8) else {
      request.finishLoading(with: NSError(domain: NSURLErrorDomain, code: NSURLErrorFileDoesNotExist))
      return
    }
    if let info = request.contentInformationRequest {
      info.contentType = "public.m3u-playlist"
      info.contentLength = Int64(data.count)
      info.isByteRangeAccessSupported = false
    }
    request.dataRequest?.respond(with: data)
    request.finishLoading()
  }

  /// Fetches and converts the manifest (on `queue`).
  private func fetch(_ done: @escaping (Result<DashToHls.Output, PlayerError>) -> Void) {
    var request = URLRequest(url: manifest)
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    let manifest = self.manifest
    let task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
      guard let self else { return }
      self.queue.async {
        if let error {
          return done(
            .failure(
              .code(
                .networkError, "The DASH manifest could not be fetched (\(error.localizedDescription)).",
                recoverable: true)))
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 200
        guard (200..<300).contains(status), let data, let text = String(data: data, encoding: .utf8) else {
          let missing = status == 404 || status == 410
          var failure = PlayerError.code(
            missing ? .sourceNotFound : .httpError, "The server returned HTTP \(status) for the DASH manifest.",
            recoverable: status >= 500 || status == 429)
          failure.httpStatus = status
          return done(.failure(failure))
        }
        do {
          // A redirect moves the base the segments resolve against.
          done(.success(try DashToHls.convert(text, url: response?.url ?? manifest)))
        } catch let failure as DashToHls.Failure {
          done(.failure(.code(.unsupportedFormat, failure.message, recoverable: false)))
        } catch {
          done(.failure(.code(.unsupportedFormat, "\(error)", recoverable: false)))
        }
      }
    }
    tasks.append(task)
    task.resume()
  }
}
