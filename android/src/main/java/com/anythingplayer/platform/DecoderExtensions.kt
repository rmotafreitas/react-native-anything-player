package com.anythingplayer.platform

import android.os.Handler
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.audio.AudioRendererEventListener
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.video.VideoRendererEventListener

/**
 * Media3's software decoders (FFmpeg audio, libvpx VP9, dav1d AV1), when the
 * app is built with them (`rnapVideoDecoders=true`, `npx rnap add
 * video-decoders`). Each comes after the platform's decoder of its kind, so
 * it decodes only what the device cannot: AC-3, E-AC-3, DTS, TrueHD and MPEG
 * audio layer II, VP9 and AV1 where there is no decoder for them. Created by
 * name: an app without them links none of this.
 */
@OptIn(UnstableApi::class)
internal object DecoderExtensions {
  private const val TAG = "RNAP"
  private const val FFMPEG_AUDIO = "androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer"
  private const val VP9_VIDEO = "androidx.media3.decoder.vp9.LibvpxVideoRenderer"
  private const val AV1_VIDEO = "androidx.media3.decoder.av1.Libdav1dVideoRenderer"

  /** The software audio decoder, sharing the platform decoder's sink. */
  fun audio(handler: Handler, listener: AudioRendererEventListener, sink: AudioSink): List<Renderer> =
    listOfNotNull(
      make(
        FFMPEG_AUDIO,
        arrayOf(Handler::class.java, AudioRendererEventListener::class.java, AudioSink::class.java),
        handler,
        listener,
        sink,
      )
    )

  /** The software video decoders. */
  fun video(handler: Handler, listener: VideoRendererEventListener, joiningMs: Long, droppedFramesToNotify: Int): List<Renderer> {
    val types =
      arrayOf(Long::class.javaPrimitiveType!!, Handler::class.java, VideoRendererEventListener::class.java, Int::class.javaPrimitiveType!!)
    return listOfNotNull(
      make(VP9_VIDEO, types, joiningMs, handler, listener, droppedFramesToNotify),
      make(AV1_VIDEO, types, joiningMs, handler, listener, droppedFramesToNotify),
    )
  }

  /** The decoders built into the app (`ffmpeg`, `vp9`, `av1`). */
  val installed: List<String> by lazy {
    listOf("ffmpeg" to FFMPEG_AUDIO, "vp9" to VP9_VIDEO, "av1" to AV1_VIDEO)
      .filter { (_, name) -> runCatching { Class.forName(name) }.isSuccess }
      .map { it.first }
  }

  private fun make(name: String, types: Array<Class<*>>, vararg args: Any): Renderer? {
    val type =
      try {
        Class.forName(name)
      } catch (_: ClassNotFoundException) {
        return null // Not built in.
      }
    return try {
      type.getConstructor(*types).newInstance(*args) as Renderer
    } catch (e: ReflectiveOperationException) {
      // Built for another Media3 version than the app's.
      Log.w(TAG, "$name could not be created: ${e.cause ?: e}")
      null
    }
  }
}
