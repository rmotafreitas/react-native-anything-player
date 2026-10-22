package com.anythingplayer.sound

/**
 * The voices of one sound: at most `capacity` play at once, and when all are
 * busy the one that started first is stopped to make room. Pure bookkeeping
 * (no Android types): the SoundPool backend asks it which voice to stop.
 *
 * SoundPool does not say when a stream ends, so a voice counts as busy until
 * the time it should have ended (`endsAt`, from the sound's duration and rate)
 * has passed; a looping voice, or one whose end is unknown, is busy until it
 * is stopped. Stopping a voice that already ended is harmless, so an unknown
 * end costs nothing but a less exact choice of whom to steal.
 */
internal class VoiceAllocator(val capacity: Int) {
  class Slot(val voiceId: Long, val startedAt: Long, var endsAt: Long?) {
    /** SoundPool's stream id; 0 until the stream started. */
    var streamId: Int = 0
  }

  /** Oldest first. */
  private val slots = ArrayList<Slot>()

  /**
   * Makes room for a new voice. Returns the voice to stop (the oldest, when
   * every slot is busy), or `null` when there was a free one. The new voice
   * is registered either way; read it back with [slot].
   */
  fun begin(voiceId: Long, now: Long, endsAt: Long?): Slot? {
    slots.removeAll { it.endsAt?.let { end -> end <= now } == true }
    val stolen = if (slots.size >= capacity) slots.removeAt(0) else null
    slots.add(Slot(voiceId, now, endsAt))
    return stolen
  }

  fun slot(voiceId: Long): Slot? = slots.firstOrNull { it.voiceId == voiceId }

  fun remove(voiceId: Long): Slot? = slot(voiceId)?.also { slots.remove(it) }

  /** Every voice, forgotten. */
  fun clear(): List<Slot> = slots.toList().also { slots.clear() }

  val size: Int get() = slots.size
}
