// swift-tools-version: 5.9
import PackageDescription

/* The Watch Bubble Engine, as a package rather than an Xcode target.

 Three reasons, in order of weight:

 1. It gets a TEST TARGET. ios/App/App.xcodeproj has none — not one, for any
    target — so until this package existed there was nowhere in this repo for a
    Swift assertion to live. The parity fixtures are worthless without a Swift
    side to read them.
 2. `swift test` runs it on the Mac, in CI, without a watchOS simulator. The
    engine is pure geometry over Foundation; nothing in it needs a wrist.
 3. It is the shape the engine should be anyway: no UI, no WatchConnectivity,
    no round state. A Garmin or Wear adapter later reuses a package; it cannot
    reuse a file sitting in a watchOS app target.

 The Watch app depends on this package. Nothing here may import SwiftUI,
 WatchKit or WatchConnectivity — if it needs one of those it is not the engine. */
let package = Package(
    name: "WatchBubbleEngine",
    platforms: [.watchOS(.v10), .iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "WatchBubbleEngine", targets: ["WatchBubbleEngine"])
    ],
    targets: [
        .target(name: "WatchBubbleEngine"),
        .testTarget(name: "WatchBubbleEngineTests", dependencies: ["WatchBubbleEngine"])
    ]
)
