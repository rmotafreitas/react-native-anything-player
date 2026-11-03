package com.anythingplayer

import android.app.Activity
import android.content.Intent
import com.anythingplayer.platform.AnythingPlayerRuntime
import com.anythingplayer.platform.AssistantIntents
import com.anythingplayer.platform.Voice

/**
 * Entry points for the app's own native code.
 *
 * Voice requests from Google Assistant and Gemini can arrive as an activity
 * intent (`MEDIA_PLAY_FROM_SEARCH`). Pass the main activity's intents here, in
 * `onCreate` and `onNewIntent` (the Expo plugin does it for you):
 *
 * ```kotlin
 * override fun onCreate(savedInstanceState: Bundle?) {
 *   super.onCreate(savedInstanceState)
 *   AnythingPlayer.handleIntent(this, intent)
 * }
 * override fun onNewIntent(intent: Intent) {
 *   super.onNewIntent(intent)
 *   AnythingPlayer.handleIntent(this, intent)
 * }
 * ```
 */
object AnythingPlayer {
  /**
   * Plays what a `MEDIA_PLAY_FROM_SEARCH` intent asks for, from the catalog
   * set with `setCatalog()`. It works before any JavaScript runs. With no
   * catalog yet (a fresh install), it waits for the app's `setCatalog` or
   * search handler (docs/voice.md). An intent is acted on once — the same one
   * handed over again after the activity was recreated is ignored.
   *
   * @return whether [intent] was a request to play something (acted on now,
   *   or waiting for the app's catalog).
   */
  @JvmStatic
  fun handleIntent(activity: Activity, intent: Intent?): Boolean {
    if (!AssistantIntents.isPending(intent)) return false
    intent!!.putExtra(AssistantIntents.EXTRA_HANDLED, true)
    val request = AssistantIntents.fromIntent(intent)
    val context = activity.applicationContext
    AnythingPlayerRuntime.post {
      AnythingPlayerRuntime.initialize(context)
      Voice.playFromAssistant(request)
    }
    return true
  }
}
