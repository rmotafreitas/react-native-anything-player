import XCTest

@testable import AirwaveCore

final class IcyFramingTests: XCTestCase {
  /// Builds an ICY body: `metaint` audio bytes, then a metadata block, repeated.
  private func body(metaint: Int, chunks: Int, titles: [String?]) -> (body: [UInt8], audio: [UInt8], blocks: [(Int64, String)]) {
    var body: [UInt8] = []
    var audio: [UInt8] = []
    var blocks: [(Int64, String)] = []
    for c in 0..<chunks {
      let slice = (0..<metaint).map { UInt8(truncatingIfNeeded: $0 &+ c * 7) }
      body += slice
      audio += slice
      if let title = titles[c % titles.count] {
        var payload = Array("StreamTitle='\(title)';".utf8)
        let length = (payload.count + 15) / 16
        payload += [UInt8](repeating: 0, count: length * 16 - payload.count)
        body.append(UInt8(length))
        body += payload
        blocks.append((Int64(audio.count), title))
      } else {
        body.append(0)
      }
    }
    return (body, audio, blocks)
  }

  func testDeinterleaveWholeBody() {
    let (input, audio, blocks) = body(metaint: 100, chunks: 6, titles: ["A - B", nil, "Ç - 日本"])
    var d = IcyDeinterleaver(metaint: 100)
    let out = d.consume(input)
    XCTAssertEqual(out.audio, audio)
    XCTAssertEqual(out.blocks.map(\.audioOffset), blocks.map(\.0))
    XCTAssertEqual(out.blocks.map { IcyParser.metadata(fromBlock: $0.bytes, format: .title).title }, blocks.map(\.1))
  }

  /// Any chunking must give exactly the same result as feeding everything at once.
  func testDeinterleaveRandomChunking() {
    let (input, audio, blocks) = body(metaint: 37, chunks: 40, titles: ["x", nil, "longer title - with words", nil, nil])
    for seed in 0..<300 {
      var generator = SplitMix(seed: UInt64(seed))
      var d = IcyDeinterleaver(metaint: 37)
      var gotAudio: [UInt8] = []
      var gotBlocks: [IcyDeinterleaver.Block] = []
      var i = 0
      while i < input.count {
        let n = min(input.count - i, Int(generator.next() % 64) + 1)
        let out = d.consume(Array(input[i..<(i + n)]))
        gotAudio += out.audio
        gotBlocks += out.blocks
        i += n
      }
      XCTAssertEqual(gotAudio, audio, "seed \(seed)")
      XCTAssertEqual(gotBlocks.map(\.audioOffset), blocks.map(\.0), "seed \(seed)")
    }
  }

  /// De-interleave → re-frame at the same cadence reproduces a valid ICY body
  /// whatever the chunking, and a reader of the re-framed body sees the same
  /// audio and titles.
  func testReframeRoundTrip() {
    let (input, audio, blocks) = body(metaint: 50, chunks: 30, titles: ["one", nil, nil, "two - three"])
    for seed in 0..<100 {
      var generator = SplitMix(seed: UInt64(seed))
      var upstream = IcyDeinterleaver(metaint: 50)
      var reframer = IcyReframer(metaint: 50)
      var downstream: [UInt8] = []
      var i = 0
      while i < input.count {
        let n = min(input.count - i, Int(generator.next() % 80) + 1)
        let out = upstream.consume(Array(input[i..<(i + n)]))
        downstream += reframer.frame(out, audioEnd: upstream.audioBytes)
        i += n
      }
      var reader = IcyDeinterleaver(metaint: 50)
      let read = reader.consume(downstream)
      // Same cadence, no splice: byte-identical, except the final boundary
      // marker (written only once audio follows it).
      XCTAssertTrue(downstream == Array(input.dropLast()), "seed \(seed)")
      XCTAssertEqual(read.audio, audio, "seed \(seed)")
      XCTAssertEqual(
        read.blocks.map { IcyParser.metadata(fromBlock: $0.bytes, format: .title).title },
        blocks.map(\.1), "seed \(seed)")
    }
  }

  /// Splicing a second upstream (framing restarts at zero) keeps the
  /// downstream framing valid.
  func testSpliceKeepsFraming() {
    let first = body(metaint: 40, chunks: 5, titles: ["first"])
    let second = body(metaint: 40, chunks: 5, titles: ["second"])
    var reframer = IcyReframer(metaint: 40)
    var downstream: [UInt8] = []
    var expectedAudio: [UInt8] = []
    // The first upstream is cut mid-interval, inside a metadata block (the server dropped it).
    for input in [Array(first.body.prefix(117)), second.body] {
      var d = IcyDeinterleaver(metaint: 40)
      let out = d.consume(input)
      downstream += reframer.frame(out, audioEnd: d.audioBytes)
      expectedAudio += out.audio
    }
    var reader = IcyDeinterleaver(metaint: 40)
    let read = reader.consume(downstream)
    XCTAssertEqual(expectedAudio.count, 80 + 200)
    XCTAssertEqual(read.audio, expectedAudio)
    let titles = read.blocks.compactMap { IcyParser.metadata(fromBlock: $0.bytes, format: .title).title }
    XCTAssertEqual(titles, ["first"] + Array(repeating: "second", count: 4))
  }

  func testGarbageNeverCrashes() {
    var generator = SplitMix(seed: 7)
    var d = IcyDeinterleaver(metaint: 16)
    var r = IcyReframer(metaint: 16)
    for _ in 0..<5_000 {
      let chunk = (0..<Int(generator.next() % 50)).map { _ in UInt8(truncatingIfNeeded: generator.next()) }
      _ = r.frame(d.consume(chunk), audioEnd: d.audioBytes)
    }
  }
}

/// Deterministic PRNG for reproducible fuzzing.
struct SplitMix {
  var state: UInt64
  init(seed: UInt64) { state = seed &+ 0x9E37_79B9_7F4A_7C15 }
  mutating func next() -> UInt64 {
    state = state &+ 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
