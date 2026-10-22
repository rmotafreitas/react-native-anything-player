package com.anythingplayer.core

import java.io.ByteArrayOutputStream

// Byte-level ICY framing, for the one place the player does not have Media3 do
// it: reading a stream's titles on a connection of its own while a Cast
// receiver plays the audio. Swift twin: `IcyDeinterleaver` in
// `ios/Core/StreamMetadata.swift`; web twin: `src/web/engine/StreamMetadata.ts`.

/**
 * Incremental de-interleaver for an ICY body: every `metaint` audio bytes are
 * followed by one length byte `L` and `L × 16` bytes of metadata (NUL-padded);
 * `L == 0` means "no change". Chunk boundaries may fall anywhere.
 */
class IcyDeinterleaver(
  /** `<= 0` passes everything through as audio. */
  val metaint: Int,
) {
  /** One metadata block and where it sits in the audio. */
  class Block(
    /** Audio bytes delivered before this block. */
    val audioOffset: Long,
    val bytes: ByteArray,
  )

  class Output(val audio: ByteArray, val blocks: List<Block>)

  private enum class Phase { AUDIO, LENGTH, METADATA }

  private var phase = Phase.AUDIO
  private var remaining = maxOf(metaint, 0)
  private val pending = ByteArrayOutputStream()

  var audioBytes = 0L
    private set

  fun consume(data: ByteArray, length: Int = data.size): Output {
    if (metaint <= 0) {
      audioBytes += length
      return Output(if (length == data.size) data else data.copyOf(length), emptyList())
    }
    val audio = ByteArrayOutputStream(length)
    val blocks = ArrayList<Block>()
    var i = 0
    while (i < length) {
      when (phase) {
        Phase.AUDIO -> {
          val take = minOf(remaining, length - i)
          audio.write(data, i, take)
          audioBytes += take
          remaining -= take
          i += take
          if (remaining == 0) phase = Phase.LENGTH
        }
        Phase.LENGTH -> {
          val size = (data[i].toInt() and 0xFF) * 16
          i += 1
          if (size == 0) {
            phase = Phase.AUDIO
            remaining = metaint
          } else {
            pending.reset()
            phase = Phase.METADATA
            remaining = size
          }
        }
        Phase.METADATA -> {
          val take = minOf(remaining, length - i)
          pending.write(data, i, take)
          remaining -= take
          i += take
          if (remaining == 0) {
            blocks.add(Block(audioBytes, pending.toByteArray()))
            pending.reset()
            phase = Phase.AUDIO
            remaining = metaint
          }
        }
      }
    }
    return Output(audio.toByteArray(), blocks)
  }
}
