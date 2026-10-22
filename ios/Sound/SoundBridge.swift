import Foundation

/// The Objective-C–visible surface of the Sound API's TurboModule
/// (`AnythingPlayerSoundModule.mm`). Without `RNAP_SOUND` (the default) the
/// engine is not compiled: `isAvailable` is false and `load` rejects with
/// `SOUND_UNAVAILABLE`. One bridge per TurboModule instance; a JS reload makes
/// a new one and `invalidate()` frees the old one's sounds.
@objc(AnythingPlayerSoundBridge)
public final class AnythingPlayerSoundBridge: NSObject {
  #if RNAP_SOUND
  private let engine = SoundEngine()
  #endif

  @objc public var isAvailable: Bool {
    #if RNAP_SOUND
    return true
    #else
    return false
    #endif
  }

  @objc public func configure(respectSilentSwitch: Bool, resolve: @escaping (Any?) -> Void) {
    #if RNAP_SOUND
    engine.configure(respectSilentSwitch: respectSilentSwitch)
    #endif
    resolve(nil)
  }

  @objc public func load(
    uri: String, voices: Int,
    resolve: @escaping (Any?) -> Void, reject: @escaping (String, String, NSError?) -> Void
  ) {
    #if RNAP_SOUND
    engine.load(uri: uri, voices: voices) { result in
      switch result {
      case .success(let loaded): resolve(["id": loaded.id, "duration": loaded.duration])
      case .failure(let error): Self.reject(reject, error)
      }
    }
    #else
    Self.reject(
      reject,
      .code(
        .soundUnavailable,
        "Sound is not built into this app. Install the pods with RNAP_SOUND=1 (or the Expo plugin's `sound` option) and rebuild.",
        recoverable: false))
    #endif
  }

  @objc public func unload(soundId: String, resolve: @escaping (Any?) -> Void) {
    #if RNAP_SOUND
    engine.unload(soundId: soundId) { resolve(nil) }
    #else
    resolve(nil)
    #endif
  }

  @objc public func play(soundId: String, voiceId: Int, volume: Double, rate: Double, pan: Double, loop: Bool) {
    #if RNAP_SOUND
    engine.play(soundId: soundId, voiceId: voiceId, volume: volume, rate: rate, pan: pan, loop: loop)
    #endif
  }

  @objc public func setVoice(voiceId: Int, volume: Double, rate: Double, pan: Double) {
    #if RNAP_SOUND
    engine.setVoice(voiceId: voiceId, volume: volume, rate: rate, pan: pan)
    #endif
  }

  @objc public func stopVoice(voiceId: Int) {
    #if RNAP_SOUND
    engine.stopVoice(voiceId: voiceId)
    #endif
  }

  @objc public func stopSound(soundId: String) {
    #if RNAP_SOUND
    engine.stopSound(soundId: soundId)
    #endif
  }

  @objc public func stopAll() {
    #if RNAP_SOUND
    engine.stopAll()
    #endif
  }

  @objc public func invalidate() {
    #if RNAP_SOUND
    engine.shutdown()
    #endif
  }

  private static func reject(_ reject: (String, String, NSError?) -> Void, _ error: PlayerError) {
    reject(error.code.rawValue, error.message, Serialization.nsError(error))
  }
}
