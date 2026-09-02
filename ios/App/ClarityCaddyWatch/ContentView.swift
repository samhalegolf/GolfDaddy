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
                if let scene = session.scene {
                    ReadyFace(
                        scene: scene,
                        map: scene.hole?.number.flatMap { maps.hole($0, courseKey: scene.course?.key) },
                        player: session.playerPoint,
                        wristDistance: WristDistances.compute(fix: session.wristFix, geometry: scene.geometry)?.centre,
                        play: { session.send(.takeOver) },
                        notice: session.lastRejection.map { $0.reason == "no-live-round" ? "Play on iPhone first" : "Couldn't do that" }
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
            let locked = scene.shot?.locked == true || session.lockedShot != nil
            TabView(selection: $page) {
                ShotView(scene: scene, stale: session.state == .stale, pending: session.pendingCommands, rejection: session.lastRejection,
                         send: { kind in
                             session.send(kind)
                             if kind == .lock { page = .map }
                         },
                         dismissRejection: session.dismissRejection,
                         driving: true, handoverNotice: session.handoverNotice, dismissHandoverNotice: session.dismissHandoverNotice,
                         wristFix: session.wristFix, lockedShot: session.lockedShot)
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
                        canAim: scene.controls?.canAim == true
                            && session.engineAgreement.mayComputeLocally
                            && session.player.snapshot != nil,
                        onAim: { session.sendAim(to: $0) },
                        /* The aimable map swallows the page swipe, so
                           it reports one; landing on the numbers is
                           what sends UNLOCK below. */
                        onSwipeBack: { page = .numbers }
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
                session.send(.unlock)
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
    /* Why the last Play here did not take - "Play on iPhone first" - shown
       in place of the PAR until it is dismissed. */
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
                        Text("\(Int(distanceLabel.metres.rounded()))").font(.system(size: 17, weight: .black, design: .rounded)).monospacedDigit()
                        Text("m").font(.caption2.weight(.heavy)).foregroundStyle(.secondary)
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
