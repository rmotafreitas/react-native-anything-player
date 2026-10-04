import Foundation
import Network
import os

private let proxyLog = Logger(subsystem: "com.radioanimu.airwave", category: "proxy")

/// An in-process loopback HTTP proxy for HTTP(S) sources.
///
/// AVPlayer talks to `http://127.0.0.1:<port>/<token>`; every upstream
/// connection is made by our own `URLSession`. AVPlayer therefore sees a
/// genuine HTTP response (a live stream stays a live stream to it, with its
/// native buffering and ICY metadata handling), while we own the sockets.
///
/// Why: AVFoundation retries connections internally. When an item is replaced
/// while such a retry is pending (a reconnect during a server outage), the
/// retry can connect *after* the item is gone and keep downloading the stream
/// forever — a bandwidth leak and a phantom listener on the station's server
/// (reproduced against the test server). With the proxy, retiring a token
/// cancels its upstream at once, and any late request for it is answered
/// locally with `410 Gone` — nothing reaches the station.
///
/// (An `AVAssetResourceLoader` was tried first and rejected: AVFoundation
/// treats loader-backed resources as files, and an endless stream stalls
/// permanently after a few MB.)
///
/// Coalescing: AVFoundation sometimes opens two identical requests for one
/// item at the same instant (measured on the iOS 27 simulator: ~15 % of opens
/// through a loopback proxy) and reads both for as long as the item lives.
/// Identical requests that arrive while an upstream is still waiting for its
/// response share that upstream; the bytes are fanned out locally, so the
/// station always sees one connection.
///
/// Splicing: when the upstream of an endless stream ends after streaming
/// productively (servers and load balancers drop long connections), the
/// proxy opens a fresh upstream and continues the *same* response, so AVPlayer
/// keeps playing from its buffer instead of reaching end-of-stream. ICY
/// metadata is stripped from every upstream and re-inserted at the cadence
/// promised in the first response (a new connection restarts its framing at
/// zero). Short-lived upstreams are never spliced: a flapping server ends the
/// response and the engine's backoff takes over.
///
/// Threading: everything runs on `queue`. Route callbacks are called on `queue`.
final class StreamProxy {
  static let shared = StreamProxy()

  struct Route {
    let url: URL
    let headers: [String: String]
    /// Upstream response (status, lower-cased headers) — ICY headers, HTTP errors.
    let onResponse: (Int, [String: String]) -> Void
    /// Upstream failure before or during the body (offline, DNS, reset …).
    let onError: (Error) -> Void
    /// Diagnostics: a dropped upstream was replaced inside the response.
    let onSplice: ([String: String]) -> Void
    /// The compressed audio of the main endless response (ICY removed) and its
    /// content type — what a visualizer decodes. Called on the proxy queue.
    var onAudio: ((Data, String?) -> Void)? = nil
  }

  private let queue = DispatchQueue(label: "airwave.proxy")
  private let listenerQueue = DispatchQueue(label: "airwave.proxy.listener")
  private var listener: NWListener?
  private var port: UInt16 = 0
  private var routes: [String: Route] = [:]
  /// Recently retired tokens (bounded: an older late request gets 404, which
  /// is just as final — it never reaches the station either).
  private var retired = Set<String>()
  private var retiredOrder: [String] = []
  private static let retiredMemory = 256
  /// Upstream task id → upstream (on `queue`).
  fileprivate var upstreams: [Int: Upstream] = [:]
  private var downstreams: [ObjectIdentifier: Downstream] = [:]
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 15  // idle time between bytes
    config.timeoutIntervalForResource = .greatestFiniteMagnitude
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.urlCache = nil
    let operations = OperationQueue()
    operations.underlyingQueue = queue
    operations.maxConcurrentOperationCount = 1
    return URLSession(configuration: config, delegate: Delegate(proxy: self), delegateQueue: operations)
  }()

  /// Pause the upstream when every reader has this much waiting to be sent.
  private static let highWater = 512 * 1024
  private static let lowWater = 128 * 1024
  /// A reader that stops reading while another keeps up is dropped past this.
  private static let maxBacklog = 2 * 1024 * 1024
  /// An endless response whose upstream ends is continued over a fresh
  /// connection only if that upstream streamed for at least this long.
  static let spliceMinUpstreamMs: Int64 = 3_000

  /// Registers a route and returns the URL AVPlayer should open (nil if the
  /// listener cannot start — callers then fall back to the original URL).
  func register(_ route: Route) -> URL? {
    queue.sync {
      guard ensureListening() else { return nil }
      let token = UUID().uuidString.lowercased()
      routes[token] = route
      var components = URLComponents()
      components.scheme = "http"
      components.host = "127.0.0.1"
      components.port = Int(port)
      // Keep the extension: AVFoundation uses it as a format hint.
      let ext = route.url.pathExtension
      components.path = "/" + token + (ext.isEmpty ? "" : "." + ext)
      return components.url
    }
  }

  /// Closes every connection of `url`'s route; later requests get 410.
  func retire(_ proxied: URL) {
    let token = Self.token(of: proxied)
    queue.async { [self] in
      routes.removeValue(forKey: token)
      if retired.insert(token).inserted {
        retiredOrder.append(token)
        if retiredOrder.count > Self.retiredMemory { retired.remove(retiredOrder.removeFirst()) }
      }
      for downstream in downstreams.values where downstream.token == token { close(downstream) }
    }
  }

  // MARK: - Listener

  /// Called on `queue`. The listener reports its state on its own queue, so
  /// waiting for `.ready` here cannot deadlock.
  private func ensureListening() -> Bool {
    if let listener, listener.state == .ready, port != 0 { return true }
    listener?.cancel()
    listener = nil
    port = 0
    do {
      let parameters = NWParameters.tcp
      // Bound to loopback only: nothing off-device can reach it.
      parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
      let created = try NWListener(using: parameters)
      let ready = DispatchSemaphore(value: 0)
      created.stateUpdateHandler = { state in
        switch state {
        case .ready, .failed, .cancelled: ready.signal()
        default: break
        }
      }
      created.newConnectionHandler = { [weak self] connection in
        self?.queue.async { self?.accept(connection) }
      }
      created.start(queue: listenerQueue)
      guard ready.wait(timeout: .now() + 2) == .success, created.state == .ready,
        let bound = created.port?.rawValue
      else {
        proxyLog.error("listener failed to start: \(String(describing: created.state), privacy: .public)")
        created.cancel()
        return false
      }
      proxyLog.debug("listening on 127.0.0.1:\(bound)")
      listener = created
      port = bound
      return true
    } catch {
      return false
    }
  }

  // MARK: - Connections

  /// One AVPlayer connection.
  final class Downstream {
    let connection: NWConnection
    var token = ""
    var upstream: Upstream?
    var pending = 0
    var closed = false
    var requestBuffer = Data()

    init(connection: NWConnection) { self.connection = connection }
  }

  /// One logical upstream response (possibly spliced over several connections)
  /// and the AVPlayer connections reading it.
  final class Upstream {
    let token: String
    let request: URLRequest
    /// Requests are coalesced only with an identical Range.
    let range: String?
    var task: URLSessionDataTask?
    var readers: [Downstream] = []
    /// The response head sent to readers (nil until the first response).
    var head: Data?
    /// 200 without a content length: an endless stream, may be spliced.
    var endless = false
    var contentType: String?
    var suspended = false
    /// Current connection: when its response arrived, audio bytes it carried.
    var since: Int64?
    var bytes: Int64 = 0
    var splices = 0
    /// ICY framing: per connection in, at the first response's cadence out.
    var deinterleaver = IcyDeinterleaver(metaint: 0)
    var reframer = IcyReframer(metaint: 0)

    init(token: String, request: URLRequest, range: String?) {
      self.token = token
      self.request = request
      self.range = range
    }
  }

  private func accept(_ connection: NWConnection) {
    proxyLog.debug("accepted \(String(describing: connection.endpoint), privacy: .public)")
    let downstream = Downstream(connection: connection)
    downstreams[ObjectIdentifier(downstream)] = downstream
    connection.stateUpdateHandler = { [weak self, weak downstream] state in
      guard let self, let downstream else { return }
      switch state {
      case .failed, .cancelled: self.close(downstream)
      default: break
      }
    }
    connection.start(queue: queue)
    readRequest(downstream)
  }

  private func readRequest(_ downstream: Downstream) {
    downstream.connection.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) {
      [weak self, weak downstream] data, _, complete, error in
      guard let self, let downstream, !downstream.closed else { return }
      if let data { downstream.requestBuffer.append(data) }
      if let end = downstream.requestBuffer.range(of: Data("\r\n\r\n".utf8)) {
        let head = String(decoding: downstream.requestBuffer[..<end.lowerBound], as: UTF8.self)
        self.start(downstream, head: head)
        self.watchForClose(downstream)
      } else if complete || error != nil || downstream.requestBuffer.count > 64 * 1024 {
        self.close(downstream)
      } else {
        self.readRequest(downstream)
      }
    }
  }

  /// AVPlayer closing its side is how it says "stop".
  private func watchForClose(_ downstream: Downstream) {
    downstream.connection.receive(minimumIncompleteLength: 1, maximumLength: 1024) {
      [weak self, weak downstream] _, _, complete, error in
      guard let self, let downstream, !downstream.closed else { return }
      if complete || error != nil { self.close(downstream) } else { self.watchForClose(downstream) }
    }
  }

  private func start(_ downstream: Downstream, head: String) {
    let lines = head.components(separatedBy: "\r\n")
    let parts = lines.first?.split(separator: " ") ?? []
    guard parts.count >= 2 else { return respond(downstream, status: 400) }
    let token = Self.token(of: URL(string: "http://h" + String(parts[1])))
    downstream.token = token
    guard let route = routes[token] else {
      return respond(downstream, status: retired.contains(token) ? 410 : 404)
    }
    var request = URLRequest(url: route.url)
    request.httpMethod = parts[0] == "HEAD" ? "HEAD" : "GET"
    var range: String?
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":") else { continue }
      let name = line[..<colon].trimmingCharacters(in: .whitespaces)
      let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      switch name.lowercased() {
      case "host", "connection", "keep-alive", "proxy-connection", "accept-encoding", "x-playback-session-id":
        continue
      case "range": range = value
      default: break
      }
      request.setValue(value, forHTTPHeaderField: name)
    }
    // App headers win (auth, User-Agent).
    for (name, value) in route.headers { request.setValue(value, forHTTPHeaderField: name) }
    // Byte-exact passthrough: no transparent decompression.
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    proxyLog.debug("request \(lines.first ?? "", privacy: .public) [\(range ?? "no range", privacy: .public)]")

    if request.httpMethod == "GET",
      let shared = upstreams.values.first(where: {
        $0.token == token && $0.range == range && $0.head == nil && $0.request.httpMethod == "GET"
      })
    {
      proxyLog.debug("coalesced with a pending upstream (\(shared.readers.count) reader(s))")
      downstream.upstream = shared
      shared.readers.append(downstream)
      return
    }
    let upstream = Upstream(token: token, request: request, range: range)
    downstream.upstream = upstream
    upstream.readers = [downstream]
    connect(upstream)
  }

  private func connect(_ upstream: Upstream) {
    let task = session.dataTask(with: upstream.request)
    upstreams[task.taskIdentifier] = upstream
    upstream.task = task
    upstream.suspended = false
    upstream.since = nil
    upstream.bytes = 0
    task.resume()
  }

  fileprivate func upstreamResponse(_ upstream: Upstream, _ response: URLResponse) -> Bool {
    guard !upstream.readers.isEmpty, let http = response as? HTTPURLResponse else { return false }
    var headers: [String: String] = [:]
    http.allHeaderFields.forEach { key, value in
      if let k = key as? String { headers[k.lowercased()] = "\(value)" }
    }
    routes[upstream.token]?.onResponse(http.statusCode, headers)
    let metaint = headers["icy-metaint"].flatMap { Int($0.trimmingCharacters(in: .whitespaces)) } ?? 0
    upstream.deinterleaver = IcyDeinterleaver(metaint: metaint)
    upstream.since = Self.now
    if upstream.head != nil {
      // A splice: the response is already under way.
      guard http.statusCode == 200 else {
        proxyLog.debug("splice refused: HTTP \(http.statusCode)")
        finish(upstream)
        return false
      }
      proxyLog.debug("spliced upstream #\(upstream.splices)")
      return true
    }
    upstream.endless = http.statusCode == 200 && headers["content-length"] == nil
    upstream.contentType = headers["content-type"]
    upstream.reframer = IcyReframer(metaint: metaint)
    var head = "HTTP/1.1 \(http.statusCode) \(HTTPURLResponse.localizedString(forStatusCode: http.statusCode))\r\n"
    for (name, value) in headers {
      switch name {
      case "connection", "keep-alive", "transfer-encoding", "content-encoding", "proxy-connection": continue
      default: head += "\(name): \(value)\r\n"
      }
    }
    head += "connection: close\r\n\r\n"
    let data = Data(head.utf8)
    upstream.head = data
    for reader in upstream.readers { send(reader, data) }
    return true
  }

  fileprivate func upstreamData(_ upstream: Upstream, _ data: Data) {
    guard !upstream.readers.isEmpty else { return }
    var out = data
    if upstream.endless {
      let chunk = upstream.deinterleaver.consume([UInt8](data))
      upstream.bytes += Int64(chunk.audio.count)
      if upstream.range == nil, !chunk.audio.isEmpty, let onAudio = routes[upstream.token]?.onAudio {
        onAudio(Data(chunk.audio), upstream.contentType)
      }
      let framed = upstream.reframer.frame(chunk, audioEnd: upstream.deinterleaver.audioBytes)
      guard !framed.isEmpty else { return }
      out = Data(framed)
    }
    for reader in upstream.readers { send(reader, out) }
  }

  fileprivate func upstreamComplete(_ upstream: Upstream, _ error: Error?) {
    guard !upstream.readers.isEmpty else { return }
    upstream.task = nil
    let failure = error.flatMap { ($0 as NSError).code == NSURLErrorCancelled ? nil : $0 }
    if upstream.head != nil, upstream.endless, routes[upstream.token] != nil,
      let since = upstream.since, upstream.bytes > 0, Self.now - since >= Self.spliceMinUpstreamMs
    {
      upstream.splices += 1
      let cause = failure.map { String(describing: ($0 as NSError).code) } ?? "closed by server"
      proxyLog.debug("upstream ended (\(cause, privacy: .public)) after \(Self.now - since) ms: splicing")
      routes[upstream.token]?.onSplice([
        "cause": cause, "upstreamMs": "\(Self.now - since)", "splice": "\(upstream.splices)",
      ])
      return connect(upstream)
    }
    if let failure {
      proxyLog.debug("upstream error \(String(describing: failure), privacy: .public)")
      routes[upstream.token]?.onError(failure)
      if upstream.head == nil {
        for reader in upstream.readers { respond(reader, status: 502) }
        return
      }
    }
    finish(upstream)
  }

  /// Ends the response for every reader once what is queued has been sent.
  private func finish(_ upstream: Upstream) {
    cancelTask(of: upstream)
    for reader in upstream.readers {
      reader.connection.send(
        content: nil, contentContext: .finalMessage, isComplete: true,
        completion: .contentProcessed { [weak self, weak reader] _ in
          guard let self, let reader else { return }
          self.close(reader)
        })
    }
  }

  private func cancelTask(of upstream: Upstream) {
    guard let task = upstream.task else { return }
    upstreams.removeValue(forKey: task.taskIdentifier)
    task.cancel()
    upstream.task = nil
  }

  private func send(_ reader: Downstream, _ data: Data) {
    guard !reader.closed else { return }
    reader.pending += data.count
    if let upstream = reader.upstream, upstream.readers.count > 1, reader.pending > Self.maxBacklog {
      proxyLog.debug("dropping a reader that stopped reading")
      return close(reader)
    }
    if let upstream = reader.upstream { updateBackpressure(upstream) }
    reader.connection.send(
      content: data,
      completion: .contentProcessed { [weak self, weak reader] error in
        guard let self, let reader, !reader.closed else { return }
        reader.pending -= data.count
        if error != nil { return self.close(reader) }
        if let upstream = reader.upstream { self.updateBackpressure(upstream) }
      })
  }

  /// The upstream pauses only when every reader is behind (a slow reader
  /// must not starve the one that is playing).
  private func updateBackpressure(_ upstream: Upstream) {
    let least = upstream.readers.map(\.pending).min() ?? 0
    if !upstream.suspended, least > Self.highWater {
      upstream.suspended = true
      upstream.task?.suspend()
    } else if upstream.suspended, least < Self.lowWater {
      upstream.suspended = false
      upstream.task?.resume()
    }
  }

  private func respond(_ downstream: Downstream, status: Int) {
    let head = "HTTP/1.1 \(status) \(HTTPURLResponse.localizedString(forStatusCode: status))\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
    downstream.connection.send(
      content: Data(head.utf8), contentContext: .finalMessage, isComplete: true,
      completion: .contentProcessed { [weak self, weak downstream] _ in
        guard let self, let downstream else { return }
        self.close(downstream)
      })
  }

  /// Closes an AVPlayer connection; its upstream goes with its last reader.
  private func close(_ downstream: Downstream) {
    guard !downstream.closed else { return }
    downstream.closed = true
    downstream.connection.cancel()
    downstreams.removeValue(forKey: ObjectIdentifier(downstream))
    guard let upstream = downstream.upstream else { return }
    downstream.upstream = nil
    upstream.readers.removeAll { $0 === downstream }
    if upstream.readers.isEmpty {
      cancelTask(of: upstream)
    } else {
      updateBackpressure(upstream)
    }
  }

  private static var now: Int64 { SystemClock.shared.monotonicMs }

  static func token(of url: URL?) -> String {
    guard let url else { return "" }
    let last = url.lastPathComponent
    return last.split(separator: ".").first.map(String.init) ?? last
  }

  /// URLSession delegate (on `queue`).
  private final class Delegate: NSObject, URLSessionDataDelegate {
    weak var proxy: StreamProxy?

    init(proxy: StreamProxy) { self.proxy = proxy }

    func urlSession(
      _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
      completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
      guard let upstream = proxy?.upstreams[dataTask.taskIdentifier],
        proxy?.upstreamResponse(upstream, response) == true
      else { return completionHandler(.cancel) }
      completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
      guard let upstream = proxy?.upstreams[dataTask.taskIdentifier] else { return }
      proxy?.upstreamData(upstream, data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      guard let upstream = proxy?.upstreams.removeValue(forKey: task.taskIdentifier) else { return }
      proxy?.upstreamComplete(upstream, error)
    }
  }
}
