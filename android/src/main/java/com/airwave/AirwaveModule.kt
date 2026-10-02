package com.airwave

import com.facebook.react.bridge.ReactApplicationContext

class AirwaveModule(reactContext: ReactApplicationContext) :
  NativeAirwaveSpec(reactContext) {

  override fun multiply(a: Double, b: Double): Double {
    return a * b
  }

  companion object {
    const val NAME = NativeAirwaveSpec.NAME
  }
}
