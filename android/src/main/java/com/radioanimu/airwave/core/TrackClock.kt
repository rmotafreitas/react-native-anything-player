package com.radioanimu.airwave.core

/**
 * The elapsed time of the song a live stream is playing, for the lock screen.
 * Twin of `ios/Core/TrackClock.swift`.
 *
 * A radio stream has no duration, but the app usually knows the song's (from
 * its own API). The app sets elapsed + duration once, when the song becomes
 * audible; from then on the clock advances only while audio plays — pausing
 * or buffering freezes the audio, so it freezes the song too.
 */
internal class TrackClock(elapsed: Double, duration: Double, now: Long, running: Boolean) {
  val duration: Double = duration.coerceAtLeast(0.0)
  private var base: Double = elapsed.coerceIn(0.0, this.duration)
  private var runningSince: Long? = if (running) now else null

  val isRunning: Boolean get() = runningSince != null

  fun setRunning(running: Boolean, now: Long) {
    if (running == isRunning) return
    if (running) {
      runningSince = now
    } else {
      base = elapsed(now)
      runningSince = null
    }
  }

  /** Seconds into the song at [now], never past its end. */
  fun elapsed(now: Long): Double {
    val since = runningSince ?: return base
    return (base + (now - since).coerceAtLeast(0) / 1000.0).coerceAtMost(duration)
  }
}
