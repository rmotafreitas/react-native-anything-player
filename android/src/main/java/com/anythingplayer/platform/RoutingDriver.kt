package com.anythingplayer.platform

import com.anythingplayer.core.EngineDriver
import com.anythingplayer.core.OpenRequest
import com.anythingplayer.core.PlaybackSample

/** An [EngineDriver] that can also report the extra readings behind the progress snapshot. */
internal interface Output : EngineDriver {
  fun progress(): ProgressReading
}

/** An output that plays somewhere else (a Cast receiver). */
internal interface RemoteOutput : Output {
  /** Frees whatever the output holds (listeners, connections). */
  fun destroy()
}

/**
 * The one [EngineDriver] a player's engine talks to: it forwards to the output
 * the audio currently goes to — the device ([local]) or a [RemoteOutput] built
 * on first use. The engine moves the audio with `handoff`, which unloads the
 * item from the old output, then calls [switchOutput], then opens it on the
 * new one; nothing else here knows about routes.
 */
internal class RoutingDriver(
  private val local: Output,
  private val remoteFactory: () -> RemoteOutput?,
) : Output {
  private var remote: RemoteOutput? = null
  private var target: Output = local

  /** Whether the audio currently plays on the remote output. */
  val isRemote: Boolean
    get() = target !== local

  override fun switchOutput(outputId: String) {
    val next: Output = if (outputId.startsWith(CAST_PREFIX)) remoteOutput() ?: local else local
    target = next
    next.switchOutput(outputId)
  }

  private fun remoteOutput(): RemoteOutput? = remote ?: remoteFactory()?.also { remote = it }

  // Plain forwards, not `by` delegation: `by` binds one delegate for good, and
  // `target` changes on every output switch.
  override fun open(request: OpenRequest) = target.open(request)
  override fun play() = target.play()
  override fun pause() = target.pause()
  override fun seek(seconds: Double) = target.seek(seconds)
  override fun releaseConnection() = target.releaseConnection()
  override fun unload() = target.unload()
  override fun setVolume(effective: Double) = target.setVolume(effective)
  override fun setRate(rate: Double) = target.setRate(rate)
  override fun sample(): PlaybackSample = target.sample()
  override fun progress(): ProgressReading = target.progress()

  /** Frees the remote output; the local driver is destroyed by its owner. */
  fun destroyRemote() {
    remote?.destroy()
    remote = null
    target = local
  }

  companion object {
    /** `switchOutput` ids: `local`, or `cast:<deviceId>`. */
    const val LOCAL = "local"
    const val CAST_PREFIX = "cast:"
  }
}
