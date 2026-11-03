import Foundation

/// How far what is heard trails a live source's live point (`liveOffset`).
///
/// A progressive stream (ICY/Icecast, plain HTTP, a remuxed MPEG-TS channel)
/// has no clock of its own: what it has received is the live point, as it
/// arrives. Its buffered edge moves in steps, one per chunk, and never past
/// live, so the freshest reading of `edge − time` over a window (60 s) is the
/// live point against the device's clock; the offset is then that point now
/// minus the playhead. It does not saw-tooth between chunks, it grows while
/// paused or stalled, and it keeps going across a lined-up quality switch
/// (positions are continuous). It starts again on a new connection: a
/// `discontinuity`, or a playhead that went back.
///
/// A source with a clock (HLS program dates, a live window) is the player's
/// own reading, passed through. Settled: the reading has not risen for
/// `settleMs` (the connect burst has arrived) and has been read that long.
/// Twin of `src/web/engine/LiveOffset.ts` and `android/.../core/LiveOffset.kt`,
/// against `conformance/align/offset.json`.
final class LiveOffset {
  /// One reading of the player, on its reported timeline (seconds).
  struct Reading {
    var position: Double
    /// Where the audio received so far ends (a progressive live stream); `nil` otherwise.
    var edge: Double?
    /// The platform's own offset behind live (program dates, a live window); `nil` when it has none.
    var native: Double?
    var live: Bool
  }

  struct Value: Equatable {
    var offset: Double?
    var settled: Bool
  }

  /// The live point is the freshest `edge − time` this long back.
  static let windowMs: Int64 = 60_000
  /// Settled once the reading has not risen for this long (and was read this long).
  static let settleMs: Int64 = 3_000
  /// A rise smaller than this is a chunk's jitter, not the burst still arriving.
  static let riseS = 0.1
  /// A playhead this far back is a new connection: start again.
  static let backS = 1.0
  /// A platform reading that moves more than this has not settled.
  static let nativeStepS = 0.25

  private var leads: [(t: Int64, lead: Double)] = []
  private var since: Int64?
  private var risenAt: Int64 = 0
  private var anchor: Double?
  private var native: Double?
  private var lastPosition: Double?

  /// A new connection (a `discontinuity`, a new load): measure again.
  func reset() {
    leads = []
    since = nil
    anchor = nil
    native = nil
    lastPosition = nil
  }

  /// The offset at monotonic time `t` (ms).
  func read(_ t: Int64, _ r: Reading) -> Value {
    guard r.live else {
      reset()
      return Value(offset: nil, settled: false)
    }
    if let last = lastPosition, r.position < last - Self.backS { reset() }
    lastPosition = r.position
    if let value = r.native { return fromNative(t, value) }
    guard let edge = r.edge else { return Value(offset: nil, settled: false) }
    if since == nil { since = t }
    let lead = edge - Double(t) / 1000
    while let last = leads.last, last.lead <= lead { leads.removeLast() }
    leads.append((t, lead))
    while leads[0].t < t - Self.windowMs { leads.removeFirst() }
    let next = leads[0].lead
    if anchor == nil || next > anchor! + Self.riseS { risenAt = t }
    anchor = next
    return Value(offset: max(0, Double(t) / 1000 + next - r.position), settled: settled(t))
  }

  private func fromNative(_ t: Int64, _ value: Double) -> Value {
    if since == nil { since = t }
    if native == nil || abs(value - native!) > Self.nativeStepS { risenAt = t }
    native = value
    return Value(offset: max(0, value), settled: settled(t))
  }

  private func settled(_ t: Int64) -> Bool { t - since! >= Self.settleMs && t - risenAt >= Self.settleMs }
}
