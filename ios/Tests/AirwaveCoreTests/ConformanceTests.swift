import Foundation
import XCTest

@testable import AirwaveCore

/// Runs every scenario in `conformance/*.json` (shared with the Kotlin engine).
final class ConformanceTests: XCTestCase {
  private static var conformanceDirectory: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // AirwaveCoreTests
      .deletingLastPathComponent()  // Tests
      .deletingLastPathComponent()  // ios
      .deletingLastPathComponent()  // repo root
      .appendingPathComponent("conformance")
  }

  func testAllScenarios() throws {
    let files = try FileManager.default.contentsOfDirectory(
      at: Self.conformanceDirectory, includingPropertiesForKeys: nil
    ).filter { $0.pathExtension == "json" }.sorted { $0.path < $1.path }
    XCTAssertFalse(files.isEmpty, "no conformance files found")
    var count = 0
    for file in files {
      let data = try Data(contentsOf: file)
      let scenarios = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [[String: Any]])
      for scenario in scenarios {
        count += 1
        let name = "\(file.lastPathComponent) › \(scenario["name"] as? String ?? "?")"
        try run(scenario, name: name)
      }
    }
    print("conformance: \(count) scenarios")
  }

  private func run(_ scenario: [String: Any], name: String) throws {
    var options = EngineOptions()
    if let o = scenario["options"] as? [String: Any] {
      if let v = o["giveUpAfterMs"] as? NSNumber { options.giveUpAfterMs = v.int64Value }
      if let v = o["reconnect"] as? Bool { options.reconnect = v }
      if let v = o["autoResumeAfterInterruption"] as? Bool { options.autoResumeAfterInterruption = v }
      if let v = o["liveMaxDriftMs"] as? NSNumber { options.liveMaxDriftMs = v.int64Value }
    }
    let h = EngineHarness(options: options)
    let steps = try XCTUnwrap(scenario["steps"] as? [[String: Any]], name)
    for (index, step) in steps.enumerated() {
      let at = "\(name) [step \(index)]"
      try apply(step, to: h, at: at)
    }
    XCTAssertEqual(h.recorder.violations, [], "\(name): event ordering")
  }

  private func apply(_ step: [String: Any], to h: EngineHarness, at: String) throws {
    if let call = step["call"] as? String {
      let expectedThrow = step["throws"] as? String
      do {
        try perform(call, step, h)
        if let expectedThrow { XCTFail("\(at): expected \(expectedThrow) to be thrown") }
      } catch let error as PlayerError {
        XCTAssertEqual(error.code.rawValue, expectedThrow, "\(at): unexpected throw")
      }
    } else if let focus = step["focus"] as? String {
      h.recorder.focus = focus == "denied" ? .denied : focus == "delayed" ? .delayed : .granted
    } else if let native = step["native"] as? String {
      var gen = h.engine.generation
      if let g = step["gen"] as? NSNumber { gen = g.intValue }
      if (step["gen"] as? String) == "prev" { gen = h.engine.generation - 1 }
      switch native {
      case "ready":
        let duration = (step["duration"] as? NSNumber)?.doubleValue
        h.engine.onReady(
          generation: gen,
          info: ReadyInfo(
            duration: duration, isLive: step["live"] as? Bool ?? false,
            seekable: step["seekable"] as? Bool ?? false))
      case "playing":
        if h.engine.accepts(gen) { h.driver.setMotion(.flowing) }
        h.engine.onPlaying(generation: gen)
      case "buffering":
        if h.engine.accepts(gen) { h.driver.setMotion(.frozen) }
        h.engine.onBuffering(generation: gen)
      case "ended":
        if h.engine.accepts(gen) { h.driver.setMotion(.frozen) }
        h.engine.onEnded(generation: gen)
      case "failed":
        if h.engine.accepts(gen) { h.driver.setMotion(.frozen) }
        let code = try XCTUnwrap(ErrorCode(rawValue: step["code"] as? String ?? ""), at)
        h.engine.onFailed(
          generation: gen,
          error: PlayerError(
            code: code, message: "test", recoverable: step["recoverable"] as? Bool ?? false))
      case "pausedExternally":
        let reason = InterruptionReason(rawValue: step["reason"] as? String ?? "") ?? .system
        h.engine.onPausedExternally(generation: gen, reason: reason)
      default:
        XCTFail("\(at): unknown native step \(native)")
      }
    } else if let driver = step["driver"] as? String {
      switch driver {
      case "flowing": h.driver.setMotion(.flowing)
      case "frozen": h.driver.setMotion(.frozen)
      case "trickle": h.driver.setMotion(.trickle)
      case "reentrant": h.driver.reentrant = true
      case "position": h.driver.setPosition((step["value"] as? NSNumber)?.doubleValue ?? 0)
      default: XCTFail("\(at): unknown driver step \(driver)")
      }
    } else if let interruption = step["interruption"] as? String {
      if interruption == "began" {
        let reason = try XCTUnwrap(InterruptionReason(rawValue: step["reason"] as? String ?? ""), at)
        h.engine.interruptionBegan(reason: reason, resumable: step["resumable"] as? Bool ?? false)
      } else {
        h.engine.interruptionEnded(shouldResume: step["shouldResume"] as? Bool ?? false)
      }
    } else if let network = step["network"] as? String {
      h.engine.networkChanged(
        network == "online" ? .online : network == "offline" ? .offline : .unknown,
        interfaceChanged: step["handoff"] as? Bool ?? false)
    } else if step["platformReset"] != nil {
      h.engine.platformReset()
    } else if let ms = step["advance"] as? NSNumber {
      h.advance(ms.int64Value)
    } else if let expect = step["expect"] as? [String: Any] {
      check(expect, h, at)
    } else {
      XCTFail("\(at): unknown step \(step)")
    }
  }

  private func perform(_ call: String, _ step: [String: Any], _ h: EngineHarness) throws {
    let value = (step["value"] as? NSNumber)?.doubleValue ?? 0
    switch call {
    case "load":
      let source = SourceDescriptor(
        uri: step["uri"] as? String ?? "", headers: [:], liveHint: step["live"] as? Bool)
      try h.engine.load(
        source, autoplay: step["autoplay"] as? Bool,
        startPosition: (step["start"] as? NSNumber)?.doubleValue)
    case "play": try h.engine.play()
    case "pause": try h.engine.pause()
    case "stop": try h.engine.stop()
    case "reset": try h.engine.reset()
    case "release": h.engine.release()
    case "seek": try h.engine.seek(to: value)
    case "volume": try h.engine.setVolume(value)
    case "muted": try h.engine.setMuted(step["value"] as? Bool ?? false)
    case "rate": try h.engine.setRate(value)
    case "duck": h.engine.setDucked(step["value"] as? Bool ?? false)
    case "foreground": h.engine.appForegrounded()
    default: XCTFail("unknown call \(call)")
    }
  }

  private func check(_ expect: [String: Any], _ h: EngineHarness, _ at: String) {
    let s = h.engine.status
    for (key, value) in expect {
      switch key {
      case "state": XCTAssertEqual(s.state.rawValue, value as? String, "\(at): state")
      case "playWhenReady": XCTAssertEqual(s.playWhenReady, value as? Bool, "\(at): playWhenReady")
      case "isLive": XCTAssertEqual(s.isLive, value as? Bool, "\(at): isLive")
      case "seekable": XCTAssertEqual(s.seekable, value as? Bool, "\(at): seekable")
      case "duration":
        XCTAssertEqual(s.duration, (value as? NSNumber)?.doubleValue, "\(at): duration")
      case "interruption":
        XCTAssertEqual(s.interruption?.reason.rawValue, value as? String, "\(at): interruption")
      case "interruptionResumable":
        XCTAssertEqual(s.interruption?.resumable, value as? Bool, "\(at): interruptionResumable")
      case "error": XCTAssertEqual(s.error?.code.rawValue, value as? String, "\(at): error")
      case "reconnectAttempt":
        XCTAssertEqual(s.reconnect?.attempt, (value as? NSNumber)?.intValue, "\(at): reconnectAttempt")
      case "commands": XCTAssertEqual(h.driver.commands, value as? [String], "\(at): commands")
      case "loads": XCTAssertEqual(h.recorder.loads, value as? [String], "\(at): loads")
      case "errors": XCTAssertEqual(h.recorder.errors, value as? [String], "\(at): errors")
      case "ended": XCTAssertEqual(h.recorder.ended, (value as? NSNumber)?.intValue, "\(at): ended")
      case "wantsKeepalive":
        XCTAssertEqual(h.engine.wantsKeepalive, value as? Bool, "\(at): wantsKeepalive")
      case "needsAudioFocus":
        XCTAssertEqual(h.engine.needsAudioFocus, value as? Bool, "\(at): needsAudioFocus")
      default: XCTFail("\(at): unknown expectation \(key)")
      }
    }
    h.driver.commands.removeAll()
    h.recorder.loads.removeAll()
    h.recorder.errors.removeAll()
    h.recorder.ended = 0
  }
}
