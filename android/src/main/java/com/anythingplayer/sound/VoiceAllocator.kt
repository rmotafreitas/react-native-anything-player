package com.anythingplayer.sound

/**
 * The voices of every sound, on one shared SoundPool: each sound has its own
 * limit (`Sound.load({ voices })`), and the pool has a global cap of
 * `maxStreams`. A new voice that finds its sound's voices busy takes the place
 * of that sound's oldest; one that finds the pool full takes the place of the
 * oldest voice of any sound. Pure bookkeeping (no Android types): the SoundPool
 * backend asks it which voice to stop.
 *
 * SoundPool does not say when a stream ends, so a voice counts as busy until
 * the time it should have ended (`endsAt`, from the sound's duration and rate)
 * has passed; a looping voice, or one whose end is unknown, is busy until it
 * is stopped. Stopping a voice that already ended is harmless, so an unknown
 * end costs nothing but a less exact choice of whom to steal.
 */
internal class VoiceAllocator(val maxStreams: Int) {
  class Slot(val voiceId: Long, val soundId: String, val startedAt: Long, var endsAt: Long?) {
    /** SoundPool's stream id; 0 until the stream started. */
    var streamId: Int = 0
  }

  /** What [begin] did to make room: voices that ended on their own, and the one stopped for the new voice. */
  class Begin(val expired: List<Slot>, val stolen: Slot?)

  /** Oldest first. */
  private val slots = ArrayList<Slot>()

  /**
   * Makes room for a new voice of `soundId`, which may have `soundVoices`
   * voices at once. Drops the voices whose estimated end has passed
   * ([Begin.expired]), then stops the sound's oldest if the sound is full, then
   * the oldest of all if the pool is. The new voice is registered either way;
   * read it back with [slot].
   */
  fun begin(soundId: String, soundVoices: Int, voiceId: Long, now: Long, endsAt: Long?): Begin {
    val expired = slots.filter { it.endsAt?.let { end -> end <= now } == true }
    slots.removeAll(expired)
    var stolen: Slot? = null
    if (slots.count { it.soundId == soundId } >= soundVoices) {
      stolen = slots.first { it.soundId == soundId }
    } else if (slots.size >= maxStreams) {
      stolen = slots.first()
    }
    stolen?.let { slots.remove(it) }
    slots.add(Slot(voiceId, soundId, now, endsAt))
    return Begin(expired, stolen)
  }

  fun slot(voiceId: Long): Slot? = slots.firstOrNull { it.voiceId == voiceId }

  fun remove(voiceId: Long): Slot? = slot(voiceId)?.also { slots.remove(it) }

  /** Every voice of one sound, forgotten. */
  fun clear(soundId: String): List<Slot> = slots.filter { it.soundId == soundId }.also { slots.removeAll(it) }

  /** Every voice, forgotten. */
  fun clear(): List<Slot> = slots.toList().also { slots.clear() }

  val size: Int get() = slots.size
}
