import Foundation

/// Matroska / WebM / MPEG-TS → fragmented MP4, as bytes arrive. The demuxer
/// finds the tracks and frames; the remuxer waits until every track's
/// configuration is known, picks the tracks to mux, and turns frames into
/// fragments: it starts at a video keyframe (audio before it is dropped), a
/// TS stream's times move to zero there, video decode times are the
/// fragment's presentation times in order, audio is timed frame after frame
/// (re-anchored past half a frame of drift), and a fragment ends at each
/// video keyframe (each second of audio without video). A configuration that
/// changes closes the fragment and sends a new init segment.
///
/// The TypeScript twin (src/web/remux/Remuxer.ts) makes the same bytes from
/// the same input: conformance/remux/.
final class Remuxer {
  enum Format {
    case matroska, mpegts
  }

  struct Choice {
    var video: Int?
    var audio: Int?
  }

  struct Output {
    /// Init and media segments, in order: an init segment comes first, and again when a configuration changes.
    var segments: [[UInt8]] = []
    var cues: [RemuxCue] = []
  }

  /// Without every track's configuration this long into the file, the tracks still waiting are left out.
  private static let readyAfterMs = 3000
  /// Audio frames kept while waiting for the first video keyframe.
  private static let maxEarly = 2000

  private enum Demuxer {
    case matroska(MatroskaDemuxer)
    case mpegts(TsDemuxer)
  }

  private final class Sink: DemuxSink {
    weak var owner: Remuxer?
    func frame(_ frame: DemuxFrame) { owner?.frame(frame) }
    func cue(_ cue: RemuxCue) { owner?.out.cues.append(cue) }
  }

  private struct VideoFrame {
    let pts: Int
    let key: Bool
    let data: [UInt8]
  }

  let format: Format
  private let demuxer: Demuxer
  private let choose: ([RemuxTrack]) -> Choice
  /// The tracks muxed, in the init segment's order; `nil` until the tracks are known.
  private(set) var muxed: [RemuxTrack]?
  /// The current init segment.
  private(set) var initSegment: [UInt8]?
  /// Why nothing can be muxed (no playable track), once that is known.
  private(set) var failure: String?

  private var configs: [[UInt8]?] = []
  private var pending: [DemuxFrame] = []
  private var span: (min: Int, max: Int)?
  private var base: Int?
  private var start: Int?
  private var early: [DemuxFrame] = []
  private var video: [VideoFrame] = []
  private var audio: [RemuxSample] = []
  private var nextAudio: Int?
  /// The latest video time muxed (after `base`), for a TS stream's jumps.
  private var lastVideo: Int?
  private var sequence = 0
  private var out = Output()
  private let sink = Sink()

  /// `timeBase`: a TS file's (clock units), when this part is read on its own (a segment from the middle).
  init(format: Format, choose: (([RemuxTrack]) -> Choice)? = nil, timeBase: Int? = nil) {
    self.format = format
    demuxer = format == .matroska ? .matroska(MatroskaDemuxer()) : .mpegts(TsDemuxer())
    base = format == .matroska ? 0 : timeBase
    self.choose = choose ?? Remuxer.defaultChoice
    sink.owner = self
  }

  /// The first video track, and the default (else the first) audio track.
  static func defaultChoice(_ tracks: [RemuxTrack]) -> Choice {
    let video = tracks.first { $0.kind == .video && $0.playable }
    let audio = tracks.filter { $0.kind == .audio && $0.playable }
    return Choice(video: video?.id, audio: (audio.first { $0.isDefault } ?? audio.first)?.id)
  }

  /// Samples an audio frame lasts, in its track's timescale.
  static func audioFrameSamples(_ track: RemuxTrack, _ data: [UInt8]) -> Int {
    switch track.entry {
    case "mp4a": return track.objectType == 0x6B ? (Codecs.mpegAudioHeader(data, 0)?.samples ?? 1152) : 1024
    case "ac-3": return 1536
    case "ec-3": return Codecs.ac3Header(data, 0)?.samples ?? 1536
    case "Opus":
      let samples = Codecs.opusSamples(data)
      return samples == 0 ? 960 : samples
    case "fLaC": return Codecs.flacSamples(data) ?? 4096
    default: return 1024
    }
  }

  /// Every track found, muxed or not.
  var tracks: [RemuxTrack] {
    switch demuxer {
    case .matroska(let d): return d.tracks
    case .mpegts(let d): return d.tracks
    }
  }

  /// The Matroska demuxer (its Cues, duration, offsets), when it is one.
  var matroska: MatroskaDemuxer? {
    if case .matroska(let d) = demuxer { return d }
    return nil
  }

  /// Clock units per second of the container's times.
  var clock: Int {
    switch demuxer {
    case .matroska(let d): return d.clock
    case .mpegts(let d): return d.clock
    }
  }

  /// The time subtracted from the stream's (TS), clock units; `nil` until known.
  var timeBase: Int? { base }

  private var tracksKnown: Bool {
    switch demuxer {
    case .matroska(let d): return d.tracksKnown
    case .mpegts(let d): return d.tracksKnown
    }
  }

  /// Remuxes a chunk of the file.
  func push(_ chunk: [UInt8]) -> Output {
    switch demuxer {
    case .matroska(let d): d.push(chunk, sink)
    case .mpegts(let d): d.push(chunk, sink)
    }
    return take()
  }

  /// The file ended: what is left goes out.
  func end() -> Output {
    switch demuxer {
    case .matroska(let d): d.end(sink)
    case .mpegts(let d): d.end(sink)
    }
    if muxed == nil && tracksKnown { ready() }
    flush(nextKey: nil)
    return take()
  }

  /// The next bytes pushed come from elsewhere in the file: a Matroska
  /// cluster at `offset`, any TS packet. What was buffered is dropped, and
  /// muxing starts again at a keyframe.
  func seek(_ offset: Int = 0) {
    switch demuxer {
    case .matroska(let d): d.seek(offset)
    case .mpegts(let d): d.seek()
    }
    video = []
    audio = []
    early = []
    nextAudio = nil
    lastVideo = nil
    start = nil
    if muxed == nil { pending = [] }
  }

  /// A live stream's new connection: the demuxer drops what it held of the
  /// old one (a cut packet, a PES) and starts over; the timeline goes on (a
  /// jump in the stream's timestamps is carried over at its next keyframe).
  func reconnected() {
    switch demuxer {
    case .matroska(let d): d.seek(0)
    case .mpegts(let d): d.seek()
    }
  }

  private func take() -> Output {
    let output = out
    out = Output()
    return output
  }

  // MARK: - Readiness

  private func frame(_ frame: DemuxFrame) {
    if muxed != nil {
      mux(frame)
      return
    }
    pending.append(frame)
    if let pts = frame.pts {
      let ms = Bytes.rescale(pts, 1000, clock)
      span = span.map { (min($0.min, ms), max($0.max, ms)) } ?? (ms, ms)
    }
    guard tracksKnown else { return }
    let waiting = tracks.contains { $0.kind != .text && $0.unsupported == nil && $0.codec == nil }
    let long = span.map { $0.max - $0.min >= Self.readyAfterMs } ?? false
    if !waiting || long { ready() }
  }

  private func ready() {
    for t in tracks where t.kind != .text && t.unsupported == nil && t.codec == nil { t.unsupported = "no data" }
    let choice = choose(tracks)
    let pick = { (id: Int?, kind: RemuxTrackKind) -> RemuxTrack? in
      self.tracks.first { $0.id == id && $0.kind == kind && $0.playable }
    }
    muxed = [pick(choice.video, .video), pick(choice.audio, .audio)].compactMap { $0 }
    if muxed!.isEmpty {
      failure = describeFailure()
      pending = []
      return
    }
    writeInit()
    let frames = pending
    pending = []
    for frame in frames { mux(frame) }
  }

  private func describeFailure() -> String {
    let parts = tracks.filter { $0.kind != .text }.map { "\($0.kind.rawValue) \($0.unsupported ?? $0.codec ?? "?")" }
    return parts.isEmpty ? "no audio or video track" : "no playable track (\(parts.joined(separator: ", ")))"
  }

  private func writeInit() {
    let tracks = muxed!
    let segment = Mp4Writer.initSegment(tracks)
    initSegment = segment
    configs = tracks.map(\.config)
    out.segments.append(segment)
  }

  // MARK: - Muxing

  private func mux(_ frame: DemuxFrame) {
    let tracks = muxed!
    guard let index = tracks.firstIndex(where: { $0.id == frame.track }) else { return }
    let track = tracks[index]
    if track.config != configs[index] {
      if track.kind == .video && !frame.key { return }
      flush(nextKey: track.kind == .video ? frame.pts.map { $0 - (base ?? 0) } : nil)
      writeInit()
    }
    if track.kind == .video {
      muxVideo(frame)
    } else {
      muxAudio(track, frame)
    }
  }

  private func muxVideo(_ frame: DemuxFrame) {
    guard let framePts = frame.pts else { return }
    if start == nil {
      guard frame.key else { return }
      if base == nil { base = framePts }
      start = framePts - base!
      let held = early
      early = []
      if let audioTrack = muxed!.first(where: { $0.kind == .audio }) {
        for f in held { muxAudio(audioTrack, f) }
      }
    }
    var pts = framePts - base!
    let last = lastVideo
    if frame.key, let last, jumped(pts, last) {
      // The stream's timestamps jumped (an encoder restart, a new program,
      // a loop): the timeline goes on from where it was.
      let videoTrack = muxed!.first { $0.kind == .video }!
      let shift = pts - (last + frameDuration(videoTrack))
      base! += shift
      pts -= shift
      nextAudio = nil
    }
    if pts < start! { return }
    if frame.key && !video.isEmpty { flush(nextKey: pts) }
    video.append(VideoFrame(pts: pts, key: frame.key, data: frame.data))
    if last == nil || pts > last! { lastVideo = pts }
  }

  /// A TS time this far from the last (back a second, on ten): a discontinuity.
  private func jumped(_ time: Int, _ last: Int) -> Bool {
    guard format == .mpegts else { return false }
    return time < last - clock || time > last + 10 * clock
  }

  private func muxAudio(_ track: RemuxTrack, _ frame: DemuxFrame) {
    let hasVideo = muxed!.contains { $0.kind == .video }
    if hasVideo && start == nil {
      early.append(frame)
      if early.count > Self.maxEarly { early.removeFirst() }
      return
    }
    if base == nil {
      guard let pts = frame.pts else { return }
      base = pts
    }
    if start == nil { start = 0 }
    let duration = Self.audioFrameSamples(track, frame.data)
    if !hasVideo, let pts = frame.pts, let next = nextAudio {
      let expected = Bytes.rescale(next, clock, track.timescale)
      if jumped(pts - base!, expected) { base = pts - expected }
    }
    var time: Int
    if let pts = frame.pts {
      time = Bytes.signedRescale(pts - base!, track.timescale, clock)
      if let next = nextAudio {
        if 2 * abs(time - next) <= duration {
          time = next
        } else if time < next {
          return
        }
      }
    } else {
      guard let next = nextAudio else { return }
      time = next
    }
    // The timeline moves on through frames dropped before the start: the
    // frames after them in the same PES or block carry no time of their own.
    nextAudio = time + duration
    if time < Bytes.rescale(start!, track.timescale, clock) { return }
    // Audio without video is cut on a grid of whole seconds (the same cuts from wherever it is read).
    let grid = track.timescale
    if !hasVideo, let first = audio.first, Self.floorDiv(time, grid) > Self.floorDiv(first.dts, grid) {
      flush(nextKey: nil)
    }
    audio.append(RemuxSample(dts: time, pts: time, duration: duration, key: true, data: frame.data))
  }

  private static func floorDiv(_ a: Int, _ b: Int) -> Int {
    a >= 0 ? a / b : -((-a + b - 1) / b)
  }

  /// Writes the fragment collected; `nextKey`: the time of the keyframe after it.
  private func flush(nextKey: Int?) {
    guard let tracks = muxed else { return }
    let videoSamples = self.videoSamples(nextKey: nextKey)
    if videoSamples.isEmpty && audio.isEmpty { return }
    sequence += 1
    let samples = tracks.map { $0.kind == .video ? videoSamples : audio }
    out.segments.append(Mp4Writer.fragment(sequence: sequence, tracks: tracks, samples: samples))
    video = []
    audio = []
  }

  private func videoSamples(nextKey: Int?) -> [RemuxSample] {
    let frames = video
    let n = frames.count
    guard n > 0 else { return [] }
    let times = frames.map(\.pts).sorted()
    let track = muxed!.first { $0.kind == .video }!
    let last = times[n - 1]
    let lastDuration: Int
    if let nextKey, nextKey > last {
      lastDuration = nextKey - last
    } else if n > 1 {
      lastDuration = last - times[n - 2]
    } else {
      lastDuration = frameDuration(track)
    }
    return frames.enumerated().map { i, f in
      RemuxSample(
        dts: times[i], pts: f.pts, duration: i < n - 1 ? times[i + 1] - times[i] : lastDuration, key: f.key,
        data: f.data)
    }
  }

  private func frameDuration(_ track: RemuxTrack) -> Int {
    if let known = matroska?.frameDuration(track.id) { return known }
    return Int((Double(clock) / 25).rounded())
  }
}
