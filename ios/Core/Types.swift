import Foundation

// Value types shared by the engine and the platform layer. Everything in
// `Core/` is platform-free (Foundation only) so it compiles both into the
// CocoaPod and into the SwiftPM test package (`ios/Package.swift`).
//
// The Kotlin twin lives in `android/.../core/Types.kt`; both are exercised by
// the shared scenarios in `conformance/`. Keep names and semantics identical.

/// Public playback state. See `docs/events.md` for the full contract.
enum PlaybackState: String {
  /// Nothing loaded.
  case idle
  /// A source is being opened and has not produced audio yet.
  case loading
  /// Playback is wanted but audio is not flowing (stall, or waiting to start).
  case buffering
  /// Audio is flowing.
  case playing
  /// Loaded and not playing (by the user, or held by the system — see `interruption`).
  case paused
  /// Stopped: network and decoder resources released, source kept.
  case stopped
  /// The connection was lost while playback is wanted; recovery is scheduled.
  case reconnecting
  /// A finite source played to its end.
  case ended
  /// Unrecoverable failure (or recovery gave up). See `error`.
  case error
}

/// Why the system — not the app — paused (or refused to start) playback.
enum InterruptionReason: String {
  /// iOS `AVAudioSession` interruption (call, Siri, an app that does not mix).
  case interruption
  /// Android: another app took audio focus for good.
  case audioFocusLoss = "audio-focus-loss"
  /// Android: a call / short clip took focus; the OS hands it back later.
  case audioFocusLossTransient = "audio-focus-loss-transient"
  /// Android: focus will be granted later (start deferred until then).
  case audioFocusDelayed = "audio-focus-delayed"
  /// Focus / audio session was refused (e.g. during a phone call).
  case audioFocusDenied = "audio-focus-denied"
  /// Headphones unplugged / Bluetooth device gone.
  case outputDisconnected = "output-disconnected"
  /// The platform paused the player for a reason it did not report.
  case system
}

struct Interruption: Equatable {
  let reason: InterruptionReason
  /// Whether the OS may end it by resuming playback on its own.
  let resumable: Bool
  /// Wall-clock epoch ms when it began.
  let since: Int64
}

/// Normalized error codes. Mirrors `src/errors.ts`.
enum ErrorCode: String {
  case invalidSource = "INVALID_SOURCE"
  case sourceNotFound = "SOURCE_NOT_FOUND"
  case unsupportedFormat = "UNSUPPORTED_FORMAT"
  case decoderError = "DECODER_ERROR"
  case networkUnavailable = "NETWORK_UNAVAILABLE"
  case networkError = "NETWORK_ERROR"
  case timeout = "TIMEOUT"
  case httpError = "HTTP_ERROR"
  case streamEnded = "STREAM_ENDED"
  case audioFocusDenied = "AUDIO_FOCUS_DENIED"
  case audioSessionError = "AUDIO_SESSION_ERROR"
  case notSeekable = "NOT_SEEKABLE"
  case noSource = "NO_SOURCE"
  case playerReleased = "PLAYER_RELEASED"
  case invalidArgument = "INVALID_ARGUMENT"
  case nativePlayerError = "NATIVE_PLAYER_ERROR"
  case internalError = "INTERNAL_ERROR"
}

struct PlayerError: Error, Equatable {
  let code: ErrorCode
  let message: String
  /// Whether retrying (reconnecting / calling `play()` again) can succeed.
  let recoverable: Bool
  var httpStatus: Int? = nil
  /// Native diagnostic details — never dropped (see docs/errors.md).
  var platformDomain: String? = nil
  var platformCode: Int? = nil
  var cause: String? = nil

  static func code(_ code: ErrorCode, _ message: String, recoverable: Bool) -> PlayerError {
    PlayerError(code: code, message: message, recoverable: recoverable)
  }
}

enum NetworkState: String {
  case online
  case offline
  case unknown
}

enum FocusResult {
  case granted
  case delayed
  case denied
}

/// What the app asked to play.
struct SourceDescriptor: Equatable {
  let uri: String
  var headers: [String: String] = [:]
  /// App hint. `nil` = detect (indefinite duration ⇒ live).
  var liveHint: Bool? = nil
  /// Whether the source is fetched over the network (http/https).
  var isNetwork: Bool {
    let lower = uri.lowercased()
    return lower.hasPrefix("http://") || lower.hasPrefix("https://")
  }
}

/// What the engine asks the driver to open.
struct OpenRequest: Equatable {
  let generation: Int
  let source: SourceDescriptor
  /// Seconds to start at; `nil` = default (live edge / beginning).
  let startPosition: Double?
  let playWhenReady: Bool
}

/// A point-in-time reading of the native player, taken on demand.
struct PlaybackSample: Equatable {
  var position: Double = 0
  /// End of the buffered range, in the same timeline as `position`.
  var bufferedPosition: Double = 0
}

/// What the driver learned when the item became ready.
struct ReadyInfo: Equatable {
  /// Seconds; `nil` when indefinite (live) or unknown.
  var duration: Double?
  var isLive: Bool
  var seekable: Bool
}

struct ReconnectInfo: Equatable {
  /// 1-based attempt number of the next/current attempt.
  let attempt: Int
  /// Wall-clock epoch ms of the next attempt, `nil` while an attempt runs.
  let nextAttemptAt: Int64?
  let reason: String
}

/// The authoritative snapshot published to JS. Mirrors `PlayerStatus` in TS.
struct Status: Equatable {
  var state: PlaybackState = .idle
  var playWhenReady = false
  /// Increments on every `load()`; identifies the source this status describes.
  var loadId = 0
  var isLive = false
  var duration: Double? = nil
  var seekable = false
  var interruption: Interruption? = nil
  var error: PlayerError? = nil
  var reconnect: ReconnectInfo? = nil
  var network: NetworkState = .unknown
  var volume: Double = 1
  var muted = false
  var rate: Double = 1
}

/// One structured diagnostic line (ring-buffered natively, optionally streamed).
struct DiagnosticEntry {
  let wallTime: Int64
  let generation: Int
  let state: PlaybackState
  let event: String
  let details: [String: String]
}
