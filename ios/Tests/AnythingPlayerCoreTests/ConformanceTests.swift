import Foundation
import XCTest

@testable import AnythingPlayerCore

/// Runs every scenario in `conformance/*.json` (shared with the Kotlin engine).
final class ConformanceTests: XCTestCase {
  private static var conformanceDirectory: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // AnythingPlayerCoreTests
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
      if let v = o["fadeInMs"] as? NSNumber { options.fadeInMs = v.int64Value }
      if let v = o["fadeOutMs"] as? NSNumber { options.fadeOutMs = v.int64Value }
      if let v = o["video"] { options.video = Self.videoOptions(v) }
    }
    let h = EngineHarness(options: options)
    let steps = try XCTUnwrap(scenario["steps"] as? [[String: Any]], name)
    for (index, step) in steps.enumerated() {
      let at = "\(name) [step \(index)]"
      try apply(step, to: h, at: at)
    }
    XCTAssertEqual(h.recorder.violations, [], "\(name): event ordering")
  }

  /// `"video": true` or partial `VideoEngineOptions` (`"fallback": true` takes its defaults).
  private static func videoOptions(_ value: Any) -> VideoEngineOptions {
    var v = VideoEngineOptions()
    guard let o = value as? [String: Any] else { return v }
    if let mode = o["whenBackgrounded"] as? String { v.whenBackgrounded = BackgroundMode(rawValue: mode) ?? .pause }
    if let b = o["ambient"] as? Bool { v.ambient = b }
    if let b = o["keepAwake"] as? Bool { v.keepAwake = b }
    if let b = o["focusWhenMuted"] as? Bool { v.focusWhenMuted = b }
    if (o["fallback"] as? Bool) == true { v.fallback = FallbackPolicy() }
    if let f = o["fallback"] as? [String: Any] {
      var policy = FallbackPolicy()
      if let ms = f["dropAfterMs"] as? NSNumber { policy.dropAfterMs = ms.int64Value }
      v.fallback = policy
    }
    if let t = o["tracks"] as? [String: Any] {
      v.tracks.languages = t["languages"] as? [String] ?? []
      v.tracks.followSystem = t["followSystem"] as? Bool ?? true
    }
    if let q = o["quality"] as? [String: Any] {
      v.quality.maxHeight = (q["maxHeight"] as? NSNumber)?.intValue
      v.quality.maxBitrate = (q["maxBitrate"] as? NSNumber)?.int64Value
      v.quality.cellularMaxHeight = (q["cellularMaxHeight"] as? NSNumber)?.intValue
      v.quality.cellularMaxBitrate = (q["cellularMaxBitrate"] as? NSNumber)?.int64Value
      switch q["startQuality"] {
      case let s as String where s == "lowest": v.quality.startQuality = .lowest
      case let s as String where s == "highest": v.quality.startQuality = .highest
      case let n as NSNumber: v.quality.startQuality = .height(n.intValue)
      default: v.quality.startQuality = .auto
      }
      if let b = q["followDataSaver"] as? Bool { v.quality.followDataSaver = b }
      if let b = q["capToView"] as? Bool { v.quality.capToView = b }
    }
    return v
  }

  private static func renditions(_ value: Any?) -> [Rendition]? {
    guard let list = value as? [[String: Any]] else { return nil }
    return list.map { r in
      Rendition(
        uri: r["uri"] as? String ?? "", height: (r["height"] as? NSNumber)?.intValue,
        bitrate: (r["bitrate"] as? NSNumber)?.int64Value, audioOnly: r["audioOnly"] as? Bool ?? false)
    }
  }

  static func tracks(_ value: Any?) -> [MediaTrack] {
    (value as? [[String: Any]] ?? []).map { t in
      MediaTrack(
        id: t["id"] as? String ?? "", kind: TrackKind(rawValue: t["kind"] as? String ?? "") ?? .subtitles,
        language: t["language"] as? String, forced: t["forced"] as? Bool ?? false,
        isDefault: t["default"] as? Bool ?? false, sdh: t["sdh"] as? Bool ?? false,
        describesVideo: t["describesVideo"] as? Bool ?? false)
    }
  }

  private static func variants(_ value: Any?) -> [VideoVariant] {
    (value as? [[String: Any]] ?? []).map { v in
      VideoVariant(
        id: v["id"] as? String ?? "", height: (v["height"] as? NSNumber)?.intValue,
        bitrate: (v["bitrate"] as? NSNumber)?.int64Value, audioOnly: v["audioOnly"] as? Bool ?? false)
    }
  }

  private static func source(_ step: [String: Any], _ h: EngineHarness, refreshable: Bool) -> SourceDescriptor {
    SourceDescriptor(
      uri: step["uri"] as? String ?? "", headers: [:], liveHint: step["live"] as? Bool,
      renditions: renditions(step["renditions"]), refreshable: refreshable,
      expiresAt: (step["expiresIn"] as? NSNumber).map { h.clock.wallMs + $0.int64Value })
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
      if native == "playing" && gen == h.driver.swapGeneration {
        h.driver.completeSwap()
        h.engine.onPlaying(generation: gen)
        return
      }
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
            code: code, message: "test", recoverable: step["recoverable"] as? Bool ?? false,
            httpStatus: (step["httpStatus"] as? NSNumber)?.intValue))
      case "bandwidth":
        h.engine.onBandwidth(generation: gen, bitsPerSecond: (step["bps"] as? NSNumber)?.doubleValue ?? 0)
      case "variants":
        h.engine.onVariants(generation: gen, variants: Self.variants(step["variants"]))
      case "videoInfo":
        h.engine.onVideoInfo(
          generation: gen,
          info: VideoInfo(
            width: (step["width"] as? NSNumber)?.intValue ?? 0,
            height: (step["height"] as? NSNumber)?.intValue ?? 0, hdr: step["hdr"] as? Bool ?? false,
            variantId: step["variant"] as? String))
      case "firstFrame":
        h.engine.onFirstFrame(generation: gen)
      case "tracks":
        h.engine.onTracks(generation: gen, tracks: Self.tracks(step["tracks"]))
      case "renditionInfo":
        h.engine.renditionInfo(
          index: (step["index"] as? NSNumber)?.intValue ?? 0, height: (step["height"] as? NSNumber)?.intValue,
          bitrate: (step["bitrate"] as? NSNumber)?.int64Value)
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
      case "loaded": h.driver.setMotion(.loaded, buffered: (step["value"] as? NSNumber)?.doubleValue ?? 0)
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
    } else if let route = step["route"] as? String {
      h.engine.routeChanged(
        AudioRoute(
          kind: AudioRouteKind(rawValue: route) ?? .unknown, name: step["name"] as? String))
    } else if let view = step["view"] as? [String: Any] {
      h.engine.viewChanged(
        ViewState(
          attached: view["attached"] as? Bool ?? true, visible: view["visible"] as? Bool ?? true,
          width: (view["width"] as? NSNumber)?.intValue ?? 0, height: (view["height"] as? NSNumber)?.intValue ?? 0))
    } else if let system = step["system"] as? [String: Any] {
      h.engine.systemPreferencesChanged(
        SystemPreferences(
          languages: system["languages"] as? [String] ?? [], captions: system["captions"] as? Bool ?? false,
          audioDescriptions: system["audioDescriptions"] as? Bool ?? false))
    } else if let fullscreen = step["fullscreen"] as? Bool {
      h.engine.fullscreenChanged(fullscreen)
    } else if let pip = step["pip"] as? Bool {
      h.engine.pictureInPictureChanged(pip)
    } else if let cost = step["networkCost"] as? [String: Any] {
      h.engine.networkCostChanged(
        metered: cost["metered"] as? Bool ?? false, saveData: cost["saveData"] as? Bool ?? false)
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
      let source = Self.source(step, h, refreshable: step["refreshable"] as? Bool ?? false)
      try h.engine.load(
        source, autoplay: step["autoplay"] as? Bool,
        startPosition: (step["start"] as? NSNumber)?.doubleValue)
    case "background": h.engine.appBackgrounded()
    case "selectQuality": try h.engine.selectQuality(step["id"] as? String)
    case "listenOnly": try h.engine.setListenOnly(step["value"] as? Bool ?? false)
    case "loop": try h.engine.setLoop(step["value"] as? Bool ?? false)
    case "sourceRefreshed":
      h.engine.sourceRefreshed(loadId: h.engine.loadId, source: Self.source(step, h, refreshable: true))
    case "sourceRefreshFailed": h.engine.sourceRefreshFailed(loadId: h.engine.loadId)
    case "appTracks": h.engine.setAppTracks(Self.tracks(step["tracks"]))
    case "selectAudioTrack": try h.engine.selectAudioTrack(step["id"] as? String)
    case "selectTextTrack": try h.engine.selectTextTrack(step["id"] as? String)
    case "subtitleDelay": try h.engine.setSubtitleDelay(value)
    case "play": try h.engine.play()
    case "pause": try h.engine.pause()
    case "stop": try h.engine.stop()
    case "reset": try h.engine.reset()
    case "release": h.engine.release()
    case "seek": try h.engine.seek(to: value, exact: step["exact"] as? Bool ?? false)
    case "volume": try h.engine.setVolume(value)
    case "muted": try h.engine.setMuted(step["value"] as? Bool ?? false)
    case "rate": try h.engine.setRate(value)
    case "duck": h.engine.setDucked(step["value"] as? Bool ?? false)
    case "foreground": h.engine.appForegrounded()
    case "fadeTo":
      let recorder = h.recorder
      try h.engine.fadeTo(value, durationMs: (step["ms"] as? NSNumber)?.doubleValue ?? 0) {
        recorder.fades += 1
      }
    case "sleep":
      try h.engine.sleep(
        afterMs: (step["after"] as? NSNumber)?.doubleValue,
        fadeOutMs: (step["fadeOut"] as? NSNumber)?.doubleValue)
    case "setFades":
      try h.engine.setFades(
        inMs: (step["in"] as? NSNumber)?.doubleValue ?? 0,
        outMs: (step["out"] as? NSNumber)?.doubleValue ?? 0)
    case "handoff":
      h.engine.handoff(
        route: AudioRoute(
          kind: AudioRouteKind(rawValue: step["route"] as? String ?? "") ?? .unknown,
          name: step["name"] as? String),
        outputId: step["output"] as? String ?? "",
        resume: step["resume"] as? Bool ?? false)
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
      case "route": XCTAssertEqual(s.route.kind.rawValue, value as? String, "\(at): route")
      case "routeName": XCTAssertEqual(s.route.name, value as? String, "\(at): routeName")
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
      case "volume": XCTAssertEqual(s.volume, (value as? NSNumber)?.doubleValue, "\(at): volume")
      case "sleepAt":
        XCTAssertEqual(
          s.sleepAt.map { $0 - wallBase }, (value as? NSNumber)?.int64Value, "\(at): sleepAt")
      case "sleeps": XCTAssertEqual(h.recorder.sleeps, (value as? NSNumber)?.intValue, "\(at): sleeps")
      case "fades": XCTAssertEqual(h.recorder.fades, (value as? NSNumber)?.intValue, "\(at): fades")
      case "orderedCommands":
        orderedCommands(at, expected: value as? [String] ?? [], actual: h.driver.commands)
      case "video": videoExpect(at, s.video, value as? [String: Any])
      case "wantsMediaSession":
        XCTAssertEqual(h.engine.wantsMediaSession, value as? Bool, "\(at): wantsMediaSession")
      case "wantsScreenAwake":
        XCTAssertEqual(h.engine.wantsScreenAwake, value as? Bool, "\(at): wantsScreenAwake")
      case "refreshes": XCTAssertEqual(h.recorder.refreshes, value as? [String], "\(at): refreshes")
      case "gen": XCTAssertEqual(h.engine.generation, (value as? NSNumber)?.intValue, "\(at): gen")
      case "stats": statsExpect(at, h.engine.stats, value as? [String: Any] ?? [:])
      default: XCTFail("\(at): unknown expectation \(key)")
      }
    }
    h.recorder.refreshes.removeAll()
    h.driver.commands.removeAll()
    h.recorder.loads.removeAll()
    h.recorder.errors.removeAll()
    h.recorder.ended = 0
    h.recorder.sleeps = 0
    h.recorder.fades = 0
  }

  /// Compares the listed `status.video` fields (`qualities` as their ids).
  private func videoExpect(_ at: String, _ video: VideoStatus?, _ expected: [String: Any]?) {
    guard let expected else { return XCTAssertNil(video, "\(at): video") }
    guard let video else { return XCTFail("\(at): no status.video") }
    for (key, want) in expected {
      let label = "\(at): video.\(key)"
      switch key {
      case "width": XCTAssertEqual(video.width, (want as? NSNumber)?.intValue, label)
      case "height": XCTAssertEqual(video.height, (want as? NSNumber)?.intValue, label)
      case "hdr": XCTAssertEqual(video.hdr, want as? Bool, label)
      case "firstFrame": XCTAssertEqual(video.firstFrame, want as? Bool, label)
      case "audioOnly": XCTAssertEqual(video.audioOnly?.rawValue, want as? String, label)
      case "pictureInPicture": XCTAssertEqual(video.pictureInPicture, want as? Bool, label)
      case "quality": XCTAssertEqual(video.quality, want as? String, label)
      case "selectedQuality": XCTAssertEqual(video.selectedQuality, want as? String, label)
      case "qualities": XCTAssertEqual(video.qualities.map(\.id), want as? [String], label)
      case "tracks": XCTAssertEqual(video.tracks.map(\.id), want as? [String], label)
      case "audioTrack": XCTAssertEqual(video.audioTrack, want as? String, label)
      case "textTrack": XCTAssertEqual(video.textTrack, want as? String, label)
      case "subtitleDelay": XCTAssertEqual(video.subtitleDelay, (want as? NSNumber)?.doubleValue, label)
      case "fullscreen": XCTAssertEqual(video.fullscreen, want as? Bool, label)
      default: XCTFail("\(at): unknown video expectation \(key)")
      }
    }
  }

  private func statsExpect(_ at: String, _ stats: EngineStats, _ expected: [String: Any]) {
    for (key, want) in expected {
      let value = (want as? NSNumber)?.int64Value
      let label = "\(at): stats.\(key)"
      switch key {
      case "startupMs": XCTAssertEqual(stats.startupMs, value, label)
      case "rebufferCount": XCTAssertEqual(Int64(stats.rebufferCount), value, label)
      case "rebufferMs": XCTAssertEqual(stats.rebufferMs, value, label)
      case "qualitySwitches": XCTAssertEqual(Int64(stats.qualitySwitches), value, label)
      case "audioOnlySwitches": XCTAssertEqual(Int64(stats.audioOnlySwitches), value, label)
      default: XCTFail("\(at): unknown stats expectation \(key)")
      }
    }
  }

  /// Ordered commands: each entry must match (as a string prefix) a recorded
  /// command at or after the previous match — a subsequence, not a run.
  private func orderedCommands(
    _ at: String, expected: [String], actual: [String]
  ) {
    var cursor = 0
    for pattern in expected {
      while cursor < actual.count, !actual[cursor].hasPrefix(pattern) { cursor += 1 }
      XCTAssertTrue(
        cursor < actual.count,
        "\(at): orderedCommands: no command starting with \"\(pattern)\" at or after index \(cursor) in \(actual)")
      cursor += 1
    }
  }
}
