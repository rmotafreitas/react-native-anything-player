package com.radioanimu.airwave.platform

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.radioanimu.airwave.core.FocusResult

/** Focus changes, already reduced to what players need to do. */
internal interface FocusListener {
  fun onFocusLost(transient: Boolean)
  fun onFocusGained()
  fun onDuck(ducked: Boolean)
}

/**
 * The app's single audio-focus request, shared by every player (Android grants
 * focus per app, not per player). Main thread only.
 *
 * Lessons encoded here (all from production):
 * - Request `AUDIOFOCUS_GAIN`, never `GAIN_TRANSIENT`: a transient request
 *   makes other apps pause "temporarily" and auto-resume the moment we abandon
 *   focus (pause the radio → the music app restarts by itself).
 * - Never start without focus: a failed request (e.g. during a phone call)
 *   must not play over the call. A delayed grant defers the start to GAIN.
 * - Accept delayed focus so a start during a call begins when the call ends.
 * - Speech content pauses instead of being ducked.
 */
internal class AudioFocusCoordinator(context: Context, private val listener: FocusListener) {
  private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
  private val mainHandler = Handler(Looper.getMainLooper())
  private var request: AudioFocusRequest? = null
  private var registered = false
  private var speech = false

  /** Whether we currently hold focus. */
  var held = false
    private set

  private val changeListener =
    AudioManager.OnAudioFocusChangeListener { change ->
      // Delivered on the handler's thread (main) for API 26+; posted for older.
      if (Looper.myLooper() == Looper.getMainLooper()) onChange(change) else mainHandler.post { onChange(change) }
    }

  private fun onChange(change: Int) {
    if (!registered) return
    when (change) {
      AudioManager.AUDIOFOCUS_GAIN -> {
        held = true
        listener.onDuck(false)
        listener.onFocusGained()
      }
      AudioManager.AUDIOFOCUS_LOSS -> {
        // Another app took over for good: give the request back so the system
        // does not keep us on its stack, and never resume on our own.
        held = false
        abandon()
        listener.onFocusLost(transient = false)
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
        held = false
        listener.onFocusLost(transient = true)
      }
      AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
        // API 26+ ducks in the mixer by itself and only reports this when we
        // asked to pause instead (speech). Older versions duck manually.
        if (speech || Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          held = false
          listener.onFocusLost(transient = true)
        } else {
          listener.onDuck(true)
        }
      }
      else -> Unit
    }
  }

  /** Requests (or confirms) focus for playback. */
  fun request(speechContent: Boolean, mixWithOthers: Boolean): FocusResult {
    if (mixWithOthers) return FocusResult.GRANTED
    if (held) return FocusResult.GRANTED
    speech = speechContent
    val result =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val attributes =
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(
              if (speechContent) AudioAttributes.CONTENT_TYPE_SPEECH else AudioAttributes.CONTENT_TYPE_MUSIC
            )
            .build()
        val built =
          AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(attributes)
            .setAcceptsDelayedFocusGain(true)
            .setWillPauseWhenDucked(speechContent)
            .setOnAudioFocusChangeListener(changeListener, mainHandler)
            .build()
        request = built
        audioManager.requestAudioFocus(built)
      } else {
        @Suppress("DEPRECATION")
        audioManager.requestAudioFocus(changeListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
      }
    return when (result) {
      AudioManager.AUDIOFOCUS_REQUEST_GRANTED -> {
        registered = true
        held = true
        FocusResult.GRANTED
      }
      AudioManager.AUDIOFOCUS_REQUEST_DELAYED -> {
        registered = true
        held = false
        FocusResult.DELAYED
      }
      else -> {
        abandon()
        FocusResult.DENIED
      }
    }
  }

  /** Gives focus back (no player needs it any more). */
  fun abandon() {
    if (!registered && request == null) return
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      request?.let { audioManager.abandonAudioFocusRequest(it) }
    } else {
      @Suppress("DEPRECATION")
      audioManager.abandonAudioFocus(changeListener)
    }
    request = null
    registered = false
    held = false
  }

  val isRegistered: Boolean
    get() = registered
}
