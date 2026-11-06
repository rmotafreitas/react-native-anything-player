import Foundation
import XCTest

@testable import AnythingPlayerCore

/// The disk store behind the iOS cache and downloads.
final class MediaStoreTests: XCTestCase {
  private var dir: URL!

  override func setUp() {
    dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  }

  override func tearDown() {
    try? FileManager.default.removeItem(at: dir)
  }

  func testRangesMergeAndRun() {
    var set = RangeSet()
    set.insert(10..<20)
    set.insert(30..<40)
    set.insert(20..<30)
    set.insert(5..<6)
    XCTAssertEqual(set.ranges, [5..<6, 10..<40])
    XCTAssertTrue(set.contains(12..<39))
    XCTAssertFalse(set.contains(4..<7))
    XCTAssertEqual(set.run(from: 15), 25)
    XCTAssertEqual(set.run(from: 40), 0)
    XCTAssertEqual(set.count, 31)
  }

  func testWritesReadsAndKnowsWhenComplete() {
    let store = MediaStore(directory: dir, maxBytes: nil)
    store.describe("a", totalLength: 10, contentType: "audio/mpeg", pathExtension: "mp3")
    store.write("a", offset: 5, data: Data([5, 6, 7, 8, 9]))
    XCTAssertFalse(store.isComplete("a"))
    XCTAssertNil(store.read("a", offset: 0, length: 6))
    store.write("a", offset: 0, data: Data([0, 1, 2, 3, 4]))
    XCTAssertTrue(store.isComplete("a"))
    XCTAssertEqual(store.read("a", offset: 3, length: 4), Data([3, 4, 5, 6]))
    XCTAssertEqual(store.fileURL("a").pathExtension, "mp3")
    // A new instance reads the saved index.
    store.save()
    let again = MediaStore(directory: dir, maxBytes: nil)
    XCTAssertTrue(again.isComplete("a"))
    XCTAssertEqual(again.entry("a")?.contentType, "audio/mpeg")
  }

  func testEvictsTheLeastRecentlyUsedPastItsSize() {
    var clock = 0.0
    let store = MediaStore(directory: dir, maxBytes: 25, now: { clock })
    for key in ["a", "b", "c"] {
      clock += 1
      store.write(key, offset: 0, data: Data(count: 10))
    }
    XCTAssertNil(store.entry("a"))
    XCTAssertEqual(Set(store.keys), ["b", "c"])
    clock += 1
    store.touch("b")
    clock += 1
    store.write("d", offset: 0, data: Data(count: 10))
    XCTAssertEqual(Set(store.keys), ["b", "d"])
    store.maxBytes = 10
    XCTAssertEqual(store.keys, ["d"])
  }

  func testAdoptsAFinishedFile() throws {
    let store = MediaStore(directory: dir, maxBytes: nil)
    let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try Data(count: 42).write(to: file)
    try store.adopt("k", file: file, contentType: "video/mp4", pathExtension: "mp4")
    XCTAssertTrue(store.isComplete("k"))
    XCTAssertEqual(store.heldBytes("k"), 42)
    store.remove("k")
    XCTAssertNil(store.entry("k"))
    XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL("k").path))
  }
}

final class StoredResponseTests: XCTestCase {
  func testPlansRangesItHoldsAndRefusesTheRest() {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = MediaStore(directory: dir, maxBytes: nil)
    store.describe("a", totalLength: 100, contentType: "audio/mp4")
    store.write("a", offset: 0, data: Data(count: 50))
    XCTAssertEqual(
      store.plan("a", range: "bytes=0-1"),
      StoredResponse(
        status: 206, offset: 0, length: 2,
        headers: ["content-length": "2", "accept-ranges": "bytes", "content-type": "audio/mp4", "content-range": "bytes 0-1/100"]))
    XCTAssertNil(store.plan("a", range: "bytes=0-"))
    XCTAssertNil(store.plan("a", range: nil))
    XCTAssertNil(store.plan("a", range: "bytes=0-1,5-6"))
    store.write("a", offset: 50, data: Data(count: 50))
    XCTAssertEqual(store.plan("a", range: nil)?.status, 200)
    XCTAssertEqual(store.plan("a", range: "bytes=-10")?.offset, 90)
    XCTAssertEqual(store.plan("a", range: "bytes=90-500")?.length, 10)
    XCTAssertNil(store.plan("a", range: "bytes=100-"))
    XCTAssertNil(store.plan("missing", range: nil))
  }
}

final class MediaStoreNamesTests: XCTestCase {
  func testLongKeysWithOneStartGetTheirOwnFiles() {
    let base = String(repeating: "https://cdn.example/path/", count: 10)
    XCTAssertNotEqual(MediaStore.fileName(base + "a?sig=1"), MediaStore.fileName(base + "a?sig=2"))
    XCTAssertEqual(MediaStore.fileName("x").count, 32)
  }

  func testTheExtensionHoldsOnceBytesAreWrittenAndRecentFilesStay() {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: dir) }
    var clock = 0.0
    let store = MediaStore(directory: dir, maxBytes: 15, now: { clock })
    store.describe("a", totalLength: 10, contentType: nil, pathExtension: "mp3")
    store.write("a", offset: 0, data: Data(count: 10))
    store.describe("a", totalLength: 10, contentType: nil, pathExtension: "m4a")
    XCTAssertEqual(store.fileURL("a").pathExtension, "mp3")
    XCTAssertTrue(store.fileExists("a"))
    store.protect("a")
    clock += 1
    store.write("b", offset: 0, data: Data(count: 10))
    XCTAssertNotNil(store.entry("a"))
  }
}
