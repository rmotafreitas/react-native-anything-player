package com.anythingplayer.sound

/**
 * The loads in flight, so each promise settles exactly once, whatever happens
 * to the thread that would have settled it. A load finishes on a worker; when
 * the module is invalidated meanwhile, [close] rejects every load still
 * waiting at once, and the worker's late [finish] finds its load settled
 * and is told so (it then frees what it decoded). Safe from any thread;
 * callbacks run outside the lock.
 */
internal class PendingLoads {
  private val lock = Any()
  private val pending = HashMap<Long, (Result<LoadedSound>) -> Unit>()
  private var next = 0L
  private var closedBy: SoundException? = null

  /**
   * Starts tracking a load; returns its ticket. When already closed, settles
   * `done` with the closing error and returns `null`.
   */
  fun begin(done: (Result<LoadedSound>) -> Unit): Long? {
    var ticket = -1L
    val error =
      synchronized(lock) {
        closedBy ?: run {
          ticket = next++
          pending[ticket] = done
          null
        }
      }
    if (error != null) {
      done(Result.failure(error))
      return null
    }
    return ticket
  }

  /** Whether the load is still waiting to be settled. */
  fun isPending(ticket: Long): Boolean = synchronized(lock) { pending.containsKey(ticket) }

  /** Settles the load with `result`. Returns `false` (and does nothing) when it was already settled. */
  fun finish(ticket: Long, result: Result<LoadedSound>): Boolean {
    val done = synchronized(lock) { pending.remove(ticket) } ?: return false
    done(result)
    return true
  }

  /** Rejects every load in flight with `error`, and every later one. */
  fun close(error: SoundException) {
    val waiting =
      synchronized(lock) {
        if (closedBy == null) closedBy = error
        pending.values.toList().also { pending.clear() }
      }
    waiting.forEach { it(Result.failure(error)) }
  }
}
