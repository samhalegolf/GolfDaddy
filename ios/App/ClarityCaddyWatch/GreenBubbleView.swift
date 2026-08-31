import SwiftUI

struct GreenBubbleView: View {
    let scene: WatchScene

    var body: some View {
        VStack(spacing: 2) {
            GeometryReader { proxy in
                GreenCanvas(geometry: scene.geometry, bubble: scene.bubble)
                    .frame(width: proxy.size.width, height: proxy.size.height)
            }
            .frame(height: 112)
            HStack(spacing: 5) {
                if let club = scene.bubble?.club ?? scene.suggestion?.club { Text(club).font(.caption.weight(.bold)).foregroundStyle(.mint) }
                if let distance = scene.distance?.target { Text("\(Int(distance.rounded())) m").font(.caption.monospacedDigit()) }
            }
        }
    }
}

private struct GreenCanvas: View {
    let geometry: WatchScene.Geometry?
    let bubble: WatchScene.Bubble?

    var body: some View {
        Canvas { context, size in
            let polygon = (geometry?.greenPolygon ?? []).compactMap { point($0) }
            let target = geometry?.target.flatMap(point)
            let bubbleWidth = bubble?.widthM
            let bubbleDepth = bubble?.depthM
            let all = polygon + (target.map { [$0] } ?? [])
            let scale = fittedScale(all, size: size, bubbleWidth: bubbleWidth, bubbleDepth: bubbleDepth)
            let centre = CGPoint(x: size.width / 2, y: size.height / 2)
            func canvas(_ p: CGPoint) -> CGPoint { CGPoint(x: centre.x + p.x * scale, y: centre.y - p.y * scale) }
            if polygon.count >= 3 {
                var path = Path(); path.move(to: canvas(polygon[0])); polygon.dropFirst().forEach { path.addLine(to: canvas($0)) }; path.closeSubpath()
                context.fill(path, with: .color(Color.green.opacity(0.28)))
                context.stroke(path, with: .color(.mint), lineWidth: 1.5)
            }
            if let target, let width = bubbleWidth, let depth = bubbleDepth {
                let rect = CGRect(x: -width * scale / 2, y: -depth * scale / 2, width: width * scale, height: depth * scale)
                var bubblePath = Path(roundedRect: rect, cornerRadius: min(width, depth) * scale * 0.26)
                let tilt = Angle.degrees(bubble?.tiltDeg ?? 0)
                let transform = CGAffineTransform(translationX: canvas(target).x, y: canvas(target).y).rotated(by: CGFloat(tilt.radians))
                bubblePath = bubblePath.applying(transform)
                context.fill(bubblePath, with: .color(Color.mint.opacity(0.26)))
                context.stroke(bubblePath, with: .color(.mint), lineWidth: 1.5)
            }
        }
    }

    private func point(_ value: WatchScene.LocalPoint) -> CGPoint? {
        guard let x = value.x, let y = value.y, x.isFinite, y.isFinite else { return nil }
        return CGPoint(x: x, y: y)
    }
    private func fittedScale(_ points: [CGPoint], size: CGSize, bubbleWidth: Double?, bubbleDepth: Double?) -> CGFloat {
        let xs = points.map(\.x), ys = points.map(\.y)
        let width = max((xs.max() ?? 0) - (xs.min() ?? 0), CGFloat(bubbleWidth ?? 0), 12)
        let height = max((ys.max() ?? 0) - (ys.min() ?? 0), CGFloat(bubbleDepth ?? 0), 12)
        return min((size.width - 16) / width, (size.height - 16) / height)
    }
}
