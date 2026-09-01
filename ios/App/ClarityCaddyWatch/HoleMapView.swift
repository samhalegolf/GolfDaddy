import SwiftUI

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
            let frame = WatchMapFrame(
                imageSize: CGSize(width: reference.imageWidth, height: reference.imageHeight),
                viewSize: proxy.size,
                interest: [playerPoint, greenPoint, targetPoint].compactMap { $0 }
            )
            ZStack(alignment: .topLeading) {
                Image(uiImage: map.image)
                    .resizable()
                    .interpolation(.medium)
                    .frame(width: reference.imageWidth * frame.scale, height: reference.imageHeight * frame.scale)
                    .offset(x: frame.origin.x, y: frame.origin.y)
                Canvas { context, _ in
                    let playerAt = playerPoint.map(frame.place)
                    let greenAt = greenPoint.map(frame.place)
                    let targetAt = targetPoint.map(frame.place)
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
            .frame(width: proxy.size.width, height: proxy.size.height)
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
                HoleMapView(
                    map: map,
                    player: player,
                    green: scene.geometry?.origin,
                    target: scene.target ?? scene.bubble?.centre
                )
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
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
