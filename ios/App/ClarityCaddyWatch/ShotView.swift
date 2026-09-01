import SwiftUI

struct ShotView: View {
    let scene: WatchScene
    let stale: Bool
    let pending: [PendingWatchCommand]
    let rejection: WatchCommandAcknowledgement?
    let send: (CaddyWatchCommand.Kind) -> Void
    let dismissRejection: () -> Void
    var driving: Bool = false
    var handoverNotice: String? = nil
    var dismissHandoverNotice: () -> Void = {}

    private var holeText: String {
        let number = scene.hole?.number.map { "HOLE \($0)" } ?? "HOLE"
        return scene.hole?.par.map { "\(number) · PAR \($0)" } ?? number
    }

    private var rejectionText: String? {
        guard let rejection else { return nil }
        switch rejection.reason {
        case "marshal-rejected": return "Not yet — start your round first"
        case "future-revision": return "Out of sync — try again"
        case "invalid-location": return "No GPS fix"
        default: return "Couldn't do that"
        }
    }

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                if scene.controls?.canPreviousHole == true { control(.previousHole, title: "‹", enabled: true) }
                Text(holeText).font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                if scene.controls?.canNextHole == true { control(.nextHole, title: "›", enabled: true) }
                if stale { Image(systemName: "antenna.radiowaves.left.and.right.slash").font(.caption2).foregroundStyle(.secondary) }
            }
            if let rejectionText {
                Text(rejectionText).font(.caption2.weight(.semibold)).foregroundStyle(.red)
                    .task(id: rejection?.commandId) {
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                        dismissRejection()
                    }
            } else if let handoverNotice {
                /* The moment of handover, said out loud, then the strip below
                   takes over as the standing answer. */
                Label(handoverNotice, systemImage: "checkmark.circle.fill")
                    .font(.caption2.weight(.bold)).foregroundStyle(.mint)
                    .task(id: handoverNotice) {
                        try? await Task.sleep(nanoseconds: 2_500_000_000)
                        dismissHandoverNotice()
                    }
            } else if !scene.isBubble {
                /* The Bubble page is already the full height of a 42mm face;
                   a standing strip there pushes UNLOCK off the bottom. The
                   driver is one Unlock away on the numbers face, and a
                   change of driver still announces itself above. */
                surfaceStrip
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

    /* Who is driving, as a standing line rather than a glyph you have to know
       about: "iPhone driving · take over" while the phone has it, "Watch
       driving" once this wrist does. Tapping it is the wrist-initiated
       handover in either direction; the phone answers through the Scene, so
       the line only changes when the phone agrees it has. */
    @ViewBuilder
    private var surfaceStrip: some View {
        let waiting = pending.contains { $0.command.type == .takeOver || $0.command.type == .handBack }
        Button {
            send(driving ? .handBack : .takeOver)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: driving ? "applewatch" : "iphone")
                Text(waiting ? "Switching…" : (driving ? "Watch driving" : "iPhone driving · take over"))
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(driving ? Color.mint : Color.secondary)
            .lineLimit(1).minimumScaleFactor(0.8)
        }
        .buttonStyle(.plain)
        .disabled(waiting)
        .accessibilityLabel(driving ? "Watch is driving. Hand back to iPhone" : "iPhone is driving. Take over on Watch")
    }

    @ViewBuilder
    private func control(_ kind: CaddyWatchCommand.Kind, title: String, enabled: Bool, primary: Bool = false) -> some View {
        let waiting = pending.contains { $0.command.type == kind || (kind == .lock && $0.command.type == .lockAt) }
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
