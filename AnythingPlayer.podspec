require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "AnythingPlayer"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = { :type => "PolyForm-Noncommercial-1.0.0", :file => "LICENSE" }
  s.authors      = package["author"]

  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/rmotafreitas/react-native-anything-player.git", :tag => "#{s.version}" }

  # Core/ is platform-free (also unit-tested with `swift test`), Platform/ is
  # the AVFoundation/MediaPlayer layer, AnythingPlayerModule.mm the TurboModule shim.
  s.source_files = "ios/Core/**/*.swift", "ios/Platform/**/*.swift", "ios/AnythingPlayerModule.{h,mm}"
  s.private_header_files = "ios/AnythingPlayerModule.h"
  s.frameworks = "AVFoundation", "AudioToolbox", "MediaPlayer", "MediaToolbox", "Network"
  s.swift_version = "5.9"

  install_modules_dependencies(s)
end
