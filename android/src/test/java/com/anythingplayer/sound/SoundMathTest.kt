package com.anythingplayer.sound

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SoundMathTest {
  @Test
  fun `a centered sound is as loud as the volume says`() {
    assertEquals(Pair(0.5f, 0.5f), SoundMath.gains(0.5, 0.0))
  }

  @Test
  fun `panning lowers the far side only`() {
    assertEquals(Pair(1.0f, 0.0f), SoundMath.gains(1.0, -1.0))
    assertEquals(Pair(0.0f, 1.0f), SoundMath.gains(1.0, 1.0))
    assertEquals(Pair(1.0f, 0.5f), SoundMath.gains(1.0, -0.5))
  }

  @Test
  fun `out of range values are clamped and NaN falls back to the default`() {
    assertEquals(Pair(1.0f, 1.0f), SoundMath.gains(3.0, 0.0))
    assertEquals(Pair(0.0f, 0.0f), SoundMath.gains(-1.0, 0.0))
    assertEquals(0.5, SoundMath.rate(0.1), 0.0)
    assertEquals(2.0, SoundMath.rate(9.0), 0.0)
    assertEquals(1.0, SoundMath.rate(Double.NaN), 0.0)
    assertEquals(0.0, SoundMath.pan(Double.NaN), 0.0)
  }

  @Test
  fun `a voice ends after its length at its rate, unless it loops or the length is unknown`() {
    assertEquals(1_500L, SoundMath.endsAt(1_000, 1_000, 2.0, loop = false))
    assertEquals(3_000L, SoundMath.endsAt(1_000, 1_000, 0.5, loop = false))
    assertNull(SoundMath.endsAt(1_000, 1_000, 1.0, loop = true))
    assertNull(SoundMath.endsAt(1_000, null, 1.0, loop = false))
    assertNull(SoundMath.endsAt(1_000, 0, 1.0, loop = false))
  }
}
