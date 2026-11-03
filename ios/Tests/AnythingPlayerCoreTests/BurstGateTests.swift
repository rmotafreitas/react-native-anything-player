import XCTest

@testable import AnythingPlayerCore

/// The burst gate holds a live switch's new connection, counts its frames,
/// and lets it through from a frame boundary.
final class BurstGateTests: XCTestCase {
  /// One MPEG-1 Layer III frame: 128 kbps, 44.1 kHz, no padding (417 bytes, 1152 samples).
  private static func mp3Frame(_ fill: UInt8) -> [UInt8] {
    var frame = [UInt8](repeating: fill, count: 417)
    frame[0] = 0xFF
    frame[1] = 0xFB
    frame[2] = 0x90
    frame[3] = 0x00
    return frame
  }

  /// One ADTS AAC-LC frame: 44.1 kHz, stereo, `length` bytes, 1024 samples.
  private static func adtsFrame(_ length: Int, _ fill: UInt8) -> [UInt8] {
    var frame = [UInt8](repeating: fill, count: length)
    frame[0] = 0xFF
    frame[1] = 0xF1
    frame[2] = 0x50  // AAC LC, 44.1 kHz
    frame[3] = 0x80 | UInt8((length >> 11) & 3)
    frame[4] = UInt8((length >> 3) & 0xFF)
    frame[5] = UInt8((length & 7) << 5) | 0x1F
    frame[6] = 0xFC
    return frame
  }

  private let mp3Seconds = 1152.0 / 44100

  func testHoldsAndCountsWholeFramesAcrossChunks() {
    let gate = BurstGate()
    let audio = (0..<10).flatMap { Self.mp3Frame(UInt8($0)) }
    XCTAssertNil(gate.pass(Array(audio[0..<1000]), contentType: "audio/mpeg"))
    XCTAssertEqual(gate.heldSeconds!, 2 * mp3Seconds, accuracy: 1e-9)
    XCTAssertNil(gate.pass(Array(audio[1000...]), contentType: "audio/mpeg"))
    XCTAssertEqual(gate.heldSeconds!, 10 * mp3Seconds, accuracy: 1e-9)
  }

  func testOpensFromTheFirstFrameAtOrAfterThePointAndRelaysTheRest() {
    let gate = BurstGate()
    let frames = (0..<10).map { Self.mp3Frame(UInt8($0)) }
    let a = Array("StreamTitle='A';".utf8)
    let b = Array("StreamTitle='B';".utf8)
    let c = Array("StreamTitle='C';".utf8)
    // A before frame 1, B before frame 3 (both cut away), C before frame 6.
    let blocks = [(offset: 417, bytes: a), (offset: 3 * 417, bytes: b), (offset: 6 * 417, bytes: c)]
    XCTAssertNil(gate.pass(frames.flatMap { $0 }, blocks: blocks, contentType: "audio/mpeg"))
    let dropped = gate.requestOpen(from: 3.5 * mp3Seconds)
    XCTAssertEqual(dropped, 4 * mp3Seconds, accuracy: 1e-9)
    XCTAssertNil(gate.heldSeconds)
    let out = gate.flush()
    XCTAssertEqual(out?.audio, frames[4...].flatMap { $0 })
    // The title in effect at the cut first; the later one where it was.
    XCTAssertEqual(out?.blocks.map { $0.offset }, [0, 2 * 417])
    XCTAssertEqual(out?.blocks.map { $0.bytes }, [b, c])
    // Open: what comes next goes through as it is.
    XCTAssertEqual(gate.pass([1, 2, 3], contentType: "audio/mpeg")?.audio, [1, 2, 3])
    XCTAssertNil(gate.flush())
  }

  func testAnOpenAskedBeforeTheProxyRelaysIsAppliedToTheNextAudioInOrder() {
    let gate = BurstGate()
    let frames = (0..<4).map { Self.mp3Frame(UInt8($0)) }
    XCTAssertNil(gate.pass(frames[0] + frames[1], contentType: "audio/mpeg"))
    XCTAssertEqual(gate.requestOpen(from: 0), 0)
    // The next audio arrives before the flush: it comes after the held audio.
    let out = gate.pass(frames[2] + frames[3], contentType: "audio/mpeg")
    XCTAssertEqual(out?.audio, frames.flatMap { $0 })
    XCTAssertNil(gate.flush())
  }

  func testCountsAdtsAndResyncsPastGarbage() {
    let gate = BurstGate()
    let audio = [0x00, 0x12, 0x34] + Self.adtsFrame(300, 1) + Self.adtsFrame(280, 2)
    XCTAssertNil(gate.pass(audio, contentType: "audio/aacp"))
    XCTAssertEqual(gate.heldSeconds!, 2 * 1024.0 / 44100, accuracy: 1e-9)
    XCTAssertEqual(gate.requestOpen(from: 0.01), 1024.0 / 44100, accuracy: 1e-9)
    XCTAssertEqual(gate.flush()?.audio, Self.adtsFrame(280, 2))
  }

  func testAFormatItCannotCountGoesThroughAtOnce() {
    let gate = BurstGate()
    let ogg: [UInt8] = Array("OggS".utf8) + [0, 2, 0, 0]
    XCTAssertEqual(gate.pass(ogg, contentType: "audio/ogg")?.audio, ogg)
    XCTAssertNil(gate.heldSeconds)
  }

  func testOpensByItselfPastItsLimit() {
    let gate = BurstGate()
    let frame = Self.mp3Frame(7)
    var relayed = 0
    for _ in 0..<(BurstGate.limitBytes / frame.count + 2) {
      relayed += gate.pass(frame, contentType: "audio/mpeg")?.audio.count ?? 0
    }
    XCTAssertGreaterThan(relayed, BurstGate.limitBytes)
  }
}
