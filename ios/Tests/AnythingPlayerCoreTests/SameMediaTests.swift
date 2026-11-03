import Foundation
import XCTest

@testable import AnythingPlayerCore

/// Runs `conformance/catalog/same-media.json` (shared with Kotlin and the web).
final class SameMediaTests: XCTestCase {
  private func source(_ json: [String: Any]) -> SourceDescriptor {
    SourceDescriptor(
      uri: json["uri"] as? String ?? "",
      renditions: (json["renditions"] as? [String])?.map { Rendition(uri: $0) })
  }

  func testCases() throws {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // AnythingPlayerCoreTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // ios
      .deletingLastPathComponent()  // repo root
      .appendingPathComponent("conformance/catalog/same-media.json")
    let cases = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
    XCTAssertGreaterThan(cases.count, 3)
    for c in cases {
      let a = try XCTUnwrap(c["a"] as? [String: Any])
      let b = try XCTUnwrap(c["b"] as? [String: Any])
      XCTAssertEqual(source(a).sameMedia(source(b)), c["same"] as? Bool, c["name"] as? String ?? "?")
    }
  }
}
