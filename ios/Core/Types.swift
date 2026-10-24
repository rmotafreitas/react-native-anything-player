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
  /// Video: the app went to the background (`whenBackgrounded`, ambient players).
  case background
  /// Video: an ambient player's view left the screen; it resumes when shown again.
  case offscreen
}

/// The kind of output the audio goes to. Mirrors `AudioRouteKind` in TS.
enum AudioRouteKind: String {
  case speaker
  case headphones
  case bluetooth
  case airplay
  case cast
  case car
  case hdmi
  case usb
  case other
  case unknown
}

/// Where a player's audio goes. See the Casting and AirPlay guide.
struct AudioRoute: Equatable {
  let kind: AudioRouteKind
  /// The device's name when the platform tells it ("Living Room"), else `nil`.
  let name: String?

  /// The route before the platform reports one: the engine never guesses.
  static let unknown = AudioRoute(kind: .unknown, name: nil)
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
  case routePickerUnavailable = "ROUTE_PICKER_UNAVAILABLE"
  case castUnavailable = "CAST_UNAVAILABLE"
  case castUnsupportedSource = "CAST_UNSUPPORTED_SOURCE"
  case soundUnavailable = "SOUND_UNAVAILABLE"
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
  /// Separate files of one video at different qualities. The engine picks one
  /// and switches between them (`uri` is then unused); `nil`: one file or an
  /// adaptive manifest.
  var renditions: [Rendition]? = nil
  /// The app can hand over a new source on 401/403 or before `expiresAt`.
  var refreshable = false
  /// Wall-clock epoch ms when the source's URL stops working.
  var expiresAt: Int64? = nil
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
  /// The engine re-opens on its own (`reconnect`): a driver may then continue
  /// a dropped live connection itself. `false`: it never reconnects.
  var allowReconnect = true
  /// Open behind the current item and swap on its first frame (a quality
  /// switch): the current item keeps playing until this one reports
  /// `playing`, and is dropped then.
  var swap = false
  /// Index into the source's renditions, when it has them.
  var rendition: Int? = nil
}

/// One file of a video at one quality (`SourceDescriptor.renditions`).
struct Rendition: Equatable {
  let uri: String
  /// `nil`: the source's headers.
  var headers: [String: String]? = nil
  /// Pixels; `nil` until the platform reads it from the file.
  var height: Int? = nil
  /// Bits per second; `nil` until known.
  var bitrate: Int64? = nil
  var label: String? = nil
  /// Sound only: the last step of the audio-only fallback.
  var audioOnly = false
}

/// A quality of an adaptive source as the driver reports it, or a rendition (`status.video.qualities`).
struct VideoVariant: Equatable {
  let id: String
  var height: Int? = nil
  var bitrate: Int64? = nil
  /// An audio-only variant (or, for HLS/DASH, the audio rendition alone).
  var audioOnly = false
  var label: String? = nil
}

/// What the driver learned about the picture.
struct VideoInfo: Equatable {
  let width: Int
  let height: Int
  var hdr = false
  /// The variant playing (adaptive sources), when the driver knows it.
  var variantId: String? = nil
}

/// What the engine asks an adaptive source's driver to keep to.
struct QualityConstraints: Equatable {
  let maxHeight: Int?
  let maxBitrate: Int64?
  /// A variant the app picked; `nil`: the driver's own ABR.
  let pinned: String?
  /// Prefer an audio-only variant (listen-only, background, fallback).
  let audioOnly: Bool
}

/// Why a video player plays its sound alone.
enum AudioOnlyReason: String {
  case listen
  case background
  case fallback
}

/// Why the engine asks for a new source.
enum RefreshReason: String {
  /// A 401/403.
  case unauthorized
  /// `expiresAt` is near.
  case expiring
}

/// The view showing a video player (`viewChanged`).
struct ViewState: Equatable {
  var attached = false
  var visible = false
  /// Physical pixels; 0 when unknown.
  var width = 0
  var height = 0
}

/// Quality-of-experience numbers the engine counts (`getStats()`).
struct EngineStats: Equatable {
  /// `load()` to the first audio, ms; `nil` until then.
  var startupMs: Int64? = nil
  var rebufferCount = 0
  var rebufferMs: Int64 = 0
  var qualitySwitches = 0
  var audioOnlySwitches = 0
}

/// A video player's part of the status (`status.video`).
struct VideoStatus: Equatable {
  var width: Int?
  var height: Int?
  var hdr: Bool
  /// A frame of the current load has been shown.
  var firstFrame: Bool
  var audioOnly: AudioOnlyReason?
  var pictureInPicture: Bool
  var qualities: [VideoVariant]
  /// The quality playing (`nil` when unknown).
  var quality: String?
  /// The app's pick; `nil` = automatic.
  var selectedQuality: String?
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
  var route: AudioRoute = .unknown
  /// Wall-clock epoch ms when the sleep timer pauses the player, `nil` when off.
  var sleepAt: Int64? = nil
  /// `nil` for an audio player.
  var video: VideoStatus? = nil
}

/// A linear move from `from` to `to` between two monotonic instants (ms).
struct Ramp: Equatable {
  let from: Double
  let to: Double
  let startAt: Int64
  let endAt: Int64

  /// The value at `t`: `from` before it starts, `to` once it ends.
  func value(at t: Int64) -> Double {
    if t >= endAt { return to }
    if t <= startAt { return from }
    return from + (to - from) * (Double(t - startAt) / Double(endAt - startAt))
  }
}

/// One structured diagnostic line (ring-buffered natively, optionally streamed).
struct DiagnosticEntry {
  let wallTime: Int64
  let generation: Int
  let state: PlaybackState
  let event: String
  let details: [String: String]
}
