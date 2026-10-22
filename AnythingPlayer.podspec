require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# Google Cast and CarPlay are opt-in (the Cast SDK adds several megabytes;
# CarPlay needs Apple's entitlement): `RNAP_CAST=1 pod install` and
# `RNAP_CAR=1 pod install`, or `"rnap.cast": "true"` / `"rnap.car": "true"` in
# ios/Podfile.properties.json (the Expo plugin's `cast` and `car` options). An
# explicit environment variable wins over the file. (Locals, not methods:
# CocoaPods evaluates podspecs inside its own module.)
rnap_flag =
  lambda do |env_name, property|
    if ENV.key?(env_name)
      %w[1 true yes].include?(ENV[env_name].to_s.strip.downcase)
    else
      roots = []
      roots << Pod::Config.instance.installation_root.to_s if defined?(Pod::Config)
      roots << Dir.pwd
      roots.uniq.any? do |root|
        path = File.join(root, "Podfile.properties.json")
        next false unless File.exist?(path)
        begin
          JSON.parse(File.read(path))[property].to_s == "true"
        rescue JSON::ParserError
          false
        end
      end
    end
  end
rnap_cast_enabled = rnap_flag.call("RNAP_CAST", "rnap.cast")
rnap_car_enabled = rnap_flag.call("RNAP_CAR", "rnap.car")

# The Sound API is opt-in the same way (`RNAP_SOUND=1 pod install`, or
# `"rnap.sound": "true"`; the Expo plugin's `sound` option): without it
# ios/Sound compiles to a stub that reports `unavailable`.
rnap_sound_enabled =
  if ENV.key?("RNAP_SOUND")
    %w[1 true yes].include?(ENV["RNAP_SOUND"].to_s.strip.downcase)
  else
    roots = []
    roots << Pod::Config.instance.installation_root.to_s if defined?(Pod::Config)
    roots << Dir.pwd
    roots.uniq.any? do |root|
      path = File.join(root, "Podfile.properties.json")
      next false unless File.exist?(path)
      begin
        JSON.parse(File.read(path))["rnap.sound"].to_s == "true"
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
  # Google Cast layer, CarPlay/ the optional CarPlay layer, Sound/ and
  # AnythingPlayerSoundModule.mm the Sound API (its engine compiled only with
  # RNAP_SOUND). IntentsExtension/ (the app's Siri extension target) and
  # AppIntents/ (Siri shortcuts, compiled by the app target: iOS reads App
  # Intents from the app's own code) are templates, never part of the pod.
  sources = ["ios/Core/**/*.swift", "ios/Platform/**/*.swift", "ios/AnythingPlayerModule.{h,mm}", "ios/RNAPRoutePickerView.mm", "ios/Sound/**/*.swift", "ios/AnythingPlayerSoundModule.{h,mm}"]
  s.exclude_files = ["ios/IntentsExtension/**", "ios/AppIntents/**"]
  s.private_header_files = "ios/AnythingPlayerModule.h", "ios/AnythingPlayerSoundModule.h"
  frameworks = ["AVFoundation", "AVKit", "AudioToolbox", "Intents", "MediaPlayer", "MediaToolbox", "Network", "UIKit"]
  s.swift_version = "5.9"

  conditions = ["$(inherited)"]
  if rnap_cast_enabled
    Pod::UI.puts "[AnythingPlayer] Google Cast enabled".green
    sources << "ios/Cast/**/*.swift"
    # 4.8.4 is the newest that supports iOS 15; CocoaPods picks the newest the app's platform allows.
    s.dependency "google-cast-sdk", ">= 4.8.4"
    conditions << "RNAP_CAST"
  end
  if rnap_sound_enabled
    Pod::UI.puts "[AnythingPlayer] Sound API enabled".green
    conditions << "RNAP_SOUND"
  end
  if rnap_car_enabled
    Pod::UI.puts "[AnythingPlayer] CarPlay enabled".green
    sources << "ios/CarPlay/**/*.swift"
    frameworks << "CarPlay"
    conditions << "RNAP_CAR"
  end
  s.pod_target_xcconfig = { "SWIFT_ACTIVE_COMPILATION_CONDITIONS" => conditions.join(" ") } if conditions.length > 1
  s.frameworks = frameworks
  s.source_files = sources

  install_modules_dependencies(s)
end
