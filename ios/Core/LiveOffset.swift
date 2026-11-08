import Foundation

/// How far what is heard trails a live source's live point (`liveOffset`).
///
/// A progressive stream (ICY/Icecast, plain HTTP, a remuxed MPEG-TS channel)
/// has no clock of its own: what it has received is the live point, as it
/// arrives. Its buffered edge moves in steps, one per chunk, and never past
/// live, so the freshest `edge − time` at an arrival is the live point against
/// the device's clock; the offset is then that point now minus the playhead.
/// The freshest is kept over the last 60 s of audio received, not of time: a
/// full buffer (a long pause) or a stall freezes the edge, and nothing then
/// says the live point moved, so it is kept, however long, and however seldom
/// the player is read. It does not saw-tooth between chunks, it grows while
/// paused or stalled, and it keeps going across a lined-up quality switch
/// (positions are continuous). It starts again on a new connection: a
/// `discontinuity`, or a playhead that went back. A connection whose edge is
/// not past its playhead yet has received nothing (still opening): it has no
/// live point until audio arrives.
///
/// A source with a clock (HLS program dates, a live window) is the player's
/// own reading, passed through. Settled: the live point has not risen for
/// `settleMs` (the connect burst has arrived) and has been read that long.
/// For a reading with a clock that point is `playhead + offset − time`, the
/// playhead on the stream's clock (`programDate`) when it has one: it holds
/// still while paused, at any rate, and as a live window slides.
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
    /// Epoch ms the stream's own clock gives the playhead (program dates); `nil` without one.
    var programDate: Int64? = nil
  }

  struct Value: Equatable {
    var offset: Double?
    var settled: Bool
  }

  /// The live point is the freshest `edge − time` over this much audio received (seconds).
  static let windowS = 60.0
  /// Settled once the reading has not risen for this long (and was read this long).
  static let settleMs: Int64 = 3_000
  /// A rise smaller than this is a chunk's jitter, not the burst still arriving.
  static let riseS = 0.1
  /// A playhead this far back is a new connection: start again.
  static let backS = 1.0
  /// A platform reading whose live point moves more than this has not settled.
  static let nativeStepS = 0.25

  /// The window's arrivals, leads decreasing (a monotonic queue: the front is the freshest).
  private var leads: [(edge: Double, lead: Double)] = []
  private var lastEdge: Double?
  private var since: Int64?
  private var risenAt: Int64 = 0
  private var anchor: Double?
  /// A reading with a clock: the live point it gives (`playhead + offset − time`, the playhead on `programDate` when there is one).
  private var native: Double?
  private var lastPosition: Double?

  /// A new connection (a `discontinuity`, a new load): measure again.
  func reset() {
    leads = []
    lastEdge = nil
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
    // A reading with a clock is the player's own: its position can go back
    // as a live window slides, and a new connection is a `discontinuity`
    // there. Its playhead on the stream's clock does not move back.
    if let value = r.native { return fromNative(t, value, r.programDate.map { Double($0) / 1000 } ?? r.position) }
    if let last = lastPosition, r.position < last - Self.backS { reset() }
    lastPosition = r.position
    guard let edge = r.edge else { return Value(offset: nil, settled: false) }
    // Nothing received yet: an edge at the playhead is no arrival.
    if lastEdge == nil && edge <= r.position { return Value(offset: nil, settled: false) }
    if since == nil { since = t }
    if lastEdge == nil || edge > lastEdge! { arrived(t, edge) }
    let next = leads[0].lead
    if anchor == nil || next > anchor! + Self.riseS { risenAt = t }
    anchor = next
    return Value(offset: max(0, Double(t) / 1000 + next - r.position), settled: settled(t))
  }

  /// New audio arrived (the edge moved on): a lead, and the window slides by it.
  private func arrived(_ t: Int64, _ edge: Double) {
    lastEdge = edge
    let lead = edge - Double(t) / 1000
    while let last = leads.last, last.lead <= lead { leads.removeLast() }
    leads.append((edge, lead))
    while leads[0].edge < edge - Self.windowS { leads.removeFirst() }
  }

  /// `at`: the playhead, on the stream's clock when it has one.
  private func fromNative(_ t: Int64, _ value: Double, _ at: Double) -> Value {
    if since == nil { since = t }
    let point = at + value - Double(t) / 1000
    if native == nil || abs(point - native!) > Self.nativeStepS { risenAt = t }
    native = point
    return Value(offset: max(0, value), settled: settled(t))
  }

  private func settled(_ t: Int64) -> Bool { t - since! >= Self.settleMs && t - risenAt >= Self.settleMs }
}
