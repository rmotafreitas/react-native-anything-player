import Foundation

// The remuxer's model: what a demuxer finds in a Matroska/WebM or MPEG-TS
// file, and what the MP4 writer is given. Platform-free; the TypeScript twin
// is src/web/remux/types.ts, and both are held to conformance/remux/.

enum RemuxTrackKind: String {
  case video, audio, text
}

/// A track as the demuxer found it (a class: demuxers complete it as frames arrive).
final class RemuxTrack {
  /// The container's id: the Matroska track number, the TS PID.
  let id: Int
  let kind: RemuxTrackKind
  /// The RFC 6381 codec (`avc1.4D401E`, `mp4a.40.2`, `opus`); for text, `srt`, `ass` or `vtt`.
  /// `nil` until the codec's configuration is known.
  var codec: String?
  /// The MP4 sample entry (`avc1`, `hvc1`, `vp09`, `vp08`, `av01`, `mp4a`, `Opus`, `fLaC`, `ac-3`, `ec-3`).
  var entry: String?
  /// The sample entry's configuration box payload.
  var config: [UInt8]?
  /// The `esds` objectTypeIndication (AAC 0x40, MP3 0x6B).
  var objectType = 0
  /// Units per second of the samples' times.
  var timescale = 1000
  /// The coded picture, pixels.
  var width = 0
  var height = 0
  /// The pixels' aspect ratio, `1:1` for square pixels.
  var sarWidth = 1
  var sarHeight = 1
  var sampleRate = 0
  var channels = 0
  /// ISO 639-2 or BCP 47; `nil` when unknown.
  var language: String?
  var name: String?
  var isDefault = false
  var forced = false
  /// Why it cannot be remuxed; `nil` when it can.
  var unsupported: String?
  /// Text: the codec's private data (an ASS script's header).
  var header: String?

  init(id: Int, kind: RemuxTrackKind) {
    self.id = id
    self.kind = kind
  }

  /// Whether it can be muxed.
  var playable: Bool { unsupported == nil && codec != nil && kind != .text }
}

/// One sample, as the MP4 writer takes it: times in the track's timescale.
struct RemuxSample {
  var dts: Int
  var pts: Int
  var duration: Int
  var key: Bool
  var data: [UInt8]
}

/// A subtitle found in the file: times in milliseconds.
struct RemuxCue: Equatable {
  let track: Int
  let start: Int
  /// `nil`: the file does not say.
  let end: Int?
  let text: String
}

/// A frame as a demuxer hands it on (before the remuxer times it).
struct DemuxFrame {
  let track: Int
  /// Presentation time on the container's clock; `nil`: right after the previous frame.
  let pts: Int?
  let key: Bool
  let data: [UInt8]
}

/// Where a Matroska file's clusters start, for seeking (from its Cues).
struct CuePoint: Equatable {
  /// Milliseconds.
  let time: Int
  /// The cluster's byte offset in the file.
  let offset: Int
}

/// Where a demuxer's frames and cues go.
protocol DemuxSink: AnyObject {
  func frame(_ frame: DemuxFrame)
  func cue(_ cue: RemuxCue)
}
