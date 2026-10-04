// swift-tools-version:5.9
// Host-side test package for the platform-free engine (`Core/`). The CocoaPod
// compiles the same files into the app; this package only exists so the core
// can be unit-tested on macOS with `swift test` — no simulator required.
import PackageDescription

let package = Package(
  name: "AirwaveCore",
  platforms: [.macOS(.v13)],
  products: [.library(name: "AirwaveCore", targets: ["AirwaveCore"])],
  targets: [
    .target(name: "AirwaveCore", path: "Core"),
    .testTarget(
      name: "AirwaveCoreTests",
      dependencies: ["AirwaveCore"],
      path: "Tests/AirwaveCoreTests"
    ),
  ],
  swiftLanguageVersions: [.v5]
)
