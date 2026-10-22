package com.anythingplayer

import com.anythingplayer.sound.SoundBackend
import com.anythingplayer.sound.SoundBackends
import com.anythingplayer.sound.SoundException
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap

/**
 * The Sound API's TurboModule. Thin: the backend (a SoundPool with `rnapSound=true`,
 * a stub that reports `unavailable` without) does the work on its own thread,
 * so `play` and the other calls return at once. Nothing here touches audio
 * focus or the media session.
 */
class AnythingPlayerSoundModule(reactContext: ReactApplicationContext) : NativeAnythingPlayerSoundSpec(reactContext) {
  // Created on first use: an app that never plays a sound pays for no thread.
  private val backend: SoundBackend by lazy { SoundBackends.create(reactApplicationContext) }
  private var created = false

  companion object {
    const val NAME = NativeAnythingPlayerSoundSpec.NAME
  }

  private fun backend(): SoundBackend {
    created = true
    return backend
  }

  override fun isAvailable(): Boolean = SoundBackends.available

  // Android has no silent switch: nothing to configure.
  override fun configure(options: ReadableMap, promise: Promise) = promise.resolve(null)

  override fun load(source: ReadableMap, options: ReadableMap, promise: Promise) {
    val uri = if (source.hasKey("uri")) source.getString("uri") else null
    val voices = if (options.hasKey("voices")) options.getDouble("voices").toInt() else 4
    if (uri.isNullOrBlank()) {
      reject(promise, SoundException("INVALID_SOURCE", "A sound needs a non-empty `uri`."))
      return
    }
    backend().load(uri, voices) { result ->
      result.fold(
        onSuccess = { loaded ->
          promise.resolve(
            Arguments.createMap().apply {
              putString("id", loaded.id)
              val duration = loaded.durationSeconds
              if (duration != null) putDouble("duration", duration) else putNull("duration")
            }
          )
        },
        onFailure = { error ->
          reject(
            promise,
            error as? SoundException
              ?: SoundException("INTERNAL_ERROR", error.message ?: error.javaClass.simpleName, causeDescription = error.toString()),
          )
        },
      )
    }
  }

  override fun unload(soundId: String, promise: Promise) {
    backend().unload(soundId) { promise.resolve(null) }
  }

  override fun play(soundId: String, voiceId: Double, volume: Double, rate: Double, pan: Double, loop: Boolean) {
    backend().play(soundId, voiceId.toLong(), volume, rate, pan, loop)
  }

  override fun setVoice(voiceId: Double, volume: Double, rate: Double, pan: Double) {
    backend().setVoice(voiceId.toLong(), volume, rate, pan)
  }

  override fun stopVoice(voiceId: Double) {
    backend().stopVoice(voiceId.toLong())
  }

  override fun stopSound(soundId: String) {
    backend().stopSound(soundId)
  }

  override fun stopAll() {
    // Nothing was ever loaded: nothing to stop (and no thread to start).
    if (created) backend.stopAll()
  }

  override fun invalidate() {
    super.invalidate()
    if (created) backend.release()
  }

  private fun reject(promise: Promise, error: SoundException) {
    val info = Arguments.createMap().apply {
      putString("code", error.code)
      putString("message", error.message)
      putBoolean("recoverable", error.recoverable)
      putString("platform", "android")
      error.httpStatus?.let { putInt("httpStatus", it) }
      error.causeDescription?.let { putString("cause", it) }
    }
    promise.reject(error.code, error.message, info)
  }
}
