import SwiftUI

struct ShotView: View {
    let scene: WatchScene
    let stale: Bool

    private var holeText: String {
        let number = scene.hole?.number.map { "HOLE \($0)" } ?? "HOLE"
        return scene.hole?.par.map { "\(number) · PAR \($0)" } ?? number
    }

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                Text(holeText).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                if stale { Image(systemName: "antenna.radiowaves.left.and.right.slash").font(.caption2).foregroundStyle(.secondary) }
            }
            if scene.isBubble {
                GreenBubbleView(scene: scene)
            } else {
                Text(distanceText).font(.system(size: 39, weight: .bold, design: .rounded)).monospacedDigit().minimumScaleFactor(0.7)
                if let club = scene.suggestion?.club, !club.isEmpty { Text(club).font(.title3.weight(.semibold)).foregroundStyle(.mint) }
                DistanceDetail(distance: scene.distance)
            }
        }
        .padding(.horizontal, 5)
    }

    private var distanceText: String { scene.distance?.target.map { "\(Int($0.rounded())) m" } ?? "—" }
}

private struct DistanceDetail: View {
    let distance: WatchScene.Distance?
    var body: some View {
        HStack(spacing: 7) {
            if let front = distance?.front { Text("F \(Int(front.rounded()))") }
            if let centre = distance?.centre { Text("C \(Int(centre.rounded()))") }
            if let back = distance?.back { Text("B \(Int(back.rounded()))") }
        }
        .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
    }
}
