import Foundation

/// Reads only the ICY metadata of a live HTTP(S) stream: its own connection
/// asks for `Icy-MetaData: 1`, the core de-interleaver separates the blocks,
/// and the audio is discarded. Used while a Cast receiver plays the stream,
/// so titles keep flowing on the phone (they arrive ahead of what the
/// receiver plays, by its buffer).
///
/// It never affects playback: failures reconnect with a backoff until
/// `stop()`, and a server that sends no `icy-metaint` ends the reader (the
/// stream has no titles to read). Main thread only (the session delivers its
/// callbacks on the main queue; the metadata blocks are tiny).
final class IcyMetadataReader: NSObject, URLSessionDataDelegate {
  private let url: URL
  private let headers: [String: String]
  private let format: StreamTitleFormat
  private let onMetadata: (StreamMetadata) -> Void
  private var session: URLSession?
  private var deinterleaver: IcyDeinterleaver?
  private var station: (name: String?, genre: String?) = (nil, nil)
  private var last: StreamMetadata?
  private var failures = 0
  private var retry: DispatchWorkItem?
  private var stopped = false

  private static let maxBackoff: TimeInterval = 30

  init(url: URL, headers: [String: String], format: StreamTitleFormat,
       onMetadata: @escaping (StreamMetadata) -> Void) {
    self.url = url
    self.headers = headers
    self.format = format
    self.onMetadata = onMetadata
  }

  func start() {
    guard !stopped, session == nil else { return }
    retry?.cancel()
    retry = nil
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 15  // idle time between bytes
    config.timeoutIntervalForResource = .greatestFiniteMagnitude
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.urlCache = nil
    // The session retains its delegate until invalidated (`stop`, `connectionEnded`).
    let session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
    self.session = session
    var request = URLRequest(url: url)
    headers.forEach { request.setValue($1, forHTTPHeaderField: $0) }
    request.setValue("1", forHTTPHeaderField: "Icy-MetaData")
    deinterleaver = nil
    session.dataTask(with: request).resume()
  }

  func stop() {
    stopped = true
    retry?.cancel()
    retry = nil
    session?.invalidateAndCancel()
    session = nil
  }

  /// The app returned to the foreground: a suspension killed the connection.
  func reconnectNow() {
    guard !stopped, session == nil else { return }
    failures = 0
    start()
  }

  private func connectionEnded(retrying: Bool) {
    session?.invalidateAndCancel()
    session = nil
    guard retrying, !stopped else { return }
    failures += 1
    let delay = min(Self.maxBackoff, pow(2, Double(failures - 1)))
    let item = DispatchWorkItem { [weak self] in self?.start() }
    retry = item
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
  }

  private func publish(_ metadata: StreamMetadata) {
    var meta = metadata
    if meta.station == nil { meta.station = station.name }
    if meta.genre == nil { meta.genre = station.genre }
    guard !meta.isEmpty, meta != last else { return }
    last = meta
    onMetadata(meta)
  }

  // MARK: - URLSessionDataDelegate (main)

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard session === self.session, let http = response as? HTTPURLResponse else {
      return completionHandler(.cancel)
    }
    guard (200..<300).contains(http.statusCode) else {
      completionHandler(.cancel)
      return connectionEnded(retrying: true)
    }
    var fields: [String: String] = [:]
    for (key, value) in http.allHeaderFields {
      if let k = key as? String, let v = value as? String { fields[k.lowercased()] = v }
    }
    guard let metaint = fields["icy-metaint"].flatMap({ Int($0.trimmingCharacters(in: .whitespaces)) }),
      metaint > 0
    else {
      // No interleaved metadata: nothing to read on this stream.
      completionHandler(.cancel)
      stopped = true
      return connectionEnded(retrying: false)
    }
    failures = 0
    deinterleaver = IcyDeinterleaver(metaint: metaint)
    let name = fields["icy-name"].flatMap { $0.isEmpty ? nil : $0 }
    let genre = fields["icy-genre"].flatMap { $0.isEmpty ? nil : $0 }
    if name != station.name || genre != station.genre {
      station = (name, genre)
      var meta = last ?? StreamMetadata()
      meta.station = name
      meta.genre = genre
      if let name { meta.raw["icy-name"] = name }
      if let genre { meta.raw["icy-genre"] = genre }
      publish(meta)
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard session === self.session, deinterleaver != nil else { return }
    let blocks = deinterleaver!.consume(Array(data)).blocks
    for block in blocks {
      // A block without a title (garbage, an empty update) changes nothing.
      let meta = IcyParser.metadata(fromBlock: block.bytes, format: format)
      if !meta.isEmpty { publish(meta) }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard session === self.session else { return }
    // A live stream that ends (or fails) is reconnected: the receiver still plays it.
    connectionEnded(retrying: true)
  }
}
