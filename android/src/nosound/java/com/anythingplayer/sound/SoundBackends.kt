package com.anythingplayer.sound

import android.content.Context

// The build without the Sound API (the default): nothing is linked, the module
// reports `unavailable`. `src/sound` holds the SoundPool implementation,
// compiled in instead of this file with `rnapSound=true` (see
// `android/build.gradle`).

/** The Sound implementation this build has. Chosen at build time: `src/sound` or `src/nosound`. */
internal object SoundBackends {
  const val available = false

  fun create(context: Context): SoundBackend = UnavailableSoundBackend
}

private object UnavailableSoundBackend : SoundBackend {
  override fun load(uri: String, voices: Int, done: (Result<LoadedSound>) -> Unit) {
    done(
      Result.failure(
        SoundException(
          "SOUND_UNAVAILABLE",
          "Sound is not built in. Set `rnapSound=true` in gradle.properties (or the Expo plugin's `sound` option) and rebuild.",
        )
      )
    )
  }

  override fun unload(soundId: String, done: () -> Unit) = done()

  override fun play(soundId: String, voiceId: Long, volume: Double, rate: Double, pan: Double, loop: Boolean) = Unit

  override fun setVoice(voiceId: Long, volume: Double, rate: Double, pan: Double) = Unit

  override fun stopVoice(voiceId: Long) = Unit

  override fun stopSound(soundId: String) = Unit

  override fun stopAll() = Unit

  override fun release() = Unit
}
