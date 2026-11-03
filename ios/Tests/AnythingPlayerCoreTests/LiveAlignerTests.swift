import Foundation
import XCTest

@testable import AnythingPlayerCore

/// The live aligner against `conformance/align/live.json` (twins:
/// `src/web/__tests__/liveAligner.test.ts`, `LiveAlignerTest.kt`): each case
/// runs a simulated pair of connections, the old one heard and the new one
/// muted, and checks how the aligner lines them up.
final class LiveAlignerTests: XCTestCase {
  private struct Outcome {
    let outcome: String
    let at: Int64
    let actions: [String]
    let residual: Double?
  }

  private static let tickMs: Int64 = 40
  private static let limitMs: Int64 = 60_000

  private static var fixtures: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // AnythingPlayerCoreTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // ios
      .deletingLastPathComponent()  // repo root
      .appendingPathComponent("conformance/align/live.json")
  }

  func testFixtures() throws {
    let data = try Data(contentsOf: Self.fixtures)
    let cases = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
    XCTAssertFalse(cases.isEmpty)
    for c in cases {
      let name = c["name"] as? String ?? "?"
      let caps = try XCTUnwrap(c["caps"] as? [String: Any])
      let world = try XCTUnwrap(c["world"] as? [String: Any])
      let expect = try XCTUnwrap(c["expect"] as? [String: Any])
      let result = Self.simulate(
        LiveAligner.Caps(
          maxRate: Self.number(caps["maxRate"]), minRate: Self.number(caps["minRate"]),
          jump: try XCTUnwrap(LiveAligner.Jump(rawValue: caps["jump"] as? String ?? "")),
          startLead: Self.number(caps["startLead"]), jumpLead: Self.number(caps["jumpLead"])),
        world)
      XCTAssertEqual(result.outcome, expect["outcome"] as? String, name)
      XCTAssertEqual(result.at, Int64(Self.number(expect["at"])), name)
      XCTAssertEqual(result.actions, expect["actions"] as? [String], name)
      if let limit = expect["maxResidual"] {
        XCTAssertLessThanOrEqual(abs(try XCTUnwrap(result.residual, name)), Self.number(limit), name)
      }
    }
  }

  private static func number(_ value: Any?) -> Double { (value as? NSNumber)?.doubleValue ?? .nan }

  /// The time of the last chunk at `t`: chunks arrive every `every` ms from `phase`.
  private static func lastChunk(_ t: Int64, _ every: Int64, _ phase: Int64) -> Int64 {
    Int64((Double(t - phase) / Double(every)).rounded(.down)) * every + phase
  }

  private static func optionalMs(_ value: Any?) -> Int64? { (value as? NSNumber).map { $0.int64Value } }

  /// The readings every tick, the aligner's answers applied (see the TypeScript twin).
  private static func simulate(_ caps: LiveAligner.Caps, _ w: [String: Any]) -> Outcome {
    let aligner = LiveAligner(caps: caps)
    var actions: [String] = []
    func note(_ kind: String) { if actions.last != kind { actions.append(kind) } }
    let oldPositionAt0 = number(w["oldPosition"])
    let oldLag = number(w["oldLag"])
    let burst = number(w["burst"])
    let burstSpeed = number(w["burstSpeed"])
    let chunkMs = Int64(number(w["chunkMs"]))
    let startLatencyMs = Int64(number(w["startLatencyMs"]))
    let endsAfterBurst = w["endsAfterBurst"] as? Bool ?? false
    let stallAt = optionalMs(w["oldStallAt"])
    let reconnectingAt = optionalMs(w["oldReconnectingAt"])
    let interruptAt = optionalMs(w["interruptAt"])
    let readyAt = optionalMs(w["nextReadyAt"])
    let oldChunkMs = optionalMs(w["oldChunkMs"]) ?? chunkMs
    let nextChunkMs = optionalMs(w["nextChunkMs"]) ?? chunkMs
    let oldPhaseMs = optionalMs(w["oldPhaseMs"]) ?? 0
    let nextPhaseMs = optionalMs(w["nextPhaseMs"]) ?? 0
    let jitter = w["positionJitter"].map { number($0) } ?? 0
    let appRate = w["appRate"].map { number($0) } ?? 1
    let arrival = w["edgeArrival"] as? Bool ?? false
    let ticks = (w["ticksMs"] as? [NSNumber])?.map { $0.int64Value } ?? [tickMs]
    var i = 0
    let k = burst - oldPositionAt0 - oldLag
    var x = 0.0
    var rate = 0.0
    var moveFrom: Int64?
    var lastT: Int64 = 0
    var t: Int64 = 0
    while t <= limitMs {
      if rate > 0, let from = moveFrom {
        let start = max(lastT, from)
        if t > start { x += (rate * appRate * Double(t - start)) / 1000 }
      }
      let tq = max(0, lastChunk(t, nextChunkMs, nextPhaseMs))
      let arrived = (burstSpeed * Double(tq)) / 1000
      let received = endsAfterBurst ? min(arrived, burst) : min(arrived, burst + Double(tq) / 1000)
      x = min(x, received)
      let stalled = stallAt.map { t >= $0 } ?? false
      let oldT = stalled ? stallAt! : t
      let oldTq = lastChunk(oldT, oldChunkMs, oldPhaseMs)
      let oldPosition = oldPositionAt0 + (appRate * Double(oldT)) / 1000
      let old = LiveAligner.Reading(
        position: oldPosition, edge: oldPositionAt0 + oldLag + Double(oldTq) / 1000, playing: !stalled,
        reconnecting: reconnectingAt.map { t >= $0 } ?? false, edgeAt: arrival ? oldTq : nil)
      let moving = moveFrom.map { rate > 0 && t >= $0 && x < received } ?? false
      let next = LiveAligner.Reading(
        position: x + (i % 2 == 0 ? jitter : -jitter), edge: received, playing: moving, ready: readyAt.map { t >= $0 } ?? true,
        edgeAt: arrival ? tq : nil)
      let action = interruptAt.map { t >= $0 } == true ? aligner.interrupt() : aligner.step(t, old: old, next: next)
      lastT = t
      switch action {
      case .wait: break
      case .rate(let r, let afterMs):
        note("rate")
        if r == 0 {
          rate = 0
          moveFrom = nil
        } else {
          if rate == 0 { moveFrom = t + afterMs + startLatencyMs }
          rate = r
        }
      case .jump(let to):
        note("jump")
        x = min(to, received)
      case .takeOver:
        note("takeOver")
        return Outcome(outcome: "takeOver", at: t, actions: actions, residual: x - (oldPosition + k))
      case .fallback(let reason):
        note("fallback")
        return Outcome(outcome: "fallback:\(reason)", at: t, actions: actions, residual: nil)
      }
      t += ticks[i % ticks.count]
      i += 1
    }
    return Outcome(outcome: "none", at: limitMs, actions: actions, residual: nil)
  }
}
