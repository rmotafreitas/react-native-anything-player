import Foundation
import UIKit

// What the rest of the platform layer knows about video: the picture side's
// contract (`VideoPicture`, built by the video module in `ios/Video`, the
// `RNAP_VIDEO` build switch), the cues the drivers hand it, and the view
// behind `<VideoView>`. Without the switch there is no picture side: video
// players are refused (`status.video` is null, JS says how to turn it on) and
// `<VideoView>` is an empty box.

/// What a video load brings besides the source: its poster, its subtitle files and their session.
struct VideoLoadParts {
  var poster: String?
  /// The JS loader's session: cues sent for another one are stale.
  var session: String?
  var subtitles: [MediaTrack] = []

  init(_ source: NSDictionary? = nil) {
    poster = source?["poster"] as? String
    session = source?["subtitleSession"] as? String
    subtitles = Self.tracks(source?["subtitles"] as? [NSDictionary])
  }

  /// The app's subtitle files as tracks (`sub:<n>`, from JS).
  static func tracks(_ list: [NSDictionary]?) -> [MediaTrack] {
    (list ?? []).map { t in
      let captions = (t["kind"] as? String) == "captions"
      return MediaTrack(
        id: t["id"] as? String ?? "", kind: captions ? .captions : .subtitles, language: t["language"] as? String,
        label: t["label"] as? String, forced: t["forced"] as? Bool ?? false, isDefault: t["default"] as? Bool ?? false,
        sdh: captions)
    }
  }
}

/// A run of a cue's text with one style.
struct OverlaySpan: Equatable {
  var text: String
  var bold = false
  var italic = false
  var underline = false
  /// `nil`: the caption style's colour.
  var color: UIColor?
}

/// A cue the overlay draws: the app's subtitle files (from JS) or the source's (the legible output).
struct OverlayCue: Equatable {
  var start: Double
  var end: Double
  var spans: [OverlaySpan]
  /// `left`, `center`, `right`.
  var align = "center"
  /// `top`, `middle`, `bottom`.
  var vertical = "bottom"
  /// Fractions of the picture; `nil`: the default place.
  var x: Double?
  var y: Double?

  var text: String { spans.map(\.text).joined() }
}

/// The engine's local output: the AVPlayer driver, or a video player's pair of them.
protocol LocalOutput: EngineDriver {
  func progress() -> ProgressReading
  func destroy()
}

extension AVPlayerDriver: LocalOutput {}

/// A video player's picture side: its AVPlayers (the one on screen and the
/// one a quality switch prepares), the views that show them, fullscreen,
/// Picture in Picture and the subtitle overlay. Main thread, except
/// construction.
protocol VideoPicture: AnyObject {
  /// The player it belongs to (once the controller is built).
  func attach(to controller: PlayerController)
  /// What the engine plays through (wrapped by the routing driver).
  var output: LocalOutput { get }
  /// The AVPlayer on screen (sampling taps, media-services rebuilds).
  var primary: AVPlayerDriver { get }
  /// Every driver, the one on screen first.
  var drivers: [AVPlayerDriver] { get }
  /// A new load: its poster and subtitle session.
  func load(_ parts: VideoLoadParts)
  func statusChanged(_ status: Status)
  /// Cues of the source's own text track, now.
  func sourceCues(_ cues: [OverlayCue])
  /// Playback jumped (a seek, a loop): subtitles place themselves again.
  func positionJumped()
  /// The app's subtitle files whose cues have loaded, as WebVTT (for a Cast receiver).
  func castSubtitles(_ status: VideoStatus) -> [CastSubtitle]
  /// `cues`, `fullscreen`, `pictureInPicture`.
  func command(_ op: String, _ command: NSDictionary) throws
  /// The app went to the background or came back.
  func appBackgrounded()
  func appForegrounded()
  func destroy()
}

/// The video module this build has (`RNAP_VIDEO`).
enum VideoSupport {
  static var available: Bool {
    #if RNAP_VIDEO
    return true
    #else
    return false
    #endif
  }

  /// Main thread.
  static func create(titleFormat: StreamTitleFormat) -> VideoPicture? {
    #if RNAP_VIDEO
    return VideoOutput(titleFormat: titleFormat)
    #else
    return nil
    #endif
  }

  /// A player was registered: views mounted before it attach now.
  static func playerRegistered() {
    #if RNAP_VIDEO
    VideoHosts.playerRegistered()
    #endif
  }

  /// A view's props, window or size changed.
  static func hostChanged(_ host: RNAPVideoHostView) {
    #if RNAP_VIDEO
    VideoHosts.changed(host)
    #endif
  }
}

/// The view behind `<VideoView>` (wrapped by `RNAPVideoView.mm`): finds its
/// player by id; the video module puts the picture, the subtitles and the
/// controls in it.
@objc(RNAPVideoHostView)
public final class RNAPVideoHostView: UIView {
  @objc public var playerId: String = "" {
    didSet { if playerId != oldValue { VideoSupport.hostChanged(self) } }
  }
  /// `contain`, `cover` or `fill`.
  @objc public var contentFit: String = "contain" {
    didSet { if contentFit != oldValue { VideoSupport.hostChanged(self) } }
  }
  /// The system's own controls (AVKit's).
  @objc public var nativeControls = false {
    didSet { if nativeControls != oldValue { VideoSupport.hostChanged(self) } }
  }
  /// The video module's state for this view (its player's output).
  var attachment: AnyObject?

  override public init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    clipsToBounds = true
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    backgroundColor = .black
    clipsToBounds = true
  }

  override public func didMoveToWindow() {
    super.didMoveToWindow()
    VideoSupport.hostChanged(self)
  }

  override public func layoutSubviews() {
    super.layoutSubviews()
    VideoSupport.hostChanged(self)
  }

  /// Fabric recycles views: a recycled one belongs to no player.
  @objc public func prepareForReuse() {
    playerId = ""
  }
}

// MARK: - Cast

/// One of the app's subtitle files, as WebVTT for a Cast receiver.
struct CastSubtitle {
  /// The engine's track id (`sub:<n>`).
  var id: String
  var captions: Bool
  var language: String?
  var label: String?
  var vtt: String
}

/// What a video player hands a Cast receiver besides the source.
struct CastMedia {
  var video = false
  var subtitles: [CastSubtitle] = []
  /// The text track shown (`status.video.textTrack`).
  var textTrack: String?

  /// A WebVTT file a receiver fetches without a server: a `data:` URL.
  static func dataURL(_ vtt: String) -> String {
    let unreserved = CharacterSet(
      charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
    return "data:text/vtt;charset=utf-8," + (vtt.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "")
  }
}

/// Cues as a WebVTT file (bold, italic, underline and placement kept),
/// shifted by `delay`. Twin of `cuesToVtt` in src/core/subtitles/vtt.ts.
enum CueWriter {
  static func vtt(_ cues: [OverlayCue], delay: Double = 0) -> String {
    let blocks = cues.filter { $0.end + delay > 0 }.map { cue -> String in
      let text = cue.spans.map { span -> String in
        var t = span.text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
          .replacingOccurrences(of: ">", with: "&gt;")
        if span.underline { t = "<u>\(t)</u>" }
        if span.italic { t = "<i>\(t)</i>" }
        if span.bold { t = "<b>\(t)</b>" }
        return t
      }.joined()
      return "\(clock(cue.start + delay)) --> \(clock(cue.end + delay)) \(settings(cue))\n\(text)"
    }
    return (["WEBVTT"] + blocks).joined(separator: "\n\n") + "\n"
  }

  private static func clock(_ seconds: Double) -> String {
    let ms = max(0, Int((seconds * 1000).rounded()))
    return String(
      format: "%02d:%02d:%02d.%03d", ms / 3_600_000, (ms % 3_600_000) / 60_000, (ms % 60_000) / 1000, ms % 1000)
  }

  private static func settings(_ cue: OverlayCue) -> String {
    var out = ["align:" + (cue.align == "left" ? "start" : cue.align == "right" ? "end" : "center")]
    if let y = cue.y {
      let anchor = cue.vertical == "top" ? "start" : cue.vertical == "middle" ? "center" : "end"
      out.append(String(format: "line:%.1f%%,%@", y * 100, anchor))
    } else if cue.vertical == "top" {
      out.append("line:0")
    } else if cue.vertical == "middle" {
      out.append("line:50%,center")
    }
    if let x = cue.x { out.append(String(format: "position:%.1f%%", x * 100)) }
    return out.joined(separator: " ")
  }
}
