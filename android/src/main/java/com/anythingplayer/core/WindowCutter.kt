package com.anythingplayer.core

import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * Cuts decoded mono audio into consecutive windows of one fixed length, the
 * visualizer's: 1024 frames at 44.1 kHz (~23 ms), as the iOS stream
 * visualizer and a Web Audio analyser (`fftSize` 2048) show them.
 *
 * A decoder hands its output over in buffers of its own size: an MP3 frame
 * is 1152 samples, an HE-AAC one 2048 (46 ms), and buffers that come too fast
 * to emit were merged. A window per buffer therefore spanned 26 to 80+ ms
 * and came at a rate that depended on the codec. Cut to one length, every
 * window covers the same stretch of time, whatever the stream: what waits
 * short of a full window is kept for the next buffer (dropped only by a
 * reset or a jump it does not continue).
 */
class WindowCutter(sampleRate: Int = 44_100) {
  /** One window: its samples and the presentation time (µs) of its first, [NO_TIME] when unknown. */
  class Window(val samples: FloatArray, val startUs: Long)

  private var rate = sampleRate.coerceAtLeast(1)
  private var samples = FloatArray(4096)
  private var count = 0
  private var firstUs = NO_TIME

  /** Frames per window at the current sample rate. */
  val length: Int
    get() = (rate * WINDOW_SECONDS).roundToLong().toInt().coerceAtLeast(MIN_LENGTH)

  /** Frames waiting for a full window. */
  val pending: Int
    get() = count

  /** A new format or a flush: what was waiting belongs to audio that will not continue. */
  fun reset(sampleRate: Int) {
    rate = sampleRate.coerceAtLeast(1)
    count = 0
    firstUs = NO_TIME
  }

  /**
   * Appends [frames] samples of [block]; [presentationUs] is the time of its
   * first ([NO_TIME] when unknown). A known time places what is still waiting
   * just before it, so the windows' times stay on the decoder's and never
   * drift by the rounding of the cuts. Waiting audio this block does not
   * continue (more than a window away: a jump without a flush) is dropped,
   * never joined to it in one window.
   */
  fun append(block: FloatArray, frames: Int, presentationUs: Long) {
    if (frames <= 0) return
    if (presentationUs != NO_TIME) {
      if (count > 0 && firstUs != NO_TIME) {
        val continuesAt = firstUs + (count * 1_000_000L) / rate
        if (abs(presentationUs - continuesAt) > (length * 1_000_000L) / rate) count = 0
      }
      firstUs = presentationUs - (count * 1_000_000L) / rate
    } else if (count == 0) {
      firstUs = NO_TIME
    }
    if (samples.size < count + frames) samples = samples.copyOf(maxOf(samples.size * 2, count + frames))
    System.arraycopy(block, 0, samples, count, frames)
    count += frames
  }

  /** Every whole window waiting, oldest first; the rest stays for the next buffer. */
  fun cut(): List<Window> {
    val size = length
    if (count < size) return emptyList()
    val out = ArrayList<Window>(count / size)
    var offset = 0
    while (count - offset >= size) {
      out.add(Window(samples.copyOfRange(offset, offset + size), timeAt(offset)))
      offset += size
    }
    firstUs = timeAt(offset)
    count -= offset
    System.arraycopy(samples, offset, samples, 0, count)
    return out
  }

  private fun timeAt(frame: Int): Long =
    if (firstUs == NO_TIME) NO_TIME else firstUs + (frame * 1_000_000L) / rate

  companion object {
    /** The window's length: 1024 frames at 44.1 kHz. */
    const val WINDOW_SECONDS = 1024.0 / 44_100
    /** Media3's `C.TIME_UNSET`: no presentation time. */
    const val NO_TIME = Long.MIN_VALUE + 1
    private const val MIN_LENGTH = 64
  }
}
