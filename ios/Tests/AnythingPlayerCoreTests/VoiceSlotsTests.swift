import XCTest

@testable import AnythingPlayerCore

final class VoiceSlotsTests: XCTestCase {
  func testFreeSlotsAreUsedFirst() {
    var slots = VoiceSlots(capacity: 2)
    XCTAssertEqual(slots.acquire(voiceId: 10).slot, 0)
    let second = slots.acquire(voiceId: 11)
    XCTAssertEqual(second.slot, 1)
    XCTAssertNil(second.stolen)
    XCTAssertEqual(slots.busy, 2)
  }

  func testAFullSoundTakesTheSlotOfTheOldestVoice() {
    var slots = VoiceSlots(capacity: 2)
    _ = slots.acquire(voiceId: 1)
    _ = slots.acquire(voiceId: 2)
    let third = slots.acquire(voiceId: 3)
    XCTAssertEqual(third.stolen, 1)
    XCTAssertEqual(third.slot, 0)
    XCTAssertNil(slots.slot(of: 1))
    XCTAssertEqual(slots.slot(of: 3), 0)
    // Voice 2 is now the oldest.
    XCTAssertEqual(slots.acquire(voiceId: 4).stolen, 2)
  }

  func testAFreedSlotIsReusedBeforeStealing() {
    var slots = VoiceSlots(capacity: 2)
    _ = slots.acquire(voiceId: 1)
    _ = slots.acquire(voiceId: 2)
    slots.release(slot: 1, ownedBy: 2)
    let next = slots.acquire(voiceId: 3)
    XCTAssertEqual(next.slot, 1)
    XCTAssertNil(next.stolen)
  }

  func testAStolenVoiceDoesNotFreeTheNewOwnersSlot() {
    var slots = VoiceSlots(capacity: 1)
    _ = slots.acquire(voiceId: 1)
    _ = slots.acquire(voiceId: 2)  // steals slot 0
    slots.release(slot: 0, ownedBy: 1)  // the first voice's late completion
    XCTAssertEqual(slots.slot(of: 2), 0)
    XCTAssertEqual(slots.busy, 1)
  }

  func testReleaseAllReturnsThePlayingVoices() {
    var slots = VoiceSlots(capacity: 3)
    _ = slots.acquire(voiceId: 5)
    _ = slots.acquire(voiceId: 6)
    XCTAssertEqual(slots.releaseAll().sorted(), [5, 6])
    XCTAssertEqual(slots.busy, 0)
  }
}
