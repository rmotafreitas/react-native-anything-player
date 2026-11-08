import Foundation
import XCTest

@testable import AnythingPlayerCore

/// Runs `conformance/queue/model.json` (shared with Kotlin and the web).
final class QueueModelTests: XCTestCase {
  private struct Entry: QueueEntry {
    let id: String
    let live: Bool
  }

  private func entries(_ value: Any?) -> [Entry] {
    (value as? [Any] ?? []).map { raw in
      if let id = raw as? String { return Entry(id: id, live: false) }
      let o = raw as? [String: Any] ?? [:]
      return Entry(id: o["id"] as? String ?? "", live: o["live"] as? Bool ?? false)
    }
  }

  func testScenarios() throws {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // AnythingPlayerCoreTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // ios
      .deletingLastPathComponent()  // repo root
      .appendingPathComponent("conformance/queue/model.json")
    let scenarios = try XCTUnwrap(
      try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
    XCTAssertGreaterThan(scenarios.count, 10)
    for scenario in scenarios {
      run(scenario["name"] as? String ?? "?", scenario["steps"] as? [[String: Any]] ?? [])
    }
  }

  private func run(_ name: String, _ steps: [[String: Any]]) {
    let q = QueueModel<Entry>(seed: 1)
    for (i, step) in steps.enumerated() {
      let at = "\(name), step \(i)"
      if let expect = step["expect"] as? [String: Any] {
        for (key, want) in expect {
          switch key {
          case "current": XCTAssertEqual(q.current?.id, want as? String, "\(at): current")
          case "index": XCTAssertEqual(q.index, (want as? NSNumber)?.intValue, "\(at): index")
          case "items": XCTAssertEqual(q.items.map(\.id), want as? [String], "\(at): items")
          case "order": XCTAssertEqual(q.order, want as? [String], "\(at): order")
          case "next": XCTAssertEqual(q.peekNext(auto: false)?.id, want as? String, "\(at): next")
          case "nextAuto": XCTAssertEqual(q.peekNext(auto: true)?.id, want as? String, "\(at): nextAuto")
          case "previous": XCTAssertEqual(q.peekPrevious()?.id, want as? String, "\(at): previous")
          default: XCTFail("\(at): unknown expectation \(key)")
          }
        }
        continue
      }
      var result: Any?
      switch step["call"] as? String ?? "" {
      case "set": q.set(entries(step["items"]), startIndex: (step["start"] as? NSNumber)?.intValue ?? 0)
      case "add": q.add(entries(step["items"]), at: (step["index"] as? NSNumber)?.intValue)
      case "remove": result = q.remove(step["ids"] as? [String] ?? [])
      case "move": q.move(from: (step["from"] as? NSNumber)?.intValue ?? 0, to: (step["to"] as? NSNumber)?.intValue ?? 0)
      case "clear": q.clear()
      case "skipTo": result = q.skipTo(step["id"] as? String ?? "")
      case "repeat": q.setRepeat(RepeatMode(rawValue: step["value"] as? String ?? "") ?? .off)
      case "shuffle": q.setShuffle(step["value"] as? Bool ?? false, seed: (step["seed"] as? NSNumber)?.uint64Value)
      case "next": result = q.next(auto: step["auto"] as? Bool ?? false)?.id ?? NSNull()
      case "previous":
        switch q.previous(position: (step["position"] as? NSNumber)?.doubleValue ?? 0) {
        case .restart: result = "restart"
        case .none: result = "none"
        case .item(let id): result = "item:\(id)"
        }
      default: XCTFail("\(at): unknown call")
      }
      guard step.keys.contains("result") else { continue }
      let want = step["result"]
      if let s = want as? String {
        XCTAssertEqual(result as? String, s, "\(at): result")
      } else if want is NSNull {
        XCTAssertTrue(result is NSNull, "\(at): result \(String(describing: result))")
      } else {
        XCTAssertEqual(result as? Bool, want as? Bool, "\(at): result")
      }
    }
  }

  func testXorshiftMatchesTheTwins() {
    var r = QueueRandom(seed: 42)
    XCTAssertEqual([r.next(), r.next(), r.next()], [11_355_432, 2_836_018_348, 476_557_059])
    var a = QueueRandom(seed: 0)
    var b = QueueRandom(seed: 0x9E37_79B9)
    XCTAssertEqual(a.next(), b.next())
  }
}
