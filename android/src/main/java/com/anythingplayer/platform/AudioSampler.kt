package com.anythingplayer.platform

import android.content.Context
import android.media.AudioManager
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.RenderersFactory
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import androidx.media3.exoplayer.audio.MediaCodecAudioRenderer
import androidx.media3.exoplayer.audio.TeeAudioProcessor
import androidx.media3.exoplayer.mediacodec.DefaultMediaCodecAdapterFactory
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.metadata.MetadataRenderer
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
 * Output latency (how long until this window is heard) is how far the
 * window's presentation time is ahead of the sink's playback position — the
 * clock the player's position, its ICY metadata and `liveOffset` use, which
 * the platform keeps on what is heard (its `AudioTrack` timestamps cover the
 * mixer and a Bluetooth route). Until the sink reports a position: the
 * `AudioTrack` buffer, smoothed, or a hardware-buffer estimate.
 *
 * Buffers that come too fast to emit one by one (the decoder filling the
 * output after a connect or a seek) are merged into the next window, not
 * dropped: whoever reads the audio (boundary detection) sees all of it.
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
  /** Mono samples not emitted yet, and the presentation time (µs) of the first. */
  private var mono = FloatArray(4096)
  private var pendingFrames = 0
  private var pendingSumSquares = 0.0
  private var pendingStartUs = C.TIME_UNSET
  /** The presentation time (µs) of the buffer the sink is handling now (the one this tee sees). */
  @Volatile private var bufferPresentationUs = C.TIME_UNSET

  /** The sink, telling the tee which presentation time each buffer it sees has. */
  private inner class TimedSink(sink: AudioSink) : ForwardingAudioSink(sink) {
    override fun handleBuffer(buffer: ByteBuffer, presentationTimeUs: Long, encodedAccessUnitCount: Int): Boolean {
      bufferPresentationUs = presentationTimeUs
      return super.handleBuffer(buffer, presentationTimeUs, encodedAccessUnitCount)
    }

    override fun flush() {
      bufferPresentationUs = C.TIME_UNSET
      super.flush()
    }
  }

  /**
   * The player's renderers, whose audio sink carries this tap (always
   * installed, silent until enabled): the audio renderer and the metadata one
   * (ICY, ID3), as `DefaultRenderersFactory` builds them, and nothing else. No
   * video, text, image or camera-motion renderer is referenced, so R8 drops
   * their code (and the subtitle decoders) from the app.
   */
  /** The renderers: audio (through the sampler's tee) and metadata; a video player's also picture and text. */
  fun renderersFactory(context: Context, video: Boolean = false): RenderersFactory {
    val tee = TeeAudioProcessor(this)
    val codecs = DefaultMediaCodecAdapterFactory(context)
    return RenderersFactory { handler, videoListener, audioListener, textOutput, metadataOutput ->
      val sink =
        TimedSink(DefaultAudioSink.Builder(context).setAudioProcessors(arrayOf<AudioProcessor>(tee)).build())
          .also { audioSink = it }
      // The platform's decoders first; the software ones (when built in) for
      // what it cannot decode.
      val audio: Array<Renderer> =
        arrayOf(
          MediaCodecAudioRenderer(
            context,
            codecs,
            MediaCodecSelector.DEFAULT,
            /* enableDecoderFallback= */ false,
            handler,
            audioListener,
            sink,
          ),
          *DecoderExtensions.audio(handler, audioListener, sink).toTypedArray(),
          MetadataRenderer(metadataOutput, handler.looper),
        )
      // The video module's renderers (none without it: audio apps stay slim).
      if (video) VideoSupport.renderers(context, codecs, handler, videoListener, textOutput) + audio else audio
    }
  }

  override fun flush(sampleRateHz: Int, channelCount: Int, encoding: Int) {
    sampleRate = if (sampleRateHz > 0) sampleRateHz else 44_100
    channels = channelCount.coerceAtLeast(1)
    this.encoding = encoding
    lastEmitNanos = 0L
    smoothedLatency = -1.0
    pendingFrames = 0
    pendingSumSquares = 0.0
    pendingStartUs = C.TIME_UNSET
  }

  override fun handleBuffer(buffer: ByteBuffer) {
    val callback = onWindow
    if (!enabled || callback == null) return
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
    if (pendingFrames == 0) pendingStartUs = bufferPresentationUs
    if (mono.size < pendingFrames + frames) mono = mono.copyOf(maxOf(mono.size * 2, pendingFrames + frames))
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
      mono[pendingFrames + f] = v
      pendingSumSquares += v * v
    }
    pendingFrames += frames
    val now = System.nanoTime()
    // Too soon after the last window (the decoder filling the output): kept for the next.
    if (now - lastEmitNanos < MIN_EMIT_INTERVAL_NANOS) return
    lastEmitNanos = now
    val count = pendingFrames
    callback(
      AudioSampleWindow(
        waveform = resample(mono, count, points),
        level = sqrt(pendingSumSquares / count).coerceIn(0.0, 1.0),
        durationSeconds = count.toDouble() / sampleRate,
        outputLatencySeconds = outputLatency(pendingStartUs),
        timestampMs = System.currentTimeMillis(),
      )
    )
    pendingFrames = 0
    pendingSumSquares = 0.0
  }

  /** Seconds until presentation time [startUs] is heard: its lead over the sink's playback position. */
  private fun outputLatency(startUs: Long): Double {
    val positionUs = runCatching { audioSink?.getCurrentPositionUs(false) ?: AudioSink.CURRENT_POSITION_NOT_SET }
      .getOrDefault(AudioSink.CURRENT_POSITION_NOT_SET)
    if (startUs == C.TIME_UNSET || positionUs == AudioSink.CURRENT_POSITION_NOT_SET) return bufferLatency()
    return ((startUs - positionUs) / 1_000_000.0).coerceAtLeast(0.0)
  }

  /** Before the sink reports a position: its `AudioTrack` buffer, smoothed (or a hardware estimate). */
  private fun bufferLatency(): Double {
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
