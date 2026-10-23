package com.anythingplayer

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class AnythingPlayerPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    when (name) {
      AnythingPlayerModule.NAME -> AnythingPlayerModule(reactContext)
      AnythingPlayerSoundModule.NAME -> AnythingPlayerSoundModule(reactContext)
      else -> null
    }

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(
      AnythingPlayerModule.NAME to
        ReactModuleInfo(
          name = AnythingPlayerModule.NAME,
          className = AnythingPlayerModule.NAME,
          canOverrideExistingModule = false,
          needsEagerInit = false,
          isCxxModule = false,
          isTurboModule = true,
        ),
      AnythingPlayerSoundModule.NAME to
        ReactModuleInfo(
          name = AnythingPlayerSoundModule.NAME,
          className = AnythingPlayerSoundModule.NAME,
          canOverrideExistingModule = false,
          needsEagerInit = false,
          isCxxModule = false,
          isTurboModule = true,
        ),
    )
  }
}
