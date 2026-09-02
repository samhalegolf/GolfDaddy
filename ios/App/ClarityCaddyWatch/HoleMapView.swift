import SwiftUI
import WatchBubbleEngine

/* Draws one delivered lite map and puts the three points that matter on it:
 where the player is, where the green is, and where the shot is aimed.

 The image is already baked tee-up/green-up by the generator, so there is no
 rotation to do here — only a choice of viewport. A watch face is roughly
 180x220pt while a par 5 bakes to 448x1536px, so showing the whole hole would
 make the player a speck. The frame therefore fits the span the player actually
 cares about (themselves, the green, the aim point), never magnifying past a
 sensible ceiling and never zooming out past the whole image.

 Nothing here decides anything about the round. Every point comes from the
 authoritative Scene or the wrist's own fix; a missing point is simply not
 drawn, never guessed. */
struct HoleMapView: View {
    let map: WatchMapStore.LoadedHoleMap
    let player: WatchScene.GeoPoint?
    let green: WatchScene.GeoPoint?
    let target: WatchScene.GeoPoint?

    var body: some View {
        GeometryReader { proxy in
            let reference = map.spatialReference
            let playerPoint = imagePoint(player, reference)
            let greenPoint = imagePoint(green, reference)
            let targetPoint = imagePoint(target, reference)
            let imageSize = CGSize(width: reference.imageWidth, height: reference.imageHeight)
            /* PLAY framing, not a contain-fit. A par 5 bakes to about 1:7.7 and
               this screen is 1:1.2, so containing the whole image drew the hole
               28pt wide with 84% of the width as black bars. WatchMapCamera.play
               fills the screen and shows the part being played — and still fits
               both ends when the shot is short enough for that to mean
               something. */
            let camera = WatchMapCamera.play(
                player: playerPoint, target: targetPoint ?? greenPoint,
                imageSize: imageSize, viewSize: proxy.size)
            let origin = camera.origin(imageSize: imageSize, viewSize: proxy.size)
            ZStack(alignment: .topLeading) {
                Image(uiImage: map.image)
                    .resizable()
                    .interpolation(.medium)
                    .frame(width: reference.imageWidth * camera.scale, height: reference.imageHeight * camera.scale)
                    .offset(x: origin.x, y: origin.y)
                Canvas { context, _ in
                    let place = { (p: CGPoint) in camera.place(p, imageSize: imageSize, viewSize: proxy.size) }
                    let playerAt = playerPoint.map(place)
                    let greenAt = greenPoint.map(place)
                    let targetAt = targetPoint.map(place)
                    if let playerAt, let aim = targetAt ?? greenAt {
                        var line = Path()
                        line.move(to: playerAt)
                        line.addLine(to: aim)
                        context.stroke(line, with: .color(.mint.opacity(0.75)), style: StrokeStyle(lineWidth: 1.5, dash: [3, 3]))
                    }
                    if let greenAt { ring(context, at: greenAt, radius: 6, colour: .mint.opacity(0.9)) }
                    if let targetAt { dot(context, at: targetAt, radius: 4, fill: .mint, edge: .black.opacity(0.7)) }
                    if let playerAt { dot(context, at: playerAt, radius: 4.5, fill: .white, edge: .black.opacity(0.8)) }
                }
            }
            /* topLeading, and it is load-bearing. The Image is now far TALLER
               than the view (a hole is 1352pt at play scale in a ~190pt space),
               so the ZStack sizes to it — and `.frame` centres oversized content
               by default, which shifted the picture ~580pt and drew the empty
               space past the end of the image. The offset above is computed from
               the top-left, so the frame has to anchor there too. */
            .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
            .clipped()
        }
    }

    private func imagePoint(_ point: WatchScene.GeoPoint?, _ reference: WatchMapSpatialReference) -> CGPoint? {
        guard let lat = point?.lat, let lng = point?.lng else { return nil }
        return reference.imagePoint(lat: lat, lng: lng)
    }

    private func ring(_ context: GraphicsContext, at centre: CGPoint, radius: CGFloat, colour: Color) {
        let rect = CGRect(x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2)
        context.stroke(Path(ellipseIn: rect), with: .color(colour), lineWidth: 1.8)
    }

    private func dot(_ context: GraphicsContext, at centre: CGPoint, radius: CGFloat, fill: Color, edge: Color) {
        let rect = CGRect(x: centre.x - radius, y: centre.y - radius, width: radius * 2, height: radius * 2)
        context.fill(Path(ellipseIn: rect), with: .color(fill))
        context.stroke(Path(ellipseIn: rect), with: .color(edge), lineWidth: 1)
    }
}

/* The map page's own chrome: enough context to read the picture without
   swiping back, and an honest empty state while a package is still arriving. */
struct HoleMapPage: View {
    let scene: WatchScene
    let map: WatchMapStore.LoadedHoleMap?
    /* The wrist's own fix when it has one, the phone's otherwise — resolved by
       the session manager, because which fix is trustworthy is a transport
       question and not one a view should be answering. */
    let player: WatchScene.GeoPoint?
    let deliveryHint: String?
    /* The bag and aim, when the wrist holds them AND runs the same engine the
       phone does. Absent means the map is a picture: it still draws the hole,
       the player and the phone's target, and simply cannot be aimed on. */
    var bag: WatchBagSnapshot? = nil
    var profile: WatchBubbleProfile? = nil
    var canAim: Bool = false
    var onAim: (Coordinate) -> Void = { _ in }

    var body: some View {
        VStack(spacing: 2) {
            HStack(spacing: 5) {
                Text(scene.hole?.number.map { "HOLE \($0)" } ?? "HOLE")
                    .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                if let centre = scene.distance?.centre {
                    Text("\(Int(centre.rounded())) m").font(.caption2.monospacedDigit()).foregroundStyle(.mint)
                }
            }
            if let map {
                /* Aimable when the wrist has everything it needs to answer for
                   itself, a plain picture otherwise. Two views rather than one
                   with a disabled mode: an aimable map owns play state and a
                   camera, and a hole nobody can touch should carry neither. */
                if canAim, let bag, let profile {
                    AimableHoleMap(
                        map: map,
                        player: player,
                        green: scene.geometry?.origin,
                        sceneTarget: scene.target ?? scene.bubble?.centre,
                        bag: bag,
                        profile: profile,
                        canAim: true,
                        onAim: onAim
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                } else {
                    HoleMapView(
                        map: map,
                        player: player,
                        green: scene.geometry?.origin,
                        target: scene.target ?? scene.bubble?.centre
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
            } else {
                VStack(spacing: 6) {
                    Image(systemName: "map").font(.title3).foregroundStyle(.secondary)
                    Text(deliveryHint ?? "No hole map yet")
                        .font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(.horizontal, 3)
    }
}
