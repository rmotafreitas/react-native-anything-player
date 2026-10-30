import Foundation
import XCTest

@testable import AnythingPlayerCore

/// HLS from remuxed files: each window, read on its own (from a Cues entry
/// or a guess by the bitrate, read again from earlier when it lands late),
/// holds exactly the fragments a remux of the whole file makes in its time,
/// for the picture and for each sound; the playlists and subtitle segments.
final class RemuxHlsTests: XCTestCase {
  private static var folder: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("conformance/remux")
  }

  private func read(_ name: String) throws -> [UInt8] {
    [UInt8](try Data(contentsOf: Self.folder.appendingPathComponent(name)))
  }

  /// A fragment without its sequence number (each read numbers its own).
  private func unnumbered(_ fragment: [UInt8]) -> [UInt8] {
    var out = fragment
    for i in 20..<24 { out[i] = 0 }
    return out
  }

  /// The same fragments, but for their sequence numbers; a failure names the first that differs.
  /// `close`: Matroska sound read from a cluster starts on its millisecond
  /// timestamp, not on the sample count from the file's start: the same
  /// fragments, within a millisecond.
  private func same(
    _ got: [[UInt8]], _ want: [[UInt8]], _ timescales: [Int], _ what: String, close: Bool = false,
    line: UInt = #line
  ) {
    let a = got.map(unnumbered)
    let b = want.map(unnumbered)
    if close {
      let starts = { (list: [[UInt8]]) in list.map { RemuxHls.fragmentStart($0, timescales: timescales) ?? -1 } }
      XCTAssertEqual(a.count, b.count, what, line: line)
      for (x, y) in zip(starts(got), starts(want)) { XCTAssertEqual(x, y, accuracy: 0.001, what, line: line) }
      XCTAssertEqual(a.map(\.count), b.map(\.count), what, line: line)
      return
    }
    guard a != b else { return }
    let starts = { (list: [[UInt8]]) in list.map { RemuxHls.fragmentStart($0, timescales: timescales) ?? -1 } }
    let index = zip(a, b).enumerated().first { $0.element.0 != $0.element.1 }?.offset ?? min(a.count, b.count)
    XCTFail(
      "\(what): \(a.count) fragments at \(starts(got)), expected \(b.count) at \(starts(want)); first difference: #\(index)",
      line: line)
  }

  private func choice(video: Bool, audio: Int?) -> ([RemuxTrack]) -> Remuxer.Choice {
    { tracks in
      Remuxer.Choice(
        video: video ? tracks.first { $0.kind == .video && $0.playable }?.id : nil, audio: audio)
    }
  }

  /// The fragments of a whole-file remux.
  private func whole(_ bytes: [UInt8], _ format: Remuxer.Format, video: Bool, audio: Int?) -> (
    fragments: [[UInt8]], timescales: [Int], base: Int?
  ) {
    let remuxer = Remuxer(format: format, choose: choice(video: video, audio: audio))
    var segments = remuxer.push(bytes).segments
    segments += remuxer.end().segments
    return (segments.filter { $0.count > 8 && Bytes.readUint($0, 4, 4) == 0x6D6F_6F66 }, remuxer.muxed!.map(\.timescale), remuxer.timeBase)
  }

  /// One window read on its own; `offset`: where the first try starts.
  private func window(
    _ bytes: [UInt8], _ format: Remuxer.Format, _ window: RemuxHls.Window, video: Bool, audio: Int?,
    head: Int, base: Int?, offset first: Int, perSecond: Double
  ) -> RemuxHls.WindowReader {
    var offset = first
    for _ in 0..<6 {
      let remuxer = Remuxer(format: format, choose: choice(video: video, audio: audio), timeBase: base)
      if head > 0 { _ = remuxer.push(Array(bytes[0..<head])) }
      remuxer.seek(offset)
      let reader = RemuxHls.WindowReader(remuxer: remuxer, window: window, fromStart: offset <= head)
      var status = reader.push(Array(bytes[offset...]))
      if status == .needMore { status = reader.end() }
      if case .late(let landed) = status {
        offset = max(head, offset - Int((landed - window.start + 1) * perSecond))
        continue
      }
      return reader
    }
    XCTFail("window \(window.index) never landed")
    return RemuxHls.WindowReader(remuxer: Remuxer(format: format), window: window, fromStart: true)
  }

  func testWindows() {
    XCTAssertEqual(
      RemuxHls.windows(duration: 15, target: 6),
      [
        .init(index: 0, start: 0, end: 6), .init(index: 1, start: 6, end: 12),
        .init(index: 2, start: 12, end: 15, last: true),
      ])
    XCTAssertEqual(RemuxHls.windows(duration: 13, target: 6).map(\.end), [6, 13])
    XCTAssertEqual(RemuxHls.windows(duration: 0), [])
  }

  func testMatroskaWindowsFromCues() throws {
    let bytes = try read("h264-aac.mkv")
    let probe = Remuxer(format: .matroska)
    _ = probe.push(bytes)
    let demuxer = probe.matroska!
    let head = demuxer.firstCluster!
    let duration = Double(demuxer.duration!) / 1000
    let windows = RemuxHls.windows(duration: duration, target: 1)
    XCTAssertEqual(windows.map(\.start), [0, 1, 2])
    for (video, audio) in [(true, nil), (false, 2), (false, 3)] as [(Bool, Int?)] {
      let expected = whole(bytes, .matroska, video: video, audio: audio)
      var got: [[UInt8]] = []
      var cues: [RemuxCue] = []
      for w in windows {
        // The last Cues entry at or before the window.
        let cue = demuxer.cues.last { Double($0.time) / 1000 <= w.start + 1e-6 } ?? demuxer.cues[0]
        let reader = window(
          bytes, .matroska, w, video: video, audio: audio, head: head, base: nil, offset: cue.offset,
          perSecond: Double(bytes.count) / duration)
        got += reader.fragments
        cues += reader.cues
      }
      same(got, expected.fragments, expected.timescales, "mkv video \(video), audio \(audio ?? 0)", close: !video)
      if video {
        // The subtitles of both tracks, each once, in their windows.
        XCTAssertEqual(cues.filter { $0.track == 4 }.map(\.start), [500, 2000])
        XCTAssertEqual(cues.filter { $0.track == 5 }.map(\.start), [600, 2100])
      }
    }
  }

  func testTsWindowsFromBitrateGuesses() throws {
    let bytes = try read("h264-aac.mpegts")
    for (video, audio) in [(true, nil), (false, 257)] as [(Bool, Int?)] {
      let expected = whole(bytes, .mpegts, video: video, audio: audio)
      let duration = 3.0
      let perSecond = Double(bytes.count) / duration
      var got: [[UInt8]] = []
      // Guesses that land late (no margin): each window is read again from earlier.
      for w in RemuxHls.windows(duration: duration, target: 1) {
        let guess = Int(w.start * perSecond) / 188 * 188
        let reader = window(
          bytes, .mpegts, w, video: video, audio: audio, head: 0, base: expected.base, offset: guess,
          perSecond: perSecond)
        got += reader.fragments
      }
      same(got, expected.fragments, expected.timescales, "ts video \(video)")
    }
  }

  func testPlaylists() {
    let video = RemuxTrack(id: 1, kind: .video)
    video.codec = "avc1.4D401E"
    video.width = 640
    video.height = 360
    let english = RemuxTrack(id: 2, kind: .audio)
    english.codec = "mp4a.40.2"
    english.language = "eng"
    english.name = "English"
    english.channels = 2
    let portuguese = RemuxTrack(id: 3, kind: .audio)
    portuguese.codec = "ac-3"
    portuguese.language = "por"
    portuguese.channels = 6
    let subs = RemuxTrack(id: 4, kind: .text)
    subs.language = "eng"
    subs.forced = true
    XCTAssertEqual(
      RemuxHls.master(video: video, audios: [english, portuguese], defaultAudio: 2, texts: [subs], bandwidth: 800_000),
      """
      #EXTM3U
      #EXT-X-VERSION:7
      #EXT-X-INDEPENDENT-SEGMENTS
      #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio-2.m3u8"
      #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="por",LANGUAGE="por",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="6",URI="audio-3.m3u8"
      #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="eng",LANGUAGE="eng",DEFAULT=NO,AUTOSELECT=YES,FORCED=YES,URI="subs-4.m3u8"
      #EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4D401E,mp4a.40.2,ac-3",RESOLUTION=640x360,AUDIO="audio",SUBTITLES="subs"
      video.m3u8

      """)
    XCTAssertEqual(
      RemuxHls.mediaPlaylist(name: "video", windows: RemuxHls.windows(duration: 13, target: 6), ext: "m4s"),
      """
      #EXTM3U
      #EXT-X-VERSION:7
      #EXT-X-TARGETDURATION:14
      #EXT-X-MEDIA-SEQUENCE:0
      #EXT-X-PLAYLIST-TYPE:VOD
      #EXT-X-INDEPENDENT-SEGMENTS
      #EXT-X-MAP:URI="video-init.mp4"
      #EXTINF:6.000,
      video-0.m4s
      #EXTINF:7.000,
      video-1.m4s
      #EXT-X-ENDLIST

      """)
  }

  func testSubtitleSegments() {
    let cues = [
      RemuxCue(track: 4, start: 500, end: 1500, text: "Hello <i>there</i> & <font color=red>red</font>"),
      RemuxCue(track: 4, start: 2000, end: nil, text: "Two\nrows"),
    ]
    XCTAssertEqual(
      RemuxHls.vtt(cues, codec: "srt"),
      """
      WEBVTT
      X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000

      00:00:00.500 --> 00:00:01.500
      Hello <i>there</i> &amp; red

      00:00:02.000 --> 00:00:06.000
      Two
      rows

      """)
    let ass = [RemuxCue(track: 5, start: 2100, end: 2900, text: "1,0,Default,,0,0,0,,{\\an8}{\\b1}On{\\b0} top\\Nnext")]
    XCTAssertEqual(
      RemuxHls.vtt(ass, codec: "ass"),
      """
      WEBVTT
      X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000

      00:00:02.100 --> 00:00:02.900 line:0
      On top
      next

      """)
  }

  func testLiveSegments() throws {
    let bytes = try read("h264-aac.mpegts")
    let remuxer = Remuxer(format: .mpegts, choose: choice(video: true, audio: nil))
    let live = RemuxHls.LiveSegmenter(target: 1, keep: 8)
    var at = 0
    while at < bytes.count {
      let out = remuxer.push(Array(bytes[at..<min(at + 4096, bytes.count)]))
      for segment in out.segments {
        if let start = RemuxHls.fragmentStart(segment, timescales: remuxer.muxed!.map(\.timescale)) {
          live.add(fragment: segment, start: start)
        } else {
          live.add(init: segment)
        }
      }
      at += 4096
    }
    // Keyframes every second, segments of 1 s: a live stream's last keyframe
    // group is still open (the next keyframe closes it), so 0–1 is listed.
    XCTAssertEqual(live.segments.map(\.sequence), [0])
    XCTAssertEqual(live.segments.first?.duration ?? 0, 1, accuracy: 0.001)
    XCTAssertEqual(
      live.playlist(name: "video"),
      """
      #EXTM3U
      #EXT-X-VERSION:7
      #EXT-X-TARGETDURATION:1
      #EXT-X-MEDIA-SEQUENCE:0
      #EXT-X-INDEPENDENT-SEGMENTS
      #EXT-X-MAP:URI="video-init-0.mp4"
      #EXTINF:1.000,
      video-0.m4s

      """)
  }
}
