package com.anythingplayer.platform

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.JavaOnlyArray
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.ReadableType
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import org.json.JSONArray
import org.json.JSONObject

// The catalog lives as JSON on disk (it must load with no React instance);
// these cross it to the bridge's maps and back.

/** A JS value as JSON. */
internal fun ReadableMap.toJson(): JSONObject {
  val json = JSONObject()
  val keys = keySetIterator()
  while (keys.hasNextKey()) {
    val key = keys.nextKey()
    when (getType(key)) {
      // A null is a value (`giveUpAfterMs: null` means "never give up"): keep it.
      ReadableType.Null -> json.put(key, JSONObject.NULL)
      ReadableType.Boolean -> json.put(key, getBoolean(key))
      ReadableType.Number -> json.put(key, getDouble(key).let { if (it == Math.rint(it) && Math.abs(it) < 1e15) it.toLong() else it })
      ReadableType.String -> json.put(key, getString(key))
      ReadableType.Map -> json.put(key, getMap(key)!!.toJson())
      ReadableType.Array -> json.put(key, getArray(key)!!.toJson())
    }
  }
  return json
}

internal fun ReadableArray.toJson(): JSONArray {
  val json = JSONArray()
  for (index in 0 until size()) {
    when (getType(index)) {
      ReadableType.Null -> json.put(JSONObject.NULL)
      ReadableType.Boolean -> json.put(getBoolean(index))
      ReadableType.Number -> json.put(getDouble(index).let { if (it == Math.rint(it) && Math.abs(it) < 1e15) it.toLong() else it })
      ReadableType.String -> json.put(getString(index))
      ReadableType.Map -> json.put(getMap(index)!!.toJson())
      ReadableType.Array -> json.put(getArray(index)!!.toJson())
    }
  }
  return json
}

/** JSON as a map the option and source parsers read, with no native library involved. */
internal fun JSONObject.toReadableMap(): ReadableMap {
  val map = JavaOnlyMap()
  for (key in keys()) putValue(map, key, get(key))
  return map
}

private fun JSONArray.toReadableArray(): ReadableArray {
  val array = JavaOnlyArray()
  for (index in 0 until length()) {
    when (val value = get(index)) {
      JSONObject.NULL -> array.pushNull()
      is Boolean -> array.pushBoolean(value)
      is Number -> array.pushDouble(value.toDouble())
      is String -> array.pushString(value)
      is JSONObject -> array.pushMap(value.toReadableMap())
      is JSONArray -> array.pushArray(value.toReadableArray())
    }
  }
  return array
}

private fun putValue(map: JavaOnlyMap, key: String, value: Any?) {
  when (value) {
    null, JSONObject.NULL -> map.putNull(key)
    is Boolean -> map.putBoolean(key, value)
    is Number -> map.putDouble(key, value.toDouble())
    is String -> map.putString(key, value)
    is JSONObject -> map.putMap(key, value.toReadableMap())
    is JSONArray -> map.putArray(key, value.toReadableArray())
  }
}

/** JSON as a map to emit to JS (needs the React native library: not for unit tests). */
internal fun JSONObject.toWritableMap(): WritableMap {
  val map = Arguments.createMap()
  for (key in keys()) {
    when (val value = get(key)) {
      JSONObject.NULL -> map.putNull(key)
      is Boolean -> map.putBoolean(key, value)
      is Number -> map.putDouble(key, value.toDouble())
      is String -> map.putString(key, value)
      is JSONObject -> map.putMap(key, value.toWritableMap())
      is JSONArray -> map.putArray(key, value.toWritableArray())
    }
  }
  return map
}

private fun JSONArray.toWritableArray(): WritableArray {
  val array = Arguments.createArray()
  for (index in 0 until length()) {
    when (val value = get(index)) {
      JSONObject.NULL -> array.pushNull()
      is Boolean -> array.pushBoolean(value)
      is Number -> array.pushDouble(value.toDouble())
      is String -> array.pushString(value)
      is JSONObject -> array.pushMap(value.toWritableMap())
      is JSONArray -> array.pushArray(value.toWritableArray())
    }
  }
  return array
}
