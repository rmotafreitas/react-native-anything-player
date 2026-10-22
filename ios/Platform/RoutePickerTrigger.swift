import AVFoundation
import AVKit
import UIKit

/// `showRoutePicker()`. iOS has no API that opens the output picker, only
/// its button (`AVRoutePickerView`, what `<RoutePicker />` renders). This
/// keeps an invisible one in the key window and taps its internal button.
/// Best effort: that button is not API, so a future iOS may not have it
/// (`show()` then returns false). Main thread only.
enum RoutePickerTrigger {
  private static var picker: AVRoutePickerView?

  static func show() -> Bool {
    guard let window = keyWindow else { return false }
    let picker = self.picker ?? AVRoutePickerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    self.picker = picker
    picker.prioritizesVideoDevices = false
    picker.isUserInteractionEnabled = false
    picker.alpha = 0.011
    if picker.superview !== window {
      picker.removeFromSuperview()
      window.addSubview(picker)
    }
    // The picker is anchored here on iPad.
    picker.center = CGPoint(x: window.bounds.midX, y: window.bounds.midY)
    picker.layoutIfNeeded()
    guard let button = firstButton(in: picker) else { return false }
    button.sendActions(for: .touchUpInside)
    return true
  }

  private static var keyWindow: UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
  }

  private static func firstButton(in view: UIView) -> UIButton? {
    for subview in view.subviews {
      if let button = subview as? UIButton { return button }
      if let button = firstButton(in: subview) { return button }
    }
    return nil
  }
}

extension AudioRoute {
  /// The device's current output (`AVAudioSession.currentRoute`).
  static func current() -> AudioRoute {
    guard let output = AVAudioSession.sharedInstance().currentRoute.outputs.first else { return .unknown }
    let kind: AudioRouteKind
    switch output.portType {
    case .builtInSpeaker, .builtInReceiver: kind = .speaker
    case .headphones: kind = .headphones
    case .bluetoothA2DP, .bluetoothLE, .bluetoothHFP: kind = .bluetooth
    case .airPlay: kind = .airplay
    case .carAudio: kind = .car
    case .HDMI: kind = .hdmi
    case .usbAudio: kind = .usb
    default: kind = .other
    }
    return AudioRoute(kind: kind, name: output.portName)
  }
}
