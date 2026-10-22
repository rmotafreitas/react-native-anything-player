require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# Google Cast is opt-in (the SDK adds several megabytes): `RNAP_CAST=1 pod install`,
# or `"rnap.cast": "true"` in ios/Podfile.properties.json (the Expo plugin's
# `cast` option). An explicit RNAP_CAST wins over the file. (A local, not a
# method: CocoaPods evaluates podspecs inside its own module.)
rnap_cast_enabled =
  if ENV.key?("RNAP_CAST")
    %w[1 true yes].include?(ENV["RNAP_CAST"].to_s.strip.downcase)
  else
    roots = []
    roots << Pod::Config.instance.installation_root.to_s if defined?(Pod::Config)
    roots << Dir.pwd
    roots.uniq.any? do |root|
      path = File.join(root, "Podfile.properties.json")
      next false unless File.exist?(path)
      begin
        JSON.parse(File.read(path))["rnap.cast"].to_s == "true"
      rescue JSON::ParserError
        false
      end
    end
  end

Pod::Spec.new do |s|
  s.name         = "AnythingPlayer"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = { :type => "PolyForm-Noncommercial-1.0.0", :file => "LICENSE" }
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/rmotafreitas/react-native-anything-player.git", :tag => "v#{s.version}" }

  # Core/ is platform-free (also unit-tested with `swift test`), Platform/ is
  # the AVFoundation/MediaPlayer layer, AnythingPlayerModule.mm the TurboModule
  # shim, RNAPRoutePickerView.mm the Fabric AirPlay button, Cast/ the optional
  # Google Cast layer. IntentsExtension/ (the app's Siri extension target) and
  # AppIntents/ (Siri shortcuts, compiled by the app target: iOS reads App
  # Intents from the app's own code) are templates, never part of the pod.
  sources = ["ios/Core/**/*.swift", "ios/Platform/**/*.swift", "ios/AnythingPlayerModule.{h,mm}", "ios/RNAPRoutePickerView.mm"]
  s.exclude_files = ["ios/IntentsExtension/**", "ios/AppIntents/**"]
  s.private_header_files = "ios/AnythingPlayerModule.h"
  s.frameworks = "AVFoundation", "AVKit", "AudioToolbox", "Intents", "MediaPlayer", "MediaToolbox", "Network", "UIKit"
  s.swift_version = "5.9"

  if rnap_cast_enabled
    Pod::UI.puts "[AnythingPlayer] Google Cast enabled".green
    sources << "ios/Cast/**/*.swift"
    # 4.8.4 is the newest that supports iOS 15; CocoaPods picks the newest the app's platform allows.
    s.dependency "google-cast-sdk", ">= 4.8.4"
    s.pod_target_xcconfig = { "SWIFT_ACTIVE_COMPILATION_CONDITIONS" => "$(inherited) RNAP_CAST" }
  end
  s.source_files = sources

  install_modules_dependencies(s)
end
