import XCTest

@testable import AirwaveCore

final class TrackClockTests: XCTestCase {
  func testAdvancesOnlyWhileRunning() {
    var clock = TrackClock(elapsed: 10, duration: 200, now: 0, running: true)
    XCTAssertEqual(clock.elapsed(now: 5_000), 15, accuracy: 0.001)
    clock.setRunning(false, now: 5_000)
    XCTAssertEqual(clock.elapsed(now: 60_000), 15, accuracy: 0.001)
    clock.setRunning(true, now: 60_000)
    XCTAssertEqual(clock.elapsed(now: 62_500), 17.5, accuracy: 0.001)
  }

  func testClampsToTheSong() {
    let early = TrackClock(elapsed: -3, duration: 30, now: 0, running: false)
    XCTAssertEqual(early.elapsed(now: 0), 0)
    let late = TrackClock(elapsed: 25, duration: 30, now: 0, running: true)
    XCTAssertEqual(late.elapsed(now: 60_000), 30)
    let past = TrackClock(elapsed: 99, duration: 30, now: 0, running: false)
    XCTAssertEqual(past.elapsed(now: 0), 30)
  }

  func testRepeatedStateIsIdempotent() {
    var clock = TrackClock(elapsed: 0, duration: 100, now: 0, running: true)
    clock.setRunning(true, now: 4_000)  // already running: keeps the original start
    XCTAssertEqual(clock.elapsed(now: 10_000), 10, accuracy: 0.001)
    clock.setRunning(false, now: 10_000)
    clock.setRunning(false, now: 20_000)
    XCTAssertEqual(clock.elapsed(now: 30_000), 10, accuracy: 0.001)
  }
}
