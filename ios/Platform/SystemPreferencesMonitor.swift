import AVFoundation
import Foundation
import MediaAccessibility
import UIKit

/// What the OS says about the user, for a video player's track choice: the
/// preferred languages, the captions setting (Settings › Accessibility ›
/// Subtitles & Captioning) and audio descriptions. Reports changes on the
/// main thread.
final class SystemPreferencesMonitor {
  private let onChange: (SystemPreferences) -> Void
  private var observers: [NSObjectProtocol] = []

  init(onChange: @escaping (SystemPreferences) -> Void) {
    self.onChange = onChange
    let names: [Notification.Name] = [
      NSLocale.currentLocaleDidChangeNotification,
      UIAccessibility.closedCaptioningStatusDidChangeNotification,
      Notification.Name(kMACaptionAppearanceSettingsChangedNotification as String),
      Notification.Name(kMAAudibleMediaSettingsChangedNotification as String),
    ]
    observers = names.map {
      NotificationCenter.default.addObserver(forName: $0, object: nil, queue: .main) { [weak self] _ in
        guard let self else { return }
        self.onChange(self.current())
      }
    }
  }

  deinit {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
  }

  func current() -> SystemPreferences {
    let captions =
      UIAccessibility.isClosedCaptioningEnabled || MACaptionAppearanceGetDisplayType(.user) == .alwaysOn
    let audible = (MAAudibleMediaCopyPreferredCharacteristics().takeRetainedValue() as? [String]) ?? []
    let descriptions = audible.contains(AVMediaCharacteristic.describesVideoForAccessibility.rawValue)
    return SystemPreferences(languages: Locale.preferredLanguages, captions: captions, audioDescriptions: descriptions)
  }
}
