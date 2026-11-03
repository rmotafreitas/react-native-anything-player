import Foundation
import XCTest

@testable import AnythingPlayerCore

/// The live offset estimator against `conformance/align/offset.json` (twins:
/// `liveOffset.test.ts`, `LiveOffsetTest.kt`).
final class LiveOffsetTests: XCTestCase {
  private static var fixtures: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("conformance/align/offset.json")
  }

  func testFixtures() throws {
    let data = try Data(contentsOf: Self.fixtures)
    let cases = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    XCTAssertFalse(cases.isEmpty)
    for c in cases {
      let name = c["name"] as? String ?? "?"
      let estimator = LiveOffset()
      for s in try XCTUnwrap(c["steps"] as? [[String: Any]]) {
        let t = (s["t"] as? NSNumber)?.int64Value ?? 0
        let value = estimator.read(
          t,
          LiveOffset.Reading(
            position: (s["position"] as? NSNumber)?.doubleValue ?? .nan,
            edge: (s["edge"] as? NSNumber)?.doubleValue,
            native: (s["native"] as? NSNumber)?.doubleValue,
            live: s["live"] as? Bool ?? false,
            programDate: (s["programDate"] as? NSNumber)?.int64Value))
        guard let expect = s["expect"] as? [String: Any] else { continue }
        XCTAssertEqual(value.settled, expect["settled"] as? Bool, "\(name) @\(t)")
        if let offset = (expect["offset"] as? NSNumber)?.doubleValue {
          XCTAssertEqual(try XCTUnwrap(value.offset, name), offset, accuracy: 1e-6, "\(name) @\(t)")
        } else {
          XCTAssertNil(value.offset, name)
        }
      }
    }
  }
}
