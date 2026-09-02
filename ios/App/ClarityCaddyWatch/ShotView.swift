import SwiftUI
import WatchBubbleEngine

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
    /* The wrist's own fix, when it has a trustworthy one. */
    var wristFix: WatchScene.GeoPoint? = nil
    /* A lock this wrist has made but nothing has confirmed yet. Presented as
       locked, because that is what the player just did — with the club and
       distance the wrist computed, not the phone's, since the phone has not
       answered. Cleared by rejection, by the Scene catching up, or by expiry;
       see WatchLockedShot. */
    var lockedShot: WatchLockedShot? = nil

    /* Which numbers to show. The Watch is its own rangefinder once it is
       driving: front/centre/back come from ITS fix against the green geometry
       the Scene already carries, so a phone in the bag showing Preview (or
       nothing) does not blank the wrist. While the phone drives, its numbers
       lead - they may be a deliberate "if I stood here" placement - and the
       wrist's own fix only fills the gap when the phone offers none. */
    private var effectiveDistance: WatchScene.Distance? {
        let wrist = WristDistances.compute(fix: wristFix, geometry: scene.geometry)
        let phone = scene.distance?.target == nil ? nil : scene.distance
        return driving ? (wrist ?? phone) : (phone ?? wrist)
    }
    private var distanceFromWrist: Bool {
        let wrist = WristDistances.compute(fix: wristFix, geometry: scene.geometry)
        let phoneHas = scene.distance?.target != nil
        return wrist != nil && (driving || !phoneHas)
    }

    private var holeText: String {
        let number = scene.hole?.number.map { "HOLE \($0)" } ?? "HOLE"
        return scene.hole?.par.map { "\(number) · PAR \($0)" } ?? number
    }

    private var rejectionText: String? {
        guard let rejection else { return nil }
        switch rejection.reason {
        /* `marshal-rejected` is a catch-all: Marshal declined and did not say
           why. The old wording guessed — "start your round first" — and guessed
           wrong the moment the round WAS running, which is most of the time a
           player sees this: the usual cause is pressing LOCK while looking at a
           hole they are not playing. So say what the wrist actually knows
           (hole.live tells it), and otherwise decline to invent a reason. */
        case "marshal-rejected":
            return scene.hole?.live == false ? "Not on this hole" : "Can't do that yet"
        case "future-revision": return "Out of sync — try again"
        case "invalid-location": return "No GPS fix"
        case "no-live-round": return "Play on iPhone first"
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
                /* The wrist is driving: a live dot, not a sentence. Taking the
                   round back is done from the phone's card. */
                if driving {
                    Circle().fill(Color.mint).frame(width: 6, height: 6)
                        .shadow(color: .mint.opacity(0.8), radius: 4)
                        .accessibilityLabel("Watch is driving")
                }
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
            }
            if let lockedShot {
                LockedShotFace(shot: lockedShot)
            } else if scene.isBubble {
                GreenBubbleView(scene: scene)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    Text(distanceText).font(.system(size: 39, weight: .bold, design: .rounded)).monospacedDigit().minimumScaleFactor(0.7)
                    /* Says, quietly, that this number is the wrist's own. */
                    if distanceFromWrist { Image(systemName: "location.fill").font(.caption2).foregroundStyle(.mint) }
                }
                if let club = scene.suggestion?.club, !club.isEmpty { Text(club).font(.title3.weight(.semibold)).foregroundStyle(.mint) }
                DistanceDetail(distance: effectiveDistance)
            }
            if lockedShot != nil {
                /* No control while the lock is unconfirmed. UNLOCK would be a
                   command against a shot the phone may not have accepted, and
                   LOCK would invite a second one. The wait is short and it is
                   honest to simply show it. */
                Text("SENDING")
                    .font(.caption2.weight(.heavy)).foregroundStyle(.secondary).kerning(0.6)
            } else if scene.controls?.canLock == true {
                control(.lock, title: "LOCK", enabled: true, primary: true)
            } else if scene.controls?.canUnlock == true {
                control(.unlock, title: "UNLOCK", enabled: true, primary: false)
            }
        }
        .padding(.horizontal, 5)
    }

    private var distanceText: String { effectiveDistance?.target.map { "\(Int($0.rounded())) m" } ?? "—" }

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

/* The shot as the wrist locked it: the club it chose and the distance it
   measured, from its own engine. Deliberately not the Scene's numbers — the
   Scene has not caught up yet, and showing its stale values under a "locked"
   heading would be the one genuinely misleading thing this face could do. */
private struct LockedShotFace: View {
    let shot: WatchLockedShot

    var body: some View {
        VStack(spacing: 2) {
            Label("LOCKED", systemImage: "checkmark.circle.fill")
                .font(.caption2.weight(.heavy)).foregroundStyle(.mint).kerning(0.6)
            Text("\(Int(shot.targetDistanceM.rounded())) m")
                .font(.system(size: 34, weight: .bold, design: .rounded)).monospacedDigit()
                .minimumScaleFactor(0.7)
            Text(shot.club).font(.title3.weight(.semibold)).foregroundStyle(.mint)
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

/* Front / centre / back from the wrist's own fix.

   The Scene's geometry is the green polygon in local metres around the green
   centre, rotated so the phone's approach bearing points up (caddy-watch.js
   localPoint). The wrist fix is put into that SAME frame with the same
   equirectangular projection and rotation, so nothing here disagrees with the
   phone by a rotation. Front and back are the polygon's nearest and farthest
   extent along the line from the player to the centre - the same question
   the phone's greenDistances answers - and centre is the straight distance.
   No polygon means no front/back, never an invented one. */
enum WristDistances {
    static func compute(fix: WatchScene.GeoPoint?, geometry: WatchScene.Geometry?) -> WatchScene.Distance? {
        guard let fix, let lat = fix.lat, let lng = fix.lng,
              let origin = geometry?.origin, let olat = origin.lat, let olng = origin.lng else { return nil }
        let bearing = (geometry?.approachBearingDeg ?? 0) * .pi / 180
        let north = (lat - olat) * 111320
        let east = (lng - olng) * 111320 * cos(olat * .pi / 180)
        let px = east * cos(bearing) - north * sin(bearing)
        let py = north * cos(bearing) + east * sin(bearing)
        let centre = (px * px + py * py).squareRoot()
        guard centre.isFinite, centre > 0.5 else { return WatchScene.Distance(target: 0, front: nil, centre: 0, back: nil) }
        /* Unit vector from the player towards the green centre (the origin). */
        let dx = -px / centre, dy = -py / centre
        var front: Double? = nil, back: Double? = nil
        for vertex in geometry?.greenPolygon ?? [] {
            guard let vx = vertex.x, let vy = vertex.y else { continue }
            let along = (vx - px) * dx + (vy - py) * dy
            front = min(front ?? along, along)
            back = max(back ?? along, along)
        }
        if let f = front, f < 0 { front = 0 }
        return WatchScene.Distance(target: centre, front: front, centre: centre, back: back)
    }
}
