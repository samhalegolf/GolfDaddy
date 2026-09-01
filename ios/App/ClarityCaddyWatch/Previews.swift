#if DEBUG
import SwiftUI

/* Xcode canvas fixtures for the three states this app can be in.

 The Watch UI is unchanged until a round is live - the map is a second page that
 only exists once a Scene names a hole - so without these there is nothing to
 look at in the canvas and no way to see a hole map without a phone, a round and
 a delivered package.

 The numbers are real. The spatial reference below is exactly what
 gd-watch-map-core.js bakes for Millbrook's 1st under recipe v2, and the tee,
 green and green shape are that hole's published coordinates, so every marker is
 placed by the same projection the device uses. Only the IMAGE is a stand-in:
 the real bake is a Supabase asset this target does not carry, so the preview
 draws a schematic hole at the same 200x1536 canvas, positioned by projecting
 those same coordinates. It shows the layout and the maths honestly; it is not a
 substitute for looking at a delivered package. */
enum WatchPreviewFixtures {
    static let courseKey = "millbrook-remarkables-18"

    static let millbrookFirst = WatchMapSpatialReference(
        version: 1,
        refZoom: 20,
        transform: .init(a: 0.14267522497940566, b: -0.1587686301692798,
                         tx: -64388482.30039554, ty: 16781783.288878903),
        imageWidth: 200,
        imageHeight: 1536,
        rotationDegrees: 311.944,
        metresPerPixel: 0.4944
    )

    static let tee = WatchScene.GeoPoint(lat: -44.9492751, lng: 168.8142384)
    static let green = WatchScene.GeoPoint(lat: -44.946232370000004, lng: 168.81902248500003)
    /* Partway down the hole, and an aim point short of the green - the same two
       points the offscreen render harness uses. */
    static let player = WatchScene.GeoPoint(lat: -44.9476015985, lng: 168.81686964675)
    static let target = WatchScene.GeoPoint(lat: -44.946658352200004, lng: 168.81835271310004)

    static func scene(mode: String = "standard", canLock: Bool = true) -> WatchScene {
        WatchScene(
            schemaVersion: 1,
            roundId: "preview-round",
            revision: 42,
            flow: "live",
            mode: mode,
            course: .init(key: courseKey),
            hole: .init(number: 1, par: 5, live: true),
            distance: .init(target: 213, front: 205, centre: 213, back: 224),
            suggestion: .init(club: "5 IRON", carryM: 178, totalM: 186),
            shot: .init(locked: false, open: false),
            target: target,
            location: .init(coordinate: player, source: "phone-web", fresh: true),
            bubble: nil,
            geometry: .init(origin: green, approachBearingDeg: 312, greenPolygon: nil, target: nil, player: nil, route: nil),
            score: .init(strokes: nil),
            controls: .init(canLock: canLock, canUnlock: !canLock, canAim: false, canShotEnd: false,
                            canPreviousHole: false, canNextHole: true),
            connection: .init(status: "live")
        )
    }

    /* A schematic of hole 1 on the real canvas: the corridor recipe v2 frames,
       with the green drawn where the real green projects. Deliberately flat and
       obviously synthetic - it must never be mistaken for a delivered bake. */
    static func standInMap() -> WatchMapStore.LoadedHoleMap {
        let reference = millbrookFirst
        let width = Int(reference.imageWidth), height = Int(reference.imageHeight)
        /* UIGraphicsImageRenderer does not exist on watchOS, so this is raw
           CoreGraphics. Its origin is bottom-left; the flip below converts to
           the image's top-left space ONCE, and every coordinate after it is a
           plain image pixel. Converting anywhere else as well would mirror the
           whole drawing vertically. */
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            return WatchMapStore.LoadedHoleMap(holeNumber: 1, image: UIImage(), spatialReference: reference)
        }
        context.translateBy(x: 0, y: CGFloat(height))
        context.scaleBy(x: 1, y: -1)

        context.setFillColor(CGColor(red: 0.235, green: 0.420, blue: 0.271, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: CGFloat(width), height: CGFloat(height)))

        let teePx = reference.imagePoint(lat: tee.lat!, lng: tee.lng!) ?? .zero
        let greenPx = reference.imagePoint(lat: green.lat!, lng: green.lng!) ?? .zero
        context.setFillColor(CGColor(red: 0.435, green: 0.749, blue: 0.369, alpha: 1))
        context.fill(CGRect(x: teePx.x - 46, y: greenPx.y - 30, width: 92, height: teePx.y - greenPx.y + 90))

        context.setFillColor(CGColor(red: 0.639, green: 0.878, blue: 0.561, alpha: 1))
        context.fillEllipse(in: CGRect(x: greenPx.x - 36, y: greenPx.y - 28, width: 72, height: 56))

        context.setFillColor(CGColor(red: 0.914, green: 0.851, blue: 0.659, alpha: 1))
        for bunker in [CGPoint(x: greenPx.x - 48, y: greenPx.y + 20),
                       CGPoint(x: greenPx.x + 44, y: greenPx.y + 14),
                       CGPoint(x: teePx.x + 40, y: teePx.y - 300)] {
            context.fillEllipse(in: CGRect(x: bunker.x - 13, y: bunker.y - 9, width: 26, height: 18))
        }

        let image = context.makeImage().map { UIImage(cgImage: $0) } ?? UIImage()
        return WatchMapStore.LoadedHoleMap(holeNumber: 1, image: image, spatialReference: reference)
    }
}

#Preview("Hole map") {
    HoleMapPage(
        scene: WatchPreviewFixtures.scene(),
        map: WatchPreviewFixtures.standInMap(),
        player: WatchPreviewFixtures.player,
        deliveryHint: nil
    )
    .containerBackground(.black, for: .navigation)
}

#Preview("Hole map — still arriving") {
    HoleMapPage(
        scene: WatchPreviewFixtures.scene(),
        map: nil,
        player: WatchPreviewFixtures.player,
        deliveryHint: "Hole maps arriving…\n3 of 18"
    )
    .containerBackground(.black, for: .navigation)
}

#Preview("Numbers face") {
    ShotView(
        scene: WatchPreviewFixtures.scene(),
        stale: false,
        pending: [],
        rejection: nil,
        send: { _ in },
        dismissRejection: {}
    )
    .containerBackground(.black, for: .navigation)
}

#Preview("No round") {
    ContentView(session: WatchSessionManager())
}
#endif
