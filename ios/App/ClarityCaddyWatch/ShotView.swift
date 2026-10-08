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
    /* A lock this wrist has made but nothing has confirmed yet. The map page
       is where a locked shot is looked at; here it only decides which club to
       name and that no second LOCK is offered while the first is in flight.
       Cleared by rejection, by the Scene catching up, or by expiry; see
       WatchLockedShot. */
    var lockedShot: WatchLockedShot? = nil
    /* A demo approach is on. Its banner (ContentView's DemoBanner) is the
       live indicator then, so the header's live dot stands down. */
    var demo: Bool = false
    /* Wind, slope and units (WatchConditions): the plays line, the wind
       marker, and the wind folded into the big number. */
    @ObservedObject var conditions: WatchConditions = WatchConditions()
    /* The wind marker opened up big in the middle (tap it; tap to close). */
    @State private var windZoom = false

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
        scene.hole?.number.map { "Hole \($0)" } ?? "Hole"
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

    /* Drawn to Sam's mockup (2026-10-08), the same face as the Garmin's:

              Back            the label at the edge of the glass
              145             back of the green, on a dark-green crescent
             Hole 7           swipe sideways for the next / previous hole
          130y    9i          the target distance and the club
         plays 121            orange: flat + slope (+ wind when folded in)
          [ (+) AIM ]         LOCK, which flips to the map to aim
              121             front of the green, on the lower crescent
             Front

       The wind marker hugs the edge at the point the wind comes from (up is
       the target) - over the crescents and labels, under every value. Tap it
       to read it big; double-tap or long-press it, or the big number, to fold
       the wind into the big number (blue) and the plays number. */
    var body: some View {
        GeometryReader { proxy in
            let w = proxy.size.width, h = proxy.size.height
            let effect = conditions.windEffect(player: playerCoordinate, target: aimCoordinate, flatM: effectiveDistance?.target)
            let plays = conditions.playsLikeM(player: playerCoordinate, target: aimCoordinate, flatM: effectiveDistance?.target, effect: effect)
            let windOn = conditions.windApplied && (effect?.level ?? 0) > 0 && effectiveDistance?.target != nil
            ZStack {
                Canvas { context, size in
                    let crescent = Color(red: 0x0A / 255, green: 0x3F / 255, blue: 0x22 / 255)
                    context.fill(Self.crescent(in: size, up: true), with: .color(crescent))
                    context.fill(Self.crescent(in: size, up: false), with: .color(crescent))
                }
                Text("Back").font(.system(size: h * 0.045, weight: .semibold, design: .rounded))
                    .foregroundStyle(.gray).position(x: w / 2, y: h * 0.055)
                Text("Front").font(.system(size: h * 0.045, weight: .semibold, design: .rounded))
                    .foregroundStyle(.gray).position(x: w / 2, y: h * 0.945)

                if let effect {
                    WindMarker(effect: effect, size: proxy.size, big: false)
                        .onTapGesture(count: 2) { conditions.windApplied.toggle() }
                        .onTapGesture { windZoom = true }
                        .onLongPressGesture(minimumDuration: 0.5) { conditions.windApplied.toggle() }
                }

                Text(WatchConditions.number(effectiveDistance?.back))
                    .font(.system(size: h * 0.075, weight: .heavy, design: .rounded).monospacedDigit())
                    .position(x: w / 2, y: h * 0.135)
                Text(WatchConditions.number(effectiveDistance?.front))
                    .font(.system(size: h * 0.075, weight: .heavy, design: .rounded).monospacedDigit())
                    .position(x: w / 2, y: h * 0.865)

                noticeLine.position(x: w / 2, y: h * 0.205)
                holeBlock.frame(width: w * 0.62).position(x: w / 2, y: h * 0.275)

                distanceRow(windOn: windOn, alongM: effect?.alongM ?? 0, h: h)
                    .frame(width: w * 0.94)
                    .position(x: w / 2, y: h * 0.43)
                if let plays {
                    Text("plays \(WatchConditions.number(plays))")
                        .font(.system(size: h * 0.06, weight: .bold, design: .rounded).monospacedDigit())
                        .foregroundStyle(Self.playsOrange)
                        .position(x: w / 2, y: h * 0.545)
                }
                aimControl(h: h).frame(width: w * 0.5, height: h * 0.15).position(x: w / 2, y: h * 0.68)

                if windZoom, let effect {
                    Color.black.ignoresSafeArea()
                    WindMarker(effect: effect, size: proxy.size, big: true)
                    Text(DistanceSpeed.text(kmh: effect.kmh))
                        .font(.system(size: h * 0.06, weight: .semibold, design: .rounded))
                        .foregroundStyle(.gray).position(x: w / 2, y: h * 0.9)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { if windZoom { windZoom = false } }
        }
        .ignoresSafeArea()
        #if DEBUG
        .onAppear { if CommandLine.arguments.contains("-fixtureZoom") { windZoom = true } }
        #endif
    }

    static let playsOrange = Color(red: 1, green: 0xAA / 255, blue: 0)
    static let windBlue = Color(red: 0x55 / 255, green: 0xAA / 255, blue: 1)

    /* A lens between two half-ellipses sharing their tips, the mockup's
       dark-green crescent. */
    static func crescent(in size: CGSize, up: Bool) -> Path {
        let w = size.width, h = size.height
        let tipY = up ? h * 0.415 : h * 0.585
        let half = w * 0.47
        let outer = up ? h * 0.33 : h * 0.33
        let inner = up ? h * 0.255 : h * 0.255
        let sign: CGFloat = up ? -1 : 1
        var path = Path()
        let steps = 28
        for i in 0...steps {
            let a = CGFloat.pi * CGFloat(i) / CGFloat(steps)
            let p = CGPoint(x: w / 2 - half * cos(a), y: tipY + sign * outer * sin(a))
            if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        for i in stride(from: steps, through: 0, by: -1) {
            let a = CGFloat.pi * CGFloat(i) / CGFloat(steps)
            path.addLine(to: CGPoint(x: w / 2 - half * cos(a), y: tipY + sign * inner * sin(a)))
        }
        path.closeSubpath()
        return path
    }

    /* "130y   9i": the number to the target (blue, with the wind folded in)
       with its unit tucked at the baseline, and the club. */
    private func distanceRow(windOn: Bool, alongM: Double, h: CGFloat) -> some View {
        let target = effectiveDistance?.target
        let shown = (windOn ? target.map { $0 + alongM } : target)
        return HStack(alignment: .firstTextBaseline, spacing: 0) {
            Text(WatchConditions.number(shown))
                .font(.system(size: h * 0.22, weight: .heavy, design: .rounded).width(.condensed).monospacedDigit())
                .foregroundStyle(windOn ? Self.windBlue : .white)
            Text(WatchConditions.suffix)
                .font(.system(size: h * 0.06, weight: .bold, design: .rounded))
                .foregroundStyle(windOn ? Self.windBlue : .white)
            if distanceFromWrist {
                Image(systemName: "location.fill").font(.system(size: h * 0.04)).foregroundStyle(.mint).padding(.leading, 2)
            }
            Spacer(minLength: h * 0.04).frame(maxWidth: h * 0.07)
            Text(shortClub)
                .font(.system(size: h * 0.22, weight: .heavy, design: .rounded).width(.condensed))
        }
        .lineLimit(1)
        .minimumScaleFactor(0.6)
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { conditions.windApplied.toggle() }
        .onLongPressGesture(minimumDuration: 0.5) { conditions.windApplied.toggle() }
    }

    /* The bag's names are short already ("9i", "PW"); the phone's long ones
       ("5 IRON", "DRIVER") are shortened to match. */
    private var shortClub: String {
        guard let club = lockedShot?.club ?? scene.bubble?.club ?? scene.suggestion?.club, !club.isEmpty else { return "—" }
        let upper = club.uppercased()
        if upper.contains("DRIVER") { return "Dr" }
        if upper.hasSuffix(" IRON") { return upper.replacingOccurrences(of: " IRON", with: "") + "i" }
        if upper.hasSuffix(" WOOD") { return upper.replacingOccurrences(of: " WOOD", with: "") + "W" }
        if upper.hasSuffix(" HYBRID") { return upper.replacingOccurrences(of: " HYBRID", with: "") + "H" }
        return club
    }

    private var playerCoordinate: Coordinate? {
        let p = wristFix ?? scene.location?.coordinate
        guard let lat = p?.lat, let lng = p?.lng else { return nil }
        return Coordinate(lat: lat, lng: lng)
    }

    /* What the big number measures to: the lock in flight, the Scene's
       target or Bubble, else the green. */
    private var aimCoordinate: Coordinate? {
        if let t = lockedShot?.target { return Coordinate(lat: t.lat, lng: t.lng) }
        let p = scene.target ?? scene.bubble?.centre ?? scene.geometry?.origin
        guard let lat = p?.lat, let lng = p?.lng else { return nil }
        return Coordinate(lat: lat, lng: lng)
    }

    @ViewBuilder
    private var noticeLine: some View {
        if let rejectionText {
            Text(rejectionText).font(.caption2.weight(.semibold)).foregroundStyle(.red)
                .task(id: rejection?.commandId) {
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    dismissRejection()
                }
        } else if let handoverNotice {
            Label(handoverNotice, systemImage: "checkmark.circle.fill")
                .font(.caption2.weight(.bold)).foregroundStyle(.mint)
                .task(id: handoverNotice) {
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    dismissHandoverNotice()
                }
        } else if stale {
            Image(systemName: "antenna.radiowaves.left.and.right.slash").font(.caption2).foregroundStyle(.secondary)
        }
    }

    /* The mockup's AIM pill. AIM is LOCK here - the lock is what flips to the
       map, where the Bubble is aimed - so it carries LOCK's Double Tap and its
       in-flight state; once locked it is UNLOCK. */
    @ViewBuilder
    private func aimControl(h: CGFloat) -> some View {
        if lockedShot != nil {
            Text("SENDING").font(.caption2.weight(.heavy)).foregroundStyle(.secondary).kerning(0.6)
        } else if scene.controls?.canLock == true {
            let waiting = pending.contains { $0.command.type == .lock || $0.command.type == .lockAt }
            aimPill(title: waiting ? "…" : "AIM", h: h, enabled: !waiting) { send(.lock) }
        } else if scene.controls?.canUnlock == true {
            control(.unlock, title: "UNLOCK", enabled: true, primary: false)
        }
    }

    @ViewBuilder
    private func aimPill(title: String, h: CGFloat, enabled: Bool, action: @escaping () -> Void) -> some View {
        let pill = Button(action: action) {
            GeometryReader { g in
                let r = g.size.height / 2
                ZStack {
                    Capsule().fill(Color(red: 0, green: 0xBF / 255, blue: 0x63 / 255))
                    Capsule().stroke(Color(red: 0x1F / 255, green: 0x2A / 255, blue: 0x1F / 255), lineWidth: 2)
                    Canvas { context, size in
                        let c = CGPoint(x: r, y: size.height / 2)
                        let ring = size.height * 0.36
                        let ink = Color(red: 0x23 / 255, green: 0x1F / 255, blue: 0x20 / 255)
                        for q in 0..<4 {
                            var arc = Path()
                            arc.addArc(center: c, radius: ring, startAngle: .degrees(Double(q) * 90 + 6),
                                       endAngle: .degrees(Double(q) * 90 + 84), clockwise: false)
                            context.stroke(arc, with: .color(ink), lineWidth: 1.5)
                        }
                        var cross = Path()
                        cross.move(to: CGPoint(x: c.x, y: -size.height * 0.08)); cross.addLine(to: CGPoint(x: c.x, y: c.y - 2))
                        cross.move(to: CGPoint(x: c.x, y: c.y + 2)); cross.addLine(to: CGPoint(x: c.x, y: size.height * 1.08))
                        cross.move(to: CGPoint(x: 0, y: c.y)); cross.addLine(to: CGPoint(x: c.x - 2, y: c.y))
                        cross.move(to: CGPoint(x: c.x + 2, y: c.y)); cross.addLine(to: CGPoint(x: c.x + size.height * 0.58, y: c.y))
                        context.stroke(cross, with: .color(ink), lineWidth: 1.5)
                        context.fill(Path(ellipseIn: CGRect(x: c.x - 2, y: c.y - 2, width: 4, height: 4)), with: .color(ink))
                    }
                    Text(title)
                        .font(.system(size: g.size.height * 0.55, weight: .heavy, design: .rounded))
                        .foregroundStyle(.black)
                        .padding(.leading, g.size.height * 0.95)
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        if #available(watchOS 11.0, *) { pill.handGestureShortcut(.primaryAction) } else { pill }
    }

    /* The hole, as one block: tap an arrowed edge or swipe it sideways.
       The swipe is claimed by the block (highPriorityGesture), so swiping
       anywhere else still pages to the map. Swiping left reads as "next",
       the way a card stack moves. */
    private var holeBlock: some View {
        let canPrev = scene.controls?.canPreviousHole == true
        let canNext = scene.controls?.canNextHole == true
        let busy = pending.contains { $0.command.type == .previousHole || $0.command.type == .nextHole }
        return HStack(spacing: 0) {
            edge("chevron.left", enabled: canPrev && !busy) { send(.previousHole) }
            HStack(spacing: 4) {
                Text(holeText)
                    .font(.system(size: 19, weight: .heavy, design: .rounded))
                    .lineLimit(1).minimumScaleFactor(0.7)
                /* The wrist is driving: a live dot, not a sentence. */
                if driving && !demo {
                    Circle().fill(Color.mint).frame(width: 6, height: 6)
                        .shadow(color: .mint.opacity(0.8), radius: 4)
                        .accessibilityLabel("Watch is driving")
                }
            }
            .frame(maxWidth: .infinity)
            edge("chevron.right", enabled: canNext && !busy) { send(.nextHole) }
        }
        .frame(height: 28)
        .contentShape(Rectangle())
        .highPriorityGesture(
            DragGesture(minimumDistance: 12).onEnded { value in
                guard !busy, abs(value.translation.width) > abs(value.translation.height) else { return }
                if value.translation.width < 0, canNext { send(.nextHole) }
                else if value.translation.width > 0, canPrev { send(.previousHole) }
            }
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(holeText)
        .accessibilityAdjustableAction { direction in
            if direction == .increment, canNext { send(.nextHole) }
            if direction == .decrement, canPrev { send(.previousHole) }
        }
    }

    private func edge(_ symbol: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 11, weight: .heavy))
                .foregroundStyle(enabled ? Color.white.opacity(0.6) : Color.clear)
                .frame(width: 26, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }

    @ViewBuilder
    private func control(_ kind: CaddyWatchCommand.Kind, title: String, enabled: Bool, primary: Bool = false) -> some View {
        let waiting = pending.contains { $0.command.type == kind || (kind == .lock && $0.command.type == .lockAt) }
        if primary {
            /* LOCK claims Double Tap while there is nothing locked; the map
               page's UNLOCK claims it once there is. The two can never be on
               screen together — the dock has one face at a time — so this is
               one gesture with one meaning at any moment: do the thing to the
               shot. Declared rather than left to the system's prominence
               heuristic so both halves of the pair are decided in the code. */
            primaryButton(title: waiting ? "\(title)…" : title, enabled: enabled && !waiting) { send(kind) }
        } else {
            Button(waiting ? "\(title)…" : title) { send(kind) }
                .buttonStyle(.bordered).tint(.gray)
                .font(.caption2.weight(.bold)).disabled(!enabled || waiting)
        }
    }

    @ViewBuilder
    private func primaryButton(title: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        let button = Button(title, action: action)
            .buttonStyle(.borderedProminent).tint(.mint)
            .font(.caption.weight(.bold)).disabled(!enabled)
        if #available(watchOS 11.0, *) {
            button.handGestureShortcut(.primaryAction)
        } else {
            button
        }
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

/* The wind on the numbers face: a distance hub hard against the edge of the
   glass at the point the wind comes FROM (up is the target), with a pointed
   bump on its rim aimed at the middle - the way the wind blows. The number is
   how far it moves the shot along the line, in the watch's unit, with the
   unit a tiny tag; where the hub sits already says with or against. Calm: the
   hub alone at 4 o'clock. `big` is the opened-up view: centred, its bump
   pointing the way the wind blows. Same marker as the Garmin's. */
struct WindMarker: View {
    let effect: WatchConditions.Effect
    let size: CGSize
    let big: Bool

    var body: some View {
        let hubR = big ? size.height * 0.2 : size.height * 0.058
        let centre = big ? CGPoint(x: size.width / 2, y: size.height * 0.46) : edgeCentre(hubR: hubR)
        let towards: CGFloat = big ? CGFloat(effect.relRad)
            : atan2(size.width / 2 - centre.x, -(size.height / 2 - centre.y))
        ZStack {
            Canvas { context, _ in
                if effect.level > 0 {
                    let ux = sin(towards), uy = -cos(towards)
                    let tip = hubR * (big ? 1.6 : 1.65)
                    let spread = CGFloat.pi * 40 / 180
                    func rim(_ a: CGFloat) -> CGPoint {
                        let rx = ux * cos(a) - uy * sin(a), ry = ux * sin(a) + uy * cos(a)
                        return CGPoint(x: centre.x + rx * hubR, y: centre.y + ry * hubR)
                    }
                    var bump = Path()
                    bump.addLines([CGPoint(x: centre.x + ux * tip, y: centre.y + uy * tip), rim(spread), rim(-spread)])
                    bump.closeSubpath()
                    context.fill(bump, with: .color(ShotView.windBlue))
                }
                let disc = Path(ellipseIn: CGRect(x: centre.x - hubR, y: centre.y - hubR, width: hubR * 2, height: hubR * 2))
                context.fill(disc, with: .color(Color(white: 0.1)))
                context.stroke(disc, with: .color(ShotView.windBlue), lineWidth: big ? 3 : 1.2)
            }
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text("\(WatchConditions.value(abs(effect.alongM)))")
                    .font(.system(size: hubR * 1.05, weight: .heavy, design: .rounded).monospacedDigit())
                    .foregroundStyle(.white)
                Text(WatchConditions.suffix)
                    .font(.system(size: hubR * 0.36, weight: .semibold, design: .rounded))
                    .foregroundStyle(.gray)
            }
            .minimumScaleFactor(0.5)
            .lineLimit(1)
            .frame(width: hubR * 1.8)
            .position(centre)
        }
        .frame(width: size.width, height: size.height)
        .contentShape(Circle().path(in: CGRect(x: centre.x - hubR * 1.6, y: centre.y - hubR * 1.6, width: hubR * 3.2, height: hubR * 3.2)))
    }

    /* Against the edge along the ray at the wind's origin: the glass is a
       rounded rectangle, so the hub is pulled in more towards the corners. */
    private func edgeCentre(hubR: CGFloat) -> CGPoint {
        let phi = effect.level > 0 ? CGFloat(effect.relRad) + .pi : .pi * 120 / 180
        let sx = sin(phi), sy = -cos(phi)
        let cx = size.width / 2, cy = size.height / 2
        let corner = min(size.width, size.height) * 0.2 * abs(sin(2 * phi))
        let inset = hubR + 3 + corner
        let tx = abs(sx) > 0.001 ? (cx - inset) / abs(sx) : .greatestFiniteMagnitude
        let ty = abs(sy) > 0.001 ? (cy - inset) / abs(sy) : .greatestFiniteMagnitude
        let reach = min(tx, ty)
        return CGPoint(x: cx + sx * reach, y: cy + sy * reach)
    }
}

/* The wind's strength under the opened-up marker: mph for a yards watch,
   km/h for a metres one. */
enum DistanceSpeed {
    static func text(kmh: Double) -> String {
        WatchConditions.yards ? "\(Int((kmh / 1.609344).rounded())) mph" : "\(Int(kmh.rounded())) km/h"
    }
}
