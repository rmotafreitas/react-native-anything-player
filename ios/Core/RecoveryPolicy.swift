import Foundation

/// Every recovery constant, in one place. The Kotlin twin is
/// `android/.../core/RecoveryPolicy.kt`; `docs/recovery.md` documents the
/// production failure each one exists for. Only the fields in
/// `EngineOptions` are app-configurable — the rest are deliberately fixed.
enum RecoveryPolicy {
  /// Engine heartbeat while playback is wanted (drives the watchdogs).
  static let heartbeatMs: Int64 = 1_000

  /// A native stall shorter than this is not published (no spinner flicker,
  /// no event spam). Recovery timers still count from the real stall start.
  static let stallDebounceMs: Int64 = 500

  /// One open attempt (open → ready) may take this long before it counts as a
  /// timeout. A link that cannot start a stream in 12s is not usable.
  static let openTimeoutMs: Int64 = 12_000

  /// An open younger than this is not re-issued by another trigger (network
  /// edge, stall detector, foreground catch-up): two triggers landing together
  /// used to re-open twice and abort the first connect mid-handshake.
  static let openGraceMs: Int64 = 4_000

  /// "Playing" while the playhead has not advanced for this long is a stall
  /// the native player did not report. With `automaticallyWaitsToMinimizeStalling`
  /// off, AVPlayer can keep `timeControlStatus == .playing` through a dead socket.
  static let silentStallMs: Int64 = 4_000
  /// Same, while the network is suspect (it just dropped, returned or changed).
  static let suspectSilentStallMs: Int64 = 2_000

  /// A stall with no buffered progress for this long while online means the
  /// socket is dead, not slow: progressive streams are never revived by the
  /// native players, so the source is re-opened.
  static let stallDeadMs: Int64 = 3_000
  /// Same, while the network is suspect.
  static let suspectStallDeadMs: Int64 = 1_500
  /// A stall that trickles data but never recovers is re-opened after this.
  static let stallMaxMs: Int64 = 20_000
  /// A stall this close to a file's end (seconds), with the rest buffered, is
  /// its end: nothing more will come.
  static let endSlackS = 0.1
  /// A playhead that advances this far (seconds), at about the playback rate,
  /// while the platform still says buffering: it is playing.
  static let playheadProofS: Double = 1.5

  /// How long after a connectivity edge the link is treated as suspect.
  static let networkSuspectMs: Int64 = 20_000

  /// Reconnect backoff: base delay, doubled per attempt, capped, ±jitter.
  static let reconnectBaseMs: Int64 = 1_000
  static let reconnectMaxMs: Int64 = 30_000
  /// Fraction of the delay randomized (spreads a station's listeners out after
  /// a server restart instead of reconnecting them all on the same second).
  static let reconnectJitter: Double = 0.2

  /// While the OS reports no connectivity, attempts are skipped; every Nth
  /// skipped attempt runs anyway as a probe in case the reading is stale.
  static let offlineProbeEvery = 3

  /// Audio must flow this long before the backoff resets — a server that
  /// accepts, plays a second and drops must not cause a reconnect storm.
  static let stablePlaybackMs: Int64 = 10_000

  /// A paused network live stream keeps downloading (ExoPlayer indefinitely,
  /// AVPlayer for ~110s measured) audio that resuming will never play — the
  /// resume re-opens at the live edge. The connection is released after this.
  static let pausedStreamReleaseMs: Int64 = 30_000

  /// How often a fade (play, pause, stop, `fadeTo`, the sleep timer) updates the volume.
  static let fadeTickMs: Int64 = 50

  // MARK: Video

  /// A player without a view this long stops decoding the picture (a move between views keeps it).
  static let viewDetachGraceMs: Int64 = 1_000
  /// In the background, Picture in Picture may start (or the app return) this long after the event.
  static let pipGraceMs: Int64 = 1_000
  /// A quality switch's new file must play within this, or the switch is dropped.
  static let swapTimeoutMs: Int64 = 12_000
  /// A rendition that failed is not picked again for this long.
  static let failedRenditionMs: Int64 = 60_000
  /// How long a 401/403 waits for the app's new source before the backoff takes over.
  static let refreshTimeoutMs: Int64 = 10_000
  /// A source with `expiresAt` asks for a new one this long ahead.
  static let refreshAheadMs: Int64 = 60_000
  /// Automatic quality: a rendition fits a bandwidth this many times its bitrate.
  static let abrFitRatio = 0.7
  /// A stall steps down when the bandwidth is under this × the current bitrate.
  static let abrStallRatio = 1.2
  /// The bandwidth under the current bitrate for this long steps down.
  static let abrLowMs: Int64 = 10_000
  /// The bandwidth above this × the next bitrate…
  static let abrUpRatio = 1.5
  /// …for this long steps up (and as long after any switch or stall).
  static let abrUpMs: Int64 = 30_000
  /// Two stalls in this window step down whatever the bandwidth.
  static let abrStallWindowMs: Int64 = 30_000
  /// An audio player that measures nothing it can trust (no bandwidth
  /// reading, or a live stream, which arrives at its own rate) steps up one
  /// rendition after this long without a stall.
  static let abrQuietUpMs: Int64 = 120_000
  /// Data Saver, Low Data Mode, `saveData`: the highest picture.
  static let dataSaverMaxHeight = 480
  /// Automatic start with no bandwidth reading: the lowest rendition at least this high.
  static let startMinHeight = 480
  /// Audio-only fallback without bandwidth readings: try the picture again after this long without a stall.
  static let fallbackProbeMs: Int64 = 60_000
}

/// App-configurable recovery knobs (`PlayerOptions` in TS).
struct EngineOptions: Equatable {
  /// Reconnect automatically after recoverable failures while playback is wanted.
  var reconnect = true
  /// Give up recovering after this long without stable playback (`nil` = never).
  var giveUpAfterMs: Int64? = 600_000
  /// Resume automatically when the OS ends a transient interruption.
  var autoResumeAfterInterruption = true
  /// A live stream that has fallen this far behind the live edge (pauses +
  /// stalls since it was opened) is re-opened at the live edge on resume.
  var liveMaxDriftMs: Int64 = 5_000
  /// Fade-in when playback starts (`0` = none). Starts when the audio does.
  var fadeInMs: Int64 = 0
  /// Fade-out before a pause or a stop, and the sleep timer's default (`0` = none).
  var fadeOutMs: Int64 = 0
  /// A video player's rules; `nil` for an audio player.
  var video: VideoEngineOptions? = nil
}

/// What a video player does when the app goes to the background.
enum BackgroundMode: String {
  case pause
  case audio
  case pip
}

/// Where automatic quality starts (`PlayerOptions.video.quality.startQuality`).
enum StartQuality: Equatable {
  case auto
  case lowest
  case highest
  /// The tallest at or below this height.
  case height(Int)
}

/// Quality caps (`PlayerOptions.video.quality`).
struct QualityPolicy: Equatable {
  var maxHeight: Int? = nil
  var maxBitrate: Int64? = nil
  var cellularMaxHeight: Int? = nil
  var cellularMaxBitrate: Int64? = nil
  var startQuality: StartQuality = .auto
  /// Data Saver, Low Data Mode, `saveData`: at most 480p.
  var followDataSaver = true
  /// Never more pixels than the view shows.
  var capToView = true
}

/// The audio-only fallback's thresholds (`fallbackToAudio`).
struct FallbackPolicy: Equatable {
  /// Drop when the bandwidth stays under this × the lowest video quality…
  var dropBelowRatio = 1.2
  /// …for this long.
  var dropAfterMs: Int64 = 10_000
  /// Or after this many stalls…
  var dropAfterStalls = 2
  /// …within this window.
  var stallWindowMs: Int64 = 30_000
  /// Return when the bandwidth stays above this × the lowest video quality…
  var returnAboveRatio = 1.5
  /// …for this long.
  var returnAfterMs: Int64 = 30_000
}

/// A video player's engine rules (`EngineOptions.video`).
struct VideoEngineOptions: Equatable {
  var whenBackgrounded: BackgroundMode = .pause
  /// Decorative: no focus, no media session, paused off screen and in the background.
  var ambient = false
  var keepAwake = true
  var focusWhenMuted = false
  /// `nil`: no audio-only fallback.
  var fallback: FallbackPolicy? = nil
  var quality = QualityPolicy()
  var tracks = TrackPolicy()
}

/// How the starting audio and text tracks are chosen (`PlayerOptions.video.tracks`).
struct TrackPolicy: Equatable {
  /// The user's languages, in order.
  var languages: [String] = []
  /// Follow the OS's captions and audio-description settings.
  var followSystem = true
}

/// What the OS says about the user (`systemPreferencesChanged`).
struct SystemPreferences: Equatable {
  /// The device's languages, in order.
  var languages: [String] = []
  var captions = false
  var audioDescriptions = false
}

/// Deterministic exponential backoff with injectable jitter.
struct Backoff {
  private(set) var attempts = 0
  /// Returns a value in [0, 1). Injected so tests are deterministic.
  var random: () -> Double

  init(random: @escaping () -> Double = { Double.random(in: 0..<1) }) {
    self.random = random
  }

  /// Delay for the next attempt; increments the attempt counter.
  mutating func next() -> Int64 {
    let exponent = min(attempts, 30)
    let raw = min(
      Double(RecoveryPolicy.reconnectBaseMs) * pow(2, Double(exponent)),
      Double(RecoveryPolicy.reconnectMaxMs))
    attempts += 1
    let jitter = (random() * 2 - 1) * RecoveryPolicy.reconnectJitter
    return max(0, Int64((raw * (1 + jitter)).rounded()))
  }

  mutating func reset() {
    attempts = 0
  }
}
