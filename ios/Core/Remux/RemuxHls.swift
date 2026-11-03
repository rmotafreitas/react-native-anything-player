import Foundation

/// HLS for AVPlayer from a file it cannot read (Matroska, WebM, MPEG-TS),
/// remuxed segment by segment as AVPlayer asks for them. Platform-free; the
/// serving is `RemuxSession` (Platform/).
///
/// - On demand, the timeline is cut in windows of `target` seconds. Window
///   *i* holds every keyframe group (a fragment) that starts inside it, so
///   the windows hold each group once, with no gap, from wherever each one
///   is read. Its picture comes from one remux of the bytes from just before
///   the window (a Cues entry, or the bitrate's guess) up to the next
///   window's first keyframe; a guess that lands inside the window is read
///   again from earlier (`WindowReader` says so). Its sound, per language,
///   from an audio-only remux of the same bytes, cut on a grid of seconds;
///   its subtitles are the file's cues that start inside it, as WebVTT.
/// - A live stream (no length) is cut as it arrives (`LiveSegmenter`): a
///   segment closes at the first keyframe `target` seconds after its start.
///
/// The video is one playlist, each audio track and each subtitle track one
/// rendition: AVPlayer offers them as its media selection options, as for
/// any HLS source.
enum RemuxHls {
  /// Seconds of a segment.
  static let target = 6.0

  struct Window: Equatable {
    let index: Int
    /// Seconds.
    let start: Double
    let end: Double
    /// The last window: it holds everything from its start (a sound that runs past the picture).
    var last = false
  }

  /// The windows of a file `duration` seconds long (a remainder under half a
  /// window joins the last one: a sliver could hold no keyframe at all).
  static func windows(duration: Double, target: Double = target) -> [Window] {
    guard duration > 0 else { return [] }
    var count = Int((duration / target).rounded(.up))
    if count > 1 && duration - Double(count - 1) * target < target / 2 { count -= 1 }
    var windows: [Window] = []
    for i in 0..<count {
      let start = Double(i) * target
      let end: Double = i == count - 1 ? duration : start + target
      windows.append(Window(index: i, start: start, end: end, last: i == count - 1))
    }
    return windows
  }

  // MARK: - Playlists

  /// What a rendition is called in the playlists and its URLs.
  static func name(_ track: RemuxTrack) -> String {
    switch track.kind {
    case .video: return "video"
    case .audio: return "audio-\(track.id)"
    case .text: return "subs-\(track.id)"
    }
  }

  private static func quoted(_ text: String) -> String {
    "\"" + text.replacingOccurrences(of: "\"", with: "'").replacingOccurrences(of: "\n", with: " ") + "\""
  }

  /// The labels of a group's renditions: their names, else their languages, made unique.
  private static func labels(_ tracks: [RemuxTrack]) -> [String] {
    var seen: [String: Int] = [:]
    return tracks.enumerated().map { i, t in
      let base = t.name ?? t.language ?? "Track \(i + 1)"
      let count = (seen[base] ?? 0) + 1
      seen[base] = count
      return count == 1 ? base : "\(base) (\(count))"
    }
  }

  /// The master playlist: the picture (or the default sound, with no picture),
  /// the sounds and the subtitles as renditions.
  static func master(
    video: RemuxTrack?, audios: [RemuxTrack], defaultAudio: Int?, texts: [RemuxTrack], bandwidth: Int
  ) -> String {
    var lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"]
    for (track, label) in zip(audios, labels(audios)) {
      var attributes = [
        "TYPE=AUDIO", "GROUP-ID=\"audio\"", "NAME=\(quoted(label))",
      ]
      if let language = track.language { attributes.append("LANGUAGE=\(quoted(language))") }
      attributes.append("DEFAULT=\(track.id == defaultAudio ? "YES" : "NO")")
      attributes.append("AUTOSELECT=YES")
      if track.channels > 0 { attributes.append("CHANNELS=\"\(track.channels)\"") }
      attributes.append("URI=\(quoted(name(track) + ".m3u8"))")
      lines.append("#EXT-X-MEDIA:" + attributes.joined(separator: ","))
    }
    for (track, label) in zip(texts, labels(texts)) {
      var attributes = [
        "TYPE=SUBTITLES", "GROUP-ID=\"subs\"", "NAME=\(quoted(label))",
      ]
      if let language = track.language { attributes.append("LANGUAGE=\(quoted(language))") }
      attributes.append("DEFAULT=NO")
      attributes.append("AUTOSELECT=YES")
      attributes.append("FORCED=\(track.forced ? "YES" : "NO")")
      attributes.append("URI=\(quoted(name(track) + ".m3u8"))")
      lines.append("#EXT-X-MEDIA:" + attributes.joined(separator: ","))
    }
    var codecs: [String] = []
    if let codec = video?.codec { codecs.append(codec) }
    for track in audios { if let codec = track.codec, !codecs.contains(codec) { codecs.append(codec) } }
    var stream = ["BANDWIDTH=\(max(1, bandwidth))", "CODECS=\(quoted(codecs.joined(separator: ",")))"]
    if let video, video.width > 0, video.height > 0 {
      stream.append("RESOLUTION=\(Mp4Writer.displayWidth(video))x\(video.height)")
    }
    if !audios.isEmpty { stream.append("AUDIO=\"audio\"") }
    if !texts.isEmpty { stream.append("SUBTITLES=\"subs\"") }
    lines.append("#EXT-X-STREAM-INF:" + stream.joined(separator: ","))
    let main = video ?? audios.first { $0.id == defaultAudio } ?? audios.first
    lines.append(main.map { name($0) + ".m3u8" } ?? "video.m3u8")
    return lines.joined(separator: "\n") + "\n"
  }

  /// An on-demand media playlist: one segment per window (`<name>-<i>.<ext>`),
  /// after the init segment (`<name>-init.mp4`) for fragmented MP4.
  static func mediaPlaylist(name: String, windows: [Window], ext: String) -> String {
    let longest = windows.map { $0.end - $0.start }.max() ?? target
    // A window's keyframe groups can run past its end: room for one more group.
    let targetDuration = Int((longest * 2).rounded(.up))
    var lines = [
      "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:\(targetDuration)", "#EXT-X-MEDIA-SEQUENCE:0",
      "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-INDEPENDENT-SEGMENTS",
    ]
    if ext == "m4s" { lines.append("#EXT-X-MAP:URI=\"\(name)-init.mp4\"") }
    for window in windows {
      lines.append(String(format: "#EXTINF:%.3f,", window.end - window.start))
      lines.append("\(name)-\(window.index).\(ext)")
    }
    lines.append("#EXT-X-ENDLIST")
    return lines.joined(separator: "\n") + "\n"
  }

  // MARK: - Subtitles

  /// `HH:MM:SS.mmm`.
  static func clock(_ ms: Int) -> String {
    let ms = max(0, ms)
    return String(format: "%02d:%02d:%02d.%03d", ms / 3_600_000, ms / 60000 % 60, ms / 1000 % 60, ms % 1000)
  }

  private static func escape(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
  }

  /// SubRip text as WebVTT cue text: `<b>`, `<i>`, `<u>` kept, other tags dropped.
  static func srtText(_ text: String) -> String {
    var out = ""
    var rest = Substring(text.replacingOccurrences(of: "\r\n", with: "\n"))
    while let open = rest.firstIndex(of: "<") {
      out += escape(String(rest[..<open]))
      guard let close = rest[open...].firstIndex(of: ">") else {
        out += escape(String(rest[open...]))
        rest = ""
        break
      }
      let tag = rest[rest.index(after: open)..<close].lowercased()
      if ["b", "i", "u", "/b", "/i", "/u"].contains(tag) { out += "<\(tag)>" }
      rest = rest[rest.index(after: close)...]
    }
    out += escape(String(rest))
    return out.replacingOccurrences(of: #"\{\\[^}]*\}"#, with: "", options: .regularExpression)
  }

  /// An ASS event (Matroska's: ReadOrder, Layer, Style, Name, MarginL,
  /// MarginR, MarginV, Effect, Text) as WebVTT cue text and settings: the
  /// override blocks dropped, `\an7`–`\an9` placed at the top.
  static func assText(_ event: String) -> (text: String, settings: String) {
    let text = event.split(separator: ",", maxSplits: 8, omittingEmptySubsequences: false).dropFirst(8).first
      .map(String.init) ?? event
    let top = text.range(of: #"\\an[789]"#, options: .regularExpression) != nil
    let plain = text.replacingOccurrences(of: #"\{[^}]*\}"#, with: "", options: .regularExpression)
      .replacingOccurrences(of: "\\N", with: "\n").replacingOccurrences(of: "\\n", with: "\n")
      .replacingOccurrences(of: "\\h", with: " ")
    return (escape(plain), top ? " line:0" : "")
  }

  /// A WebVTT segment of a subtitle track's cues (`codec`: `srt`, `ass` or
  /// `vtt`), on the media timeline (the fragments' times, from zero).
  static func vtt(_ cues: [RemuxCue], codec: String?) -> String {
    var blocks = ["WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000"]
    for cue in cues {
      let end = cue.end ?? cue.start + 4000
      guard end > cue.start else { continue }
      var text: String
      var settings = ""
      switch codec {
      case "ass": (text, settings) = assText(cue.text)
      case "vtt": text = cue.text
      default: text = srtText(cue.text)
      }
      text = text.replacingOccurrences(of: "\n\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { continue }
      blocks.append("\(clock(cue.start)) --> \(clock(end))\(settings)\n\(text)")
    }
    return blocks.joined(separator: "\n\n") + "\n"
  }

  // MARK: - Fragments

  /// The start (s) of a fragment the remuxer wrote: its first `tfdt`; `nil` for an init segment.
  static func fragmentStart(_ segment: [UInt8], timescales: [Int]) -> Double? {
    // moof(8) mfhd(16) traf(8) tfhd(16: track id at +12) tfdt v1(20: time at +12)
    guard segment.count >= 68, Bytes.readUint(segment, 4, 4) == 0x6D6F_6F66 else { return nil }
    let track = Bytes.readUint(segment, 44, 4)
    guard track >= 1, track <= timescales.count, timescales[track - 1] > 0 else { return nil }
    return Double(Bytes.readUint(segment, 60, 8)) / Double(timescales[track - 1])
  }

  /// One window's fragments and cues, from a read that starts before it.
  final class WindowReader {
    enum Status: Equatable {
      /// More bytes: the next window's first fragment has not come yet.
      case needMore
      case done
      /// The read started inside the window (at this time): fragments before it may be missing.
      case late(Double)
    }

    let window: Window
    private let remuxer: Remuxer
    /// The read starts at the file's (or the clusters') start: nothing is before it.
    private let fromStart: Bool
    private(set) var fragments: [[UInt8]] = []
    private(set) var cues: [RemuxCue] = []
    private var first = true
    private var finished: Status?

    init(remuxer: Remuxer, window: Window, fromStart: Bool) {
      self.remuxer = remuxer
      self.window = window
      self.fromStart = fromStart
    }

    func push(_ bytes: [UInt8]) -> Status {
      if let finished { return finished }
      return absorb(remuxer.push(bytes), ended: false)
    }

    func end() -> Status {
      if let finished { return finished }
      return absorb(remuxer.end(), ended: true)
    }

    private func absorb(_ out: Remuxer.Output, ended: Bool) -> Status {
      let from = Int((window.start * 1000).rounded())
      let to = window.last ? Int.max : Int((window.end * 1000).rounded())
      cues += out.cues.filter { $0.start >= from && $0.start < to }
      let timescales = remuxer.muxed?.map(\.timescale) ?? []
      for segment in out.segments {
        guard let start = RemuxHls.fragmentStart(segment, timescales: timescales) else { continue }
        if first {
          first = false
          if !fromStart && window.index > 0 && start > window.start + 1e-6 {
            finished = .late(start)
            return .late(start)
          }
        }
        if !window.last && start >= window.end - 1e-6 {
          finished = .done
          return .done
        }
        if start >= window.start - 1e-6 { fragments.append(segment) }
      }
      if ended {
        // Nothing at all (no keyframe, so no parameter sets either): the read
        // started past the window's groups.
        if first && !fromStart && window.index > 0 {
          finished = .late(window.end)
          return .late(window.end)
        }
        finished = .done
        return .done
      }
      return .needMore
    }
  }

  // MARK: - Live

  /// A live stream's fragments cut into segments as they arrive, the last
  /// few listed in a sliding playlist.
  final class LiveSegmenter {
    struct Segment {
      let sequence: Int
      let duration: Double
      let data: [UInt8]
      /// Which init segment it needs (`<name>-init-<n>.mp4`).
      let initIndex: Int
    }

    let target: Double
    let keep: Int
    private(set) var segments: [Segment] = []
    private(set) var inits: [[UInt8]] = []
    /// The segment being filled: its start (s), bytes and init segment.
    private var open: (start: Double, data: [UInt8], initIndex: Int)?
    private var nextSequence = 0

    init(target: Double = 4, keep: Int = 8) {
      self.target = target
      self.keep = keep
    }

    /// An init segment: the fragments after it need it (the segment being filled closes first).
    func add(init segment: [UInt8]) {
      guard inits.last != segment else { return }
      inits.append(segment)
    }

    /// A fragment starting at `start` (s): a segment closes before it once it
    /// holds `target` seconds, or when the fragment needs another init segment.
    func add(fragment: [UInt8], start: Double) {
      guard !inits.isEmpty else { return }
      let initIndex = inits.count - 1
      if let current = open, current.initIndex != initIndex || start - current.start >= target - 1e-6 {
        close(at: start, current)
      }
      if open == nil { open = (start, [], initIndex) }
      open!.data += fragment
    }

    private func close(at end: Double, _ current: (start: Double, data: [UInt8], initIndex: Int)) {
      open = nil
      guard !current.data.isEmpty else { return }
      segments.append(
        Segment(
          sequence: nextSequence, duration: max(0.001, end - current.start), data: current.data,
          initIndex: current.initIndex))
      nextSequence += 1
      if segments.count > keep { segments.removeFirst(segments.count - keep) }
    }

    /// The live playlist (`<name>-<sequence>.m4s`); `nil` until a segment closed.
    func playlist(name: String) -> String? {
      guard let first = segments.first else { return nil }
      let longest = segments.map(\.duration).max() ?? target
      var lines = [
        "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-TARGETDURATION:\(Int(longest.rounded(.up)))",
        "#EXT-X-MEDIA-SEQUENCE:\(first.sequence)", "#EXT-X-INDEPENDENT-SEGMENTS",
      ]
      var map = -1
      for segment in segments {
        if segment.initIndex != map {
          map = segment.initIndex
          lines.append("#EXT-X-MAP:URI=\"\(name)-init-\(map).mp4\"")
        }
        lines.append(String(format: "#EXTINF:%.3f,", segment.duration))
        lines.append("\(name)-\(segment.sequence).m4s")
      }
      return lines.joined(separator: "\n") + "\n"
    }

    func segment(_ sequence: Int) -> Segment? { segments.first { $0.sequence == sequence } }
  }
}
