import Foundation
import XCTest

@testable import AnythingPlayerCore

/// DASH to HLS for AVPlayer against `conformance/dash/`: each manifest's
/// master and media playlists, written next to it as `<name>.hls/`.
final class DashToHlsTests: XCTestCase {
  private static var folder: URL {
    URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("conformance/dash")
  }

  /// Converts `name.mpd` (as served from `url`) and compares with `name.hls/`.
  /// `RNAP_WRITE_GOLDEN=1` writes the expected files instead.
  private func golden(_ name: String, url: String) throws -> DashToHls.Output {
    let mpd = try String(contentsOf: Self.folder.appendingPathComponent("\(name).mpd"), encoding: .utf8)
    let output = try DashToHls.convert(mpd, url: URL(string: url)!)
    let expected = Self.folder.appendingPathComponent("\(name).hls")
    let files = [("master.m3u8", output.master)] + output.media.map { ($0.name, $0.playlist) }
    if ProcessInfo.processInfo.environment["RNAP_WRITE_GOLDEN"] == "1" {
      try FileManager.default.createDirectory(at: expected, withIntermediateDirectories: true)
      for (file, text) in files { try text.write(to: expected.appendingPathComponent(file), atomically: true, encoding: .utf8) }
    }
    for (file, text) in files {
      let want = try String(contentsOf: expected.appendingPathComponent(file), encoding: .utf8)
      XCTAssertEqual(text, want, "\(name)/\(file)")
    }
    let listed = try FileManager.default.contentsOfDirectory(atPath: expected.path).sorted()
    XCTAssertEqual(listed, files.map(\.0).sorted(), "\(name): the playlists made")
    return output
  }

  func testCmafOnDemand() throws {
    let output = try golden("cmaf-vod", url: "https://cdn.example/ep1/manifest.mpd")
    XCTAssertFalse(output.live)
  }

  func testLive() throws {
    let output = try golden("live", url: "https://origin.example/live/manifest.mpd")
    XCTAssertTrue(output.live)
  }

  /// A live presentation of numbered segments (a duration, no timeline): its clock dates them too.
  func testLiveNumberedSegmentsCarryProgramDates() throws {
    let mpd = """
      <MPD type="dynamic" availabilityStartTime="2026-10-24T00:00:00Z"><Period start="PT10S" duration="PT6S">
      <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2"><SegmentTemplate timescale="1000" duration="2000"
      media="a-$Number$.m4s" initialization="a-init.mp4" startNumber="5"/><Representation id="a" bandwidth="1"/>
      </AdaptationSet></Period></MPD>
      """
    let output = try DashToHls.convert(mpd, url: URL(string: "https://x/m.mpd")!)
    let playlist = try XCTUnwrap(output.media.first { $0.name.hasPrefix("audio") }?.playlist)
    for date in ["00:00:10.000", "00:00:12.000", "00:00:14.000"] {
      XCTAssertTrue(playlist.contains("#EXT-X-PROGRAM-DATE-TIME:2026-10-24T\(date)Z"), date)
    }
  }

  /// Captions inside the picture are offered only where the manifest declares them.
  func testClosedCaptionsOnlyWhenDeclared() throws {
    func master(_ accessibility: String) throws -> String {
      let mpd = """
        <MPD type="static" mediaPresentationDuration="PT4S"><Period>
        <AdaptationSet mimeType="video/mp4" codecs="avc1.42c01e">\(accessibility)<SegmentTemplate timescale="1000"
        duration="2000" media="v-$Number$.m4s" initialization="v-init.mp4"/><Representation id="v" bandwidth="1"
        width="640" height="360"/></AdaptationSet></Period></MPD>
        """
      return try DashToHls.convert(mpd, url: URL(string: "https://x/m.mpd")!).master
    }
    XCTAssertTrue(try master("").contains("CLOSED-CAPTIONS=NONE"))
    XCTAssertFalse(
      try master(#"<Accessibility schemeIdUri="urn:scte:dash:cc:cea-608:2015" value="CC1=eng"/>"#)
        .contains("CLOSED-CAPTIONS"))
  }

  func testTemplates() {
    XCTAssertEqual(
      DashToHls.fill("$RepresentationID$/$Number%05d$-$Bandwidth$$$.m4s", id: "v1", bandwidth: 800, number: 42, time: nil),
      "v1/00042-800$.m4s")
    XCTAssertEqual(DashToHls.fill("t-$Time$.m4s", id: "a", bandwidth: 0, number: nil, time: 90000), "t-90000.m4s")
    XCTAssertEqual(DashToHls.fill("$Unknown$-$Number$", id: "a", bandwidth: 0, number: 3, time: nil), "$Unknown$-3")
  }

  func testDurations() {
    XCTAssertEqual(DashToHls.isoDuration("PT1M0.0S"), 60)
    XCTAssertEqual(DashToHls.isoDuration("PT4.5S"), 4.5)
    XCTAssertEqual(DashToHls.isoDuration("P1DT2H"), 93_600)
    XCTAssertNil(DashToHls.isoDuration("1M"))
    XCTAssertEqual(DashToHls.frameRate("30000/1001")!, 29.97, accuracy: 0.001)
  }

  func testRefusals() {
    let indexed = """
      <MPD type="static" mediaPresentationDuration="PT10S"><Period><AdaptationSet mimeType="video/mp4">
      <Representation id="v" bandwidth="1"><BaseURL>v.mp4</BaseURL><SegmentBase indexRange="0-100"/></Representation>
      </AdaptationSet></Period></MPD>
      """
    XCTAssertThrowsError(try DashToHls.convert(indexed, url: URL(string: "https://x/m.mpd")!)) {
      XCTAssertTrue(($0 as? DashToHls.Failure)?.message.contains("SegmentBase") == true)
    }
    XCTAssertThrowsError(try DashToHls.convert("<html/>", url: URL(string: "https://x/m.mpd")!))
    XCTAssertThrowsError(try DashToHls.convert("not xml <", url: URL(string: "https://x/m.mpd")!))
  }
}
