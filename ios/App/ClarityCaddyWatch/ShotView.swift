import SwiftUI

struct ShotView: View {
    let scene: WatchScene
    let stale: Bool
    let pending: [PendingWatchCommand]
    let send: (CaddyWatchCommand.Kind) -> Void

    private var holeText: String {
        let number = scene.hole?.number.map { "HOLE \($0)" } ?? "HOLE"
        return scene.hole?.par.map { "\(number) · PAR \($0)" } ?? number
    }

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                if scene.controls?.canPreviousHole == true { control(.previousHole, title: "‹", enabled: true) }
                Text(holeText).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                if scene.controls?.canNextHole == true { control(.nextHole, title: "›", enabled: true) }
                if stale { Image(systemName: "antenna.radiowaves.left.and.right.slash").font(.caption2).foregroundStyle(.secondary) }
            }
            if scene.isBubble {
                GreenBubbleView(scene: scene)
            } else {
                Text(distanceText).font(.system(size: 39, weight: .bold, design: .rounded)).monospacedDigit().minimumScaleFactor(0.7)
                if let club = scene.suggestion?.club, !club.isEmpty { Text(club).font(.title3.weight(.semibold)).foregroundStyle(.mint) }
                DistanceDetail(distance: scene.distance)
            }
            if scene.controls?.canLock == true {
                control(.lock, title: "LOCK", enabled: true, primary: true)
            } else if scene.controls?.canUnlock == true {
                control(.unlock, title: "UNLOCK", enabled: true, primary: false)
            }
        }
        .padding(.horizontal, 5)
    }

    private var distanceText: String { scene.distance?.target.map { "\(Int($0.rounded())) m" } ?? "—" }

    @ViewBuilder
    private func control(_ kind: CaddyWatchCommand.Kind, title: String, enabled: Bool, primary: Bool = false) -> some View {
        let waiting = pending.contains { $0.command.type == kind }
        if primary {
            Button(waiting ? "\(title)…" : title) { send(kind) }
                .buttonStyle(.borderedProminent).tint(.mint)
                .font(.caption.weight(.bold)).disabled(!enabled || waiting)
        } else {
            Button(waiting ? "\(title)…" : title) { send(kind) }
                .buttonStyle(.bordered).tint(.gray)
                .font(.caption2.weight(.bold)).disabled(!enabled || waiting)
        }
    }
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
