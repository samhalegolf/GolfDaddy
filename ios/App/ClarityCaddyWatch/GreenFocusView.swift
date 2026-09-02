import SwiftUI
import WatchBubbleEngine

/* Green focus, on the wrist.
 *
 * Inside 40m of the green this replaces the numbers face, because from here
 * everything the shot face is about — a club, a carry, a bubble — has stopped
 * being the question. What is left is two things: how far the middle is, so a
 * chip has a number, and where the ball ended up, so the hole can be closed.
 *
 * The camera frames the whole 40m BAND rather than the green, so the ball can
 * be dragged anywhere it might really be. Framing the green polygon is what
 * the phone used to do and it put a ball short of the green off the screen —
 * on a watch that is not a cosmetic problem, it is a control you cannot reach.
 *
 * Nothing here writes to the round. The ball's position and "hole done" leave
 * as commands, and if the phone is asleep in a bag they sit in the outbox and
 * this face carries on regardless — which is the entire point. */
struct GreenFocusView: View {
    let holeNumber: Int?
    let par: Int?
    let map: WatchMapStore.LoadedHoleMap?
    let green: Coordinate?
    let greenShape: [Coordinate]
    /// Where the shot finished. Follows the fix until the player drags it.
    let ball: Coordinate?
    let ballPlaced: Bool
    let player: Coordinate?
    let onBallMoved: (Coordinate) -> Void
    let onHoleDone: () -> Void
    let onBack: () -> Void

    private var toGreenM: Double? {
        guard let green, let from = ball ?? player else { return nil }
        return WatchHoleFlow.metres(from, green)
    }

    var body: some View {
        VStack(spacing: 3) {
            HStack(spacing: 5) {
                Text(holeNumber.map { "HOLE \($0)" } ?? "HOLE")
                    .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                if let par { Text("PAR \(par)").font(.caption2.weight(.heavy)).foregroundStyle(.tertiary) }
                Spacer()
                Text("ON THE GREEN").font(.system(size: 9, weight: .heavy)).kerning(0.6).foregroundStyle(.mint)
            }
            .padding(.horizontal, 4)

            ZStack(alignment: .topLeading) {
                GreenBandMap(map: map, green: green, greenShape: greenShape,
                             ball: ball, player: player, onBallMoved: onBallMoved)
                /* The number sits ON the green rather than under it: the map is
                   the whole face here, and a strip below would cost the band
                   the room it needs to stay reachable. */
                if let toGreenM {
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text("\(Int(toGreenM.rounded()))")
                            .font(.system(size: 19, weight: .black, design: .rounded)).monospacedDigit()
                        Text("m").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .padding(5)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            .frame(maxHeight: .infinity)

            Text(ballPlaced ? "TO THE MIDDLE" : "DRAG THE BALL TO YOUR SHOT")
                .font(.system(size: 9, weight: .heavy)).kerning(0.5)
                .foregroundStyle(ballPlaced ? Color.secondary : Color.mint)
                .lineLimit(1).minimumScaleFactor(0.7)

            HStack(spacing: 6) {
                Button(action: onBack) {
                    Image(systemName: "chevron.left").font(.caption.weight(.bold))
                }
                .buttonStyle(.bordered).tint(.gray)
                .frame(width: 44)
                .accessibilityLabel("Back to the hole")

                Button("Hole done", action: onHoleDone)
                    .buttonStyle(.borderedProminent).tint(.mint)
                    .font(.callout.weight(.heavy))
            }
        }
        .padding(.horizontal, 3)
    }
}

/* The band itself. Split out because it owns a camera and a drag, and the face
   above owns neither — the same separation AimableHoleMap has from HoleMapPage. */
private struct GreenBandMap: View {
    let map: WatchMapStore.LoadedHoleMap?
    let green: Coordinate?
    let greenShape: [Coordinate]
    let ball: Coordinate?
    let player: Coordinate?
    let onBallMoved: (Coordinate) -> Void

    var body: some View {
        GeometryReader { proxy in
            if let map, let green, let greenPx = map.spatialReference.imagePoint(lat: green.lat, lng: green.lng) {
                let reference = map.spatialReference
                let imageSize = CGSize(width: reference.imageWidth, height: reference.imageHeight)
                /* The band, measured in this bake's own pixels: a point 40m
                   north of the green, projected, and the distance between the
                   two taken on screen. Nothing here converts metres. */
                let radiusPx = Self.radiusPx(reference: reference, green: green, greenPx: greenPx)
                let camera = WatchMapCamera.green(centre: greenPx, radiusPx: radiusPx,
                                                  imageSize: imageSize, viewSize: proxy.size)
                let origin = camera.origin(imageSize: imageSize, viewSize: proxy.size)
                ZStack(alignment: .topLeading) {
                    Image(uiImage: map.image)
                        .resizable().interpolation(.medium)
                        .frame(width: reference.imageWidth * camera.scale, height: reference.imageHeight * camera.scale)
                        .offset(x: origin.x, y: origin.y)
                    Canvas { context, _ in
                        let place = { (p: CGPoint) in camera.place(p, imageSize: imageSize, viewSize: proxy.size) }
                        let project = { (c: Coordinate) -> CGPoint? in
                            reference.imagePoint(lat: c.lat, lng: c.lng).map(place)
                        }
                        /* The band drawn as a ring, so "inside this is the
                           green" is a thing you can see rather than a rule you
                           have to have been told. */
                        let centre = place(greenPx)
                        let bandR = radiusPx * camera.scale
                        context.stroke(Path(ellipseIn: CGRect(x: centre.x - bandR, y: centre.y - bandR,
                                                              width: bandR * 2, height: bandR * 2)),
                                       with: .color(.mint.opacity(0.28)),
                                       style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                        let outline = greenShape.compactMap(project)
                        if outline.count >= 3 {
                            var path = Path()
                            path.move(to: outline[0])
                            outline.dropFirst().forEach { path.addLine(to: $0) }
                            path.closeSubpath()
                            context.stroke(path, with: .color(.mint.opacity(0.9)), lineWidth: 1.6)
                        } else {
                            context.stroke(Path(ellipseIn: CGRect(x: centre.x - 9, y: centre.y - 9, width: 18, height: 18)),
                                           with: .color(.mint.opacity(0.9)), lineWidth: 1.6)
                        }
                        if let playerAt = player.flatMap(project) {
                            context.fill(Path(ellipseIn: CGRect(x: playerAt.x - 3.5, y: playerAt.y - 3.5, width: 7, height: 7)),
                                         with: .color(.white.opacity(0.7)))
                        }
                        if let ballAt = ball.flatMap(project) {
                            context.fill(Path(ellipseIn: CGRect(x: ballAt.x - 7, y: ballAt.y - 7, width: 14, height: 14)),
                                         with: .color(.white))
                            context.stroke(Path(ellipseIn: CGRect(x: ballAt.x - 7, y: ballAt.y - 7, width: 14, height: 14)),
                                           with: .color(.black.opacity(0.75)), lineWidth: 1.2)
                        }
                    }
                }
                .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                .clipped()
                .contentShape(Rectangle())
                /* One gesture, no arming: on this face the only thing to touch
                   is the ball, so a drag anywhere moves it there. A minimum
                   distance of zero means a tap places it too, which is the
                   faster answer for "it finished over there". */
                .gesture(
                    DragGesture(minimumDistance: 0)
                        .onChanged { value in place(value.location, camera: camera, reference: reference, imageSize: imageSize, viewSize: proxy.size) }
                        .onEnded { value in place(value.location, camera: camera, reference: reference, imageSize: imageSize, viewSize: proxy.size) }
                )
            } else {
                VStack(spacing: 4) {
                    Image(systemName: "flag.circle").font(.title3).foregroundStyle(.mint)
                    Text("On the green").font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(white: 0.09))
            }
        }
    }

    private func place(_ point: CGPoint, camera: WatchMapCamera, reference: WatchMapSpatialReference,
                       imageSize: CGSize, viewSize: CGSize) {
        guard let image = camera.imagePoint(fromView: point, imageSize: imageSize, viewSize: viewSize),
              let geo = reference.coordinate(atImageX: image.x, y: image.y) else { return }
        onBallMoved(Coordinate(lat: geo.lat, lng: geo.lng))
    }

    /* Marshal's GREEN_FOCUS_M in this bake's pixels. Projected rather than
       divided by metresPerPixel: the bake may be rotated and the reference is
       the only thing that knows, so the honest measurement is to place a point
       40m away and see where it lands. */
    private static func radiusPx(reference: WatchMapSpatialReference, green: Coordinate, greenPx: CGPoint) -> CGFloat {
        let north = Coordinate(lat: green.lat + WatchHoleFlow.greenFocusM / 111_320, lng: green.lng)
        guard let edge = reference.imagePoint(lat: north.lat, lng: north.lng) else {
            return CGFloat(WatchHoleFlow.greenFocusM / (reference.metresPerPixel ?? 0.5))
        }
        let r = hypot(edge.x - greenPx.x, edge.y - greenPx.y)
        return r.isFinite && r > 0 ? r : CGFloat(WatchHoleFlow.greenFocusM / (reference.metresPerPixel ?? 0.5))
    }
}
