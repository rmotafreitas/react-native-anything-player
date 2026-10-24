package com.anythingplayer.platform

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.LocaleList
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.CaptioningManager
import androidx.core.content.ContextCompat
import com.anythingplayer.core.SystemPreferences
import java.util.Locale

/**
 * What the OS says about the user, for a video player's track choice: the
 * device's languages, the caption setting (Settings › Accessibility ›
 * Caption preferences) and, on Android 13+, audio descriptions. Reports
 * changes on the main thread.
 */
internal class SystemPreferencesMonitor(context: Context, private val onChange: (SystemPreferences) -> Unit) {
  private val captioning = context.getSystemService(Context.CAPTIONING_SERVICE) as? CaptioningManager
  private val accessibility = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager
  private var last: SystemPreferences? = null

  init {
    captioning?.addCaptioningChangeListener(
      object : CaptioningManager.CaptioningChangeListener() {
        override fun onEnabledChanged(enabled: Boolean) = changed()

        override fun onLocaleChanged(locale: Locale?) = changed()
      },
    )
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      accessibility?.addAudioDescriptionRequestedChangeListener(ContextCompat.getMainExecutor(context)) { _ -> changed() }
    }
    ContextCompat.registerReceiver(
      context,
      object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = changed()
      },
      IntentFilter(Intent.ACTION_LOCALE_CHANGED),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
  }

  fun current(): SystemPreferences {
    val locales = LocaleList.getDefault()
    val languages = mutableListOf<String>()
    // A caption language the user picked comes first.
    captioning?.locale?.toLanguageTag()?.let(languages::add)
    for (i in 0 until locales.size()) languages.add(locales[i].toLanguageTag())
    val descriptions =
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && accessibility?.isAudioDescriptionRequested == true
    return SystemPreferences(languages.distinct(), captioning?.isEnabled == true, descriptions).also { last = it }
  }

  private fun changed() {
    val next = current()
    onChange(next)
  }
}
