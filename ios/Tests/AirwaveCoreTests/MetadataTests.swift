import Foundation
import XCTest

@testable import AirwaveCore

/// Runs `conformance/metadata/icy.json` (shared with the Kotlin parser).
final class MetadataTests: XCTestCase {
  private static var casesFile: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("conformance/metadata/icy.json")
  }

  func testIcyCases() throws {
    let data = try Data(contentsOf: Self.casesFile)
    let cases = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    XCTAssertGreaterThan(cases.count, 10)
    for c in cases {
      let name = c["name"] as? String ?? "?"
      let format = StreamTitleFormat(rawValue: c["format"] as? String ?? "") ?? .artistTitle
      let meta: StreamMetadata
      if let text = c["text"] as? String {
        meta = IcyParser.metadata(fromBlock: Array(text.utf8), format: format)
      } else if let hex = c["bytes"] as? String {
        meta = IcyParser.metadata(fromBlock: Self.bytes(hex), format: format)
      } else {
        let fields = try XCTUnwrap(c["fields"] as? [String: String], name)
        meta = IcyParser.metadata(fromFields: fields, format: format)
      }
      let expect = try XCTUnwrap(c["expect"] as? [String: Any], name)
      for (key, value) in expect {
        switch key {
        case "title": XCTAssertEqual(meta.title, value as? String, "\(name): title")
        case "artist": XCTAssertEqual(meta.artist, value as? String, "\(name): artist")
        case "artworkUri": XCTAssertEqual(meta.artworkUri, value as? String, "\(name): artworkUri")
        case "raw": XCTAssertEqual(meta.raw, value as? [String: String], "\(name): raw")
        default: XCTFail("\(name): unknown key \(key)")
        }
      }
    }
  }

  func testDecodeNeverFails() {
    for byte in 0...255 {
      _ = IcyParser.decode([UInt8(byte), 0x41, UInt8(255 - byte)])
    }
    XCTAssertEqual(IcyParser.decode([]), "")
    XCTAssertEqual(IcyParser.decode([0, 0, 0]), "")
  }

  func testRandomInputNeverCrashes() {
    var generator = SystemRandomNumberGenerator()
    for _ in 0..<2_000 {
      let length = Int.random(in: 0..<64, using: &generator)
      let alphabet: [UInt8] = Array("StreamTitle='; -".utf8) + [0, 0x92, 0xC3, 0xE9]
      let bytes = (0..<length).map { _ in alphabet.randomElement(using: &generator)! }
      _ = IcyParser.metadata(fromBlock: bytes, format: .artistTitle)
    }
  }

  func testBackoffSequence() {
    var backoff = Backoff(random: { 0.5 })
    XCTAssertEqual((0..<7).map { _ in backoff.next() }, [1000, 2000, 4000, 8000, 16000, 30000, 30000])
    backoff.reset()
    XCTAssertEqual(backoff.next(), 1000)
    var low = Backoff(random: { 0 })
    var high = Backoff(random: { 0.999999 })
    XCTAssertEqual(low.next(), 800)
    XCTAssertEqual(high.next(), 1200)
  }

  static func bytes(_ hex: String) -> [UInt8] {
    var out: [UInt8] = []
    var index = hex.startIndex
    while index < hex.endIndex {
      let next = hex.index(index, offsetBy: 2)
      out.append(UInt8(hex[index..<next], radix: 16)!)
      index = next
    }
    return out
  }
}
