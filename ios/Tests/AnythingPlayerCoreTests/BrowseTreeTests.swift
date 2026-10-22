import Foundation
import XCTest

@testable import AnythingPlayerCore

/// Runs `conformance/catalog/browse.json` against the Swift tree builder.
/// Twins: `src/__tests__/catalog.test.ts` and `BrowseTreeTest.kt`.
final class BrowseTreeTests: XCTestCase {
  private func spec() throws -> [String: Any] {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // AnythingPlayerCoreTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // ios
      .deletingLastPathComponent()  // repo root
      .appendingPathComponent("conformance/catalog/browse.json")
    let data = try Data(contentsOf: url)
    return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func testSegments() throws {
    let cases = try XCTUnwrap(try spec()["segments"] as? [[String: Any]])
    XCTAssertFalse(cases.isEmpty)
    for testCase in cases {
      let group = testCase["group"] as? String ?? ""
      XCTAssertEqual(
        BrowseTree.groupSegments(group), testCase["segments"] as? [String] ?? [], "segments › \(group)")
    }
    XCTAssertEqual(BrowseTree.groupSegments(nil), [])
  }

  func testMembership() throws {
    let cases = try XCTUnwrap(try spec()["membership"] as? [[String: Any]])
    XCTAssertFalse(cases.isEmpty)
    for testCase in cases {
      XCTAssertEqual(
        BrowseTree.isInGroup(testCase["itemGroup"] as? String, testCase["group"] as? String),
        testCase["in"] as? Bool, "membership › \(testCase)")
    }
  }

  func testSearchInAGroup() throws {
    let search = try XCTUnwrap(try spec()["search"] as? [String: Any])
    let catalog = try XCTUnwrap(search["catalog"] as? [[String: Any]])
    let ids = catalog.map { $0["id"] as? String ?? "" }
    let items = catalog.map {
      SearchableItem(title: $0["title"] as? String ?? "", kind: $0["kind"] as? String, group: $0["group"] as? String)
    }
    let cases = try XCTUnwrap(search["cases"] as? [[String: Any]])
    XCTAssertFalse(cases.isEmpty)
    for testCase in cases {
      let name = testCase["name"] as? String ?? "?"
      let raw = try XCTUnwrap(testCase["request"] as? [String: Any], name)
      let request = CatalogQuery(query: raw["query"] as? String ?? "", group: raw["group"] as? String)
      XCTAssertEqual(
        CatalogSearch.search(items, request).matches.map { ids[$0] }, testCase["expect"] as? [String] ?? [],
        "search › \(name)")
    }
  }

  func testTrees() throws {
    let trees = try XCTUnwrap(try spec()["trees"] as? [[String: Any]])
    XCTAssertFalse(trees.isEmpty)
    for testCase in trees {
      let name = testCase["name"] as? String ?? "?"
      let tree = Self.build(testCase)
      let children = testCase["children"] as? [String: [[String]]] ?? [:]
      for (id, expected) in children {
        guard let actual = tree.children(id) else {
          XCTFail("\(name): \(id) has children")
          continue
        }
        XCTAssertEqual(
          actual.map { [$0.isFolder ? "folder" : "item", $0.id, $0.title] }, expected, "\(name): \(id)")
      }
      for (id, style) in testCase["styles"] as? [String: String] ?? [:] {
        XCTAssertEqual(tree.style(id).rawValue, style, "\(name): style of \(id)")
      }
      for (id, artwork) in testCase["artworks"] as? [String: Any] ?? [:] {
        XCTAssertEqual(tree.node(id)?.artwork, artwork as? String, "\(name): artwork of \(id)")
      }
      for id in testCase["missing"] as? [String] ?? [] {
        XCTAssertNil(tree.children(id), "\(name): \(id) has no children")
        XCTAssertNotEqual(tree.node(id)?.isFolder, true, "\(name): \(id) is not a folder")
      }
    }
  }

  func testAnItemKnowsItsId() {
    let tree = BrowseTree([BrowseItem(id: "a", title: "A", group: "G")])
    XCTAssertEqual(tree.node("a")?.itemId, "a")
    XCTAssertEqual(tree.node("a")?.isFolder, false)
    XCTAssertNil(tree.node("rnap:group:G")?.itemId)
    XCTAssertNil(tree.node("nothing"))
  }

  private static func build(_ testCase: [String: Any]) -> BrowseTree {
    let items = (testCase["items"] as? [[String: Any]] ?? []).map {
      BrowseItem(
        id: $0["id"] as? String ?? "", title: $0["title"] as? String ?? "",
        kind: $0["kind"] as? String ?? "station", group: $0["group"] as? String,
        artwork: $0["artwork"] as? String)
    }
    let raw = testCase["options"] as? [String: Any] ?? [:]
    let titles = raw["titles"] as? [String: String] ?? [:]
    var options = BrowseOptions()
    options.recentLimit = raw["recentLimit"] as? Int ?? 0
    options.favorites = raw["favorites"] as? [String] ?? []
    options.rootOrder = raw["rootOrder"] as? [String] ?? []
    options.titles = BrowseTitles(
      recent: titles["recent"] ?? BrowseTitles().recent,
      favorites: titles["favorites"] ?? BrowseTitles().favorites,
      more: titles["more"] ?? BrowseTitles().more)
    options.rootLimit = raw["rootLimit"] as? Int ?? BrowseTree.defaultRootLimit
    options.foldersOnly = raw["foldersOnly"] as? Bool ?? false
    options.folderLimit = raw["folderLimit"] as? Int ?? 0
    return BrowseTree(items, options: options, recentIds: testCase["recent"] as? [String] ?? [])
  }
}
