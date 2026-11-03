import Foundation

#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

/// A file AVPlayer cannot read (Matroska, WebM, MPEG-TS), served to it as
/// HLS through the stream proxy (`StreamProxy.registerRemux`): the playlists
/// made from the file's tracks, Cues and duration, and each segment remuxed
/// (`Remuxer`, `RemuxHls`) when AVPlayer asks for it. Nothing is decoded.
///
/// - On demand (a length and range requests, or a local file): the head of
///   the file gives the tracks, the Cues (read from where the SeekHead says)
///   or, for TS, the tail its duration. A window is read from a Cues entry,
///   else from the bitrate's guess, again from earlier when it lands late;
///   its bytes are kept a little, for the other renditions of the window.
/// - Live (no length): the stream is read as it comes, every rendition
///   remuxed and cut into a sliding playlist (`LiveSegmenter`); a dropped
///   connection is reopened (the remuxer carries the timeline over a jump).
///
/// Threading: everything runs on `queue`; `serve` answers on it.
final class RemuxSession {
  struct Response {
    let status: Int
    let contentType: String
    let body: Data

    static func text(_ text: String, _ type: String) -> Response {
      Response(status: 200, contentType: type, body: Data(text.utf8))
    }

    static func media(_ bytes: [UInt8]) -> Response {
      Response(status: 200, contentType: "video/mp4", body: Data(bytes))
    }

    static let missing = Response(status: 404, contentType: "text/plain", body: Data())
    static let unavailable = Response(status: 503, contentType: "text/plain", body: Data())
  }

  /// The container a URL's extension names, if RNAP remuxes it.
  static func format(of url: URL) -> Remuxer.Format? {
    switch url.pathExtension.lowercased() {
    case "mkv", "mk3d", "mka", "webm": return .matroska
    case "ts", "m2ts", "mts", "m2t", "tsv", "mpegts": return .mpegts
    default: return nil
    }
  }

  /// The container the first bytes show (Matroska's EBML magic, TS sync bytes).
  static func sniff(_ bytes: [UInt8]) -> Remuxer.Format? {
    if bytes.count >= 4 && Bytes.readUint(bytes, 0, 4) == 0x1A45_DFA3 { return .matroska }
    for size in [188, 192] {
      let lead = size - 188
      var i = 0
      while i < size && i + lead + 2 * size < bytes.count {
        let p = i + lead
        if bytes[p] == 0x47 && bytes[p + size] == 0x47 && bytes[p + 2 * size] == 0x47 { return .mpegts }
        i += 1
      }
    }
    return nil
  }

  let queue = DispatchQueue(label: "anythingplayer.remux")
  private let url: URL
  private let headers: [String: String]
  private var format: Remuxer.Format?
  private let lock = NSLock()
  private var failureValue: PlayerError?
  private var closed = false

  /// Why the file could not be served, if it could not: the item fails, and
  /// the driver reports this instead of AVFoundation's generic error. Any thread.
  var failure: PlayerError? { lock.sync { failureValue } }

  private static let headBytes = 2 * 1024 * 1024
  private static let tailBytes = 512 * 1024
  private static let maxCuesBytes = 8 * 1024 * 1024
  private static let maxTries = 4
  /// Window bytes kept for the other renditions of a window.
  private static let keptChunks = 4
  /// How long a playlist request waits for the session to be ready.
  private static let readyTimeout: TimeInterval = 20

  // On demand.
  private struct Plan {
    let format: Remuxer.Format
    let size: Int
    let duration: Double
    /// Bytes before the first cluster (Matroska), pushed before each window's.
    let head: [UInt8]
    let timeBase: Int?
    let cues: [CuePoint]
    let video: RemuxTrack?
    let audios: [RemuxTrack]
    let defaultAudio: Int?
    let texts: [RemuxTrack]
    let windows: [RemuxHls.Window]
    let master: String
  }

  private enum State {
    case starting
    case ready(Plan)
    case live(Live)
    case failed
  }

  private var state = State.starting
  private var waiting: [(file: String, done: (Response) -> Void)] = []
  private var chunks: [(offset: Int, bytes: [UInt8])] = []
  /// Windows being read: their requests wait for the one read.
  private var inFlight: [String: [(RemuxHls.WindowReader?) -> Void]] = [:]
  private var cache: [String: RemuxHls.WindowReader] = [:]
  private var cacheOrder: [String] = []

  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.default
    config.timeoutIntervalForRequest = 20
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.urlCache = nil
    let operations = OperationQueue()
    operations.underlyingQueue = queue
    operations.maxConcurrentOperationCount = 1
    return URLSession(configuration: config, delegate: delegate, delegateQueue: operations)
  }()
  private let delegate = Delegate()

  init(url: URL, headers: [String: String], format: Remuxer.Format?) {
    self.url = url
    self.headers = headers
    self.format = format
    queue.async { self.start() }
  }

  /// Stops reading (the item is gone).
  func close() {
    queue.async {
      self.closed = true
      self.live?.task?.cancel()
      self.delegate.cancelAll()
      self.session.invalidateAndCancel()
      for request in self.waiting { request.done(.missing) }
      self.waiting = []
    }
  }

  /// Answers AVPlayer's request for `file` (a playlist or a segment), on `queue`.
  func serve(_ file: String, done: @escaping (Response) -> Void) {
    queue.async {
      switch self.state {
      case .starting:
        self.waiting.append((file, done))
        self.queue.asyncAfter(deadline: .now() + Self.readyTimeout) { [weak self] in
          guard let self, case .starting = self.state else { return }
          let late = self.waiting
          self.waiting = []
          for request in late { request.done(.unavailable) }
        }
      case .ready(let plan): self.serveOnDemand(file, plan, done)
      case .live(let live): self.serveLive(file, live, done)
      case .failed: done(.missing)
      }
    }
  }

  private func fail(_ error: PlayerError) {
    lock.sync { if failureValue == nil { failureValue = error } }
    state = .failed
    let late = waiting
    waiting = []
    for request in late { request.done(.missing) }
  }

  private func becomeReady(_ state: State) {
    self.state = state
    let pending = waiting
    waiting = []
    for request in pending { serve(request.file, done: request.done) }
  }

  // MARK: - Bytes

  private static func error(status: Int) -> PlayerError {
    let missing = status == 404 || status == 410
    var failure = PlayerError.code(
      missing ? .sourceNotFound : .httpError, "The server returned HTTP \(status).",
      recoverable: status >= 500 || status == 429 || status == 408)
    failure.httpStatus = status
    return failure
  }

  private static func networkError(_ error: Error) -> PlayerError {
    .code(.networkError, "The file could not be read (\(error.localizedDescription)).", recoverable: true)
  }

  /// Bytes `from..<to` (to the end when `to` is nil). A local file is read directly.
  private func read(
    _ from: Int, _ to: Int?, _ done: @escaping (Result<(bytes: [UInt8], total: Int?, ranged: Bool), PlayerError>) -> Void
  ) {
    if url.isFileURL {
      queue.async {
        do {
          let handle = try FileHandle(forReadingFrom: self.url)
          defer { try? handle.close() }
          let total = Int(try handle.seekToEnd())
          try handle.seek(toOffset: UInt64(min(from, total)))
          let count = max(0, min(to ?? total, total) - from)
          let data = try handle.read(upToCount: count) ?? Data()
          done(.success(([UInt8](data), total, true)))
        } catch {
          done(.failure(.code(.sourceNotFound, "The file could not be read (\(error.localizedDescription)).", recoverable: false)))
        }
      }
      return
    }
    var request = URLRequest(url: url)
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    request.setValue("bytes=\(from)-\(to.map { String($0 - 1) } ?? "")", forHTTPHeaderField: "Range")
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    let task = session.dataTask(with: request)
    var collected: [UInt8] = []
    var total: Int?
    var ranged = false
    delegate.handlers[task.taskIdentifier] = Delegate.Handlers(
      response: { response in
        guard let http = response as? HTTPURLResponse else { return false }
        guard (200..<300).contains(http.statusCode) else {
          done(.failure(Self.error(status: http.statusCode)))
          return false
        }
        ranged = http.statusCode == 206
        let range = http.value(forHTTPHeaderField: "Content-Range")
        if let slash = range?.lastIndex(of: "/"), let size = Int(range![range!.index(after: slash)...]) {
          total = size
        } else if !ranged, http.expectedContentLength > 0 {
          total = Int(http.expectedContentLength)
        }
        // A file that ignores the range (or a stream) is not read to the end here.
        if !ranged && from > 0 {
          done(.failure(.code(.unsupportedFormat, "The server does not answer range requests.", recoverable: false)))
          return false
        }
        return true
      },
      data: { data in
        collected += data
        // A live stream (or a server that ignored the range) has no end: stop at what was asked.
        if let to, collected.count >= to - from {
          collected = Array(collected.prefix(to - from))
          return false
        }
        return true
      },
      complete: { error in
        if let error, (error as NSError).code != NSURLErrorCancelled {
          done(.failure(Self.networkError(error)))
        } else {
          done(.success((collected, total, ranged)))
        }
      })
    task.resume()
  }

  /// Window bytes, from those kept when they hold them.
  private func chunk(_ from: Int, _ length: Int, _ done: @escaping (Result<[UInt8], PlayerError>) -> Void) {
    if let kept = chunks.first(where: { $0.offset <= from && $0.offset + $0.bytes.count >= from + length }) {
      let start = from - kept.offset
      return done(.success(Array(kept.bytes[start..<(start + length)])))
    }
    read(from, from + length) { [weak self] result in
      guard let self else { return }
      if case .success(let read) = result {
        self.chunks.append((from, read.bytes))
        if self.chunks.count > Self.keptChunks { self.chunks.removeFirst() }
      }
      done(result.map(\.bytes))
    }
  }

  // MARK: - Start

  private func start() {
    if !url.isFileURL && !["http", "https"].contains(url.scheme?.lowercased() ?? "") {
      return fail(.code(.unsupportedFormat, "Only http(s) and file URLs can be remuxed.", recoverable: false))
    }
    if url.isFileURL {
      read(0, Self.headBytes) { [weak self] result in self?.headRead(result) }
    } else {
      openStream()
    }
  }

  /// The first request: a range from zero. A file answers 206 (or 200 with a
  /// length); a live stream 200 without one, and keeps streaming here.
  private func openStream() {
    var request = URLRequest(url: url)
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    request.setValue("bytes=0-", forHTTPHeaderField: "Range")
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    let task = session.dataTask(with: request)
    var head: [UInt8] = []
    var total: Int?
    var ranged = false
    var live: Live?
    delegate.handlers[task.taskIdentifier] = Delegate.Handlers(
      response: { [weak self] response in
        guard let self, let http = response as? HTTPURLResponse else { return false }
        guard (200..<300).contains(http.statusCode) else {
          self.fail(Self.error(status: http.statusCode))
          return false
        }
        ranged = http.statusCode == 206
        if let range = http.value(forHTTPHeaderField: "Content-Range"), let slash = range.lastIndex(of: "/") {
          total = Int(range[range.index(after: slash)...])
        } else if http.expectedContentLength > 0 {
          total = Int(http.expectedContentLength)
        }
        if total == nil {
          live = Live(owner: self)
          self.live = live
          live!.task = task
        }
        return true
      },
      data: { [weak self] data in
        guard self != nil else { return false }
        if let live { return live.feed([UInt8](data)) }
        head += data
        return head.count < RemuxSession.headBytes
      },
      complete: { [weak self] error in
        guard let self else { return }
        if let live {
          live.ended(error)
          return
        }
        if let error, (error as NSError).code != NSURLErrorCancelled, head.isEmpty {
          return self.fail(Self.networkError(error))
        }
        guard ranged || (total ?? 0) <= head.count else {
          return self.fail(
            .code(
              .unsupportedFormat, "The server does not answer range requests, which RNAP needs to remux this file.",
              recoverable: false))
        }
        self.headRead(.success((head, total, ranged)))
      })
    task.resume()
  }

  private func headRead(_ result: Result<(bytes: [UInt8], total: Int?, ranged: Bool), PlayerError>) {
    guard !closed else { return }
    let head: [UInt8]
    let size: Int
    switch result {
    case .failure(let error): return fail(error)
    case .success(let read):
      head = read.bytes
      size = read.total ?? read.bytes.count
    }
    guard let format = format ?? Self.sniff(head) else {
      return fail(.code(.unsupportedFormat, "The file is neither Matroska nor MPEG-TS.", recoverable: false))
    }
    self.format = format
    let probe = Remuxer(format: format)
    _ = probe.push(head)
    if probe.muxed == nil { _ = probe.end() }
    if let failure = probe.failure { return fail(.code(.unsupportedFormat, "The file has \(failure).", recoverable: false)) }
    if let demuxer = probe.matroska, demuxer.cues.isEmpty, let offset = demuxer.cuesOffset, offset < size {
      read(offset, min(size, offset + Self.maxCuesBytes)) { [weak self] result in
        if case .success(let read) = result { _ = demuxer.readCuesElement(read.bytes) }
        self?.plan(probe, head: head, size: size)
      }
    } else {
      plan(probe, head: head, size: size)
    }
  }

  private func plan(_ probe: Remuxer, head: [UInt8], size: Int) {
    guard !closed else { return }
    let tracks = probe.tracks
    let video = tracks.first { $0.kind == .video && $0.playable }
    let audios = tracks.filter { $0.kind == .audio && $0.playable }
    let texts = tracks.filter { $0.kind == .text && $0.unsupported == nil && $0.codec != nil }
    let defaultAudio = probe.muxed?.first { $0.kind == .audio }?.id ?? audios.first?.id
    let finish = { [weak self] (duration: Double?) in
      guard let self, !self.closed else { return }
      guard let duration, duration > 0 else {
        return self.fail(.code(.unsupportedFormat, "The file's duration could not be read.", recoverable: false))
      }
      let demuxer = probe.matroska
      let windows = RemuxHls.windows(duration: duration)
      let master = RemuxHls.master(
        video: video, audios: audios, defaultAudio: defaultAudio, texts: texts,
        bandwidth: Int(Double(size) * 8 / duration))
      let firstCluster = demuxer?.firstCluster ?? 0
      self.becomeReady(
        .ready(
          Plan(
            format: probe.format, size: size, duration: duration,
            head: demuxer != nil ? Array(head.prefix(firstCluster)) : [], timeBase: probe.timeBase,
            cues: demuxer?.cues ?? [], video: video, audios: audios, defaultAudio: defaultAudio, texts: texts,
            windows: windows, master: master)))
    }
    if let demuxer = probe.matroska {
      let fromCues = demuxer.cues.last.map { Double($0.time) / 1000 + RemuxHls.target }
      return finish(demuxer.duration.map { Double($0) / 1000 } ?? fromCues)
    }
    // TS: the duration is the last timestamp's distance from the first keyframe.
    guard let base = probe.timeBase else { return finish(nil) }
    let pid = (video ?? audios.first)?.id
    read(max(0, size - Self.tailBytes), size) { result in
      guard case .success(let read) = result, var last = TsDemuxer.lastTimestamp(read.bytes, pid: pid) else {
        return finish(nil)
      }
      while last < base { last += 1 << 33 }
      finish(Double(last - base) / 90000)
    }
  }

  // MARK: - On demand

  private func serveOnDemand(_ file: String, _ plan: Plan, _ done: @escaping (Response) -> Void) {
    let mpegurl = "application/vnd.apple.mpegurl"
    if file == "master.m3u8" { return done(.text(plan.master, mpegurl)) }
    let tracks = [plan.video].compactMap { $0 } + plan.audios + plan.texts
    for track in tracks {
      let name = RemuxHls.name(track)
      let text = track.kind == .text
      if file == "\(name).m3u8" {
        return done(.text(RemuxHls.mediaPlaylist(name: name, windows: plan.windows, ext: text ? "vtt" : "m4s"), mpegurl))
      }
      if file == "\(name)-init.mp4" && !text { return done(.media(Mp4Writer.initSegment([track]))) }
      let ext = text ? ".vtt" : ".m4s"
      guard file.hasPrefix(name + "-"), file.hasSuffix(ext),
        let index = Int(file.dropFirst(name.count + 1).dropLast(ext.count)),
        index >= 0, index < plan.windows.count
      else { continue }
      let window = plan.windows[index]
      if text {
        // The subtitles come out of the picture's read (or the sound's, without one).
        let source = plan.video ?? plan.audios.first { $0.id == plan.defaultAudio }
        guard let source else { return done(.missing) }
        return windowReader(plan, window, track: source) { reader in
          let cues = reader?.cues.filter { $0.track == track.id } ?? []
          done(.text(RemuxHls.vtt(cues, codec: track.codec), "text/vtt"))
        }
      }
      return windowReader(plan, window, track: track) { reader in
        guard let reader, !reader.fragments.isEmpty else { return done(.missing) }
        done(.media(Array(reader.fragments.joined())))
      }
    }
    done(.missing)
  }

  /// The window read for one rendition (cached, and shared by requests that come together).
  private func windowReader(
    _ plan: Plan, _ window: RemuxHls.Window, track: RemuxTrack, _ done: @escaping (RemuxHls.WindowReader?) -> Void
  ) {
    let key = "\(RemuxHls.name(track))-\(window.index)"
    if let cached = cache[key] { return done(cached) }
    if inFlight[key] != nil {
      inFlight[key]!.append(done)
      return
    }
    inFlight[key] = [done]
    let finish = { [weak self] (reader: RemuxHls.WindowReader?) in
      guard let self else { return }
      if let reader {
        self.cache[key] = reader
        self.cacheOrder.append(key)
        if self.cacheOrder.count > 8 { self.cache[self.cacheOrder.removeFirst()] = nil }
      }
      let callbacks = self.inFlight.removeValue(forKey: key) ?? []
      for callback in callbacks { callback(reader) }
    }
    attempt(plan, window, track: track, offset: initialOffset(plan, window), tries: 0, finish)
  }

  private func perSecond(_ plan: Plan) -> Double { Double(plan.size) / plan.duration }

  /// Where a window's read starts: the last Cues entry at or before it, else
  /// two seconds before it by the bitrate.
  private func initialOffset(_ plan: Plan, _ window: RemuxHls.Window) -> Int {
    let floor = plan.head.count
    if window.index == 0 { return plan.format == .matroska ? floor : 0 }
    if let cue = plan.cues.last(where: { Double($0.time) / 1000 <= window.start + 1e-6 }) { return cue.offset }
    let guess = Int((window.start - 2) * perSecond(plan))
    return max(floor, guess / 188 * 188)
  }

  private func attempt(
    _ plan: Plan, _ window: RemuxHls.Window, track: RemuxTrack, offset: Int, tries: Int,
    _ done: @escaping (RemuxHls.WindowReader?) -> Void
  ) {
    let choice = Remuxer.Choice(video: track.kind == .video ? track.id : nil, audio: track.kind == .audio ? track.id : nil)
    let remuxer = Remuxer(format: plan.format, choose: { _ in choice }, timeBase: plan.timeBase)
    if !plan.head.isEmpty { _ = remuxer.push(plan.head) }
    remuxer.seek(offset)
    let fromStart = offset <= plan.head.count
    let reader = RemuxHls.WindowReader(remuxer: remuxer, window: window, fromStart: fromStart)
    let step = max(512 * 1024, Int(perSecond(plan) * RemuxHls.target * 1.5))
    func next(_ at: Int) {
      guard !closed else { return done(nil) }
      let length = min(step, plan.size - at)
      let status: RemuxHls.WindowReader.Status
      if length <= 0 {
        status = reader.end()
        return handle(status)
      }
      chunk(at, length) { result in
        switch result {
        case .failure:
          done(nil)
        case .success(let bytes):
          let status = bytes.isEmpty ? reader.end() : reader.push(bytes)
          if status == .needMore { return next(at + bytes.count) }
          handle(status)
        }
      }
    }
    func handle(_ status: RemuxHls.WindowReader.Status) {
      if case .late(let landed) = status, tries < Self.maxTries, !fromStart {
        let back = Int((landed - window.start + 2 * Double(tries + 1)) * perSecond(plan))
        let earlier = max(plan.head.count, (offset - back) / 188 * 188)
        return attempt(plan, window, track: track, offset: earlier, tries: tries + 1, done)
      }
      done(reader)
    }
    next(offset)
  }

  // MARK: - Live

  private var live: Live?

  /// A live stream: every rendition remuxed as the bytes come, and cut into
  /// segments; the playlists list the last few.
  final class Live {
    private unowned let owner: RemuxSession
    var task: URLSessionDataTask?
    /// Bytes read before the tracks were known: every rendition starts from them.
    private var early: [UInt8] = []
    private var probe: Remuxer?
    private var renditions: [(track: RemuxTrack, remuxer: Remuxer, segmenter: RemuxHls.LiveSegmenter)] = []
    private var master: String?
    private var reconnects = 0
    private var received = false

    init(owner: RemuxSession) { self.owner = owner }

    /// Bytes of the stream; `false` to stop reading.
    func feed(_ bytes: [UInt8]) -> Bool {
      received = true
      reconnects = 0
      if renditions.isEmpty {
        early += bytes
        if probe == nil {
          guard early.count >= 3 * 192 + 4 else { return true }
          guard let format = owner.format ?? RemuxSession.sniff(early) else {
            owner.fail(.code(.unsupportedFormat, "The stream is neither Matroska nor MPEG-TS.", recoverable: false))
            return false
          }
          owner.format = format
          probe = Remuxer(format: format)
          _ = probe!.push(early)
        } else {
          _ = probe!.push(bytes)
        }
        guard let probe, probe.muxed != nil, probe.timeBase != nil || probe.format == .matroska else {
          if let failure = probe?.failure {
            owner.fail(.code(.unsupportedFormat, "The stream has \(failure).", recoverable: false))
            return false
          }
          // Give up waiting for the tracks after 16 MB.
          return early.count < 16 * 1024 * 1024
        }
        start(probe)
        return true
      }
      for rendition in renditions { absorb(rendition, rendition.remuxer.push(bytes)) }
      if master == nil, renditions.allSatisfy({ !$0.segmenter.segments.isEmpty }) { ready() }
      return true
    }

    private func start(_ probe: Remuxer) {
      let tracks = probe.tracks
      let video = tracks.first { $0.kind == .video && $0.playable }
      let audios = tracks.filter { $0.kind == .audio && $0.playable }
      for track in [video].compactMap({ $0 }) + audios {
        let choice = Remuxer.Choice(video: track.kind == .video ? track.id : nil, audio: track.kind == .audio ? track.id : nil)
        let remuxer = Remuxer(format: probe.format, choose: { _ in choice }, timeBase: probe.timeBase)
        let rendition = (track: track, remuxer: remuxer, segmenter: RemuxHls.LiveSegmenter())
        renditions.append(rendition)
        absorb(rendition, remuxer.push(early))
      }
      early = []
      self.probe = nil
    }

    private func absorb(
      _ rendition: (track: RemuxTrack, remuxer: Remuxer, segmenter: RemuxHls.LiveSegmenter), _ out: Remuxer.Output
    ) {
      let timescales = rendition.remuxer.muxed?.map(\.timescale) ?? []
      for segment in out.segments {
        if let start = RemuxHls.fragmentStart(segment, timescales: timescales) {
          rendition.segmenter.add(fragment: segment, start: start)
        } else {
          rendition.segmenter.add(init: segment)
        }
      }
    }

    private func ready() {
      let video = renditions.first { $0.track.kind == .video }?.track
      let audios = renditions.filter { $0.track.kind == .audio }.map(\.track)
      master = RemuxHls.master(
        video: video, audios: audios, defaultAudio: audios.first?.id, texts: [], bandwidth: 3_000_000)
      owner.becomeReady(.live(self))
    }

    func serve(_ file: String, _ done: (Response) -> Void) {
      let mpegurl = "application/vnd.apple.mpegurl"
      if file == "master.m3u8", let master { return done(.text(master, mpegurl)) }
      for rendition in renditions {
        let name = RemuxHls.name(rendition.track)
        let segmenter = rendition.segmenter
        if file == "\(name).m3u8" {
          return done(segmenter.playlist(name: name).map { .text($0, mpegurl) } ?? .unavailable)
        }
        if file.hasPrefix("\(name)-init-"), let index = Int(file.dropFirst(name.count + 6).dropLast(4)),
          index >= 0, index < segmenter.inits.count
        {
          return done(.media(segmenter.inits[index]))
        }
        if file.hasPrefix(name + "-"), file.hasSuffix(".m4s"),
          let sequence = Int(file.dropFirst(name.count + 1).dropLast(4)), let segment = segmenter.segment(sequence)
        {
          return done(.media(segment.data))
        }
      }
      done(.missing)
    }

    /// The connection ended: reopened after a pause that grows, up to five tries in a row.
    func ended(_ error: Error?) {
      task = nil
      guard !owner.closed else { return }
      if !received && renditions.isEmpty {
        return owner.fail(error.map(RemuxSession.networkError) ?? .code(.streamEnded, "The stream ended.", recoverable: true))
      }
      reconnects += 1
      guard reconnects <= 5 else {
        return owner.fail(.code(.networkError, "The stream could not be reached again.", recoverable: true))
      }
      // A new connection starts mid-packet: the demuxers resync, the timeline goes on.
      for rendition in renditions { rendition.remuxer.reconnected() }
      let delay = Double(1 << min(reconnects - 1, 4))
      owner.queue.asyncAfter(deadline: .now() + delay) { [weak self] in
        guard let self, !self.owner.closed else { return }
        self.owner.reopen(self)
      }
    }
  }

  private func serveLive(_ file: String, _ live: Live, _ done: @escaping (Response) -> Void) {
    live.serve(file, done)
  }

  /// A new connection for a live stream that dropped.
  private func reopen(_ live: Live) {
    var request = URLRequest(url: url)
    for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    let task = session.dataTask(with: request)
    live.task = task
    delegate.handlers[task.taskIdentifier] = Delegate.Handlers(
      response: { response in
        guard let http = response as? HTTPURLResponse else { return false }
        return (200..<300).contains(http.statusCode)
      },
      data: { data in live.feed([UInt8](data)) },
      complete: { error in live.ended(error) })
    task.resume()
  }

  // MARK: - URLSession

  /// The session's delegate (on `queue`): each task's handlers.
  private final class Delegate: NSObject, URLSessionDataDelegate {
    struct Handlers {
      /// `false` cancels the task (its `complete` still runs).
      let response: (URLResponse) -> Bool
      /// `false` cancels the task.
      let data: (Data) -> Bool
      let complete: (Error?) -> Void
    }

    var handlers: [Int: Handlers] = [:]
    private var tasks: [Int: URLSessionTask] = [:]

    func cancelAll() {
      for task in tasks.values { task.cancel() }
      tasks = [:]
    }

    func urlSession(
      _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
      completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
      tasks[dataTask.taskIdentifier] = dataTask
      let keep = handlers[dataTask.taskIdentifier]?.response(response) ?? false
      completionHandler(keep ? .allow : .cancel)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
      guard let handler = handlers[dataTask.taskIdentifier] else { return dataTask.cancel() }
      if !handler.data(data) { dataTask.cancel() }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      tasks[task.taskIdentifier] = nil
      guard let handler = handlers.removeValue(forKey: task.taskIdentifier) else { return }
      handler.complete(error)
    }
  }
}
