package com.anythingplayer.core

// A player's queue: which item is current, what comes next and before, in
// list or shuffled order, and how edits move the current item. Pure state:
// the engine loads what it decides. Twins: `src/web/engine/QueueModel.ts`,
// `ios/Core/QueueModel.swift`; held to `conformance/queue`.

enum class RepeatMode(val wire: String) {
  OFF("off"),
  ONE("one"),
  ALL("all"),
  ;

  companion object {
    fun from(wire: String): RepeatMode? = entries.firstOrNull { it.wire == wire }
  }
}

/** What the model needs to know of an item. */
interface QueueEntry {
  val id: String

  /** A live stream: never ends on its own, `previous` never restarts it. */
  val live: Boolean
}

/** What `previous` does. */
sealed class PreviousAction {
  object Restart : PreviousAction()

  data class Item(val id: String) : PreviousAction()

  object None : PreviousAction()
}

/** `previous` more than this far into a finite item restarts it, seconds. */
const val RESTART_THRESHOLD_S = 3.0

/** xorshift32: the shuffle's generator, the same in every twin. */
class QueueRandom(seed: Long) {
  private var state: Int = (seed and 0xFFFFFFFFL).toInt().let { if (it == 0) 0x9E3779B9L.toInt() else it }

  /** The next value, 0 ≤ n < 2³². */
  fun next(): Long {
    var x = state
    x = x xor (x shl 13)
    x = x xor (x ushr 17)
    x = x xor (x shl 5)
    state = x
    return x.toLong() and 0xFFFFFFFFL
  }

  /** 0 ≤ n < bound. */
  fun below(bound: Int): Int = (next() % bound).toInt()
}

class QueueModel<T : QueueEntry>(seed: Long = System.currentTimeMillis()) {
  private var list: MutableList<T> = mutableListOf()
  private var playOrder: MutableList<String> = mutableListOf()
  private var currentId: String? = null
  private var random = QueueRandom(seed)

  var repeat: RepeatMode = RepeatMode.OFF
    private set
  var shuffle: Boolean = false
    private set

  val items: List<T> get() = list
  val order: List<String> get() = playOrder
  val current: T? get() = currentId?.let { find(it) }
  val index: Int? get() = currentId?.let { id -> indexOf(id).takeIf { it >= 0 } }
  val length: Int get() = list.size

  fun find(id: String): T? = list.firstOrNull { it.id == id }

  fun indexOf(id: String): Int = list.indexOfFirst { it.id == id }

  // ── Edits ──

  fun set(items: List<T>, startIndex: Int = 0) {
    list = items.toMutableList()
    currentId = if (items.isEmpty()) null else items[startIndex.coerceIn(0, items.size - 1)].id
    reorder()
  }

  fun add(items: List<T>, index: Int = list.size) {
    if (items.isEmpty()) return
    val at = index.coerceIn(0, list.size)
    list.addAll(at, items)
    if (!shuffle) {
      playOrder = list.map { it.id }.toMutableList()
    } else {
      for (item in items) {
        val pos = currentId?.let { playOrder.indexOf(it) } ?: -1
        val slots = playOrder.size - pos
        playOrder.add(pos + 1 + random.below(slots), item.id)
      }
    }
    if (currentId == null) currentId = playOrder.firstOrNull()
  }

  /** Returns whether the current item changed. */
  fun remove(ids: List<String>): Boolean {
    val gone = ids.toSet()
    val before = currentId
    val replacement =
      if (before != null && before in gone) {
        val pos = playOrder.indexOf(before)
        val after = playOrder.drop(pos + 1).firstOrNull { it !in gone }
        val earlier = playOrder.take(pos).reversed().firstOrNull { it !in gone }
        after ?: earlier
      } else {
        before
      }
    list = list.filter { it.id !in gone }.toMutableList()
    playOrder = playOrder.filter { it !in gone }.toMutableList()
    currentId = replacement
    return currentId != before
  }

  fun move(from: Int, to: Int) {
    if (from < 0 || from >= list.size) return
    val target = to.coerceIn(0, list.size - 1)
    val item = list.removeAt(from)
    list.add(target, item)
    if (!shuffle) playOrder = list.map { it.id }.toMutableList()
  }

  fun clear() {
    val current = this.current
    list = if (current != null) mutableListOf(current) else mutableListOf()
    playOrder = if (current != null) mutableListOf(current.id) else mutableListOf()
  }

  fun skipTo(id: String): Boolean {
    if (find(id) == null) return false
    currentId = id
    return true
  }

  fun setRepeat(mode: RepeatMode) {
    repeat = mode
  }

  fun setShuffle(on: Boolean, seed: Long? = null) {
    if (seed != null) random = QueueRandom(seed)
    shuffle = on
    reorder()
  }

  // ── Navigation ──

  fun peekNext(auto: Boolean): T? {
    val current = currentId ?: return null
    if (auto && repeat == RepeatMode.ONE) return this.current
    val pos = playOrder.indexOf(current)
    val id =
      when {
        pos + 1 < playOrder.size -> playOrder[pos + 1]
        repeat != RepeatMode.OFF -> playOrder.firstOrNull()
        else -> null
      }
    return id?.let { find(it) }
  }

  fun peekPrevious(): T? {
    val current = currentId ?: return null
    val pos = playOrder.indexOf(current)
    val id =
      when {
        pos > 0 -> playOrder[pos - 1]
        repeat != RepeatMode.OFF -> playOrder.lastOrNull()
        else -> null
      }
    return id?.let { find(it) }
  }

  fun next(auto: Boolean): T? {
    val item = peekNext(auto) ?: return null
    currentId = item.id
    return item
  }

  fun previous(position: Double): PreviousAction {
    val current = this.current ?: return PreviousAction.None
    if (!current.live && position > RESTART_THRESHOLD_S) return PreviousAction.Restart
    val before = peekPrevious()
    if (before == null || before.id == current.id) {
      return if (current.live) PreviousAction.None else PreviousAction.Restart
    }
    currentId = before.id
    return PreviousAction.Item(before.id)
  }

  private fun reorder() {
    val ids = list.map { it.id }
    if (!shuffle) {
      playOrder = ids.toMutableList()
      return
    }
    val rest = ids.filter { it != currentId }.toMutableList()
    for (i in rest.size - 1 downTo 1) {
      val j = random.below(i + 1)
      val tmp = rest[i]
      rest[i] = rest[j]
      rest[j] = tmp
    }
    playOrder = (if (currentId == null) rest else (listOf(currentId!!) + rest)).toMutableList()
  }
}
