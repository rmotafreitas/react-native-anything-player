import Foundation

#if canImport(FoundationXML)
  import FoundationXML
#endif

/// DASH to HLS, for AVPlayer: a CMAF DASH manifest (fragmented MP4 segments)
/// rewritten as an HLS master playlist and one media playlist per picture,
/// sound and text, whose segments are the manifest's own URLs. AVPlayer
/// fetches them itself; only the playlists are made here. Static (on demand)
/// and dynamic (live) manifests, segments addressed by `SegmentTemplate`
/// (`$Number$` or `$Time$`, with or without a `SegmentTimeline`) or
/// `SegmentList`. `SegmentBase` (a single indexed file) is not supported.
/// Platform-free: unit-tested with `swift test`.
enum DashToHls {
  struct Failure: Error, Equatable {
    let message: String
  }

  /// A media playlist of the converted manifest.
  struct Media: Equatable {
    /// Its file name in the master playlist (`video-<id>.m3u8`).
    let name: String
    let playlist: String
  }

  struct Output: Equatable {
    let master: String
    let media: [Media]
    /// A live manifest: AVPlayer reloads the media playlists, which are made
    /// again from a fresh manifest.
    let live: Bool
  }

  /// Converts the manifest at `url` (its text, `mpd`).
  static func convert(_ mpd: String, url: URL) throws -> Output {
    let root = try XmlNode.parse(mpd)
    guard root.name == "MPD" else { throw Failure(message: "Not a DASH manifest (no <MPD>).") }
    let live = root["type"] == "dynamic"
    let duration = root["mediaPresentationDuration"].flatMap(isoDuration)
    let base = resolve(root.child("BaseURL")?.text, against: url)
    guard let period = root.children("Period").first else { throw Failure(message: "The manifest has no period.") }
    let periodBase = resolve(period.child("BaseURL")?.text, against: base)
    let periodDuration = period["duration"].flatMap(isoDuration) ?? duration

    var media: [Media] = []
    var videos: [(rep: Representation, playlist: String)] = []
    var audios: [(set: XmlNode, rep: Representation, playlist: String)] = []
    var texts: [(set: XmlNode, playlist: String, name: String)] = []
    for set in period.children("AdaptationSet") {
      let setBase = resolve(set.child("BaseURL")?.text, against: periodBase)
      let kind = contentKind(set)
      let reps = set.children("Representation").map { Representation(node: $0, set: set, base: setBase) }
      switch kind {
      case "video":
        for rep in reps {
          let name = "video-\(safe(rep.id)).m3u8"
          media.append(Media(name: name, playlist: try mediaPlaylist(rep, live: live, duration: periodDuration)))
          videos.append((rep, name))
        }
      case "audio":
        // One sound per adaptation set: its best representation (HLS
        // renditions do not switch bitrates within a group).
        guard let rep = reps.max(by: { $0.bandwidth < $1.bandwidth }) else { continue }
        let name = "audio-\(safe(rep.id)).m3u8"
        media.append(Media(name: name, playlist: try mediaPlaylist(rep, live: live, duration: periodDuration)))
        audios.append((set, rep, name))
      case "text":
        // A sidecar WebVTT file (segmented text is not converted).
        guard let rep = reps.first, (rep.mimeType ?? "") == "text/vtt", let file = rep.baseURL else { continue }
        let name = "subtitles-\(safe(rep.id)).m3u8"
        let length = periodDuration ?? 0
        media.append(Media(name: name, playlist: textPlaylist(file, duration: length, live: live)))
        texts.append((set, name, name))
      default:
        continue
      }
    }
    guard !videos.isEmpty || !audios.isEmpty else {
      throw Failure(message: "The manifest has no picture or sound RNAP can convert for AVPlayer.")
    }
    return Output(master: master(videos: videos, audios: audios, texts: texts), media: media, live: live)
  }

  // MARK: - The master playlist

  private static func master(
    videos: [(rep: Representation, playlist: String)],
    audios: [(set: XmlNode, rep: Representation, playlist: String)],
    texts: [(set: XmlNode, playlist: String, name: String)]
  ) -> String {
    var lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for (i, audio) in audios.enumerated() {
      let language = audio.set["lang"] ?? audio.rep.node["lang"]
      var attributes = ["TYPE=AUDIO", "GROUP-ID=\"aud\""]
      attributes.append("NAME=\"\(quoted(label(audio.set) ?? language ?? "Audio \(i + 1)"))\"")
      if let language, language != "und" { attributes.append("LANGUAGE=\"\(quoted(language))\"") }
      attributes.append("DEFAULT=\(i == 0 ? "YES" : "NO")")
      attributes.append("AUTOSELECT=YES")
      if roles(audio.set).contains("description") {
        attributes.append("CHARACTERISTICS=\"public.accessibility.describes-video\"")
      }
      attributes.append("URI=\"\(audio.playlist)\"")
      lines.append("#EXT-X-MEDIA:" + attributes.joined(separator: ","))
    }
    for (i, text) in texts.enumerated() {
      let language = text.set["lang"]
      var attributes = ["TYPE=SUBTITLES", "GROUP-ID=\"subs\""]
      attributes.append("NAME=\"\(quoted(label(text.set) ?? language ?? "Subtitles \(i + 1)"))\"")
      if let language, language != "und" { attributes.append("LANGUAGE=\"\(quoted(language))\"") }
      attributes.append("DEFAULT=NO")
      attributes.append("AUTOSELECT=YES")
      if roles(text.set).contains("forced-subtitle") { attributes.append("FORCED=YES") }
      if roles(text.set).contains("caption") {
        attributes.append("CHARACTERISTICS=\"public.accessibility.transcribes-spoken-dialog\"")
      }
      attributes.append("URI=\"\(text.playlist)\"")
      lines.append("#EXT-X-MEDIA:" + attributes.joined(separator: ","))
    }
    let audioBandwidth = audios.map(\.rep.bandwidth).max() ?? 0
    let audioCodecs = audios.first?.rep.codecs
    if videos.isEmpty {
      // Sound alone: the first sound is the variant.
      if let audio = audios.first {
        var attributes = ["BANDWIDTH=\(audio.rep.bandwidth)"]
        if let codecs = audio.rep.codecs { attributes.append("CODECS=\"\(codecs)\"") }
        lines.append("#EXT-X-STREAM-INF:" + attributes.joined(separator: ","))
        lines.append(audio.playlist)
      }
    }
    for video in videos.sorted(by: { $0.rep.bandwidth < $1.rep.bandwidth }) {
      var attributes = ["BANDWIDTH=\(video.rep.bandwidth + audioBandwidth)"]
      let codecs = [video.rep.codecs, audioCodecs].compactMap { $0 }.joined(separator: ",")
      if !codecs.isEmpty { attributes.append("CODECS=\"\(codecs)\"") }
      if let w = video.rep.width, let h = video.rep.height { attributes.append("RESOLUTION=\(w)x\(h)") }
      if let rate = video.rep.frameRate { attributes.append(String(format: "FRAME-RATE=%.3f", rate)) }
      if !audios.isEmpty { attributes.append("AUDIO=\"aud\"") }
      if !texts.isEmpty { attributes.append("SUBTITLES=\"subs\"") }
      lines.append("#EXT-X-STREAM-INF:" + attributes.joined(separator: ","))
      lines.append(video.playlist)
    }
    return lines.joined(separator: "\n") + "\n"
  }

  // MARK: - Media playlists

  private static func mediaPlaylist(_ rep: Representation, live: Bool, duration: Double?) throws -> String {
    let segments = try rep.segments(duration: duration)
    guard !segments.list.isEmpty else { throw Failure(message: "Representation \(rep.id) lists no segments.") }
    let target = Int(ceil(segments.list.map(\.duration).max() ?? 1))
    var lines = [
      "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:\(max(1, target))",
      "#EXT-X-MEDIA-SEQUENCE:\(segments.firstNumber)", "#EXT-X-INDEPENDENT-SEGMENTS",
    ]
    if !live { lines.append("#EXT-X-PLAYLIST-TYPE:VOD") }
    if let initialization = segments.initialization { lines.append("#EXT-X-MAP:URI=\"\(initialization)\"") }
    for segment in segments.list {
      lines.append(String(format: "#EXTINF:%.3f,", segment.duration))
      lines.append(segment.url)
    }
    if !live { lines.append("#EXT-X-ENDLIST") }
    return lines.joined(separator: "\n") + "\n"
  }

  private static func textPlaylist(_ file: String, duration: Double, live: Bool) -> String {
    let length = max(duration, 1)
    var lines = [
      "#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:\(Int(ceil(length)))", "#EXT-X-MEDIA-SEQUENCE:0",
    ]
    if !live { lines.append("#EXT-X-PLAYLIST-TYPE:VOD") }
    lines.append(String(format: "#EXTINF:%.3f,", length))
    lines.append(file)
    if !live { lines.append("#EXT-X-ENDLIST") }
    return lines.joined(separator: "\n") + "\n"
  }

  // MARK: - Representations

  struct Segment: Equatable {
    let url: String
    let duration: Double
  }

  struct Representation {
    let node: XmlNode
    let set: XmlNode
    let id: String
    let bandwidth: Int
    let codecs: String?
    let mimeType: String?
    let width: Int?
    let height: Int?
    let frameRate: Double?
    /// The representation's own base: segments resolve against it.
    let base: URL
    /// A representation that is one file (`<BaseURL>` and nothing else).
    let baseURL: String?

    init(node: XmlNode, set: XmlNode, base: URL) {
      self.node = node
      self.set = set
      id = node["id"] ?? "0"
      bandwidth = Int(node["bandwidth"] ?? "") ?? 0
      codecs = node["codecs"] ?? set["codecs"]
      mimeType = node["mimeType"] ?? set["mimeType"]
      width = Int(node["width"] ?? set["width"] ?? "")
      height = Int(node["height"] ?? set["height"] ?? "")
      frameRate = (node["frameRate"] ?? set["frameRate"]).flatMap(DashToHls.frameRate)
      let own = node.child("BaseURL")?.text
      let resolved = DashToHls.resolve(own, against: base)
      self.base = resolved
      baseURL = own == nil ? nil : resolved.absoluteString
    }

    func segments(duration: Double?) throws -> (initialization: String?, firstNumber: Int, list: [Segment]) {
      if let template = node.child("SegmentTemplate") ?? set.child("SegmentTemplate") {
        return try templateSegments(template, duration: duration)
      }
      if let list = node.child("SegmentList") ?? set.child("SegmentList") {
        return listSegments(list)
      }
      if node.child("SegmentBase") != nil || set.child("SegmentBase") != nil {
        throw Failure(
          message: "This DASH manifest's files are indexed (SegmentBase); AVPlayer needs segments (SegmentTemplate or SegmentList).")
      }
      throw Failure(message: "Representation \(id) has no segments.")
    }

    private func url(_ template: String, number: Int? = nil, time: Int? = nil) -> String {
      DashToHls.resolve(DashToHls.fill(template, id: id, bandwidth: bandwidth, number: number, time: time), against: base)
        .absoluteString
    }

    private func templateSegments(_ t: XmlNode, duration: Double?) throws
      -> (initialization: String?, firstNumber: Int, list: [Segment])
    {
      let timescale = Double(t["timescale"] ?? "1") ?? 1
      let start = Int(t["startNumber"] ?? "1") ?? 1
      let initialization = t["initialization"].map { url($0) }
      guard let media = t["media"] else { throw Failure(message: "Representation \(id) has no media template.") }
      var list: [Segment] = []
      if let timeline = t.child("SegmentTimeline") {
        var time = 0
        var number = start
        // Addressed by time, a live window slides while `startNumber` stays:
        // HLS's media sequence then counts segments from time zero.
        var first = start
        if !media.contains("$Number"), let s0 = timeline.children("S").first,
          let t0 = Int(s0["t"] ?? ""), let d0 = Int(s0["d"] ?? ""), d0 > 0
        {
          first = t0 / d0
          number = first
        }
        for s in timeline.children("S") {
          if let at = Int(s["t"] ?? "") { time = at }
          let d = Int(s["d"] ?? "") ?? 0
          let repeats = Int(s["r"] ?? "0") ?? 0
          // `r = -1` repeats to the end of the period.
          let count =
            repeats >= 0
            ? repeats + 1
            : max(1, Int(((duration ?? 0) * timescale - Double(time)) / Double(max(d, 1))))
          for _ in 0..<count {
            list.append(Segment(url: url(media, number: number, time: time), duration: Double(d) / timescale))
            time += d
            number += 1
          }
        }
        return (initialization, first, list)
      }
      guard let d = Double(t["duration"] ?? ""), d > 0, let total = duration else {
        throw Failure(message: "Representation \(id) has neither a segment timeline nor a duration.")
      }
      let length = d / timescale
      let count = Int(ceil(total / length - 0.0001))
      for i in 0..<count {
        let last = i == count - 1 ? total - length * Double(i) : length
        list.append(Segment(url: url(media, number: start + i, time: Int(Double(i) * d)), duration: last))
      }
      return (initialization, start, list)
    }

    private func listSegments(_ l: XmlNode) -> (initialization: String?, firstNumber: Int, list: [Segment]) {
      let timescale = Double(l["timescale"] ?? "1") ?? 1
      let d = (Double(l["duration"] ?? "") ?? 0) / timescale
      let initialization = l.child("Initialization")?["sourceURL"].map { url($0) }
      let list = l.children("SegmentURL").compactMap { s in
        s["media"].map { Segment(url: url($0), duration: d) }
      }
      return (initialization, Int(l["startNumber"] ?? "1") ?? 1, list)
    }
  }

  // MARK: - Helpers

  /// `video`, `audio`, `text` or `nil`.
  private static func contentKind(_ set: XmlNode) -> String? {
    if let type = set["contentType"] { return type }
    let mime = set["mimeType"] ?? set.children("Representation").first?["mimeType"] ?? ""
    if mime.hasPrefix("video/") { return "video" }
    if mime.hasPrefix("audio/") { return "audio" }
    if mime.hasPrefix("text/") || mime.contains("ttml") || mime.contains("vtt") { return "text" }
    return nil
  }

  private static func roles(_ set: XmlNode) -> [String] {
    set.children("Role").compactMap { $0["value"] }
  }

  private static func label(_ set: XmlNode) -> String? {
    set["label"] ?? set.child("Label")?.text
  }

  private static func safe(_ id: String) -> String {
    String(id.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
  }

  private static func quoted(_ value: String) -> String {
    value.replacingOccurrences(of: "\"", with: "'")
  }

  static func resolve(_ relative: String?, against base: URL) -> URL {
    guard let relative = relative?.trimmingCharacters(in: .whitespacesAndNewlines), !relative.isEmpty else {
      return base
    }
    return URL(string: relative, relativeTo: base)?.absoluteURL ?? base
  }

  /// `$RepresentationID$`, `$Bandwidth$`, `$Number$`, `$Time$`, with `%0Nd` widths, and `$$`.
  static func fill(_ template: String, id: String, bandwidth: Int, number: Int?, time: Int?) -> String {
    var out = ""
    var rest = Substring(template)
    while let open = rest.firstIndex(of: "$") {
      out += rest[rest.startIndex..<open]
      let afterOpen = rest.index(after: open)
      guard let close = rest[afterOpen...].firstIndex(of: "$") else {
        out += rest[open...]
        return out
      }
      let token = rest[afterOpen..<close]
      rest = rest[rest.index(after: close)...]
      if token.isEmpty {
        out += "$"
        continue
      }
      let parts = token.split(separator: "%", maxSplits: 1)
      let name = String(parts[0])
      let format = parts.count > 1 ? String(parts[1]) : nil
      let value: Int?
      switch name {
      case "RepresentationID":
        out += id
        continue
      case "Bandwidth": value = bandwidth
      case "Number": value = number
      case "Time": value = time
      default:
        out += "$\(token)$"
        continue
      }
      guard let value else { continue }
      if let format, format.hasSuffix("d"), let width = Int(format.dropFirst(format.hasPrefix("0") ? 1 : 0).dropLast()) {
        let digits = String(value)
        out += String(repeating: "0", count: max(0, width - digits.count)) + digits
      } else {
        out += String(value)
      }
    }
    out += rest
    return out
  }

  /// ISO 8601 durations as DASH writes them: `PT1M0.0S`, `P1DT2H`, `PT4.5S`.
  static func isoDuration(_ text: String) -> Double? {
    guard text.hasPrefix("P") else { return nil }
    var seconds = 0.0
    var number = ""
    var inTime = false
    for c in text.dropFirst() {
      switch c {
      case "T": inTime = true
      case "0"..."9", ".": number.append(c)
      default:
        guard let value = Double(number) else { return nil }
        number = ""
        switch (c, inTime) {
        case ("D", false): seconds += value * 86_400
        case ("H", true): seconds += value * 3_600
        case ("M", true): seconds += value * 60
        case ("S", true): seconds += value
        default: return nil
        }
      }
    }
    return number.isEmpty ? seconds : nil
  }

  /// `25`, `30000/1001`.
  static func frameRate(_ text: String) -> Double? {
    let parts = text.split(separator: "/")
    guard let first = parts.first, let n = Double(first) else { return nil }
    if parts.count == 2, let d = Double(parts[1]), d > 0 { return n / d }
    return n
  }
}

/// A minimal XML tree (elements, attributes, text) for the manifest.
final class XmlNode {
  let name: String
  let attributes: [String: String]
  private(set) var children: [XmlNode] = []
  fileprivate(set) var text = ""

  init(name: String, attributes: [String: String]) {
    self.name = name
    self.attributes = attributes
  }

  subscript(key: String) -> String? { attributes[key] }

  func child(_ name: String) -> XmlNode? { children.first { $0.name == name } }

  func children(_ name: String) -> [XmlNode] { children.filter { $0.name == name } }

  fileprivate func append(_ node: XmlNode) { children.append(node) }

  static func parse(_ text: String) throws -> XmlNode {
    let builder = Builder()
    let parser = XMLParser(data: Data(text.utf8))
    parser.delegate = builder
    guard parser.parse(), let root = builder.root else {
      throw DashToHls.Failure(message: "The DASH manifest is not valid XML.")
    }
    return root
  }

  private final class Builder: NSObject, XMLParserDelegate {
    var root: XmlNode?
    var stack: [XmlNode] = []

    func parser(
      _ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName: String?,
      attributes: [String: String] = [:]
    ) {
      // Namespaced names (`cenc:pssh`) keep their local part.
      let local = elementName.split(separator: ":").last.map(String.init) ?? elementName
      let node = XmlNode(name: local, attributes: attributes)
      stack.last?.append(node)
      if root == nil { root = node }
      stack.append(node)
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) {
      stack.last?.text += string
    }

    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName: String?) {
      if let node = stack.popLast() { node.text = node.text.trimmingCharacters(in: .whitespacesAndNewlines) }
    }
  }
}
