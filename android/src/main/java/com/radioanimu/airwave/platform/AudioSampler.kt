package com.radioanimu.airwave.platform

import android.content.Context
import android.media.AudioManager
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.RenderersFactory
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.TeeAudioProcessor
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

/** Ceiling on the event rate (the tap fires per decoded buffer, ~40–100 Hz). */
private const val MIN_EMIT_INTERVAL_NANOS = 8_000_000L
private const val MAX_OUTPUT_LATENCY_SECONDS = 0.6
private const val LATENCY_SMOOTHING = 0.85

/** One decoded window, downmixed to mono and resampled to the requested size. */
internal class AudioSampleWindow(
  val waveform: FloatArray,
  val level: Double,
  val durationSeconds: Double,
  val outputLatencySeconds: Double,
  val timestampMs: Long,
)

/**
 * Decoded-PCM tap for visualizers.
 *
 * A [TeeAudioProcessor] in ExoPlayer's audio sink sees every decoded buffer on
 * its way to the speaker — no `RECORD_AUDIO` permission, unlike the platform
 * `Visualizer` effect. Each buffer is downmixed to mono and resampled to
 * [points] here, on the playback thread, so JS receives a ready-to-draw window.
 *
 * Output latency (how long until this window is heard) is the queue depth of
 * the sink's `AudioTrack` — the exact lead of the newest written samples over
 * the speaker, in the sink's own clock — smoothed, with a hardware-buffer
 * estimate until the track reports one.
 */
@OptIn(UnstableApi::class)
internal class AudioSampler(context: Context) : TeeAudioProcessor.AudioBufferSink {
  @Volatile var enabled = false
  @Volatile var points = 1024
  /** Called on the playback thread. */
  @Volatile var onWindow: ((AudioSampleWindow) -> Unit)? = null
  @Volatile private var audioSink: AudioSink? = null

  private val fallbackLatencySeconds = estimateOutputLatency(context)
  private var sampleRate = 44_100
  private var channels = 2
  private var encoding = C.ENCODING_PCM_16BIT
  private var lastEmitNanos = 0L
  private var smoothedLatency = -1.0
  private var mono = FloatArray(4096)

  /** A renderers factory whose audio sink carries this tap (always installed, silent until enabled). */
  fun renderersFactory(context: Context): RenderersFactory {
    val tee = TeeAudioProcessor(this)
    return object : DefaultRenderersFactory(context) {
      override fun buildAudioSink(
        context: Context,
        enableFloatOutput: Boolean,
        enableAudioTrackPlaybackParams: Boolean,
      ): AudioSink =
        DefaultAudioSink.Builder(context)
          .setEnableFloatOutput(enableFloatOutput)
          .setEnableAudioOutputPlaybackParameters(enableAudioTrackPlaybackParams)
          .setAudioProcessors(arrayOf<AudioProcessor>(tee))
          .build()
          .also { audioSink = it }
    }
  }

  override fun flush(sampleRateHz: Int, channelCount: Int, encoding: Int) {
    sampleRate = if (sampleRateHz > 0) sampleRateHz else 44_100
    channels = channelCount.coerceAtLeast(1)
    this.encoding = encoding
    lastEmitNanos = 0L
    smoothedLatency = -1.0
  }

  override fun handleBuffer(buffer: ByteBuffer) {
    val callback = onWindow
    if (!enabled || callback == null) return
    val now = System.nanoTime()
    if (now - lastEmitNanos < MIN_EMIT_INTERVAL_NANOS) return
    val bytesPerSample =
      when (encoding) {
        C.ENCODING_PCM_16BIT -> 2
        C.ENCODING_PCM_FLOAT -> 4
        C.ENCODING_PCM_8BIT -> 1
        else -> return // 24/32-bit integer PCM: not produced by the decoders used here
      }
    val pcm = buffer.duplicate().order(ByteOrder.LITTLE_ENDIAN)
    val frames = pcm.remaining() / (bytesPerSample * channels)
    if (frames <= 0) return
    lastEmitNanos = now
    if (mono.size < frames) mono = FloatArray(frames)
    var sumSquares = 0.0
    for (f in 0 until frames) {
      var sum = 0f
      for (c in 0 until channels) {
        sum +=
          when (encoding) {
            C.ENCODING_PCM_16BIT -> pcm.short / 32768f
            C.ENCODING_PCM_FLOAT -> pcm.float
            else -> ((pcm.get().toInt() and 0xFF) - 128) / 128f
          }
      }
      val v = sum / channels
      mono[f] = v
      sumSquares += v * v
    }
    callback(
      AudioSampleWindow(
        waveform = resample(mono, frames, points),
        level = sqrt(sumSquares / frames).coerceIn(0.0, 1.0),
        durationSeconds = frames.toDouble() / sampleRate,
        outputLatencySeconds = outputLatency(),
        timestampMs = System.currentTimeMillis(),
      )
    )
  }

  private fun outputLatency(): Double {
    val queuedUs = runCatching { audioSink?.audioTrackBufferSizeUs ?: C.TIME_UNSET }.getOrDefault(C.TIME_UNSET)
    val raw =
      if (queuedUs == C.TIME_UNSET || queuedUs < 0) fallbackLatencySeconds
      else (queuedUs / 1_000_000.0).coerceIn(0.0, MAX_OUTPUT_LATENCY_SECONDS)
    smoothedLatency = if (smoothedLatency < 0) raw else smoothedLatency * LATENCY_SMOOTHING + raw * (1 - LATENCY_SMOOTHING)
    return smoothedLatency
  }

  private companion object {
    /** ~3 hardware buffers: the platform's own output-path estimate. */
    fun estimateOutputLatency(context: Context): Double {
      val am = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return 0.15
      val frames = am.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER)?.toDoubleOrNull() ?: 0.0
      val rate = am.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)?.toDoubleOrNull() ?: 0.0
      if (frames <= 0 || rate <= 0) return 0.15
      return (frames / rate * 3).coerceIn(0.0, MAX_OUTPUT_LATENCY_SECONDS)
    }

    /** Linear-interpolation resample of `source[0 until count]` to [size] points. */
    fun resample(source: FloatArray, count: Int, size: Int): FloatArray {
      val out = FloatArray(size)
      if (count == 1 || size == 1) {
        out.fill(source[0])
        return out
      }
      val step = (count - 1).toDouble() / (size - 1)
      for (i in 0 until size) {
        val x = i * step
        val i0 = x.toInt().coerceAtMost(count - 1)
        val i1 = (i0 + 1).coerceAtMost(count - 1)
        val t = (x - i0).toFloat()
        out[i] = source[i0] + (source[i1] - source[i0]) * t
      }
      return out
    }
  }
}
