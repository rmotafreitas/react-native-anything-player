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
