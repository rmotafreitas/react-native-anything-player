package com.anythingplayer.sound

import android.content.Context

// The build with the Sound API (`rnapSound=true`): a SoundPool per sound.
// `src/nosound` has the stub compiled in instead of this file.

/** The Sound implementation this build has. Chosen at build time: `src/sound` or `src/nosound`. */
internal object SoundBackends {
  const val available = true

  fun create(context: Context): SoundBackend = SoundPoolBackend(context.applicationContext)
}
