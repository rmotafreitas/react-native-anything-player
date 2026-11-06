import AVFoundation
import Foundation

/// The media cache on iOS (`Cache` in JS). Two disk stores: one written as
/// items play and by `preload` (least recently played go first), and one kept
/// by downloads, never evicted. The stream proxy reads and writes them for a
/// file as it plays; a file the device holds whole is opened from disk
/// directly; a downloaded HLS item plays from its `AVAssetDownloadURLSession`
/// package. Nothing here needs JavaScript. Main thread for the player's
/// questions; the work runs on `queue`.
final class MediaCache: NSObject {
  static let shared = MediaCache()

  private static let mb: Int64 = 1024 * 1024
  private static let defaultMax: Int64 = 256 * mb
  private static let defaultPreload: Int64 = mb
  private static let progressInterval: TimeInterval = 1

  let play: MediaStore
  let kept: MediaStore
  private let queue = DispatchQueue(label: "anythingplayer.cache")
  private let defaults = UserDefaults.standard
  private let lock = NSLock()
  private var enabledValue: Bool

  private struct Download: Codable {
    let id: String
    let uri: String
    let key: String
    let headers: [String: String]
    /// `file` or `hls`.
    let type: String
    var state: String
    var bytes: Int64 = 0
    var totalBytes: Int64?
    var error: String?
    var errorCode: String?
    /// An HLS package, relative to the home directory (the app's container moves).
    var package: String?
  }

  /// What a data task is for.
  private enum Job {
    case preload(key: String, done: (Error?) -> Void)
    case download(id: String)
  }

  /// A data task's work: where its bytes go.
  private final class Transfer {
    let job: Job
    let store: MediaStore
    let key: String
    var offset: Int64

    init(_ job: Job, _ store: MediaStore, _ key: String, _ offset: Int64) {
      self.job = job
      self.store = store
      self.key = key
      self.offset = offset
    }
  }

  private var downloads: [String: Download] = [:]
  private var jobs: [Int: Transfer] = [:]
  private var assetTasks: [Int: String] = [:]
  private var lastProgress: [String: TimeInterval] = [:]

  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.default
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.urlCache = nil
    let operations = OperationQueue()
    operations.underlyingQueue = queue
    operations.maxConcurrentOperationCount = 1
    return URLSession(configuration: config, delegate: self, delegateQueue: operations)
  }()

  /// HLS downloads: AVFoundation's own, which must be a background session.
  private lazy var assetSession: AVAssetDownloadURLSession = {
    let config = URLSessionConfiguration.background(withIdentifier: "com.anythingplayer.downloads")
    let operations = OperationQueue()
    operations.underlyingQueue = queue
    operations.maxConcurrentOperationCount = 1
    return AVAssetDownloadURLSession(configuration: config, assetDownloadDelegate: self, delegateQueue: operations)
  }()

  private override init() {
    let fm = FileManager.default
    let caches = fm.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    var support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("rnap-downloads")
    try? fm.createDirectory(at: support, withIntermediateDirectories: true)
    // Downloads can be fetched again: not in the user's backups.
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try? support.setResourceValues(values)
    let max = UserDefaults.standard.object(forKey: "rnap.cache.maxSizeBytes") as? NSNumber
    play = MediaStore(directory: caches.appendingPathComponent("rnap-media"), maxBytes: max?.int64Value ?? Self.defaultMax)
    kept = MediaStore(directory: support, maxBytes: nil)
    enabledValue = UserDefaults.standard.bool(forKey: "rnap.cache.enabled")
    super.init()
    queue.async { self.restore() }
  }

  private var enabled: Bool { lock.sync { enabledValue } }

  // MARK: - The player's questions (any thread)

  func key(of source: SourceDescriptor) -> String {
    source.cacheKey ?? (source.uri.components(separatedBy: "#").first ?? source.uri)
  }

  /// A file the proxy may serve from, and write to as it plays.
  func route(for source: SourceDescriptor) -> (key: String, writes: Bool)? {
    guard source.liveHint != true, source.drm == nil, source.isNetwork else { return nil }
    return (key(of: source), source.cache ?? enabled)
  }

  /// A file the device holds whole (a download, else the cache): opened from disk.
  func completeFile(for source: SourceDescriptor) -> URL? {
    guard source.liveHint != true, source.isNetwork, !Self.isHls(source.uri) else { return nil }
    let key = self.key(of: source)
    if kept.isComplete(key) { return kept.fileURL(key) }
    if play.isComplete(key) {
      play.touch(key)
      return play.fileURL(key)
    }
    return nil
  }

  /// A downloaded HLS item's package.
  func downloadedPackage(for source: SourceDescriptor) -> URL? {
    let key = self.key(of: source)
    let package: String? = queue.sync {
      downloads.values.first { $0.key == key && $0.type == "hls" && $0.state == "completed" }?.package
    }
    return package.map { URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent($0) }
  }

  /// The proxy relayed a response for a key it may write: what the file is.
  func describe(key: String, url: URL, totalLength: Int64?, contentType: String?) {
    play.describe(key, totalLength: totalLength, contentType: contentType, pathExtension: Self.pathExtension(url, contentType))
  }

  /// Which store serves a key (a download first).
  func store(holding key: String, range: String?) -> (MediaStore, StoredResponse)? {
    if let plan = kept.plan(key, range: range) { return (kept, plan) }
    if let plan = play.plan(key, range: range) {
      play.touch(key)
      return (play, plan)
    }
    return nil
  }

  // MARK: - Commands (`cacheCommand`)

  func command(_ command: NSDictionary, completion: @escaping (Result<[String: Any], PlayerError>) -> Void) {
    let op = command["op"] as? String ?? ""
    let source = (command["source"] as? NSDictionary).map { SourceDescriptor.parse($0).0 }
    queue.async {
      do {
        switch op {
        case "configure":
          if let on = command["enabled"] as? Bool {
            self.lock.sync { self.enabledValue = on }
            self.defaults.set(on, forKey: "rnap.cache.enabled")
          }
          if let max = (command["maxSizeBytes"] as? NSNumber)?.int64Value {
            self.defaults.set(max, forKey: "rnap.cache.maxSizeBytes")
            self.play.maxBytes = max
          }
          completion(.success([:]))
        case "preload":
          let item = try Self.need(source)
          let all = command["all"] as? Bool ?? false
          let bytes = (command["bytes"] as? NSNumber)?.int64Value ?? Self.defaultPreload
          self.preload(item, bytes: all ? nil : bytes) { error in
            if let error { completion(.failure(Self.failure(error))) } else { completion(.success(self.info(item))) }
          }
        case "download":
          completion(.success(try self.download(Self.need(source), id: command["id"] as? String)))
        case "downloads":
          completion(.success(["downloads": self.downloads.values.map(Self.map)]))
        case "removeDownload":
          self.removeDownload(command["id"] as? String ?? "")
          completion(.success([:]))
        case "info":
          completion(.success(self.info(try Self.need(source))))
        case "usage":
          completion(.success([
            "cacheBytes": self.play.totalBytes, "downloadBytes": self.kept.totalBytes + self.packageBytes(),
            "maxSizeBytes": self.play.maxBytes ?? 0,
          ]))
        case "clear":
          self.play.clear()
          completion(.success([:]))
        default:
          throw PlayerError.code(.invalidArgument, "Unknown cache command \"\(op)\".", recoverable: false)
        }
      } catch let error as PlayerError {
        completion(.failure(error))
      } catch {
        completion(.failure(Self.failure(error)))
      }
    }
  }

  // MARK: - Work (on `queue`)

  private func preload(_ source: SourceDescriptor, bytes: Int64?, done: @escaping (Error?) -> Void) {
    // HLS is fetched by AVFoundation itself: there is nothing to warm (a download keeps it).
    guard source.liveHint != true, source.isNetwork, !Self.isHls(source.uri), let url = URL(string: source.uri) else {
      return done(nil)
    }
    let key = self.key(of: source)
    if play.isComplete(key) || kept.isComplete(key) { return done(nil) }
    var request = URLRequest(url: url)
    source.headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
    if let bytes { request.setValue("bytes=0-\(bytes - 1)", forHTTPHeaderField: "Range") }
    let task = session.dataTask(with: request)
    jobs[task.taskIdentifier] = Transfer(.preload(key: key, done: done), play, key, 0)
    task.resume()
  }

  private func download(_ source: SourceDescriptor, id: String?) throws -> [String: Any] {
    guard source.liveHint != true, source.isNetwork, source.drm == nil else {
      throw PlayerError.code(
        .unsupportedFormat, "Downloads are finite sources over HTTP(S): not live streams, local files or DRM.",
        recoverable: false)
    }
    guard !DashLoader.isDash(URL(string: source.uri) ?? URL(fileURLWithPath: "/")) else {
      throw PlayerError.code(.unsupportedFormat, "DASH cannot be downloaded on iOS (HLS and files can).", recoverable: false)
    }
    let name = id ?? source.uri
    if downloads[name] != nil { removeDownload(name) }
    let entry = Download(
      id: name, uri: source.uri, key: key(of: source), headers: source.headers,
      type: Self.isHls(source.uri) ? "hls" : "file", state: "queued")
    downloads[name] = entry
    save()
    start(entry)
    return Self.map(entry)
  }

  private func start(_ download: Download) {
    guard let url = URL(string: download.uri) else { return }
    var d = download
    d.state = "downloading"
    downloads[d.id] = d
    emit(d)
    if d.type == "hls" {
      let asset = AVURLAsset(url: url, options: ["AVURLAssetHTTPHeaderFieldsKey": d.headers])
      guard let task = assetSession.makeAssetDownloadTask(asset: asset, assetTitle: d.id, assetArtworkData: nil, options: nil)
      else { return fail(d.id, PlayerError.code(.unsupportedFormat, "This HLS item cannot be downloaded.", recoverable: false)) }
      task.taskDescription = d.id
      assetTasks[task.taskIdentifier] = d.id
      task.resume()
      return
    }
    // A file: from where it stopped (the store keeps what arrived).
    var request = URLRequest(url: url)
    d.headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
    let from = kept.run(d.key, from: 0)
    if from > 0 { request.setValue("bytes=\(from)-", forHTTPHeaderField: "Range") }
    let task = session.dataTask(with: request)
    task.taskDescription = d.id
    jobs[task.taskIdentifier] = Transfer(.download(id: d.id), kept, d.key, from)
    task.resume()
  }

  private func removeDownload(_ id: String) {
    guard let download = downloads.removeValue(forKey: id) else { return }
    for (task, transfer) in jobs {
      if case .download(let owner) = transfer.job, owner == id { jobs.removeValue(forKey: task) }
    }
    session.getAllTasks { tasks in tasks.filter { $0.taskDescription == id }.forEach { $0.cancel() } }
    assetSession.getAllTasks { tasks in tasks.filter { $0.taskDescription == id }.forEach { $0.cancel() } }
    if let package = download.package {
      try? FileManager.default.removeItem(at: URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(package))
    }
    kept.remove(download.key)
    save()
  }

  private func info(_ source: SourceDescriptor) -> [String: Any] {
    let key = self.key(of: source)
    let download = downloads.values.first { $0.key == key }
    let held = max(kept.heldBytes(key), play.heldBytes(key))
    let total = kept.entry(key)?.totalLength ?? play.entry(key)?.totalLength ?? download?.totalBytes
    let complete = download?.state == "completed" || kept.isComplete(key) || play.isComplete(key)
    let bytes = download?.type == "hls" ? download?.bytes ?? 0 : held
    return [
      "state": complete ? "complete" : (bytes > 0 ? "partial" : "none"),
      "bytes": bytes, "totalBytes": total.map { $0 as Any } ?? NSNull(),
      "downloaded": download?.state == "completed",
    ]
  }

  private func fail(_ id: String, _ error: PlayerError) {
    guard var d = downloads[id] else { return }
    d.state = "failed"
    d.error = error.message
    d.errorCode = error.code.rawValue
    downloads[id] = d
    save()
    emit(d)
  }

  private func emit(_ d: Download) {
    var event = Self.map(d)
    event["type"] = "download"
    AnythingPlayerRuntime.shared.emit(event)
  }

  private func progress(_ d: Download) {
    let now = Date().timeIntervalSince1970
    if now - (lastProgress[d.id] ?? 0) < Self.progressInterval { return }
    lastProgress[d.id] = now
    emit(d)
  }

  private func packageBytes() -> Int64 {
    downloads.values.compactMap(\.package).reduce(0) { sum, path in
      sum + Self.directorySize(URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(path))
    }
  }

  private var indexURL: URL { kept.directory.appendingPathComponent("downloads.json") }

  private func save() {
    if let data = try? JSONEncoder().encode(Array(downloads.values)) { try? data.write(to: indexURL, options: .atomic) }
  }

  private func restore() {
    guard let data = try? Data(contentsOf: indexURL), let list = try? JSONDecoder().decode([Download].self, from: data)
    else { return }
    for d in list { downloads[d.id] = d }
    // An unfinished file download goes on; HLS ones are resumed by their background session.
    for d in list where d.type == "file" && (d.state == "queued" || d.state == "downloading") { start(d) }
    _ = assetSession
  }

  // MARK: - Helpers

  private static func need(_ source: SourceDescriptor?) throws -> SourceDescriptor {
    guard let source else { throw PlayerError.code(.invalidArgument, "A cache command needs a source.", recoverable: false) }
    return source
  }

  private static func isHls(_ uri: String) -> Bool {
    (uri.components(separatedBy: "?").first ?? uri).lowercased().hasSuffix(".m3u8")
  }

  /// The extension AVFoundation reads the container by: the URL's, else from the type.
  static func pathExtension(_ url: URL, _ contentType: String?) -> String {
    let ext = url.pathExtension.lowercased()
    if !ext.isEmpty, ext.count <= 5 { return ext }
    switch contentType?.lowercased().components(separatedBy: ";").first?.trimmingCharacters(in: .whitespaces) {
    case "audio/mpeg", "audio/mp3": return "mp3"
    case "audio/aac", "audio/aacp": return "aac"
    case "audio/mp4", "audio/x-m4a": return "m4a"
    case "audio/flac", "audio/x-flac": return "flac"
    case "audio/wav", "audio/x-wav", "audio/wave": return "wav"
    case "video/mp4": return "mp4"
    case "video/quicktime": return "mov"
    default: return "mp3"
    }
  }

  private static func directorySize(_ url: URL) -> Int64 {
    guard let files = FileManager.default.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey]) else { return 0 }
    var total: Int64 = 0
    for case let file as URL in files {
      total += Int64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
    }
    return total
  }

  private static func failure(_ error: Error) -> PlayerError {
    if let e = error as? PlayerError { return e }
    let ns = error as NSError
    var failure = PlayerError.code(.networkError, ns.localizedDescription, recoverable: true)
    failure.platformDomain = ns.domain
    failure.platformCode = ns.code
    return failure
  }

  private static func map(_ d: Download) -> [String: Any] {
    var error: Any = NSNull()
    if let message = d.error {
      error = ["code": d.errorCode ?? "NETWORK_ERROR", "message": message, "recoverable": true, "platform": "ios"]
    }
    return [
      "id": d.id, "uri": d.uri, "state": d.state, "bytes": d.bytes,
      "totalBytes": d.totalBytes.map { $0 as Any } ?? NSNull(), "error": error,
    ]
  }
}

// MARK: - URLSession (preloads and file downloads, on `queue`)

extension MediaCache: URLSessionDataDelegate {
  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let job = jobs[dataTask.taskIdentifier], let http = response as? HTTPURLResponse else {
      return completionHandler(.cancel)
    }
    guard (200..<300).contains(http.statusCode) else {
      let missing = http.statusCode == 404 || http.statusCode == 410
      var error = PlayerError.code(missing ? .sourceNotFound : .httpError, "The server answered \(http.statusCode).", recoverable: http.statusCode >= 500)
      error.httpStatus = http.statusCode
      finish(dataTask.taskIdentifier, error)
      return completionHandler(.cancel)
    }
    let headers = http.allHeaderFields.reduce(into: [String: String]()) { out, pair in
      if let k = pair.key as? String { out[k.lowercased()] = "\(pair.value)" }
    }
    var offset: Int64 = 0
    var total = headers["content-length"].flatMap { Int64($0) }
    if http.statusCode == 206, let range = headers["content-range"] {
      // `bytes a-b/total`
      let parts = range.replacingOccurrences(of: "bytes ", with: "").split(separator: "/")
      offset = parts.first.flatMap { Int64($0.split(separator: "-").first ?? "") } ?? 0
      total = parts.count > 1 ? Int64(parts[1]) : nil
    } else if job.offset > 0 {
      // The server ignored the range: the file comes again from its start.
      job.store.remove(job.key)
    }
    if let url = http.url ?? dataTask.originalRequest?.url {
      job.store.describe(job.key, totalLength: total, contentType: headers["content-type"], pathExtension: Self.pathExtension(url, headers["content-type"]))
    }
    job.offset = offset
    if case .download(let id) = job.job, var d = downloads[id] {
      d.totalBytes = total
      downloads[id] = d
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let job = jobs[dataTask.taskIdentifier] else { return }
    job.store.write(job.key, offset: job.offset, data: data)
    job.offset += Int64(data.count)
    if case .download(let id) = job.job, var d = downloads[id] {
      d.bytes = job.store.heldBytes(job.key)
      downloads[id] = d
      progress(d)
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if task is AVAssetDownloadTask, let id = assetTasks.removeValue(forKey: task.taskIdentifier) ?? task.taskDescription {
      // An HLS download's end (its package arrived in didFinishDownloadingTo).
      guard var d = downloads[id] else { return }
      if let error, (error as NSError).code != NSURLErrorCancelled {
        return fail(id, Self.failure(error))
      }
      if d.package != nil {
        d.state = "completed"
        downloads[id] = d
        save()
        emit(d)
      }
      return
    }
    finish(task.taskIdentifier, error.map(Self.failure))
  }

  private func finish(_ task: Int, _ error: PlayerError?) {
    guard let job = jobs.removeValue(forKey: task) else { return }
    switch job.job {
    case .preload(_, let done):
      done(error)
    case .download(let id):
      if let error {
        if (error.platformCode ?? 0) != NSURLErrorCancelled { fail(id, error) }
        return
      }
      guard var d = downloads[id] else { return }
      d.state = job.store.isComplete(job.key) || d.totalBytes == nil ? "completed" : "failed"
      d.bytes = job.store.heldBytes(job.key)
      downloads[id] = d
      // The same bytes are not kept twice.
      if d.state == "completed" { play.remove(d.key) }
      save()
      emit(d)
    }
  }
}

// MARK: - HLS downloads

extension MediaCache: AVAssetDownloadDelegate {
  func urlSession(
    _ session: URLSession, assetDownloadTask: AVAssetDownloadTask, didFinishDownloadingTo location: URL
  ) {
    // After a relaunch the task is not in `assetTasks`: its description names the download.
    guard let id = assetTasks[assetDownloadTask.taskIdentifier] ?? assetDownloadTask.taskDescription,
      var d = downloads[id]
    else { return }
    let home = NSHomeDirectory()
    d.package = location.path.hasPrefix(home) ? String(location.path.dropFirst(home.count + 1)) : location.path
    d.bytes = Self.directorySize(location)
    d.totalBytes = d.bytes
    downloads[d.id] = d
    save()
  }

  func urlSession(
    _ session: URLSession, assetDownloadTask: AVAssetDownloadTask, didLoad timeRange: CMTimeRange,
    totalTimeRangesLoaded loadedTimeRanges: [NSValue], timeRangeExpectedToLoad: CMTimeRange
  ) {
    guard let id = assetTasks[assetDownloadTask.taskIdentifier] ?? assetDownloadTask.taskDescription,
      var d = downloads[id]
    else { return }
    let loaded = loadedTimeRanges.map { $0.timeRangeValue.duration.seconds }.reduce(0, +)
    let expected = timeRangeExpectedToLoad.duration.seconds
    // Bytes are not told for HLS: a share of 1,000 stands in until the end.
    if expected > 0 {
      d.bytes = Int64(loaded / expected * 1000)
      d.totalBytes = 1000
    }
    downloads[id] = d
    progress(d)
  }
}
