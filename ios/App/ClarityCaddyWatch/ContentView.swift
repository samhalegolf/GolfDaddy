import SwiftUI
import WatchBubbleEngine

struct ContentView: View {
    @ObservedObject var session: WatchSessionManager
    @ObservedObject private var maps: WatchMapStore

    /* The two pages of the driving face. LOCK flips to the map by itself —
       the shot has just become a thing to look at — and swiping back to the
       numbers IS the unlock. The map is never entered by a swipe the code
       cares about and never left by anything but the player, so a change to
       `.numbers` while the shot is locked can only be that swipe. */
    private enum Page: Hashable { case numbers, map }
    @State private var page: Page = .numbers

    /* The store publishes on its own schedule (a file lands, a manifest is
       adopted), so the view observes it alongside the session rather than
       waiting for the next Scene revision to notice. */
    init(session: WatchSessionManager) {
        _session = ObservedObject(wrappedValue: session)
        _maps = ObservedObject(wrappedValue: session.maps)
    }

    var body: some View {
        Group {
            switch session.face {
            case .noRound:
                NoRoundFace()
            case .receiving:
                ReceivingFace(courseName: session.scene?.course?.name, held: session.mapsHeld, expected: session.mapsExpected)
            case .ready:
                /* Off the course Play here can only be refused, so the Ready
                   face becomes the demo browser: every hole, each with a Demo
                   that starts it 100-130m short of the green on this wrist. */
                if let scene = session.scene, scene.controls?.canDemo == true {
                    DemoBrowserFace(
                        scene: scene,
                        holes: session.demoHoles,
                        map: { maps.hole($0, courseKey: scene.course?.key) },
                        length: session.demoHoleLength,
                        par: { scene.course?.par($0) },
                        approach: session.demoApproach,
                        demo: session.startDemo(hole:),
                        notice: session.lastRejection.map { _ in "Couldn't start demo" }
                    )
                    .task(id: session.lastRejection?.commandId) {
                        guard session.lastRejection != nil else { return }
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                        session.dismissRejection()
                    }
                } else if let scene = session.scene {
                    ReadyFace(
                        scene: scene,
                        map: scene.hole?.number.flatMap { maps.hole($0, courseKey: scene.course?.key) },
                        player: session.playerPoint,
                        wristDistance: WristDistances.compute(fix: session.wristFix, geometry: scene.geometry)?.centre,
                        play: { session.send(.takeOver) },
                        notice: session.lastRejection.map { $0.reason == "play-unavailable" ? "Can't start here yet" : "Couldn't do that" }
                    )
                    .task(id: session.lastRejection?.commandId) {
                        guard session.lastRejection != nil else { return }
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                        session.dismissRejection()
                    }
                }
            case .taking:
                TakingFace()
            case .playing:
                if let scene = session.scene {
                    /* Three of the wrist's own screens sit IN FRONT of the
                       driving pages, because each is the whole answer while it
                       is up: on the green there is no club to choose, on the
                       holding screen there is no hole to look at, and on the
                       queued hole there is nothing to measure from. They are
                       decided locally (WatchHoleFlow) so they keep working with
                       the phone asleep in a bag. */
                    switch session.holeFlow.face {
                    case .greenFocus:
                        GreenFocusView(
                            holeNumber: session.holeFlow.hole ?? scene.hole?.number,
                            par: (session.holeFlow.hole ?? scene.hole?.number).flatMap { session.scene?.course?.par($0) } ?? scene.hole?.par,
                            map: (session.holeFlow.hole ?? scene.hole?.number).flatMap { maps.hole($0, courseKey: scene.course?.key) },
                            green: session.flowHole(session.holeFlow.hole ?? scene.hole?.number)?.green,
                            greenShape: session.flowGreenShape(session.holeFlow.hole ?? scene.hole?.number),
                            ball: session.holeFlow.ball,
                            ballPlaced: session.holeFlow.ballPlaced,
                            player: session.playerPoint.flatMap { p in
                                guard let lat = p.lat, let lng = p.lng else { return nil }
                                return Coordinate(lat: lat, lng: lng)
                            },
                            onBallMoved: { session.flowMoveBall(to: $0) },
                            onHoleDone: session.flowHoleDone,
                            onBack: session.flowBack)
                    case .holeComplete:
                        HoleCompleteView(
                            holeNumber: session.holeFlow.hole,
                            par: session.holeFlow.hole.flatMap { session.scene?.course?.par($0) },
                            score: session.holeFlow.score,
                            nextHole: session.flowNextHole,
                            onStep: { session.flowStepScore($0) },
                            onNext: session.flowNext,
                            onBack: session.flowBack)
                    case .queued:
                        QueuedHoleView(
                            holeNumber: session.holeFlow.hole,
                            par: session.holeFlow.hole.flatMap { session.scene?.course?.par($0) },
                            lengthM: session.queuedLengthM,
                            toTeeM: session.queuedToTeeM,
                            atTee: session.queuedAtTee,
                            map: session.holeFlow.hole.flatMap { maps.hole($0, courseKey: scene.course?.key) },
                            green: session.flowHole(session.holeFlow.hole).flatMap { hole in
                                hole.green.map { WatchScene.GeoPoint(lat: $0.lat, lng: $0.lng) }
                            },
                            onPlay: session.flowPlay)
                    case .playing:
                        drivingPages(scene: scene)
                    }
                }
            }
        }
        .containerBackground(.black, for: .navigation)
        /* The driving pages always open on the numbers. `page` outlives them,
           so a round (or a demo) that ended on the map page used to bring the
           next one up on the map, unlocked, with nothing to look at. */
        .onChange(of: session.face) { _, face in
            if face != .playing { page = .numbers }
        }
    }

    /* The driving face proper: the numbers, and the lite map beside them. */
    @ViewBuilder
    private func drivingPages(scene: WatchScene) -> some View {
        Group {
            /* The numbers face stays page one and keeps LOCK a single
               tap away. The lite map is a second page rather than a
               replacement or a background: it is a picture of a hole,
               and it earns the whole screen when it is the thing being
               looked at. */
            let locked = session.shotIsLocked
            TabView(selection: $page) {
                ShotView(scene: scene, stale: session.state == .stale, pending: session.pendingCommands, rejection: session.lastRejection,
                         send: { kind in
                             /* UNLOCK has one door — session.unlock() — because
                                letting the shot go also clears this wrist's own
                                unconfirmed lock and re-arms the walk-away rule,
                                and a second sender would do neither. */
                             if kind == .unlock { session.unlock(); return }
                             session.send(kind)
                             /* Flip to the map only when there is a Bubble to
                                land on: this wrist's own optimistic lock, or
                                (below, onChange of shot.locked) the phone's.
                                Flipping on the press drew the hole with no
                                target first - the player-low framing - and
                                then jumped to the Bubble when the Scene came. */
                             if kind == .lock, session.lockedShot != nil { page = .map }
                         },
                         dismissRejection: session.dismissRejection,
                         driving: true, handoverNotice: session.handoverNotice, dismissHandoverNotice: session.dismissHandoverNotice,
                         wristFix: session.wristFix, lockedShot: session.lockedShot,
                         demo: session.isDemo,
                         conditions: session.conditions)
                    .tag(Page.numbers)
                if let holeNumber = scene.hole?.number {
                    HoleMapPage(
                        scene: scene,
                        map: maps.hole(holeNumber, courseKey: scene.course?.key),
                        player: session.playerPoint,
                        deliveryHint: deliveryHint(for: scene),
                        bag: session.player.snapshot?.bag,
                        profile: session.player.snapshot?.bubble,
                        /* Aiming needs three things at once: the phone
                           says the shot can be aimed, the wrist runs
                           the same engine, and it has a bag to run it
                           with. Any of them missing and the map is a
                           picture — which is what it was yesterday. */
                        canAim: (scene.controls?.canAim == true || session.lockedShot != nil)
                            && session.engineAgreement.mayComputeLocally
                            && session.player.snapshot != nil,
                        onAim: { session.sendAim(to: $0) },
                        /* The aimable map swallows the page swipe, so
                           it reports one; landing on the numbers is
                           what sends UNLOCK below. */
                        onSwipeBack: { page = .numbers },
                        /* The same unlock, said out loud. A swipe is the
                           gesture somebody has to be shown once; this is
                           the control a player finds by looking, and it
                           is also what Double Tap presses. */
                        locked: locked,
                        onUnlock: { page = .numbers },
                        pendingTarget: session.lockedShot.map { WatchScene.GeoPoint(lat: $0.target.lat, lng: $0.target.lng) },
                        pendingExtentM: session.lockedShot.map { CGSize(width: $0.widthM, height: $0.depthM) },
                        pendingClub: session.lockedShot?.club,
                        aimOrigin: session.aimOrigin,
                        conditions: session.conditions
                    )
                    .tag(Page.map)
                }
            }
            .tabViewStyle(.page)
            /* The phone locked (or the wrist's LOCK was confirmed):
               the map is where a locked shot lives. */
            .onChange(of: scene.shot?.locked) { _, isLocked in
                if isLocked == true { page = .map }
            }
            /* Opened mid-shot — the app relaunched, or the round came
               back — the locked shot is still on the map. */
            .onAppear { if locked { page = .map } }
            .onChange(of: page) { _, now in
                guard now == .numbers, locked else { return }
                session.unlock()
            }
        }
        /* Over both pages, so it never scrolls away with the numbers. */
        .overlay(alignment: .top) {
            if session.isDemo {
                DemoBanner(strong: page == .map)
            }
        }
    }

    /* Says which of the three honest reasons applies instead of one blank
       "no map" for all of them: nothing sent, still arriving, or a package for
       a course that is not the one being played. */
    private func deliveryHint(for scene: WatchScene) -> String {
        guard let courseKey = scene.course?.key, !courseKey.isEmpty else { return "No hole map for this round" }
        guard let installed = maps.installed else { return "Waiting for hole maps\nfrom iPhone" }
        guard installed.manifest.courseKey == courseKey else { return "Hole maps are for\nanother course" }
        if !installed.isComplete { return "Hole maps arriving…\n\(installed.readyHoles.count) of \(installed.manifest.holes.count)" }
        return "This hole has no map"
    }
}

struct NoRoundFace: View {
    var body: some View {
        VStack(spacing: 7) {
            Text("CLARITY CADDY").font(.caption2.weight(.semibold)).foregroundStyle(.mint)
            Text("Start a round\non iPhone").font(.headline).multilineTextAlignment(.center)
        }
        .padding()
    }
}

/* The course is on its way over from the phone. Counts the holes as they
   land, off the store's own inventory, so the number is what the wrist can
   actually draw and not what the phone believes it sent. */
struct ReceivingFace: View {
    let courseName: String?
    let held: Int
    let expected: Int

    var body: some View {
        VStack(spacing: 12) {
            Text("RECEIVING\nCOURSE")
                .font(.caption2.weight(.heavy)).foregroundStyle(.mint)
                .multilineTextAlignment(.center).kerning(0.8)
            ProgressView(value: Double(held), total: Double(max(expected, 1)))
                .tint(.mint)
            Text("\(held) of \(expected) holes")
                .font(.caption.monospacedDigit().weight(.bold)).foregroundStyle(.secondary)
            if let courseName, !courseName.isEmpty {
                Text(courseName).font(.caption2).foregroundStyle(.tertiary).lineLimit(2).multilineTextAlignment(.center)
            }
        }
        .padding(.horizontal, 14)
    }
}

/* The course is here and the phone is driving. This face proves readiness by
   drawing the hole, and offers the one thing the wrist can do about it. */
struct ReadyFace: View {
    let scene: WatchScene
    let map: WatchMapStore.LoadedHoleMap?
    let player: WatchScene.GeoPoint?
    let wristDistance: Double?
    let play: () -> Void
    /* Why the last Play here did not take, shown in place of the PAR until it
       is dismissed. It no longer says "Play on iPhone first": the wrist's Play
       now starts the hole itself (caddy-watch.js setActive), so the only
       refusal left is Marshal declining to start play from where the player is
       standing - which is about the ground, not about which device to use. */
    var notice: String? = nil

    private var distanceLabel: (caption: String, metres: Double)? {
        if let wristDistance { return ("YOU → GREEN", wristDistance) }
        if let length = scene.hole?.teeToGreenM { return ("TEE → GREEN", length) }
        return nil
    }

    var body: some View {
        VStack(spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(scene.hole?.number.map { "Hole \($0)" } ?? "Hole").font(.headline)
                Spacer()
                if let notice {
                    Text(notice).font(.caption2.weight(.semibold)).foregroundStyle(.red).lineLimit(1).minimumScaleFactor(0.7)
                } else if let par = scene.hole?.par {
                    Text("PAR \(par)").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 4)
            ZStack(alignment: .bottomTrailing) {
                if let map {
                    HoleMapView(map: map, player: player, green: scene.geometry?.origin, target: nil)
                } else {
                    VStack(spacing: 4) {
                        Image(systemName: "map").font(.title3).foregroundStyle(.secondary)
                        Text("No hole map").font(.caption2).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(white: 0.09))
                }
                if let distanceLabel {
                    HStack(alignment: .firstTextBaseline, spacing: 2) {
                        Text(WatchConditions.number(distanceLabel.metres)).font(.system(size: 17, weight: .black, design: .rounded)).monospacedDigit()
                        Text(WatchConditions.suffix).font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 6).padding(.vertical, 3)
                    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    .padding(5)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .frame(maxHeight: .infinity)
            Button("Play here", action: play)
                .buttonStyle(.borderedProminent).tint(.mint)
                .font(.callout.weight(.heavy))
                .accessibilityHint("Take the round onto this Watch")
        }
        .padding(.horizontal, 3)
    }
}

/* Preview on the wrist. The phone is off the course, so nothing can be played
   for real; instead every hole can be looked at and demoed. One page per hole,
   paged vertically - the crown or a swipe steps through them, which is the
   watchOS-native way and needs no small targets - each drawn from the
   delivered lite map with its length. Demo asks the phone to put the player
   100-130m short of that green and hand the round here: the same Playing face
   a real round reaches, so the handover looks exactly as it will on the course. */
struct DemoBrowserFace: View {
    let scene: WatchScene
    let holes: [Int]
    let map: (Int) -> WatchMapStore.LoadedHoleMap?
    let length: (Int) -> Double?
    let par: (Int) -> Int?
    let approach: (Int) -> (player: WatchScene.GeoPoint?, green: WatchScene.GeoPoint?)
    let demo: (Int) -> Void
    var notice: String? = nil

    @State private var selection: Int = 0

    var body: some View {
        TabView(selection: $selection) {
            ForEach(holes, id: \.self) { hole in
                page(hole).tag(hole)
            }
        }
        .tabViewStyle(.verticalPage)
        .onAppear {
            /* Open on the hole the phone is showing. */
            if selection == 0 { selection = scene.hole?.number.flatMap { holes.contains($0) ? $0 : nil } ?? holes.first ?? 1 }
        }
    }

    /* The hole fills the screen; its name sits over the top and Demo over the
       bottom, so the picture is the page rather than a strip inside it. */
    private func page(_ hole: Int) -> some View {
        ZStack {
            if let map = map(hole) {
                let shot = approach(hole)
                /* Framed on the green, nudged a few metres back down the
                   approach so it sits clear between the label and Demo, with
                   the line in from the demo spot running off the bottom. The
                   camera will not zoom out past the corridor image's width,
                   so ~115m is roughly one screen and both ends cannot show. */
                let fit = shot.player.flatMap { p -> (centre: WatchScene.GeoPoint, extentM: CGSize)? in
                    guard let g = shot.green, let pl = p.lat, let pn = p.lng, let gl = g.lat, let gn = g.lng else { return nil }
                    return (WatchScene.GeoPoint(lat: gl + (pl - gl) * 0.1, lng: gn + (pn - gn) * 0.1), CGSize(width: 130, height: 300))
                }
                HoleMapView(map: map, player: shot.player, green: shot.green, target: nil, fit: fit)
            } else {
                VStack(spacing: 4) {
                    Image(systemName: "map").font(.title3).foregroundStyle(.secondary)
                    Text("No hole map").font(.caption2).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(white: 0.09))
            }
            /* Everything sits at the bottom: the green is at the top edge of
               the baked corridor, so the camera cannot bring it down, and a
               label up there would cover it. */
            VStack(spacing: 5) {
                Spacer()
                HStack(spacing: 5) {
                    Text("PREVIEW").font(.system(size: 9, weight: .heavy)).kerning(0.6).foregroundStyle(.mint)
                    Text("Hole \(hole)").font(.system(size: 15, weight: .bold)).monospacedDigit()
                    if let notice {
                        Text(notice).font(.system(size: 10, weight: .semibold)).foregroundStyle(.red).lineLimit(1).minimumScaleFactor(0.7)
                    } else if !subtitle(hole).isEmpty {
                        Text(subtitle(hole)).font(.system(size: 11, weight: .heavy)).foregroundStyle(.white.opacity(0.8)).lineLimit(1)
                    }
                }
                .padding(.horizontal, 9).padding(.vertical, 3)
                .background(.black.opacity(0.6), in: Capsule())
                Button { demo(hole) } label: {
                    Label("Demo", systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent).tint(.mint)
                .font(.callout.weight(.heavy))
                .shadow(color: .black.opacity(0.5), radius: 6)
                .padding(.horizontal, 10).padding(.bottom, 8)
                .accessibilityHint("Play hole \(hole) from a 100 to 130 metre approach on this Watch")
            }
        }
        .ignoresSafeArea()
    }

    private func subtitle(_ hole: Int) -> String {
        let parText = par(hole).map { "PAR \($0)" }
        let lengthText = length(hole).map { WatchConditions.withUnit($0) }
        return [parText, lengthText].compactMap { $0 }.joined(separator: " · ")
    }
}

/* A demo approach is on: a mint wash across the top of the screen, under the
   clock, that stays put on both driving pages and says how to leave. Blended
   rather than boxed, so it reads as the state of the screen, not a control
   competing with the hole block below it. */
struct DemoBanner: View {
    /// Over the map page: mint on a green picture needs more to be seen.
    let strong: Bool

    /* The unlock band's mint where it meets the glass, then eased out over a
       long run - several stops rather than one straight ramp - so there is no
       line where the banner stops. */
    private func wash(_ top: Double) -> LinearGradient {
        LinearGradient(stops: [
            .init(color: Color.mint.opacity(top), location: 0),
            .init(color: Color.mint.opacity(top * 0.76), location: 0.3),
            .init(color: Color.mint.opacity(top * 0.4), location: 0.55),
            .init(color: Color.mint.opacity(top * 0.14), location: 0.8),
            .init(color: Color.mint.opacity(0), location: 1)
        ], startPoint: .top, endPoint: .bottom)
    }

    var body: some View {
        ZStack(alignment: .top) {
            wash(strong ? 0.8 : 0.5)
                .frame(height: strong ? 72 : 64)
                .allowsHitTesting(false)
            /* A label, not a control. Nothing on the wrist ends a demo:
               the phone ends it by itself the moment a real fix puts the
               player at the course (demo-approach.js endIfAtCourse), and
               the round carries on down the real path. */
            Text("DEMO").font(.caption2.weight(.heavy)).kerning(0.8)
                .foregroundStyle(.white)
                .shadow(color: .black.opacity(0.5), radius: 2)
                .padding(.top, 12)
                .allowsHitTesting(false)
        }
        .frame(maxWidth: .infinity)
        .animation(.easeOut(duration: 0.2), value: strong)
        .ignoresSafeArea()
    }
}

/* The moment between asking and having. Short, and deliberately not a state
   that can be acted on. */
struct TakingFace: View {
    var body: some View {
        VStack(spacing: 14) {
            ProgressView().tint(.mint).controlSize(.large)
            Text("TAKING\nTHE ROUND")
                .font(.caption2.weight(.heavy)).foregroundStyle(.mint)
                .multilineTextAlignment(.center).kerning(0.8)
        }
    }
}
