// swift-tools-version:5.9
// Host-side test package for the platform-free engine (`Core/`). The CocoaPod
// compiles the same files into the app; this package only exists so the core
// can be unit-tested on macOS with `swift test` — no simulator required.
import PackageDescription

let package = Package(
  name: "AnythingPlayerCore",
  platforms: [.macOS(.v13)],
  products: [.library(name: "AnythingPlayerCore", targets: ["AnythingPlayerCore"])],
  targets: [
    .target(name: "AnythingPlayerCore", path: "Core"),
    .testTarget(
      name: "AnythingPlayerCoreTests",
      dependencies: ["AnythingPlayerCore"],
      path: "Tests/AnythingPlayerCoreTests"
    ),
  ],
  swiftLanguageVersions: [.v5]
)
