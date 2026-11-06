package com.anythingplayer.core

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Runs `conformance/queue/model.json` (shared with Swift and the web). */
class QueueModelTest {
  private data class Entry(override val id: String, override val live: Boolean) : QueueEntry

  private fun entries(array: JSONArray): List<Entry> =
    (0 until array.length()).map { i ->
      when (val v = array.get(i)) {
        is String -> Entry(v, false)
        else -> (v as JSONObject).let { Entry(it.getString("id"), it.optBoolean("live", false)) }
      }
    }

  private fun strings(array: JSONArray) = (0 until array.length()).map { array.getString(it) }

  private fun value(o: JSONObject, key: String): Any? = if (o.isNull(key)) null else o.get(key)

  @Test
  fun scenarios() {
    val scenarios = JSONArray(File(ConformanceTest.conformanceDir, "queue/model.json").readText())
    assertTrue(scenarios.length() > 10)
    for (i in 0 until scenarios.length()) {
      val scenario = scenarios.getJSONObject(i)
      run(scenario.getString("name"), scenario.getJSONArray("steps"))
    }
  }

  private fun run(name: String, steps: JSONArray) {
    val q = QueueModel<Entry>(1)
    for (i in 0 until steps.length()) {
      val step = steps.getJSONObject(i)
      val at = "$name, step $i"
      if (step.has("expect")) {
        val e = step.getJSONObject("expect")
        for (key in e.keys()) {
          val want = value(e, key)
          val actual: Any? =
            when (key) {
              "current" -> q.current?.id
              "index" -> q.index
              "items" -> q.items.map { it.id }
              "order" -> q.order.toList()
              "next" -> q.peekNext(false)?.id
              "nextAuto" -> q.peekNext(true)?.id
              "previous" -> q.peekPrevious()?.id
              else -> fail("$at: unknown expectation $key")
            }
          val expected = if (want is JSONArray) strings(want) else if (want is Number) want.toInt() else want
          assertEquals("$at: $key", expected, actual)
        }
        continue
      }
      var result: Any? = null
      when (val call = step.getString("call")) {
        "set" -> q.set(entries(step.getJSONArray("items")), step.optInt("start", 0))
        "add" -> {
          val items = entries(step.getJSONArray("items"))
          if (step.has("index")) q.add(items, step.getInt("index")) else q.add(items)
        }
        "remove" -> result = q.remove(strings(step.getJSONArray("ids")))
        "move" -> q.move(step.getInt("from"), step.getInt("to"))
        "clear" -> q.clear()
        "skipTo" -> result = q.skipTo(step.getString("id"))
        "repeat" -> q.setRepeat(RepeatMode.from(step.getString("value"))!!)
        "shuffle" -> q.setShuffle(step.getBoolean("value"), if (step.has("seed")) step.getLong("seed") else null)
        "next" -> result = q.next(step.optBoolean("auto", false))?.id
        "previous" ->
          result =
            when (val action = q.previous(step.getDouble("position"))) {
              is PreviousAction.Item -> "item:${action.id}"
              PreviousAction.Restart -> "restart"
              PreviousAction.None -> "none"
            }
        else -> fail("$at: unknown call $call")
      }
      if (step.has("result")) assertEquals("$at: result", value(step, "result"), result)
    }
  }

  @Test
  fun `xorshift32 gives the same sequence as the twins`() {
    val r = QueueRandom(42)
    assertEquals(listOf(11355432L, 2836018348L, 476557059L), listOf(r.next(), r.next(), r.next()))
    assertEquals(QueueRandom(0x9E3779B9L).next(), QueueRandom(0).next())
  }
}
