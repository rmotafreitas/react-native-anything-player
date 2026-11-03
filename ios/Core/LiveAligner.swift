import Foundation

/// A live quality switch's audio, lined up with what is heard.
///
/// Separate Icecast mounts of one station, loaded as renditions, are separate
/// connections, and each starts with the server's burst of recent audio. The
/// burst is a byte count, so how far behind live a connection starts depends
/// on its bitrate (64 KiB is 1.6 s at 320 kbps, 8 s at 64 kbps): taking over
/// on the new connection's first audio repeats or skips the difference.
///
/// Once a connection's burst has arrived, its buffered edge is the live edge,
/// so the two timelines map onto each other by `k = edge(new) − edge(old)`.
/// An edge moves in steps, as chunks arrive (each connection on its own
/// beat), and never past live: a connection's freshest reading over a window,
/// the most of `edge − time`, is its live edge. While a burst arrives that
/// rises fast; once two windows in a row agree on both connections, the
/// burst is in and the newer gives `k`. The
/// aligner then drives the new, muted player until it plays what the old one
/// plays: held paused while it is ahead, moved forward before it plays
/// anything (the stream proxy drops the burst's start before AVPlayer reads
/// it), and gently slower for the last tenths. It says when to take over and
/// when to give up and switch as before (a `discontinuity` for the app).
///
/// Pure: `SwapDriver` feeds it readings every `tickMs` and applies what it
/// answers. Twin of `src/web/engine/LiveAligner.ts` and
/// `android/.../core/LiveAligner.kt`, against `conformance/align/live.json`.
final class LiveAligner {
  /// One player's reading, on its own timeline (seconds).
  struct Reading {
    var position: Double
    /// Where the audio received so far ends; `nil` when unknown.
    var edge: Double?
    /// The playhead moves.
    var playing: Bool
    /// A dropped connection is being replaced: the edge says nothing about live.
    var reconnecting = false
    /// It can start: one not ready yet is held, whatever the gap.
    var ready = true
    /// When the edge's audio arrived (ms, `t`'s clock), where the player
    /// knows: the reading's time otherwise.
    var edgeAt: Int64?
    /// The stream's own clock (program dates): epoch seconds it gives
    /// position 0 on this timeline, `programDate − position`. With one on
    /// both sides the mapping is known at once, and followed as a live window slides.
    var clock: Double?

    init(
      position: Double, edge: Double?, playing: Bool, reconnecting: Bool = false, ready: Bool = true,
      edgeAt: Int64? = nil, clock: Double? = nil
    ) {
      self.clock = clock
      self.position = position
      self.edge = edge
      self.playing = playing
      self.reconnecting = reconnecting
      self.ready = ready
      self.edgeAt = edgeAt
    }
  }

  /// Whether (and when) the new player can be moved forward within what it received.
  enum Jump: String {
    /// A seek, any time it is held.
    case always
    /// Only at the first decision, before it plays anything.
    case first
    case never
  }

  /// What the new player can do while it is muted.
  struct Caps {
    /// The fastest it may run (1: it cannot catch up by speed).
    var maxRate: Double
    /// The slowest it may run (1: it cannot).
    var minRate: Double
    var jump: Jump
    /// How far ahead a held player starts, seconds: its start-up delay,
    /// learned again after every start. Better too long than too short where
    /// it cannot run faster: a player ahead is held again, one behind cannot
    /// catch up.
    var startLead: Double
    /// A moved player lands this much further ahead than its start lead, then
    /// is held (its time to be ready).
    var jumpLead: Double

    init(maxRate: Double, minRate: Double, jump: Jump, startLead: Double, jumpLead: Double) {
      self.maxRate = maxRate
      self.minRate = minRate
      self.jump = jump
      self.startLead = startLead
      self.jumpLead = jumpLead
    }
  }

  enum Action: Equatable {
    case wait
    /// Run the new player at this rate (× the app's); 0 holds it paused.
    /// `afterMs`: start it this much later (a hold that ends between ticks).
    case rate(Double, afterMs: Int64)
    /// Move the new player to this position (held).
    case jump(to: Double)
    /// Aligned: make the new player the one heard. `residual`: new − old, seconds.
    case takeOver(residual: Double)
    /// Switch as before (on the new player's first audio) and report a discontinuity.
    case fallback(reason: String)
  }

  /// How often the drivers read both players.
  static let tickMs: Int64 = 40
  /// Each connection's freshest edge, against the clock, over two windows this long…
  static let settleWindowMs: Int64 = 1_500
  /// …moved less than this, and both edges grew by `growth` × the window in
  /// the newer one: the burst is in.
  static let driftS = 0.1
  static let growth = 0.5
  /// No settled burst by then: switch as before.
  static let settleBudgetMs: Int64 = 8_000
  /// Not aligned by then (from the first reading): switch as before.
  static let budgetMs: Int64 = 30_000
  /// Aligned: take over.
  static let toleranceS = 0.05
  /// Close enough when the player cannot do better, or did not within
  /// `fineBudgetMs` of first getting this close.
  static let acceptS = 0.3
  static let fineBudgetMs: Int64 = 3_000
  /// The rate closes the gap over about this long (1 + gap / horizon).
  static let horizonS = 1.0
  static let rateStep = 0.05
  /// At rate 1 this long before its readings are trusted for a takeover.
  static let steadyMs: Int64 = 300
  /// Told to run but not moving for this long: it stalled.
  static let startBudgetMs: Int64 = 3_000

  /// Both edges at `t`, and when each one's audio arrived.
  private struct EdgeSample {
    let t: Int64
    let next: Double
    let old: Double
    let nextAt: Int64
    let oldAt: Int64
  }

  private let caps: Caps
  private var startedAt: Int64?
  private var samples: [EdgeSample] = []
  private var k: Double?
  private var decided = false
  private var done = false
  private var commanded = 0.0
  private var runningSince: Int64?
  private var steadySince: Int64?
  private var fineSince: Int64?
  private var startGap: Double?
  private var lead: Double
  /// Where it was when it was told to start: it has started once it moved.
  private var startPosition = 0.0

  init(caps: Caps) {
    self.caps = caps
    lead = caps.startLead
  }

  /// `k`, once measured: new position = old position + k.
  var offset: Double? { k }

  /// The last gap read (new − old, seconds): what a switch now would skip (+) or repeat (−).
  private(set) var gap: Double?

  /// Whether it answered take over or fall back.
  var finished: Bool { done }

  /// A connection jumped (either player): the mapping no longer holds.
  func interrupt() -> Action { fallback("discontinuity") }

  /// One tick: both readings at monotonic time `t` (ms).
  func step(_ t: Int64, old: Reading, next: Reading) -> Action {
    if done { return .wait }
    if startedAt == nil { startedAt = t }
    let elapsed = t - startedAt!
    if old.reconnecting || next.reconnecting { return fallback("reconnecting") }
    if !old.playing { return fallback("stalled") }
    if let a = old.clock, let b = next.clock { k = a - b }
    if k == nil {
      if elapsed >= Self.settleBudgetMs { return fallback("unsettled") }
      measure(t, old: old, next: next)
      if k == nil { return .wait }
    }
    if elapsed >= Self.budgetMs { return fallback("timeout") }
    return align(t, elapsed: elapsed, old: old, next: next)
  }

  // MARK: - The mapping

  private func measure(_ t: Int64, old: Reading, next: Reading) {
    guard let oldEdge = old.edge, let nextEdge = next.edge else { return }
    samples.append(EdgeSample(t: t, next: nextEdge, old: oldEdge, nextAt: next.edgeAt ?? t, oldAt: old.edgeAt ?? t))
    // Keep two windows, and one sample at or before their start.
    let span = 2 * Self.settleWindowMs
    while samples.count > 1, samples[1].t <= t - span { samples.removeFirst() }
    guard t - samples[0].t >= span else { return }
    let middle = t - Self.settleWindowMs
    let earlier = samples.filter { $0.t < middle }
    let later = samples.filter { $0.t >= middle }
    func drift(_ nextEdge: Bool) -> Double {
      abs(Self.freshest(later, nextEdge: nextEdge) - Self.freshest(earlier, nextEdge: nextEdge))
    }
    func grew(_ edge: (EdgeSample) -> Double) -> Bool {
      edge(later.last!) - edge(later.first!) >= Self.growth * Double(Self.settleWindowMs) / 1000
    }
    // Still arriving, or not growing: the windows slide on.
    guard drift(true) <= Self.driftS, drift(false) <= Self.driftS else { return }
    guard grew({ $0.next }), grew({ $0.old }) else { return }
    k = Self.freshest(later, nextEdge: true) - Self.freshest(later, nextEdge: false)
    samples = []
  }

  // MARK: - Driving the new player

  private func align(_ t: Int64, elapsed: Int64, old: Reading, next: Reading) -> Action {
    let target = old.position + k!
    let gap = next.position - target
    self.gap = gap
    let first = !decided
    decided = true
    if commanded == 0 { return fromHold(t, elapsed: elapsed, target: target, gap: gap, first: first, next: next) }
    return running(t, gap: gap, next: next)
  }

  /// Running: started, faster or slower, until close enough.
  private func running(_ t: Int64, gap: Double, next: Reading) -> Action {
    if !next.playing {
      // Starting, or out of audio.
      steadySince = nil
      if t - runningSince! >= Self.startBudgetMs { return fallback("starting") }
      return .wait
    }
    if let startGap, next.position != startPosition {
      // It started from a hold at `startGap` and moves at `gap`: its start-up delay.
      lead = min(max(startGap - gap, 0), 1)
      self.startGap = nil
    }
    // Close for a while without settling (readings too coarse for the tolerance): close enough.
    let close = abs(gap) <= Self.acceptS
    if close && fineSince == nil { fineSince = t }
    let late = fineSince.map { t - $0 >= Self.fineBudgetMs } ?? false
    if close && late { return takeOver(gap) }
    let desired = desiredRate(gap)
    if desired != commanded { return setRate(t, desired, gap: gap, next: next) }
    if commanded != 1 { return .wait }
    return steady(t, gap: gap, close: close)
  }

  /// At rate 1: trusted once steady, then aligned, or as close as it gets.
  private func steady(_ t: Int64, gap: Double, close: Bool) -> Action {
    if steadySince == nil { steadySince = t }
    if t - steadySince! < Self.steadyMs { return .wait }
    if abs(gap) <= Self.toleranceS { return takeOver(gap) }
    let canFix = gap < 0 ? caps.maxRate > 1 : caps.minRate < 1
    if close && !canFix { return takeOver(gap) }
    if gap < -Self.acceptS && !canFix { return fallback("behind") }
    return .wait
  }

  /// Held: moved, held on, started, or run faster.
  private func fromHold(
    _ t: Int64, elapsed: Int64, target: Double, gap: Double, first: Bool, next: Reading
  ) -> Action {
    let canJump = caps.jump == .always || (caps.jump == .first && first)
    // At first anything short of the lead is moved (the start is then always
    // from a hold); later only a player that fell behind.
    let short = first ? gap < lead : gap < -Self.toleranceS
    if short && canJump {
      // Moved just ahead, then held: it never starts behind.
      let to = target + lead + caps.jumpLead
      return .jump(to: next.edge.map { min(to, $0) } ?? to)
    }
    if gap > lead || !next.ready { return holding(t, elapsed: elapsed, gap: gap, first: first, next: next) }
    if gap < -Self.toleranceS && caps.maxRate > 1 { return setRate(t, speedUp(gap), gap: gap, next: next) }
    if gap < -Self.acceptS { return fallback("behind") }
    return setRate(t, 1, gap: gap, next: next)
  }

  /// Ahead (or not ready): held until the old one gets there, if it gets there in time.
  private func holding(_ t: Int64, elapsed: Int64, gap: Double, first: Bool, next: Reading) -> Action {
    let due = (gap - lead) * 1000
    if first && due > Double(Self.budgetMs - elapsed) { return fallback("ahead") }
    // Due before the next tick: started then, on a timer of its own.
    if next.ready && due < Double(Self.tickMs) {
      return setRate(t, 1, gap: lead, next: next, afterMs: Int64(due.rounded(.down)))
    }
    return .wait
  }

  /// While it runs: faster when behind, held again when well ahead, slower when a little.
  private func desiredRate(_ gap: Double) -> Double {
    if gap < -Self.toleranceS { return caps.maxRate > 1 ? speedUp(gap) : 1 }
    if gap > Self.acceptS { return 0 }
    if gap > Self.toleranceS { return caps.minRate < 1 ? slowDown(gap) : 1 }
    return 1
  }

  private func speedUp(_ gap: Double) -> Double {
    min(caps.maxRate, max(1 + Self.rateStep, Self.quantize(1 - gap / Self.horizonS)))
  }

  private func slowDown(_ gap: Double) -> Double {
    max(caps.minRate, min(1 - Self.rateStep, Self.quantize(1 - gap / Self.horizonS)))
  }

  private func setRate(_ t: Int64, _ rate: Double, gap: Double, next: Reading, afterMs: Int64 = 0) -> Action {
    let from = commanded
    commanded = rate
    steadySince = nil
    startGap = from == 0 && rate == 1 ? gap : nil
    startPosition = next.position
    if rate == 0 {
      runningSince = nil
    } else if from == 0 {
      runningSince = t + afterMs
    }
    return .rate(rate, afterMs: afterMs)
  }

  private func takeOver(_ residual: Double) -> Action {
    done = true
    return .takeOver(residual: residual)
  }

  private func fallback(_ reason: String) -> Action {
    done = true
    return .fallback(reason: reason)
  }

  /// Rates move in `rateStep`s: no stream of tiny changes.
  private static func quantize(_ rate: Double) -> Double { (rate / rateStep + 0.5).rounded(.down) * rateStep }

  /// A connection's live edge, against the clock: its freshest reading of `edge − time`.
  private static func freshest(_ samples: [EdgeSample], nextEdge: Bool) -> Double {
    var best = -Double.infinity
    for s in samples {
      let at = nextEdge ? s.nextAt : s.oldAt
      best = max(best, (nextEdge ? s.next : s.old) - Double(at) / 1000)
    }
    return best
  }
}
