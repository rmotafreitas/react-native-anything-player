package com.anythingplayer.platform

import com.anythingplayer.core.EngineQueueItem
import com.anythingplayer.core.ErrorCode
import com.anythingplayer.core.PlaybackEngine
import com.anythingplayer.core.PlayerError
import com.anythingplayer.core.QueueState
import com.anythingplayer.core.RepeatMode
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap

/**
 * A player's queue commands (`queueCommand`), and what the host keeps for
 * each queue item besides its source: its lock-screen fields and video
 * parts. The queue itself is the engine's. Twin of the web's `WebQueue.ts`.
 * Main thread.
 */
internal class QueueHost(private val engine: PlaybackEngine) {
  class Parts(val fields: NowPlayingFields, val video: VideoLoadParts)

  private val parts = HashMap<String, Parts>()

  /** The engine's snapshot, readable from any thread (`getQueue`). */
  @Volatile var snapshot: QueueState = engine.queueState
    private set

  operator fun get(id: String): Parts? = parts[id]

  fun command(command: ReadableMap) {
    try {
      when (val op = command.optString("op")) {
        "set" -> {
          val (items, added) = items(command.optArray("items"))
          // Before the engine loads the first item: it asks for its parts.
          val previous = HashMap(parts)
          parts.putAll(added)
          try {
            engine.queueSet(
              items,
              command.optDouble("startIndex")?.toInt() ?: 0,
              command.optDouble("startPosition"),
              command.optBoolean("autoplay"),
            )
          } catch (error: PlayerError) {
            parts.clear()
            parts.putAll(previous)
            throw error
          }
        }
        "add" -> {
          val (items, added) = items(command.optArray("items"))
          val clash = added.keys.firstOrNull { it in snapshot.ids }
          if (clash != null) throw invalid("Two queue items have the id \"$clash\".")
          parts.putAll(added)
          engine.queueAdd(items, command.optDouble("index")?.toInt())
        }
        "remove" -> engine.queueRemove(strings(command.optArray("ids")))
        "move" -> engine.queueMove(command.optDouble("from")?.toInt() ?: -1, command.optDouble("to")?.toInt() ?: -1)
        "clear" -> engine.queueClear()
        "skipTo" -> engine.queueSkipTo(command.optString("id") ?: "", command.optDouble("position"))
        "next" -> engine.queueNext()
        "previous" -> engine.queuePrevious()
        "repeat" -> {
          val mode = command.optString("mode") ?: ""
          engine.setRepeat(RepeatMode.from(mode) ?: throw invalid("Unknown repeat mode \"$mode\"."))
        }
        "shuffle" -> engine.setShuffle(command.optBoolean("enabled") == true)
        else -> throw invalid("Unknown queue command \"$op\".")
      }
    } finally {
      changed()
    }
  }

  /** The engine's queue changed: the snapshot follows, and items that left let go of their parts. */
  fun changed() {
    snapshot = engine.queueState
    val kept = snapshot.ids.toSet()
    parts.keys.retainAll(kept)
  }

  fun map(): WritableMap = queueToMap(snapshot)

  private fun items(array: ReadableArray?): Pair<List<EngineQueueItem>, Map<String, Parts>> {
    if (array == null) throw invalid("Queue items must be an array.")
    val added = HashMap<String, Parts>()
    val items =
      (0 until array.size()).map { i ->
        val map = array.getMap(i) ?: throw invalid("A queue item must be an object.")
        val id = map.optString("id")?.takeIf { it.isNotEmpty() } ?: throw invalid("Every queue item needs an id.")
        val (source, fields) = parseSource(map)
        added[id] = Parts(fields, parseVideoParts(map))
        EngineQueueItem(id, source.liveHint == true, source)
      }
    return items to added
  }

  private fun strings(array: ReadableArray?): List<String> {
    if (array == null) throw invalid("`ids` must be an array.")
    return (0 until array.size()).mapNotNull { array.getString(it) }
  }

  private fun invalid(message: String) = PlayerError(ErrorCode.INVALID_ARGUMENT, message, false)
}

/** `{ ids, order, index, currentId, repeat, shuffle }`. */
internal fun queueToMap(q: QueueState): WritableMap =
  Arguments.createMap().apply {
    putArray("ids", Arguments.fromList(q.ids))
    putArray("order", Arguments.fromList(q.order))
    q.index?.let { putInt("index", it) } ?: putNull("index")
    q.currentId?.let { putString("currentId", it) } ?: putNull("currentId")
    putString("repeat", q.repeat.wire)
    putBoolean("shuffle", q.shuffle)
  }
