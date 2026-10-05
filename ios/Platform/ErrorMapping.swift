import AVFoundation
import Foundation

/// Maps AVFoundation / URL loading errors onto normalized `PlayerError`s.
/// The full NSError chain (domains, codes, HTTP status from the item's error
/// log) is always preserved in `platformDomain` / `platformCode` / `cause`:
/// "code=-11800" alone is useless, its underlying error is what explains it.
enum ErrorMapping {
  static func map(_ error: Error?, httpStatus: Int?, offline: Bool, hadPlayed: Bool) -> PlayerError {
    guard let ns = error as NSError? else {
      if let status = httpStatus { return http(status, nil) }
      return PlayerError(
        code: .nativePlayerError, message: "The native player failed without an error.", recoverable: true)
    }
    let chain = Self.chain(ns)
    func make(_ code: ErrorCode, _ message: String, _ recoverable: Bool, http: Int? = nil) -> PlayerError {
      PlayerError(
        code: code, message: message, recoverable: recoverable, httpStatus: http,
        platformDomain: ns.domain, platformCode: ns.code,
        cause: chain.map { "\($0.domain)(\($0.code)): \($0.localizedDescription)" }.joined(separator: " ← "))
    }

    // HTTP status reported in the item's error log beats any generic code.
    if let status = httpStatus, status >= 400 {
      var mapped = http(status, nil)
      mapped.platformDomain = ns.domain
      mapped.platformCode = ns.code
      mapped.cause = make(.httpError, "", false).cause
      return mapped
    }

    for e in chain {
      if e.domain == "AnythingPlayerHTTP" {
        var mapped = http(e.code, nil)
        mapped.platformDomain = ns.domain
        mapped.platformCode = ns.code
        mapped.cause = make(.httpError, "", false).cause
        return mapped
      }
      if e.domain == NSURLErrorDomain {
        switch e.code {
        case NSURLErrorNotConnectedToInternet, NSURLErrorDataNotAllowed,
          NSURLErrorInternationalRoamingOff:
          return make(.networkUnavailable, "The device is offline.", true)
        case NSURLErrorTimedOut:
          return make(.timeout, "The connection timed out.", true)
        case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed:
          return make(
            offline ? .networkUnavailable : .networkError,
            offline ? "The device is offline." : "The server's host name could not be resolved.", true)
        case NSURLErrorCannotConnectToHost, NSURLErrorNetworkConnectionLost,
          NSURLErrorResourceUnavailable, NSURLErrorBadServerResponse, NSURLErrorZeroByteResource,
          NSURLErrorCannotLoadFromNetwork, NSURLErrorCallIsActive:
          return make(
            offline ? .networkUnavailable : .networkError, "The connection to the server failed.", true)
        case NSURLErrorFileDoesNotExist, NSURLErrorFileIsDirectory:
          return make(.sourceNotFound, "The file does not exist.", false)
        case NSURLErrorNoPermissionsToReadFile:
          return make(.invalidSource, "The app has no permission to read this file.", false)
        case NSURLErrorAppTransportSecurityRequiresSecureConnection:
          return make(
            .invalidSource,
            "App Transport Security blocks cleartext HTTP; use https or add an ATS exception.", false)
        case NSURLErrorUnsupportedURL, NSURLErrorBadURL:
          return make(.invalidSource, "The URL is not valid.", false)
        case NSURLErrorSecureConnectionFailed, NSURLErrorServerCertificateUntrusted,
          NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateNotYetValid,
          NSURLErrorServerCertificateHasUnknownRoot:
          return make(.networkError, "The secure connection to the server failed.", false)
        default:
          return make(offline ? .networkUnavailable : .networkError, e.localizedDescription, true)
        }
      }
      if e.domain == NSCocoaErrorDomain
        && (e.code == NSFileReadNoSuchFileError || e.code == NSFileNoSuchFileError)
      {
        return make(.sourceNotFound, "The file does not exist.", false)
      }
      if e.domain == NSPOSIXErrorDomain {
        // ECONNRESET, ETIMEDOUT, ENETDOWN, ENETUNREACH, EPIPE …
        return make(offline ? .networkUnavailable : .networkError, e.localizedDescription, true)
      }
    }

    if ns.domain == AVFoundationErrorDomain {
      switch AVError.Code(rawValue: ns.code) {
      case .fileFormatNotRecognized, .failedToParse:
        return make(.unsupportedFormat, "The data is not a supported audio format.", hadPlayed)
      case .decoderNotFound, .formatUnsupported, .contentIsUnavailable:
        return make(.unsupportedFormat, "This audio format is not supported on this device.", false)
      case .decodeFailed, .decoderTemporarilyUnavailable:
        return make(.decoderError, "The audio could not be decoded.", true)
      case .mediaServicesWereReset:
        return make(.nativePlayerError, "The system media services were reset.", true)
      case .noLongerPlayable:
        return make(.nativePlayerError, "The item is no longer playable.", true)
      default:
        break
      }
    }
    return make(
      offline ? .networkUnavailable : .nativePlayerError,
      offline ? "The device is offline." : ns.localizedDescription, true)
  }

  static func http(_ status: Int, _ base: PlayerError?) -> PlayerError {
    if status == 404 || status == 410 {
      return PlayerError(
        code: .sourceNotFound, message: "The server returned HTTP \(status).", recoverable: false,
        httpStatus: status)
    }
    let retryable = status == 408 || status == 429 || status >= 500
    return PlayerError(
      code: .httpError, message: "The server returned HTTP \(status).", recoverable: retryable,
      httpStatus: status)
  }

  private static func chain(_ error: NSError) -> [NSError] {
    var result: [NSError] = []
    var current: NSError? = error
    while let e = current, result.count < 8 {
      result.append(e)
      current = e.userInfo[NSUnderlyingErrorKey] as? NSError
    }
    return result
  }
}
