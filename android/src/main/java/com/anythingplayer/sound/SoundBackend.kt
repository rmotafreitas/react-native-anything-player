package com.anythingplayer.sound

/** A sound that was decoded: its id, and its length when the platform says. */
internal class LoadedSound(val id: String, val durationSeconds: Double?)

/** What went wrong in the Sound API; `code` is a `PlayerErrorCode` of the JS API. */
internal class SoundException(
  val code: String,
  override val message: String,
  val recoverable: Boolean = false,
  val httpStatus: Int? = null,
  val causeDescription: String? = null,
) : Exception(message)

/**
 * The Sound API's native side. `src/sound` has the SoundPool implementation,
 * `src/nosound` a stub that reports unavailable (chosen at build time by
 * `rnapSound`, see `android/build.gradle`). Calls come from the JS thread and
 * return at once; the implementation works on its own thread.
 */
internal interface SoundBackend {
  fun load(uri: String, voices: Int, done: (Result<LoadedSound>) -> Unit)
  fun unload(soundId: String, done: () -> Unit)
  fun play(soundId: String, voiceId: Long, volume: Double, rate: Double, pan: Double, loop: Boolean)
  fun setVoice(voiceId: Long, volume: Double, rate: Double, pan: Double)
  fun stopVoice(voiceId: Long)
  fun stopSound(soundId: String)
  fun stopAll()
  fun release()
}
