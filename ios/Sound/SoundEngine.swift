#if RNAP_SOUND
import AVFoundation
import Foundation

/// The Sound API on iOS: one `AVAudioEngine`, and for each loaded sound a pool
/// of voices. A voice is `AVAudioPlayerNode → AVAudioUnitVarispeed (rate and
/// pitch) → AVAudioMixerNode (volume, pan) → the engine's main mixer`. Sounds
/// are decoded into an `AVAudioPCMBuffer` at load, so `play` only schedules a
/// buffer.
///
/// Everything runs on one serial queue: the JS thread never waits for audio,
/// and notifications (interruptions, configuration changes, a media services
/// reset) are hopped onto it, so they cannot race a command.
///
/// Coexisting with `Player` (`AudioSessionCoordinator`): the engine never
/// takes the audio session's category from anyone. It sets one only when the
/// app still has the default (`soloAmbient`) or the category is the one this
/// engine set earlier; a `.playback` category set by the Player is used as is.
/// It never deactivates the session (the Player owns that), and it does not
/// touch the media session or the now-playing info.
final class SoundEngine {
  private final class Chain {
    let player = AVAudioPlayerNode()
    let speed = AVAudioUnitVarispeed()
    let mixer = AVAudioMixerNode()
    /// Bumped on every start and stop: a completion or a delayed stop from an older voice sees it changed and does nothing.
    var generation = 0
  }

  private final class Sound {
    let id: String
    let buffer: AVAudioPCMBuffer
    var chains: [Chain] = []
    var slots: VoiceSlots

    init(id: String, buffer: AVAudioPCMBuffer, voices: Int) {
      self.id = id
      self.buffer = buffer
      slots = VoiceSlots(capacity: voices)
    }
  }

  private let queue = DispatchQueue(label: "com.anythingplayer.sound", qos: .userInteractive)
  private var engine = AVAudioEngine()
  private var sounds: [String: Sound] = [:]
  /// Playing voices: where each one is.
  private var voices: [Int: (soundId: String, slot: Int)] = [:]
  private var respectSilentSwitch = false
  private var ownedCategory: AVAudioSession.Category?
  private var idleStop: DispatchWorkItem?
  private var observers: [NSObjectProtocol] = []
  private var counter = 0

  /// How long the engine keeps running after the last voice ended. Restarting it costs a few milliseconds on the next sound; running it forever costs battery.
  private static let idleSeconds = 10.0
  /// A cut waveform clicks: voices stop after a short fade.
  private static let fadeSeconds = 0.012
  /// Decoded sounds are kept in memory; this is for effects, not songs.
  private static let maxDecodedBytes = 48 * 1024 * 1024

  init() {
    let center = NotificationCenter.default
    let session = AVAudioSession.sharedInstance()
    observers = [
      center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) {
        [weak self] note in self?.queue.async { self?.handleInterruption(note) }
      },
      center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) {
        [weak self] note in self?.queue.async { self?.handleConfigurationChange(note) }
      },
      center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) {
        [weak self] _ in self?.queue.async { self?.rebuild() }
      },
    ]
  }

  deinit {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
  }

  // MARK: - Commands (any thread)

  func configure(respectSilentSwitch: Bool) {
    queue.async { self.respectSilentSwitch = respectSilentSwitch }
  }

  func load(
    uri: String, voices: Int, completion: @escaping (Result<(id: String, duration: Double), PlayerError>) -> Void
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      let decoded = Self.decode(uri: uri)
      self.queue.async {
        switch decoded {
        case .failure(let error): completion(.failure(error))
        case .success(let buffer):
          self.counter += 1
          let sound = Sound(id: "sound-\(self.counter)", buffer: buffer, voices: voices)
          self.build(sound)
          self.sounds[sound.id] = sound
          let duration = Double(buffer.frameLength) / buffer.format.sampleRate
          completion(.success((sound.id, duration)))
        }
      }
    }
  }

  func unload(soundId: String, completion: @escaping () -> Void) {
    queue.async {
      if let sound = self.sounds.removeValue(forKey: soundId) {
        self.haltAll(sound)
        self.detach(sound)
      }
      completion()
    }
  }

  func play(soundId: String, voiceId: Int, volume: Double, rate: Double, pan: Double, loop: Bool) {
    queue.async {
      guard let sound = self.sounds[soundId], self.ensureRunning() else { return }
      self.idleStop?.cancel()
      let (slot, stolen) = sound.slots.acquire(voiceId: voiceId)
      if let stolen { self.voices[stolen] = nil }
      let chain = sound.chains[slot]
      chain.generation += 1
      let generation = chain.generation
      chain.player.stop()
      self.apply(chain, volume: volume, rate: rate, pan: pan)
      chain.player.scheduleBuffer(
        sound.buffer, at: nil, options: loop ? .loops : [], completionCallbackType: .dataPlayedBack
      ) { [weak self] _ in
        self?.queue.async { self?.finished(soundId: soundId, slot: slot, voiceId: voiceId, generation: generation) }
      }
      chain.player.play()
      self.voices[voiceId] = (soundId, slot)
    }
  }

  func setVoice(voiceId: Int, volume: Double, rate: Double, pan: Double) {
    queue.async {
      guard let place = self.voices[voiceId], let sound = self.sounds[place.soundId],
        sound.chains.indices.contains(place.slot)
      else { return }
      self.apply(sound.chains[place.slot], volume: volume, rate: rate, pan: pan)
    }
  }

  func stopVoice(voiceId: Int) {
    queue.async {
      guard let place = self.voices[voiceId], let sound = self.sounds[place.soundId] else { return }
      self.halt(sound, slot: place.slot, voiceId: voiceId)
    }
  }

  func stopSound(soundId: String) {
    queue.async {
      if let sound = self.sounds[soundId] { self.haltAll(sound) }
    }
  }

  func stopAll() {
    queue.async {
      for sound in self.sounds.values { self.haltAll(sound) }
    }
  }

  /// The module was invalidated (a reload): free everything.
  func shutdown() {
    queue.async {
      for sound in self.sounds.values {
        self.haltAll(sound)
        self.detach(sound)
      }
      self.sounds.removeAll()
      self.idleStop?.cancel()
      self.engine.stop()
    }
  }

  // MARK: - Voices (queue only)

  private func apply(_ chain: Chain, volume: Double, rate: Double, pan: Double) {
    chain.mixer.outputVolume = Float(min(1, max(0, volume)))
    chain.mixer.pan = Float(min(1, max(-1, pan)))
    chain.speed.rate = Float(min(2, max(0.5, rate)))
  }

  private func finished(soundId: String, slot: Int, voiceId: Int, generation: Int) {
    guard let sound = sounds[soundId], sound.chains.indices.contains(slot),
      sound.chains[slot].generation == generation
    else { return }
    sound.slots.release(slot: slot, ownedBy: voiceId)
    voices[voiceId] = nil
    scheduleIdleStop()
  }

  /// Stops one voice after a short fade.
  private func halt(_ sound: Sound, slot: Int, voiceId: Int) {
    guard sound.chains.indices.contains(slot) else { return }
    sound.slots.release(slot: slot, ownedBy: voiceId)
    voices[voiceId] = nil
    let chain = sound.chains[slot]
    chain.generation += 1
    let generation = chain.generation
    chain.mixer.outputVolume = 0
    queue.asyncAfter(deadline: .now() + Self.fadeSeconds) {
      // A new voice may have taken the node meanwhile (it stopped it itself).
      if chain.generation == generation { chain.player.stop() }
    }
    scheduleIdleStop()
  }

  private func haltAll(_ sound: Sound) {
    for voiceId in sound.slots.releaseAll() {
      guard let place = voices[voiceId] else { continue }
      voices[voiceId] = nil
      guard sound.chains.indices.contains(place.slot) else { continue }
      let chain = sound.chains[place.slot]
      chain.generation += 1
      let generation = chain.generation
      chain.mixer.outputVolume = 0
      queue.asyncAfter(deadline: .now() + Self.fadeSeconds) {
        if chain.generation == generation { chain.player.stop() }
      }
    }
    scheduleIdleStop()
  }

  // MARK: - The graph (queue only)

  private func build(_ sound: Sound) {
    let format = sound.buffer.format
    sound.chains = (0..<sound.slots.capacity).map { _ in
      let chain = Chain()
      engine.attach(chain.player)
      engine.attach(chain.speed)
      engine.attach(chain.mixer)
      engine.connect(chain.player, to: chain.speed, format: format)
      engine.connect(chain.speed, to: chain.mixer, format: format)
      engine.connect(chain.mixer, to: engine.mainMixerNode, format: format)
      return chain
    }
  }

  private func detach(_ sound: Sound) {
    for chain in sound.chains {
      chain.player.stop()
      engine.detach(chain.player)
      engine.detach(chain.speed)
      engine.detach(chain.mixer)
    }
    sound.chains = []
  }

  /// A media services reset kills the engine and every node: new engine, the same buffers.
  private func rebuild() {
    idleStop?.cancel()
    voices.removeAll()
    ownedCategory = nil
    engine = AVAudioEngine()
    for sound in sounds.values {
      _ = sound.slots.releaseAll()
      build(sound)
    }
  }

  // MARK: - Running (queue only)

  private func ensureRunning() -> Bool {
    prepareSession()
    if engine.isRunning { return true }
    do {
      engine.prepare()
      try engine.start()
      return true
    } catch {
      return false
    }
  }

  private func scheduleIdleStop() {
    idleStop?.cancel()
    guard voices.isEmpty else { return }
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.voices.isEmpty else { return }
      self.engine.pause()
    }
    idleStop = work
    queue.asyncAfter(deadline: .now() + Self.idleSeconds, execute: work)
  }

  /// Makes the audio session usable without taking it from the Player.
  private func prepareSession() {
    let session = AVAudioSession.sharedInstance()
    let wanted: AVAudioSession.Category = respectSilentSwitch ? .ambient : .playback
    let current = session.category
    let ours = ownedCategory != nil && current == ownedCategory
    // The default category (`soloAmbient`) stops other apps' audio and cannot
    // play with the screen locked; the Player's `.playback` is left alone.
    if current == .soloAmbient || (ours && current != wanted) {
      if (try? session.setCategory(wanted, mode: .default, options: [.mixWithOthers])) != nil {
        ownedCategory = wanted
      }
    }
    try? session.setActive(true)
  }

  private func handleInterruption(_ note: Notification) {
    guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
      AVAudioSession.InterruptionType(rawValue: raw) == .began
    else { return }
    // The system stopped the engine; the voices are gone. The next `play` starts it again.
    stopEverythingNow()
    engine.pause()
  }

  private func handleConfigurationChange(_ note: Notification) {
    guard let changed = note.object as? AVAudioEngine, changed === engine else { return }
    // The output format changed (a route change): the engine stopped and its players with it.
    stopEverythingNow()
  }

  private func stopEverythingNow() {
    for sound in sounds.values {
      _ = sound.slots.releaseAll()
      for chain in sound.chains {
        chain.generation += 1
        chain.player.stop()
      }
    }
    voices.removeAll()
  }

  // MARK: - Decoding (any thread)

  private static func decode(uri: String) -> Result<AVAudioPCMBuffer, PlayerError> {
    let location: URL
    var temporary: URL?
    defer { if let temporary { try? FileManager.default.removeItem(at: temporary) } }
    if uri.hasPrefix("/") {
      location = URL(fileURLWithPath: uri)
    } else if let url = URL(string: uri), let scheme = url.scheme?.lowercased() {
      if scheme == "file" {
        location = url
      } else if scheme == "http" || scheme == "https" {
        switch download(url) {
        case .failure(let error): return .failure(error)
        case .success(let file):
          temporary = file
          location = file
        }
      } else {
        return .failure(.code(.invalidSource, "Sound cannot load a \(scheme): address.", recoverable: false))
      }
    } else {
      return .failure(.code(.invalidSource, "\(uri) is not a file path or a URL.", recoverable: false))
    }
    guard FileManager.default.fileExists(atPath: location.path) else {
      return .failure(.code(.sourceNotFound, "\(location.path) was not found.", recoverable: false))
    }
    do {
      let file = try AVAudioFile(forReading: location)
      let frames = AVAudioFrameCount(file.length)
      let bytes = Int(frames) * Int(file.processingFormat.channelCount) * MemoryLayout<Float>.size
      if bytes > maxDecodedBytes {
        return .failure(
          .code(
            .invalidSource,
            "This sound is \(bytes / 1_048_576) MB decoded. Sound is for effects of a few seconds: play longer audio with Player.",
            recoverable: false))
      }
      guard frames > 0,
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: frames)
      else {
        return .failure(.code(.unsupportedFormat, "The sound is empty.", recoverable: false))
      }
      try file.read(into: buffer)
      return .success(buffer)
    } catch let error as NSError {
      var failure = PlayerError.code(
        .unsupportedFormat, "iOS could not decode this sound (\(error.localizedDescription)).", recoverable: false)
      failure.platformDomain = error.domain
      failure.platformCode = error.code
      return .failure(failure)
    }
  }

  /// `AVAudioFile` reads files, not URLs: download to a temporary file that keeps the extension (the decoder uses it as a hint).
  private static func download(_ url: URL) -> Result<URL, PlayerError> {
    let done = DispatchSemaphore(value: 0)
    var outcome: Result<URL, PlayerError> = .failure(.code(.timeout, "The download did not finish.", recoverable: true))
    let task = URLSession.shared.downloadTask(with: url) { location, response, error in
      defer { done.signal() }
      if let error = error as NSError? {
        var failure = PlayerError.code(
          .networkError, "Could not download the sound (\(error.localizedDescription)).", recoverable: true)
        failure.platformDomain = error.domain
        failure.platformCode = error.code
        outcome = .failure(failure)
        return
      }
      if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
        let missing = http.statusCode == 404 || http.statusCode == 410
        var failure = PlayerError.code(
          missing ? .sourceNotFound : .httpError, "The server returned HTTP \(http.statusCode).",
          recoverable: http.statusCode >= 500 || http.statusCode == 408 || http.statusCode == 429)
        failure.httpStatus = http.statusCode
        outcome = .failure(failure)
        return
      }
      guard let location else { return }
      let ext = url.pathExtension.isEmpty ? Self.fileExtension(for: response?.mimeType) : url.pathExtension
      let target = FileManager.default.temporaryDirectory.appendingPathComponent("rnap-sound-\(UUID().uuidString).\(ext)")
      do {
        try FileManager.default.moveItem(at: location, to: target)
        outcome = .success(target)
      } catch {
        outcome = .failure(.code(.internalError, "\(error)", recoverable: false))
      }
    }
    task.resume()
    // The session's own timeout (60 s) ends the task; this is a backstop.
    if done.wait(timeout: .now() + 90) == .timedOut { task.cancel() }
    return outcome
  }

  private static func fileExtension(for mime: String?) -> String {
    switch mime?.lowercased() {
    case "audio/mpeg", "audio/mp3": return "mp3"
    case "audio/mp4", "audio/x-m4a", "audio/aac": return "m4a"
    case "audio/x-caf": return "caf"
    case "audio/flac", "audio/x-flac": return "flac"
    default: return "wav"
    }
  }
}
#endif
