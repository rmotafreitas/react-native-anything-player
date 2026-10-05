package com.anythingplayer.core

import org.junit.Assert.assertEquals
import org.junit.Test

class TrackClockTest {
  @Test
  fun advancesOnlyWhileRunning() {
    val clock = TrackClock(elapsed = 10.0, duration = 200.0, now = 0, running = true)
    assertEquals(15.0, clock.elapsed(5_000), 0.001)
    clock.setRunning(false, 5_000)
    assertEquals(15.0, clock.elapsed(60_000), 0.001)
    clock.setRunning(true, 60_000)
    assertEquals(17.5, clock.elapsed(62_500), 0.001)
  }

  @Test
  fun clampsToTheSong() {
    assertEquals(0.0, TrackClock(-3.0, 30.0, 0, false).elapsed(0), 0.0)
    assertEquals(30.0, TrackClock(25.0, 30.0, 0, true).elapsed(60_000), 0.0)
    assertEquals(30.0, TrackClock(99.0, 30.0, 0, false).elapsed(0), 0.0)
  }

  @Test
  fun repeatedStateIsIdempotent() {
    val clock = TrackClock(0.0, 100.0, 0, true)
    clock.setRunning(true, 4_000)
    assertEquals(10.0, clock.elapsed(10_000), 0.001)
    clock.setRunning(false, 10_000)
    clock.setRunning(false, 20_000)
    assertEquals(10.0, clock.elapsed(30_000), 0.001)
  }
}
