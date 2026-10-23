package com.anythingplayer.sound

/** The numbers SoundPool takes, from the API's volume (0–1), rate (0.5–2) and pan (-1…1). */
internal object SoundMath {
  const val MIN_RATE = 0.5
  const val MAX_RATE = 2.0

  fun volume(value: Double): Double = if (value.isNaN()) 1.0 else value.coerceIn(0.0, 1.0)

  fun rate(value: Double): Double = if (value.isNaN()) 1.0 else value.coerceIn(MIN_RATE, MAX_RATE)

  fun pan(value: Double): Double = if (value.isNaN()) 0.0 else value.coerceIn(-1.0, 1.0)

  /**
   * Left and right volume: the pan lowers the far side linearly, the near
   * side stays at `volume` (a centered sound is as loud as the volume says).
   */
  fun gains(volume: Double, pan: Double): Pair<Float, Float> {
    val v = volume(volume)
    val p = pan(pan)
    val left = if (p > 0.0) 1.0 - p else 1.0
    val right = if (p < 0.0) 1.0 + p else 1.0
    return Pair((v * left).toFloat(), (v * right).toFloat())
  }

  /** When a voice that starts at `now` should end, in the clock's unit (ms); `null` when it never does or the length is unknown. */
  fun endsAt(now: Long, durationMs: Long?, rate: Double, loop: Boolean): Long? {
    if (loop || durationMs == null || durationMs <= 0) return null
    return now + (durationMs / rate(rate)).toLong()
  }
}
