import Foundation
import XCTest

@testable import AnythingPlayerCore

/// Runs the shared catalog fixtures in `conformance/catalog/*.json`.
final class CatalogSearchTests: XCTestCase {
  private static var catalogDirectory: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // AnythingPlayerCoreTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // ios
      .deletingLastPathComponent()  // repo root
      .appendingPathComponent("conformance/catalog")
  }

  func testNormalize() throws {
    let data = try Data(contentsOf: Self.catalogDirectory.appendingPathComponent("normalize.json"))
    let cases = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    XCTAssertFalse(cases.isEmpty, "no normalize cases found")
    for testCase in cases {
      let name = testCase["name"] as? String ?? "?"
      let text = try XCTUnwrap(testCase["text"] as? String, name)
      XCTAssertEqual(
        CatalogSearch.tokenize(text), testCase["tokens"] as? [String] ?? [], "normalize › \(name)")
    }
  }

  func testSearch() throws {
    let data = try Data(contentsOf: Self.catalogDirectory.appendingPathComponent("search.json"))
    let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    let catalog = try XCTUnwrap(root["catalog"] as? [[String: Any]])
    var ids: [String] = []
    var items: [SearchableItem] = []
    for entry in catalog {
      ids.append(entry["id"] as? String ?? "")
      items.append(
        SearchableItem(
          title: entry["title"] as? String ?? "",
          artist: entry["artist"] as? String,
          album: entry["album"] as? String,
          genre: entry["genre"] as? String,
          keywords: entry["keywords"] as? [String],
          kind: entry["kind"] as? String))
    }
    let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
    XCTAssertFalse(cases.isEmpty, "no search cases found")
    for testCase in cases {
      let name = testCase["name"] as? String ?? "?"
      let raw = try XCTUnwrap(testCase["request"] as? [String: Any], name)
      let request = CatalogQuery(
        query: raw["query"] as? String ?? "",
        title: raw["title"] as? String,
        artist: raw["artist"] as? String,
        album: raw["album"] as? String,
        genre: raw["genre"] as? String,
        focus: raw["focus"] as? String)
      let outcome = CatalogSearch.search(items, request)
      XCTAssertEqual(
        outcome.matches.map { ids[$0] }, testCase["expect"] as? [String] ?? [], "search › \(name)")
      XCTAssertEqual(
        outcome.emptyQuery, testCase["emptyQuery"] as? Bool ?? false,
        "search › \(name): emptyQuery")
    }
  }
}
