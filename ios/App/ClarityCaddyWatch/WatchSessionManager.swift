import Combine
import CoreLocation
import Foundation
import WatchConnectivity
import WatchKit
import WatchBubbleEngine

@MainActor
final class WatchSessionManager: NSObject, ObservableObject {
    enum State { case noRound, live, stale }

    /* The four faces of a round on the wrist, in the order they happen.
       Receiving: the phone is still pushing the course across. Ready: the
       course is here (or there is none to wait for) and the phone is driving;
       the face offers Play here. Taking: this wrist has asked for the round, or
       the phone has offered it, and the answer is in flight. Playing: the
       wrist is driving - the numbers face with LOCK. */
    enum Face { case noRound, receiving, ready, taking, playing }

    private var storeWatch: AnyCancellable?

    @Published private(set) var scene: WatchScene?
    @Published private(set) var state: State = .noRound
    @Published private(set) var pendingCommands: [PendingWatchCommand] = []
    @Published private(set) var lastRejection: WatchCommandAcknowledgement?
    /* The shot this wrist believes it just locked, shown while nothing has
       confirmed it yet. Intent, never truth — see WatchLockedShot. */
    @Published private(set) var lockedShot: WatchLockedShot?

    /* One line about a handover that just happened, shown briefly where the
       status strip sits. Set only on a real change of driver, so a Scene that
       merely repeats "the Watch is driving" many times a minute stays silent. */
    @Published private(set) var handoverNotice: String?
    private var answeredHandovers = Set<String>()

    var isDriving: Bool { scene?.isDriving == true }

    /* What the phone says the package holds, and what this wrist can prove it
       holds. The phone's count decides whether there is anything to wait for;
       the local store decides whether the Ready face has a picture to show. */
    var mapsExpected: Int { scene?.surface?.watch?.maps?.total ?? 0 }
    var mapsHeld: Int {
        guard let installed = maps.installed, installed.manifest.courseKey == scene?.course?.key else { return 0 }
        return installed.readyHoles.count
    }

    var face: Face {
        guard let scene, scene.hasRound else { return .noRound }
        if scene.isDriving { return .playing }
        if scene.surface?.handover?.state == "offered" || pendingCommands.contains(where: { $0.command.type == .takeOver }) { return .taking }
        if mapsExpected > 0 && mapsHeld < mapsExpected { return .receiving }
        return .ready
    }

    /* Lite maps live in their own durable store rather than in the Scene: they
       are large, they change only when a course is regenerated, and a Scene
       arrives many times a minute. */
    nonisolated let maps = WatchMapStore()
    /* The bag and saved My Bubble. Its own store because it is its own
       transport: a snapshot belongs to the PLAYER and changes when they edit
       their bag, while a map package belongs to the course. */
    nonisolated let player = WatchPlayerStore()

    /* Whether this wrist may run its own Bubble engine, or must render the
       phone's. Derived rather than stored: it is a pure function of what the
       phone has declared on the latest Scene and on the bag currently held, so
       there is no third copy to fall out of step with either.

       Nothing consumes it yet - the Swift engine is the next step - but the
       gate lands with the versions it reads, so the engine is written against
       a decision that already exists rather than one bolted on afterwards. */
    var engineAgreement: BubbleEngineVersion.Agreement {
        BubbleEngineVersion.agreement(
            scene: scene?.bubble?.engineVersion,
            snapshot: player.snapshot?.engineVersion
        )
    }

    /* The wrist's own Bubble for the target currently in play.

       This is the engine actually running. It computes from the WRIST's fix
       against the Scene's target, which is the same thing WristDistances
       already does for front/centre/back - the wrist is its own rangefinder,
       and now its own Bubble too.

       nil is a complete answer and it has four honest causes: the versions do
       not agree (the phone's Bubble is rendered instead), no bag has arrived,
       no target is in play, or there is no trustworthy wrist fix. None of them
       is an error and none of them shows the player anything: the numbers face
       keeps drawing the Scene's Bubble exactly as it did before this existed.

       Moving the target is not here. That is the Interaction Engine's, and
       until it exists the wrist computes for the target the phone placed. */
    var localBubble: BubbleEngine.Result? {
        guard engineAgreement.mayComputeLocally else { return nil }
        guard let snapshot = player.snapshot else { return nil }
        guard let fix = wristFix, let lat = fix.lat, let lng = fix.lng else { return nil }
        guard let aim = scene?.target ?? scene?.bubble?.centre,
              let aimLat = aim.lat, let aimLng = aim.lng else { return nil }
        return BubbleEngine.calculate(.init(
            player: Coordinate(lat: lat, lng: lng),
            target: Coordinate(lat: aimLat, lng: aimLng),
            bag: snapshot.bag,
            bubble: snapshot.bubble
        ))
    }

    /* The point a lite map draws the player at: the wrist's own fix while it has
       a trustworthy one, the phone's otherwise. Published separately from
       `scene` because a fix changes on its own schedule, several times between
       Scene revisions. */
    @Published private(set) var wristFix: WatchScene.GeoPoint?

    /* The wrist's own way through a hole — green focus, the holding screen and
       the queued next hole. See WatchHoleFlow for why these three, and only
       these three, are decided here rather than asked for.
     *
     * It runs only while this wrist is DRIVING. A wrist the phone is driving
     * shows what the phone shows, because two surfaces deciding independently
     * which hole you are on is exactly the disagreement the whole play-owner
     * design exists to prevent. Driving means there is only one decider and it
     * happens to be this one. */
    @Published private(set) var holeFlow = WatchHoleFlow()

    /* Everything the flow needs to know about a hole, assembled from what this
       wrist already holds: green and tee out of the delivered lite-map
       package, par off the Scene. Nil when there is no package for this hole,
       which is the honest answer — without a green there is no green focus and
       without a tee there is no tee zone, and the wrist simply keeps showing
       the numbers face. */
    func flowHole(_ number: Int?) -> WatchHoleFlow.Hole? {
        guard let number else { return nil }
        let reference = maps.hole(number, courseKey: scene?.course?.key)?.reference
        let par = scene?.course?.par(number) ?? (scene?.hole?.number == number ? scene?.hole?.par : nil)
        guard let reference, reference.isUsable else {
            return par == nil ? nil : WatchHoleFlow.Hole(number: number, par: par)
        }
        return WatchHoleFlow.Hole(
            number: number,
            par: par,
            tee: reference.playLine.map { Coordinate(lat: $0.tee.lat, lng: $0.tee.lng) },
            green: Coordinate(lat: reference.green.lat, lng: reference.green.lng))
    }

    /// The green outline for the hole being shown, for the green face to draw.
    func flowGreenShape(_ number: Int?) -> [Coordinate] {
        guard let number, let shape = maps.hole(number, courseKey: scene?.course?.key)?.reference?.usableGreenShape else { return [] }
        return shape.map { Coordinate(lat: $0.lat, lng: $0.lng) }
    }

    /// The hole after the one just finished. The wrist steps by one; anything
    /// cleverer is the phone's card and the picker's business.
    var flowNextHole: Int? {
        guard let current = holeFlow.hole ?? scene?.hole?.number else { return nil }
        return current + 1
    }

    /* A fix, or a Scene, or both — everything that could change what the flow
       should be showing goes through here. Effects leave as commands; nothing
       waits for one to be acknowledged, which is what lets the next hole start
       with the phone asleep in a bag. */
    private func advanceFlow() {
        guard scene?.isDriving == true else { return }
        let current = flowHole(scene?.hole?.number)
        let next = holeFlow.face == .queued ? flowHole(holeFlow.hole) : flowHole(flowNextHole)
        let fix = wristFix.flatMap { fix -> Coordinate? in
            guard let lat = fix.lat, let lng = fix.lng else { return nil }
            return Coordinate(lat: lat, lng: lng)
        }
        let effect = holeFlow.update(fix: fix, hole: current, next: next,
                                     locked: scene?.shot?.locked == true || lockedShot != nil)
        if let effect { dispatch(effect) }
    }

    // ------------------------------------------------- the wrist's own actions

    func flowMoveBall(to point: Coordinate) {
        if let effect = holeFlow.moveBall(to: point) { dispatch(effect) }
    }

    /* "That's me." Closes the shot the phone has open when there is one, and
       moves to the holding screen. Whether there is a shot to close is the
       PHONE's answer (controls.canLogFinish): the wrist decides screens, not
       what is in the record. */
    func flowHoleDone() {
        let effects = holeFlow.complete(hole: flowHole(scene?.hole?.number),
                                        logShot: scene?.controls?.canLogFinish == true)
        effects.forEach(dispatch)
        WKInterfaceDevice.current().play(.success)
    }

    func flowStepScore(_ delta: Int) {
        if let effect = holeFlow.stepScore(delta) { dispatch(effect) }
    }

    func flowNext() {
        guard let next = flowNextHole, let hole = flowHole(next) ?? WatchHoleFlow.Hole(number: next) as WatchHoleFlow.Hole? else { return }
        dispatch(holeFlow.queue(hole))
    }

    func flowPlay() {
        guard let number = holeFlow.hole, let hole = flowHole(number) ?? WatchHoleFlow.Hole(number: number) as WatchHoleFlow.Hole? else { return }
        dispatch(holeFlow.play(hole: hole))
        WKInterfaceDevice.current().play(.start)
    }

    func flowBack() { _ = holeFlow.back() }

    /* What the queued screen reads. Its own length is a fact about the hole and
       always available; the walk to the tee needs both a mapped tee and a fix,
       and is simply absent otherwise — an absent number is better than a
       confident one measured from nothing. */
    var queuedLengthM: Double? {
        guard let hole = flowHole(holeFlow.hole), let tee = hole.tee, let green = hole.green else { return nil }
        return WatchHoleFlow.metres(tee, green)
    }
    var queuedToTeeM: Double? {
        guard let hole = flowHole(holeFlow.hole), let tee = hole.tee,
              let fix = wristFix, let lat = fix.lat, let lng = fix.lng else { return nil }
        return WatchHoleFlow.metres(Coordinate(lat: lat, lng: lng), tee)
    }
    var queuedAtTee: Bool {
        guard let d = queuedToTeeM else { return false }
        return d <= WatchHoleFlow.teeZoneM
    }

    /* One effect, one command. Nothing here waits for an answer: the wrist has
       already drawn the consequence, and the phone catching up late is the
       normal case rather than a failure. */
    private func dispatch(_ effect: WatchHoleFlow.Effect) {
        switch effect {
        case .ballMoved(let point):
            send(.ballMoved, payload: CommandPayload(point: WatchCoordinate(lat: point.lat, lng: point.lng)), allowDuplicate: true)
        case .logFinish:
            send(.logFinish, payload: CommandPayload())
        case .holeComplete(let hole):
            send(.holeComplete, payload: CommandPayload(hole: hole))
        case .stepScore(let hole, let delta):
            send(.stepScore, payload: CommandPayload(hole: hole, delta: delta), allowDuplicate: true)
        case .advance(let hole):
            /* Advance and Play are a pair and must arrive in this order: Play
               starts the hole the phone is LOOKING at, which Advance is what
               put there. The outbox preserves order. */
            send(.advance, payload: CommandPayload(hole: hole))
        case .play(let hole):
            send(.advance, payload: CommandPayload(hole: hole))
            send(.playHole, payload: CommandPayload(hole: hole))
        }
    }

    private let outboxKey = "CaddyWatchPendingCommandsV1"
    private var session: WCSession?
    private let locationManager = WatchLocationManager()

    var playerPoint: WatchScene.GeoPoint? { wristFix ?? scene?.location?.coordinate }

    override init() {
        super.init()
        restoreOutbox()
        locationManager.onFix = { [weak self] fix in
            guard let self else { return }
            self.wristFix = fix.map { WatchScene.GeoPoint(lat: $0.coordinate.latitude, lng: $0.coordinate.longitude) }
            /* Every fix, not every Scene. The whole reason the between-holes
               screens live here is that they must keep working while the phone
               is asleep, and a phone asleep sends no Scenes. */
            self.advanceFlow()
        }
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        session.delegate = self
        session.activate()
        self.session = session
        /* Each hole that lands changes the store; a short debounce turns a
           burst of eighteen into one or two reports rather than eighteen. */
        storeWatch = maps.$installed
            .dropFirst()
            .debounce(for: .milliseconds(400), scheduler: DispatchQueue.main)
            .sink { [weak self] _ in self?.reportMapInventory() }
        /* Told once on activation, so a phone that has been sending into the
           void since a reinstall learns immediately that this wrist holds
           nothing. */
        reportPlayerInventory()
    }

    /* LOCK always resolves against the wrist's own GPS when a recent, accurate
       fix exists — the phone can then stay in the bag. It only falls back to
       the phone-authoritative LOCK when the watch has no trustworthy fix. */
    func send(_ type: CaddyWatchCommand.Kind) { send(type, payload: CommandPayload()) }

    /* `allowDuplicate` exists for the two commands that carry a VALUE rather
       than an intent: a ball dragged twice and a score stepped twice are two
       different things to say, and dropping the second as a duplicate would
       lose the one the player is looking at. Everything else stays deduped,
       because a second LOCK while the first is in flight is a mistake. */
    func send(_ type: CaddyWatchCommand.Kind, payload initialPayload: CommandPayload, allowDuplicate: Bool = false) {
        guard let scene, let roundId = scene.roundId, !roundId.isEmpty else { return }
        guard allowDuplicate || !isPending(type) else { return }
        lastRejection = nil
        var wireType = type
        var payload = initialPayload
        if type == .lock, let fix = locationManager.lastFix, let observation = WatchLocationObservation(fix) {
            wireType = .lockAt
            payload = CommandPayload(location: observation)
        }
        let command = CaddyWatchCommand(commandId: UUID().uuidString, roundId: roundId, baseRevision: scene.revision, createdAt: Date().timeIntervalSince1970 * 1000, device: "apple-watch", type: wireType, payload: payload)
        /* A LOCK the wrist computed for itself can be shown as locked at once,
           rather than after a round trip. It is recorded against THIS command's
           id, so the acknowledgement that comes back names exactly the record
           it settles. If the wrist has no Bubble of its own — no bag, versions
           disagreed, no fix — nothing is recorded and the button waits, which
           is what it did before this existed. */
        if type == .lock, let bubble = localBubble, let fix = wristFix,
           let lat = fix.lat, let lng = fix.lng {
            lockedShot = WatchLockedShot(
                commandId: command.commandId, roundId: roundId, baseRevision: scene.revision,
                holeNumber: scene.hole?.number, bubble: bubble,
                player: Coordinate(lat: lat, lng: lng))
        }
        pendingCommands.append(PendingWatchCommand(command: command, status: .pending, attemptCount: 0, lastAttemptAt: nil))
        persistOutbox()
        NSLog("[CCWatch] send %@ pending=%d face=%@", wireType.rawValue, pendingCommands.count, String(describing: face))
        attempt(commandId: command.commandId)
    }

    /* The aim, sent once the finger lifts.
     *
     * NOT on every frame of the drag. Local recalculation is what makes the
     * drag feel immediate; the phone does not need the intermediate frames, and
     * a Scene republished per frame would swamp the link for numbers nobody
     * reads. One command, at the end, carrying where the target actually
     * landed.
     *
     * Raw, with no clamp of its own — see CommandPayload. Marshal owns the aim
     * roof and the wrist accepts its correction on the next Scene.
     *
     * `isPending` is deliberately NOT consulted: a second drag while the first
     * command is still queued must send the newer target, not be dropped as a
     * duplicate. Each carries its own command ID, and Marshal applies them in
     * order; the last one wins, which is the one the player is looking at. */
    func sendAim(to point: Coordinate) {
        guard let scene, let roundId = scene.roundId, !roundId.isEmpty else { return }
        guard scene.controls?.canAim == true else { return }
        lastRejection = nil
        let command = CaddyWatchCommand(
            commandId: UUID().uuidString, roundId: roundId, baseRevision: scene.revision,
            createdAt: Date().timeIntervalSince1970 * 1000, device: "apple-watch",
            type: .aimAt, payload: CommandPayload(point: WatchCoordinate(lat: point.lat, lng: point.lng)))
        pendingCommands.append(PendingWatchCommand(command: command, status: .pending, attemptCount: 0, lastAttemptAt: nil))
        persistOutbox()
        attempt(commandId: command.commandId)
    }

    func dismissRejection() { lastRejection = nil }

    /* A wire command's true type may be LOCK_AT rather than LOCK once wrist GPS
       is available; the LOCK button still needs to read "busy" either way. */
    func isPending(_ type: CaddyWatchCommand.Kind) -> Bool {
        pendingCommands.contains { $0.command.type == type || (type == .lock && $0.command.type == .lockAt) }
    }

    private func receive(context: [String: Any]) {
        guard let raw = context["scene"] else { NSLog("[CCWatch] scene key missing in context: %@", context.keys.joined(separator: ",")); return }
        guard JSONSerialization.isValidJSONObject(raw) else { NSLog("[CCWatch] scene is not a valid JSON object"); return }
        guard let data = try? JSONSerialization.data(withJSONObject: raw) else { NSLog("[CCWatch] scene serialization failed"); return }
        let incoming: WatchScene
        do { incoming = try JSONDecoder().decode(WatchScene.self, from: data) }
        catch { NSLog("[CCWatch] scene decode failed: %@ payload: %@", String(describing: error), String(data: data, encoding: .utf8) ?? "?"); return }
        guard incoming.isSupported else { NSLog("[CCWatch] unsupported schemaVersion %d", incoming.schemaVersion); return }
        /* The round is over. A lock belongs to the round it was made in, so it
           goes with it — otherwise the wrist would carry a shot from a finished
           round into the next screen the player looks at. */
        guard incoming.hasRound else { scene = nil; state = .noRound; lockedShot = nil; locationManager.stop(); return }
        if let current = scene, current.roundId == incoming.roundId, incoming.revision < current.revision { return }
        let previous = scene
        scene = incoming
        state = .live
        locationManager.start()
        reconcileOutbox(with: incoming)
        noteSurface(previous: previous, incoming: incoming)
        /* The round moved: the phone started a different hole, or somebody used
           the picker. The wrist owns its screens and never which hole is being
           played, so it follows without argument — unless it is itself between
           holes, where the hole on screen is deliberately not the phone's and
           following would undo the queue it just made. */
        if holeFlow.face == .playing || holeFlow.face == .greenFocus {
            holeFlow.follow(hole: incoming.hole?.number)
        }
        advanceFlow()
    }

    /* A Scene arriving is proof the phone is listening, which the durable
       outbox otherwise only learns from a reachability flip. Commands for a
       round that is no longer the one on the phone can never be accepted
       (the command gate checks the round ID first), so they are dropped
       rather than retried forever; the rest are re-sent if they have been
       waiting a while. The phone dedupes by command ID, so a repeat is safe. */
    private func reconcileOutbox(with incoming: WatchScene) {
        /* AFTER the outbox filter below, deliberately: whether the lock's own
           command is still pending is one of the three inputs to the decision,
           and dropping stale commands is what settles it. `scene` is already
           the incoming one by the time this runs. */
        defer { refreshLockedShot() }
        let before = pendingCommands.count
        pendingCommands.removeAll { $0.command.roundId != incoming.roundId }
        if pendingCommands.count != before { persistOutbox() }
        let now = Date().timeIntervalSince1970 * 1000
        for pending in pendingCommands where now - (pending.lastAttemptAt ?? 0) > 10_000 {
            attempt(commandId: pending.command.commandId)
        }
    }

    /* The wrist's side of a handover. A phone-initiated one arrives `offered`:
       answering TAKE_OVER is how the phone learns the round actually reached a
       wrist rather than a drawer, and it is answered once per handover ID so a
       repeated Scene does not become a repeated command. The notice and haptic
       fire only when the driver actually changed. */
    private func noteSurface(previous: WatchScene?, incoming: WatchScene) {
        let handover = incoming.surface?.handover
        if incoming.isDriving, handover?.state == "offered", let id = handover?.id, !answeredHandovers.contains(id) {
            answeredHandovers.insert(id)
            send(.takeOver)
        }
        /* For a surface command the Scene IS the outcome: once the phone says
           the wrist is driving, an outstanding TAKE_OVER has plainly landed
           (and likewise HAND_BACK), acknowledgement or not. Clearing it here
           keeps the strip from reading "Switching…" past the switch. */
        let settled: CaddyWatchCommand.Kind = incoming.isDriving ? .takeOver : .handBack
        if pendingCommands.contains(where: { $0.command.type == settled }) {
            pendingCommands.removeAll { $0.command.type == settled }
            persistOutbox()
        }
        let wasDriving = previous?.isDriving == true
        guard wasDriving != incoming.isDriving else { return }
        if incoming.isDriving {
            handoverNotice = handover?.from == "phone" ? "iPhone handed over" : "You're driving"
            if previous != nil { WKInterfaceDevice.current().play(.success) }
        } else if previous != nil {
            handoverNotice = "Back on iPhone"
            WKInterfaceDevice.current().play(.click)
        }
    }

    func dismissHandoverNotice() { handoverNotice = nil }

    private func receive(acknowledgement raw: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(raw),
              let data = try? JSONSerialization.data(withJSONObject: raw),
              let acknowledgement = try? JSONDecoder().decode(WatchCommandAcknowledgement.self, from: data) else { return }
        /* Both outcomes are definitive. Accepted commands wait for the next
           authoritative Scene to change presentation; rejected commands do not
           loop forever, but their command ID remains retryable on the phone. */
        pendingCommands.removeAll { $0.command.commandId == acknowledgement.commandId }
        persistOutbox()
        NSLog("[CCWatch] ack %@ accepted=%d reason=%@ pending=%d face=%@", acknowledgement.commandId, acknowledgement.accepted ? 1 : 0, acknowledgement.reason ?? "-", pendingCommands.count, String(describing: face))
        if !acknowledgement.accepted {
            lastRejection = acknowledgement
            WKInterfaceDevice.current().play(.failure)
            /* The lock did not happen. Discard at once rather than waiting for
               the expiry — a player who has just been told "no" must not still
               be looking at a locked shot. */
            if lockedShot?.commandId == acknowledgement.commandId { lockedShot = nil }
        }
        refreshLockedShot()
    }

    /* Ends 2 and 3: the Scene has caught up, the round changed, or nothing came
       back at all. The rule itself is in WatchLockedShot so it can be tested
       without any of this; here it is only applied, at the three moments the
       inputs to it change. */
    private func refreshLockedShot() {
        guard let shot = lockedShot else { return }
        let pending = pendingCommands.contains { $0.command.commandId == shot.commandId }
        if !shot.isStillShowing(roundId: scene?.roundId, sceneRevision: scene?.revision, commandStillPending: pending) {
            lockedShot = nil
        }
    }

    private func attempt(commandId: String) {
        guard let index = pendingCommands.firstIndex(where: { $0.command.commandId == commandId }),
              let message = commandMessage(pendingCommands[index].command), let session else { return }
        pendingCommands[index].attemptCount += 1
        pendingCommands[index].lastAttemptAt = Date().timeIntervalSince1970 * 1000
        persistOutbox()
        if session.isReachable {
            session.sendMessage(message, replyHandler: nil) { [weak self] _ in
                // A transport error is deliberately not an acknowledgement, but it
                // must not strand the command either: transferUserInfo is durable
                // and delivers once the phone can process it, the same fallback
                // NativeRoundBridge.acknowledgeCommand already uses for the
                // phone -> watch direction. Without this, a single transient
                // sendMessage failure left the command - and isPending's block on
                // retapping the same button - stuck until reachability happened
                // to change again, which is what made Next/Previous/Lock feel
                // unreliable rather than merely slow.
                session.transferUserInfo(message)
                Task { @MainActor in
                    guard let self else { return }
                    self.state = self.scene == nil ? .noRound : .stale
                }
            }
        } else {
            session.transferUserInfo(message)
        }
    }

    private func retryPending() { pendingCommands.forEach { attempt(commandId: $0.command.commandId) } }

    /* Tells the phone exactly which course/version/holes are already on the
       wrist so it re-sends only what is missing. A whole 18-hole package is
       under 100KB, but re-pushing it on every launch would still burn radio
       time during a round for no new information. Best-effort by design: if
       this never arrives the phone simply sends everything again. */
    private func reportMapInventory() {
        guard let session, session.activationState == .activated else { return }
        let payload: [String: Any] = ["watchMapHave": maps.inventory()]
        /* Mirrored live when reachable, like everything else that crosses this
           link: the phone's card counts holes off this report as they land. */
        if session.isReachable { session.sendMessage(payload, replyHandler: nil, errorHandler: nil) }
        session.transferUserInfo(payload)
    }

    /* Which bag this wrist holds, so the phone re-sends only when it differs.
       An empty fingerprint means "none", which is what makes a phone send one.
       Losing this report costs one re-send, never correctness. */
    private func reportPlayerInventory() {
        guard let session, session.activationState == .activated else { return }
        /* The bag this wrist holds AND the engine it implements, in one
           report. They travel together because they are answered at the same
           moments - activation, adoption, coming back into range - and because
           a phone that can see the wrist's engine version can spot a mismatch
           from its own side instead of only inferring one from a Watch that
           never computes. */
        var held = player.inventory
        held.merge(BubbleEngineVersion.report) { current, _ in current }
        let payload: [String: Any] = ["watchPlayerHave": held]
        if session.isReachable { session.sendMessage(payload, replyHandler: nil, errorHandler: nil) }
        session.transferUserInfo(payload)
    }

    private func commandMessage(_ command: CaddyWatchCommand) -> [String: Any]? {
        guard let data = try? JSONEncoder().encode(command),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return ["command": object]
    }

    private func restoreOutbox() {
        guard let data = UserDefaults.standard.data(forKey: outboxKey),
              let stored = try? JSONDecoder().decode([PendingWatchCommand].self, from: data) else { return }
        pendingCommands = stored
    }

    private func persistOutbox() {
        guard let data = try? JSONEncoder().encode(pendingCommands) else { return }
        UserDefaults.standard.set(data, forKey: outboxKey)
    }
}

extension WatchSessionManager: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = session.receivedApplicationContext
        Task { @MainActor [weak self] in
            self?.receive(context: context)
            if activationState == .activated {
                self?.retryPending()
                self?.reportMapInventory()
            }
            else if self?.scene != nil { self?.state = .stale }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor [weak self] in self?.receive(context: applicationContext) }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        /* The phone mirrors every scene as a live message because the
           application-context store can lag behind a reconnect. Same payload
           shape, same authoritative receive path. */
        if message["scene"] != nil {
            Task { @MainActor [weak self] in self?.receive(context: message) }
            return
        }
        /* Lite maps are mirrored live for the same reason the Scene is: the
           queued stores do not reach the Watch app reliably, and a duplicate
           write of identical bytes is harmless. */
        if let manifest = message["watchMapManifest"] {
            Task { @MainActor [weak self] in
                self?.maps.receive(manifest: manifest)
                self?.reportMapInventory()
            }
            return
        }
        if let asset = message["watchMapAsset"] as? [String: Any], let bytes = asset["bytes"] as? Data {
            maps.accept(bytes: bytes, metadata: asset)
            return
        }
        if let snapshot = message["watchPlayer"] {
            Task { @MainActor [weak self] in
                /* Report ONLY when something actually changed.
                   Reporting unconditionally made a hot loop: a rejected
                   snapshot still triggered a report, the phone answered a
                   report with another publish, and the two spun at hundreds of
                   messages a second. A report is news, and a rejection is not
                   news - the phone already knows what it sent. */
                if self?.player.receive(player: snapshot) == true { self?.reportPlayerInventory() }
            }
            return
        }
        guard let acknowledgement = message["acknowledgement"] as? [String: Any] else { return }
        Task { @MainActor [weak self] in self?.receive(acknowledgement: acknowledgement) }
    }

    nonisolated func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        if let manifest = userInfo["watchMapManifest"] {
            Task { @MainActor [weak self] in
                self?.maps.receive(manifest: manifest)
                self?.reportMapInventory()
            }
            return
        }
        if let snapshot = userInfo["watchPlayer"] {
            Task { @MainActor [weak self] in
                if self?.player.receive(player: snapshot) == true { self?.reportPlayerInventory() }
            }
            return
        }
        guard let acknowledgement = userInfo["acknowledgement"] as? [String: Any] else { return }
        Task { @MainActor [weak self] in self?.receive(acknowledgement: acknowledgement) }
    }

    /* WatchConnectivity deletes the handed-over file as soon as this returns,
       so the store copies it out synchronously here rather than hopping to the
       main actor first. */
    nonisolated func session(_ session: WCSession, didReceive file: WCSessionFile) {
        maps.acceptTransferredFile(at: file.fileURL, metadata: file.metadata)
    }

    nonisolated func sessionReachabilityDidChange(_ session: WCSession) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            /* Coming back into range is the moment to say what this wrist
               holds - a bag edited while the phone was away has been waiting on
               exactly this. Deliberately outside the round guard below: it is
               true whether or not a round is in progress. */
            if session.isReachable { self.reportPlayerInventory() }
            guard self.scene != nil else { return }
            self.state = session.isReachable ? .live : .stale
            if session.isReachable { self.retryPending() }
        }
    }
}

extension WatchLocationObservation {
    /* Mirrors locationObservation()'s own acceptance bound in caddy-watch.js so
       a stale or coarse wrist fix falls back to phone-authoritative LOCK
       instead of round-tripping a command Marshal will just reject. */
    init?(_ location: CLLocation, maxAgeSeconds: TimeInterval = 30) {
        guard location.horizontalAccuracy >= 0, location.horizontalAccuracy <= 100 else { return nil }
        guard Date().timeIntervalSince(location.timestamp) <= maxAgeSeconds else { return nil }
        coordinate = WatchCoordinate(lat: location.coordinate.latitude, lng: location.coordinate.longitude)
        source = "apple-watch"
        horizontalAccuracy = location.horizontalAccuracy
        timestamp = location.timestamp.timeIntervalSince1970 * 1000
    }
}

/* Keeps one fresh, best-effort GPS fix while a round is live so LOCK can mark
   the ball from the wrist. Foreground-only: there is deliberately no
   background location mode here (§ no golf-state transitions belong here). */
@MainActor
final class WatchLocationManager: NSObject, ObservableObject {
    @Published private(set) var lastFix: CLLocation?

    /* Only accurate-enough fixes reach map drawing, on the same 100m bound
       LOCK_AT already trusts — a 500m fix would put the player in a neighbouring
       fairway, which reads as a broken map rather than a coarse one. */
    var onFix: ((CLLocation?) -> Void)?

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.distanceFilter = 5
        manager.delegate = self
    }

    func start() {
        switch manager.authorizationStatus {
        case .notDetermined: manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse, .authorizedAlways: manager.startUpdatingLocation()
        default: break
        }
    }

    func stop() {
        manager.stopUpdatingLocation()
        lastFix = nil
        onFix?(nil)
    }
}

extension WatchLocationManager: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            if status == .authorizedWhenInUse || status == .authorizedAlways { manager.startUpdatingLocation() }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            self.lastFix = latest
            let usable = latest.horizontalAccuracy >= 0 && latest.horizontalAccuracy <= 100
            self.onFix?(usable ? latest : nil)
        }
    }
}
