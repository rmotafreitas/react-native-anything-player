import Foundation
import XCTest

@testable import AnythingPlayerCore

/// DRM's platform-free parts: FairPlay's content id, why a `drm` without
/// FairPlay cannot play here, and the round trip through the app's `getLicense`.
final class DrmTests: XCTestCase {
  func testContentIdIsTheSkdHost() {
    XCTAssertEqual(fairPlayContentId("skd://twelve?x=1"), "twelve")
    XCTAssertEqual(fairPlayContentId("skd://abc/def"), "abc")
    XCTAssertEqual(fairPlayContentId("plain-id"), "plain-id")
  }

  func testOnlyFairPlayPlaysHere() {
    let fairplay = FairPlayServer(licenseUrl: "https://l/fps", certificateUrl: "https://l/cert")
    XCTAssertNil(DrmDescriptor(fairplay: fairplay, others: ["widevine"]).unsupportedMessage)
    let message = DrmDescriptor(others: ["widevine", "clearkey"]).unsupportedMessage
    XCTAssertEqual(
      message, "The source's drm gives widevine, clearkey, not FairPlay: Apple platforms decrypt FairPlay only.")
  }

  func testTheAppAnswersARequest() {
    let requests = LicenseRequests()
    var got: Result<Data, PlayerError>?
    let id = requests.open { got = $0 }
    requests.answer(id, license: Data([1, 2, 3]).base64EncodedString(), error: nil)
    XCTAssertEqual(try got?.get(), Data([1, 2, 3]))
    // Answered once: a late answer changes nothing.
    requests.answer(id, license: nil, error: "late")
    XCTAssertEqual(try got?.get(), Data([1, 2, 3]))
  }

  func testAHookThatThrowsFailsTheLicense() {
    let requests = LicenseRequests()
    var got: Result<Data, PlayerError>?
    let id = requests.open { got = $0 }
    requests.answer(id, license: nil, error: "token expired")
    guard case .failure(let error)? = got else { return XCTFail("no failure") }
    XCTAssertEqual(error.code, .drmLicenseFailed)
    XCTAssertEqual(error.message, "The app's getLicense failed: token expired.")
  }

  func testAnUnansweredRequestTimesOut() {
    let requests = LicenseRequests(timeout: 0.05)
    let failed = expectation(description: "timed out")
    _ = requests.open { result in
      if case .failure(let error) = result, error.message.contains("did not answer") { failed.fulfill() }
    }
    wait(for: [failed], timeout: 2)
  }
}
