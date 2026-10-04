import Foundation

/// The elapsed time of the song a live stream is playing, for the lock screen.
///
/// A radio stream has no duration, but the app usually knows the song's
/// (from its own API). The app sets elapsed + duration once, when the song
/// becomes audible; from then on the clock advances only while audio plays —
/// pausing or buffering freezes the audio, so it freezes the song too.
struct TrackClock: Equatable {
  let duration: Double
  private var base: Double
  private var runningSince: Int64?

  init(elapsed: Double, duration: Double, now: Int64, running: Bool) {
    self.duration = max(0, duration)
    base = min(max(0, elapsed), self.duration)
    runningSince = running ? now : nil
  }

  var isRunning: Bool { runningSince != nil }

  mutating func setRunning(_ running: Bool, now: Int64) {
    guard running != isRunning else { return }
    if running {
      runningSince = now
    } else {
      base = elapsed(now: now)
      runningSince = nil
    }
  }

  /// Seconds into the song at `now`, never past its end.
  func elapsed(now: Int64) -> Double {
    guard let since = runningSince else { return base }
    return min(duration, base + Double(max(0, now - since)) / 1000)
  }
}
