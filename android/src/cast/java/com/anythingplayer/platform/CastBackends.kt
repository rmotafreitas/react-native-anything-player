package com.anythingplayer.platform

import android.content.Context
import com.anythingplayer.cast.RealCastBackend

/** The Cast integration this build has. Chosen at build time: `src/cast` (this file) or `src/nocast`. */
internal object CastBackends {
  fun create(context: Context, host: CastHost): CastBackend = RealCastBackend(context, host)
}
