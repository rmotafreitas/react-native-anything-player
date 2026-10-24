import Foundation
import XCTest

@testable import AnythingPlayerCore

/// The container remuxer against `conformance/remux/`: each fixture's tracks,
/// cues and fragmented MP4 output must match the files the TypeScript twin
/// wrote (`<fixture>.out/`), byte for byte.
final class RemuxTests: XCTestCase {
  private static var folder: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("conformance/remux")
  }

  private static var fixtures: [String] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
    return names.filter { ["mkv", "webm", "mpegts", "m2ts"].contains(($0 as NSString).pathExtension) }.sorted()
  }

  private static func format(_ name: String) -> Remuxer.Format {
    ["mpegts", "m2ts"].contains((name as NSString).pathExtension) ? .mpegts : .matroska
  }

  private func read(_ name: String) throws -> [UInt8] {
    [UInt8](try Data(contentsOf: Self.folder.appendingPathComponent(name)))
  }

  private struct Run {
    let remuxer: Remuxer
    let bytes: [UInt8]
    let cues: [RemuxCue]
  }

  private func run(_ name: String, _ bytes: [UInt8], chunk: Int, audio: Int? = nil) -> Run {
    let remuxer = Remuxer(
      format: Self.format(name), choose: audio.map { id in { _ in Remuxer.Choice(video: nil, audio: id) } })
    var out: [UInt8] = []
    var cues: [RemuxCue] = []
    var at = 0
    while at < bytes.count {
      let output = remuxer.push(Array(bytes[at..<min(at + chunk, bytes.count)]))
      out += output.segments.joined()
      cues += output.cues
      at += chunk
    }
    let output = remuxer.end()
    out += output.segments.joined()
    cues += output.cues
    return Run(remuxer: remuxer, bytes: out, cues: cues)
  }

  /// Equal bytes; a failure names the first offset that differs (not the whole buffers).
  private func assertSame(_ got: [UInt8], _ want: [UInt8], _ what: String, line: UInt = #line) {
    guard got != want else { return }
    let at = zip(got, want).enumerated().first { $0.element.0 != $0.element.1 }?.offset ?? min(got.count, want.count)
    XCTFail("\(what): \(got.count) bytes, expected \(want.count); first difference at \(at)", line: line)
  }

  private func hex(_ bytes: [UInt8]?) -> Any {
    bytes.map { $0.map { String(format: "%02x", $0) }.joined() } ?? NSNull()
  }

  func testFixtures() throws {
    XCTAssertGreaterThanOrEqual(Self.fixtures.count, 8)
    for name in Self.fixtures {
      let bytes = try read(name)
      let main = run(name, bytes, chunk: 1000)
      for chunk in [188, 7919, bytes.count] {
        assertSame(run(name, bytes, chunk: chunk).bytes, main.bytes, "\(name): chunks of \(chunk)")
      }
      let out = Self.folder.appendingPathComponent("\(name).out")
      assertSame(main.bytes, try read("\(name).out/main.mp4"), "\(name): main.mp4")
      var files = ["main.mp4", "tracks.json", "cues.json"]
      let muxedAudio = main.remuxer.muxed?.first { $0.kind == .audio }?.id
      for track in main.remuxer.tracks where track.kind == .audio && track.playable && track.id != muxedAudio {
        let file = "audio-\(track.id).mp4"
        files.append(file)
        assertSame(run(name, bytes, chunk: 1000, audio: track.id).bytes, try read("\(name).out/\(file)"), "\(name): \(file)")
      }
      let listed = try FileManager.default.contentsOfDirectory(atPath: out.path).sorted()
      XCTAssertEqual(listed, files.sorted(), "\(name): the outputs")

      let tracksJson = try JSONSerialization.jsonObject(with: Data(contentsOf: out.appendingPathComponent("tracks.json")))
      let expected = tracksJson as! [String: Any]
      XCTAssertEqual(expected["muxed"] as? [Int], main.remuxer.muxed?.map(\.id) ?? [], "\(name): muxed")
      let want = expected["tracks"] as! [[String: Any]]
      XCTAssertEqual(want.count, main.remuxer.tracks.count, "\(name): track count")
      for (t, w) in zip(main.remuxer.tracks, want) {
        let got: [String: Any] = [
          "id": t.id, "kind": t.kind.rawValue, "codec": t.codec ?? NSNull(), "entry": t.entry ?? NSNull(),
          "config": hex(t.config), "objectType": t.objectType, "timescale": t.timescale, "width": t.width,
          "height": t.height, "sar": "\(t.sarWidth):\(t.sarHeight)", "sampleRate": t.sampleRate,
          "channels": t.channels, "language": t.language ?? NSNull(), "name": t.name ?? NSNull(),
          "default": t.isDefault, "forced": t.forced, "unsupported": t.unsupported ?? NSNull(),
        ]
        XCTAssertEqual(NSDictionary(dictionary: got), NSDictionary(dictionary: w), "\(name): track \(t.id)")
      }

      let cuesJson = try JSONSerialization.jsonObject(with: Data(contentsOf: out.appendingPathComponent("cues.json")))
      let wantCues = (cuesJson as! [[String: Any]]).map {
        RemuxCue(track: $0["track"] as! Int, start: $0["start"] as! Int, end: $0["end"] as? Int, text: $0["text"] as! String)
      }
      XCTAssertEqual(main.cues, wantCues, "\(name): cues")
    }
  }

  func testMatroskaSeeksToACluster() throws {
    let bytes = try read("h264-aac.mkv")
    let head = Remuxer(format: .matroska)
    _ = head.push(bytes)
    let demuxer = head.matroska!
    XCTAssertGreaterThanOrEqual(demuxer.cues.count, 3)
    XCTAssertGreaterThan(demuxer.duration ?? 0, 2900)
    let remuxer = Remuxer(format: .matroska)
    var out = remuxer.push(Array(bytes[0..<demuxer.firstCluster!])).segments
    let target = demuxer.cues[2]
    remuxer.seek(target.offset)
    out += remuxer.push(Array(bytes[target.offset...])).segments
    out += remuxer.end().segments
    // The first fragment's first tfdt (the video's, timescale 1000) is the cue's time.
    let fragment = out[1]
    let tfdt = fragment.indices.first { fragment[$0..<($0 + 4)].elementsEqual("tfdt".utf8) }!
    XCTAssertEqual(Bytes.readUint(fragment, tfdt + 8, 8), target.time)
  }

  func testTsDiscontinuityGoesOn() throws {
    let once = try read("h264-aac.mpegts")
    // The same file twice: the second copy's timestamps start over.
    let result = run("h264-aac.mpegts", once + once, chunk: 4096)
    let timescale = result.remuxer.muxed!.first { $0.kind == .video }!.timescale
    var times: [Double] = []
    var at = 0
    let bytes = result.bytes
    while at + 8 <= bytes.count {
      let size = Bytes.readUint(bytes, at, 4)
      if bytes[(at + 4)..<(at + 8)].elementsEqual("moof".utf8) {
        let tfdt = (at..<(at + size)).first { bytes[$0..<($0 + 4)].elementsEqual("tfdt".utf8) }!
        times.append(Double(Bytes.readUint(bytes, tfdt + 8, 8)) / Double(timescale))
      }
      at += max(8, size)
    }
    XCTAssertEqual(times.count, 6)
    for i in 1..<times.count { XCTAssertEqual(times[i] - times[i - 1], 1, accuracy: 0.05) }
  }

  func testLacing() {
    let frames: [[UInt8]] = [[1, 2, 3], [UInt8](repeating: 7, count: 300), [9]]
    let payload = frames.flatMap { $0 }
    XCTAssertEqual(MatroskaDemuxer.delace([2, 3, 255, 45] + payload, 0, 1)!, frames)
    let delta = 297 + (1 << 13) - 1
    XCTAssertEqual(MatroskaDemuxer.delace([2, 0x83, UInt8(0x40 | (delta >> 8)), UInt8(delta & 0xFF)] + payload, 0, 3)!, frames)
    XCTAssertEqual(MatroskaDemuxer.delace([2, 1, 2, 3, 4, 5, 6], 0, 2)!, [[1, 2], [3, 4], [5, 6]])
    XCTAssertNil(MatroskaDemuxer.delace([2, 1, 2], 0, 2))
  }
}
