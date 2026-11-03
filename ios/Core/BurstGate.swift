import Foundation

/// Holds a live quality switch's new connection back from AVPlayer until the
/// aligner knows how much of its connect burst to drop.
///
/// ICY metadata blocks found in the held audio keep their place in it: when it
/// opens, the title in effect at the cut comes first, and later ones where
/// they were.
///
/// A new Icecast connection starts with the server's burst of recent audio, a
/// byte count: a lower bitrate starts further behind live (`LiveAligner`). A
/// live AVPlayer cannot be run faster to catch up, so a connection that
/// starts behind what is heard loses the start of its burst instead, before
/// AVPlayer reads any of it: the stream proxy keeps the audio here (ICY
/// metadata taken out, each block kept at its place), counts it by its MP3 or ADTS
/// frames, and lets it through from the first frame at or after the point the
/// aligner names. A format it cannot count (Ogg, FLAC…) goes through at once.
///
/// Thread-safe: the proxy queue holds and relays, the main thread reads and
/// asks it to open.
final class BurstGate {
  private enum Format {
    case mp3, adts
  }

  /// Past this much held audio it opens by itself: AVPlayer must not starve.
  static let limitBytes = 4 * 1024 * 1024

  private let lock = NSLock()
  private var format: Format?
  private var counts = true
  private var held: [UInt8] = []
  /// Bytes of `held` already split into whole frames, and the frames' starts.
  private var scanned = 0
  private var starts: [(byte: Int, time: Double)] = []
  private var seconds = 0.0
  /// ICY blocks in the held audio, at the byte they came before.
  private var blocks: [(offset: Int, bytes: [UInt8])] = []
  /// Where the main thread asked it to open, until the proxy queue does.
  private var requested: Int?
  private var open = false

  /// It let the audio through: the response flows as usual (only the proxy
  /// queue opens it, so it reads this race-free there).
  var isOpen: Bool {
    lock.lock()
    defer { lock.unlock() }
    return open
  }

  /// Seconds of whole frames held, from the connection's first audio; `nil`
  /// once it let the audio through (or it cannot count it).
  var heldSeconds: Double? {
    lock.lock()
    defer { lock.unlock() }
    return open || requested != nil || !counts ? nil : seconds
  }

  /// Main thread: let the audio through from the first frame at or after
  /// `from` seconds. Returns the seconds dropped (where AVPlayer's time 0 is
  /// on the connection's timeline). The proxy relays it (`flush`).
  func requestOpen(from: Double) -> Double {
    lock.lock()
    defer { lock.unlock() }
    guard !open, requested == nil else { return 0 }
    var byte = scanned
    var dropped = seconds
    if let first = starts.first(where: { $0.time >= from - 1e-9 }) {
      byte = first.byte
      dropped = first.time
    }
    if from <= 0 {
      byte = 0
      dropped = 0
    }
    requested = byte
    return dropped
  }

  /// What it lets through: audio, and the ICY blocks that go before the byte
  /// at their offset in it.
  typealias Out = (audio: [UInt8], blocks: [(offset: Int, bytes: [UInt8])])

  /// Proxy queue: the audio of the held response (`contentType` from its
  /// head), with the ICY blocks found in it (offsets in `audio`). Returns
  /// what to relay now (`nil`: held).
  func pass(_ audio: [UInt8], blocks found: [(offset: Int, bytes: [UInt8])] = [], contentType: String?) -> Out? {
    lock.lock()
    defer { lock.unlock() }
    if open { return (audio, found) }
    if format == nil && counts { detect(contentType, audio) }
    blocks += found.map { (held.count + $0.offset, $0.bytes) }
    held.append(contentsOf: audio)
    if counts { scan() }
    if requested == nil && counts && held.count < Self.limitBytes { return nil }
    return openNow()
  }

  /// Proxy queue: relays what an open asked for, with no new audio.
  func flush() -> Out? {
    lock.lock()
    defer { lock.unlock() }
    guard !open, requested != nil else { return nil }
    return openNow()
  }

  private func openNow() -> Out {
    let from = min(requested ?? 0, held.count)
    let audio = Array(held[from...])
    // The title in effect at the cut first, then the later ones where they were.
    var out: [(offset: Int, bytes: [UInt8])] = []
    if let current = blocks.last(where: { $0.offset <= from }) { out.append((0, current.bytes)) }
    out += blocks.filter { $0.offset > from }.map { ($0.offset - from, $0.bytes) }
    open = true
    held = []
    starts = []
    blocks = []
    return (audio, out)
  }

  private func detect(_ contentType: String?, _ audio: [UInt8]) {
    let type = contentType?.lowercased() ?? ""
    if type.contains("mpeg") || type.contains("mp3") {
      format = .mp3
    } else if type.contains("aac") {
      format = .adts
    } else if Codecs.adtsHeader(audio, 0) != nil {
      format = .adts
    } else if Codecs.mpegAudioHeader(audio, 0)?.layer == 3 {
      format = .mp3
    } else {
      counts = false
    }
  }

  /// Splits the held audio into whole frames (resyncing past anything else).
  private func scan() {
    var at = scanned
    while at < held.count {
      guard let (length, duration) = frame(at) else {
        // A header cut short: the rest arrives later. Not a frame: one byte on.
        if at + 9 > held.count { break }
        at += 1
        continue
      }
      guard at + length <= held.count else { break }
      starts.append((at, seconds))
      seconds += duration
      at += length
    }
    scanned = at
  }

  private func frame(_ at: Int) -> (length: Int, duration: Double)? {
    switch format {
    case .mp3:
      guard let h = Codecs.mpegAudioHeader(held, at), h.layer == 3, h.length > 4 else { return nil }
      return (h.length, Double(h.samples) / Double(h.sampleRate))
    case .adts:
      guard let h = Codecs.adtsHeader(held, at), h.length > h.headerLength else { return nil }
      return (h.length, Double(1024 * h.blocks) / Double(h.sampleRate))
    case nil:
      return nil
    }
  }
}
