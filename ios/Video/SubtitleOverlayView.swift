#if RNAP_VIDEO
import CoreText
import MediaAccessibility
import UIKit

/// Draws cues over the picture in the user's caption style (Settings ›
/// Accessibility › Subtitles & Captioning › Style: text and background
/// colours and opacities, the window, the edge, the font and its size).
final class SubtitleOverlayView: UIView {
  private var cues: [OverlayCue] = []
  /// Points at the bottom covered by controls: cues placed at the bottom stay above.
  var bottomInset: CGFloat = 0 {
    didSet { if bottomInset != oldValue { setNeedsDisplay() } }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    isUserInteractionEnabled = false
    contentMode = .redraw
    isAccessibilityElement = false
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
  }

  func show(_ next: [OverlayCue]) {
    guard next != cues else { return }
    cues = next
    setNeedsDisplay()
  }

  /// The user's caption style, read when drawing (it can change while playing).
  private struct Style {
    var foreground: UIColor
    var background: UIColor
    var window: UIColor
    var edge: MACaptionAppearanceTextEdgeStyle
    var font: UIFont
  }

  private func style() -> Style {
    func color(_ cg: CGColor, _ opacity: CGFloat) -> UIColor { UIColor(cgColor: cg).withAlphaComponent(opacity) }
    let domain = MACaptionAppearanceDomain.user
    let foreground = color(
      MACaptionAppearanceCopyForegroundColor(domain, nil).takeRetainedValue(),
      MACaptionAppearanceGetForegroundOpacity(domain, nil))
    let background = color(
      MACaptionAppearanceCopyBackgroundColor(domain, nil).takeRetainedValue(),
      MACaptionAppearanceGetBackgroundOpacity(domain, nil))
    let window = color(
      MACaptionAppearanceCopyWindowColor(domain, nil).takeRetainedValue(),
      MACaptionAppearanceGetWindowOpacity(domain, nil))
    // AVFoundation's default size: 5.33% of the picture's height, times the user's scale.
    let scale = MACaptionAppearanceGetRelativeCharacterSize(domain, nil)
    let size = max(12, bounds.height * 0.0533 * (scale > 0 ? scale : 1))
    let descriptor = MACaptionAppearanceCopyFontDescriptorForStyle(domain, nil, .default).takeRetainedValue()
    let font = CTFontCreateWithFontDescriptor(descriptor, size, nil) as UIFont
    return Style(
      foreground: foreground, background: background, window: window,
      edge: MACaptionAppearanceGetTextEdgeStyle(domain, nil), font: font)
  }

  override func draw(_ rect: CGRect) {
    guard !cues.isEmpty, bounds.width > 0, bounds.height > 0 else { return }
    let style = style()
    for cue in cues { draw(cue, style) }
  }

  private func text(_ cue: OverlayCue, _ style: Style, outline: Bool) -> NSAttributedString {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = cue.align == "left" ? .left : cue.align == "right" ? .right : .center
    let out = NSMutableAttributedString()
    for span in cue.spans {
      var traits: UIFontDescriptor.SymbolicTraits = []
      if span.bold { traits.insert(.traitBold) }
      if span.italic { traits.insert(.traitItalic) }
      let font =
        traits.isEmpty
        ? style.font
        : style.font.fontDescriptor.withSymbolicTraits(traits).map { UIFont(descriptor: $0, size: style.font.pointSize) }
          ?? style.font
      var attributes: [NSAttributedString.Key: Any] = [.font: font, .paragraphStyle: paragraph]
      if outline {
        attributes[.strokeColor] = UIColor.black
        attributes[.strokeWidth] = 8
        attributes[.foregroundColor] = UIColor.black
      } else {
        attributes[.foregroundColor] = span.color ?? style.foreground
        if style.background.cgColor.alpha > 0 { attributes[.backgroundColor] = style.background }
        if span.underline { attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue }
        switch style.edge {
        case .dropShadow: attributes[.shadow] = shadow(offset: 2, blur: 2)
        case .raised: attributes[.shadow] = shadow(offset: -1, blur: 1)
        case .depressed: attributes[.shadow] = shadow(offset: 1, blur: 1)
        default: break
        }
      }
      out.append(NSAttributedString(string: span.text, attributes: attributes))
    }
    return out
  }

  private func shadow(offset: CGFloat, blur: CGFloat) -> NSShadow {
    let s = NSShadow()
    s.shadowOffset = CGSize(width: offset, height: offset)
    s.shadowBlurRadius = blur
    s.shadowColor = UIColor.black
    return s
  }

  private func draw(_ cue: OverlayCue, _ style: Style) {
    let maxWidth = bounds.width * 0.9
    let body = text(cue, style, outline: false)
    let size = body.boundingRect(
      with: CGSize(width: maxWidth, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin], context: nil
    ).integral.size
    let box = CGRect(origin: origin(cue, size, maxWidth), size: CGSize(width: maxWidth, height: size.height))
    if style.window.cgColor.alpha > 0 {
      let lineWidth = min(size.width, maxWidth)
      let left: CGFloat =
        cue.align == "left" ? box.minX : cue.align == "right" ? box.maxX - lineWidth : box.midX - lineWidth / 2
      style.window.setFill()
      UIBezierPath(rect: CGRect(x: left - 4, y: box.minY - 4, width: lineWidth + 8, height: size.height + 8)).fill()
    }
    if style.edge == .uniform {
      // The outline first, under the text.
      text(cue, style, outline: true).draw(with: box, options: [.usesLineFragmentOrigin], context: nil)
    }
    body.draw(with: box, options: [.usesLineFragmentOrigin], context: nil)
  }

  /// The text box's corner: at the cue's point (anchored by its alignment), else near an edge.
  private func origin(_ cue: OverlayCue, _ size: CGSize, _ maxWidth: CGFloat) -> CGPoint {
    let w = bounds.width
    let h = bounds.height
    var x = (w - maxWidth) / 2
    if let cx = cue.x {
      let anchor: CGFloat = cue.align == "left" ? 0 : cue.align == "right" ? maxWidth : maxWidth / 2
      x = min(max(0, CGFloat(cx) * w - anchor), max(0, w - maxWidth))
    }
    let margin = h * 0.06
    var y: CGFloat
    if let cy = cue.y {
      let anchor: CGFloat = cue.vertical == "top" ? 0 : cue.vertical == "middle" ? size.height / 2 : size.height
      y = min(max(0, CGFloat(cy) * h - anchor), max(0, h - size.height))
    } else {
      switch cue.vertical {
      case "top": y = margin
      case "middle": y = (h - size.height) / 2
      default: y = h - max(margin, bottomInset) - size.height
      }
    }
    return CGPoint(x: x, y: y)
  }
}
#endif
