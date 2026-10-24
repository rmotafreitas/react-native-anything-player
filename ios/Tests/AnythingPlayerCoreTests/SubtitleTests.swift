import Foundation
import XCTest

@testable import AnythingPlayerCore

/// The native subtitle pieces against `conformance/subtitles/` and `conformance/tracks/`.
final class SubtitleTests: XCTestCase {
  private static var conformance: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("conformance")
  }

  private func load(_ name: String) throws -> [[String: Any]] {
    let data = try Data(contentsOf: Self.conformance.appendingPathComponent(name))
    return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
  }

  private func bytes(_ hex: String) -> [UInt8] {
    var out: [UInt8] = []
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      out.append(UInt8(hex[index..<next], radix: 16) ?? 0)
      index = next
    }
    return out
  }

  func testCharsets() throws {
    for c in try load("subtitles/charset.json") {
      XCTAssertEqual(
        SubtitleCharset.detect(bytes(c["hex"] as? String ?? "")), c["expect"] as? String,
        c["name"] as? String ?? "")
    }
  }

  func testSchedule() throws {
    for c in try load("subtitles/schedule.json") {
      let cues = (c["cues"] as? [[NSNumber]] ?? []).map {
        CueTime(start: $0[0].doubleValue, end: $0[1].doubleValue)
      }
      for check in c["checks"] as? [[String: Any]] ?? [] {
        let position = (check["position"] as? NSNumber)?.doubleValue ?? 0
        let delay = (check["delay"] as? NSNumber)?.doubleValue ?? 0
        let label = "\(c["name"] ?? "") @ \(position)"
        XCTAssertEqual(
          CueSchedule.active(cues, at: position, delay: delay),
          (check["active"] as? [NSNumber] ?? []).map(\.intValue), label)
        XCTAssertEqual(
          CueSchedule.nextChange(cues, after: position, delay: delay),
          (check["next"] as? NSNumber)?.doubleValue, label)
      }
    }
  }

  func testTrackChoice() throws {
    for c in try load("tracks/select.json") {
      let p = c["preferences"] as? [String: Any] ?? [:]
      let preferences = TrackPreferences(
        languages: p["languages"] as? [String] ?? [], followSystem: p["followSystem"] as? Bool ?? true,
        systemLanguages: p["systemLanguages"] as? [String] ?? [],
        systemCaptions: p["systemCaptions"] as? Bool ?? false,
        systemAudioDescriptions: p["systemAudioDescriptions"] as? Bool ?? false)
      let expect = c["expect"] as? [String: Any] ?? [:]
      XCTAssertEqual(
        TrackSelection.select(ConformanceTests.tracks(c["tracks"]), preferences),
        TrackChoice(audio: expect["audio"] as? String, text: expect["text"] as? String),
        c["name"] as? String ?? "")
    }
  }
}
