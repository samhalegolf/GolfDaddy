import Foundation

/* The wrist's own way through a hole.
 *
 * WHY THIS EXISTS AT ALL. Everything else on this Watch is a picture of a
 * decision the phone made: the Scene arrives, the wrist draws it, and any
 * button the player presses becomes a command that crosses the link and waits.
 * That is right for the things that write to a round — a lock, an aim, a shot
 * outcome — because the phone owns the record and two owners is how a round
 * ends up disagreeing with itself.
 *
 * It is wrong for playing hole after hole. Walking on to a green, saying the
 * hole is done, leaving the score at par and queueing the next one are not
 * claims about the record; they are the wrist deciding what is on the wrist's
 * own screen, from the wrist's own GPS. Sending each of them to the phone and
 * waiting for a Scene to come back means a green that appears late, a "hole
 * complete" that takes a beat, and a round that stops working the moment the
 * phone is in a bag two fairways away with the screen off.
 *
 * So the SCREENS are decided here, locally, and the RECORD still goes to the
 * phone — sent as an Effect, fire and forget, arriving whenever the link comes
 * back. The two can never contradict each other because they are answering
 * different questions: this decides what the wrist is showing, and Marshal
 * decides what happened.
 *
 * The rules and the numbers are Marshal's, deliberately duplicated rather than
 * derived: app/js/marshal.js GREEN_FOCUS_M, GREEN_RELEASE_M, GREEN_APPROACH_M
 * and TEE_ZONE_M. Change one and change the other — WatchHoleFlowTests pins
 * the values so the pair cannot drift silently.
 *
 * Pure and has no memory of anything but its own state: no CoreLocation, no
 * WatchConnectivity, no SwiftUI. That is what lets the whole thing be driven
 * in a test rather than on a golf course.
 */
public struct WatchHoleFlow: Equatable {

    // ------------------------------------------------------------- the rules

    /// Inside this of the green centre the wrist is looking at the green.
    public static let greenFocusM: Double = 40
    /// And it takes five metres more to leave, so a fix jittering on the
    /// boundary cannot reopen a focus that was just closed.
    public static let greenReleaseM: Double = 45
    /// How much closer to the green you must have got since locking before the
    /// green may take the screen off an aim. Standing over a chip does not
    /// reach it; playing the chip and walking to the ball always does.
    public static let greenApproachM: Double = 10
    /// Close enough to the tee that arriving IS pressing Play.
    public static let teeZoneM: Double = 30

    /// Everything the wrist needs to know about one hole. It has all of this
    /// already: green and tee come from the lite-map package it was sent, and
    /// par rides on the Scene's `course.pars`.
    public struct Hole: Equatable {
        public let number: Int
        public let par: Int?
        public let tee: Coordinate?
        public let green: Coordinate?

        public init(number: Int, par: Int? = nil, tee: Coordinate? = nil, green: Coordinate? = nil) {
            self.number = number
            self.par = par
            self.tee = tee
            self.green = green
        }
    }

    /* Which screen the wrist is on.
     *
     * `playing` is everything the wrist already did — the numbers face and the
     * map. The other three are the new ones, and each is a place where GPS
     * means something different: on the green it is where your ball is, on the
     * holding screen it means nothing at all, and on the queued hole it is
     * only being watched for the tee. */
    public enum Face: String, Equatable, Sendable {
        case playing, greenFocus, holeComplete, queued
    }

    /* What the phone needs to be told. Returned rather than sent, because a
     * pure state machine that could send would need a link, and a link is the
     * thing this design exists to stop waiting for. */
    public enum Effect: Equatable, Sendable {
        case ballMoved(Coordinate)
        case logFinish
        case holeComplete(hole: Int)
        case stepScore(hole: Int, delta: Int)
        case advance(hole: Int)
        case play(hole: Int)
    }

    public private(set) var face: Face = .playing
    /// The hole the wrist is showing. On `queued` this is the NEXT hole, which
    /// is the whole reason the face exists: the hole on screen is not the hole
    /// your feet are on, and nothing may pretend otherwise.
    public private(set) var hole: Int?
    /// Where the shot finished, on the green face. Starts at the fix so there
    /// is always something to drag.
    public private(set) var ball: Coordinate?
    public private(set) var ballPlaced: Bool = false
    /// The score on the holding screen. Par the moment the screen opens.
    public private(set) var score: Int?
    /// A green the player closed by hand, so it does not reopen while they are
    /// still standing inside the radius.
    public private(set) var greenClosed: Int?
    /// How far from the green the fix was when the current shot was locked.
    /// The only thing that distinguishes "still deciding" from "played it".
    public private(set) var lockedAtGreenM: Double?
    /// The green of the hole just finished, kept only so the reach fallback
    /// below can tell "walked to the next tee" from "still standing on the
    /// last one". Nil until a hole is completed, which is deliberate: without
    /// it the fallback does not apply at all.
    public private(set) var lastGreen: Coordinate?
    private var wasLocked = false

    public init() {}

    /* The distance the whole flow is measured in, exposed so the FACES measure
       the same way the rules do. The engine's `Geo` is internal on purpose —
       the app target has no business doing bubble maths — but "how far is that"
       is the one question every one of these screens asks, and two answers to
       it is how a green that says 8m ends up in a state that thinks it is 41.
       Same haversine as app/js/distance.js. */
    public static func metres(_ a: Coordinate, _ b: Coordinate) -> Double? {
        let d = Geo.distance(a, b)
        return d.isFinite ? d : nil
    }

    // -------------------------------------------------------------- position

    /* A fix, and what the phone currently says about the shot. Returns an
     * effect only when the wrist has decided something the phone should know —
     * which, on this path, is only ever "I have started the hole I queued".
     *
     * Everything else it decides here is a screen, and screens are not events. */
    @discardableResult
    public mutating func update(fix: Coordinate?, hole current: Hole?, next: Hole?, locked: Bool,
                                reachM: Double? = nil) -> Effect? {
        /* A lock records where it was made FROM, in green-distance, because
           that is what greenApproachM is measured against. It is captured on
           the transition rather than read every time, so a shot locked before
           the wrist had a fix does not silently acquire one later. */
        if locked && !wasLocked {
            lockedAtGreenM = fix.flatMap { distance(from: $0, to: current?.green) }
            /* A new shot ends any "leave the green alone" the player asked for.
               It cannot bring the green straight back: greenApproachM below
               holds it off until the shot has actually been played. Marshal
               clears the same flag on the same event, for the same reason. */
            greenClosed = nil
        }
        if !locked { lockedAtGreenM = nil }
        wasLocked = locked

        guard let fix else { return nil }

        /* Walked off the green: whatever was dismissed there is no longer in
           front of you. */
        if let closed = greenClosed, closed == current?.number || closed == hole {
            let back = distance(from: fix, to: current?.green)
            if back == nil || back! > Self.greenReleaseM { greenClosed = nil }
        }

        switch face {
        case .queued:
            /* The tee zone IS the Play button. It can only ever start the hole
               already on screen, which a deliberate press put there. */
            guard let next else { return nil }
            if let tee = next.tee, let d = distance(from: fix, to: tee), d <= Self.teeZoneM {
                return play(hole: next)
            }
            return arrivedByReach(fix: fix, next: next, reachM: reachM) ? play(hole: next) : nil

        case .holeComplete:
            /* Nothing about a position matters on the holding screen. That is
               what it is for. */
            return nil

        case .greenFocus:
            /* The ball follows the fix until the player picks it up; once they
               have placed it, it stays where they put it. */
            if !ballPlaced { ball = fix }
            return nil

        case .playing:
            /* Only the hole this wrist is actually showing may take the screen.
             *
             * Moving on is behind a deliberate button - "That's me", Next hole,
             * Play - and once that has been pressed, position is not entitled
             * to argue with it. Without this guard it did: the player putts
             * out, presses through to the next hole, and is still standing on
             * the green they just finished while the phone's Scene has not
             * caught up (its ADVANCE and PLAY are in flight, or were rejected).
             * `current` is then the OLD hole, its green is five metres away,
             * and the wrist is dragged straight back to it - again on the next
             * fix, and the next, so the next hole can never be reached.
             *
             * The positional rule is not being weakened. It is being asked
             * about the right hole. */
            guard hole == nil || current?.number == hole else { return nil }
            guard shouldFocusGreen(fix: fix, hole: current, locked: locked) else { return nil }
            openGreen(on: current, ball: fix)
            return nil
        }
    }

    /* The looser way onto the queued hole.
     *
     * Thirty metres to the mapped tee is the right test when the map is right.
     * When it is not - a tee box nobody mapped, a package a little out of
     * place, a hole played from a different set of markers - it never arrives,
     * and the queued screen becomes a dead end you can only leave by pressing
     * Play by hand.
     *
     * So: can this bag reach anything on that hole from where the player is
     * standing? If the longest club cannot get to its tee or its green then
     * they are not on it, whatever the map thinks. If it can, they are
     * plausibly on it and the map or the tee is what is wrong.
     *
     * Reach alone is NOT enough, which is why the green behind matters. From
     * the green you have just putted out on, the next tee is usually well
     * inside a driver - so reach on its own would start the next hole while
     * you were still picking your ball out of the cup, and the walk to the tee
     * is exactly what this screen is for. Both conditions, or neither. */
    func arrivedByReach(fix: Coordinate, next: Hole, reachM: Double?) -> Bool {
        guard let reachM, reachM > 0 else { return false }
        /* No green behind means no hole was completed, so there is no walk to
           have finished - a hole queued from mid-round keeps the strict tee
           zone and nothing else. */
        guard let last = lastGreen, let back = distance(from: fix, to: last), back > Self.greenReleaseM else { return false }
        let reaches = [next.tee, next.green].compactMap { $0 }.compactMap { distance(from: fix, to: $0) }
        guard let nearest = reaches.min() else { return false }
        return nearest <= reachM
    }

    /* Green focus, decided. Position and nothing else, with one exception: a
     * shot that is still locked has to have been PLAYED first, or the green
     * would snatch the screen back from an aim the player is still making. */
    func shouldFocusGreen(fix: Coordinate, hole: Hole?, locked: Bool) -> Bool {
        guard let hole, let green = hole.green else { return false }
        if greenClosed == hole.number { return false }
        guard let d = distance(from: fix, to: green), d <= Self.greenFocusM else { return false }
        guard locked else { return true }
        guard let from = lockedAtGreenM else { return false }
        return (from - d) >= Self.greenApproachM
    }

    // --------------------------------------------------------------- actions

    private mutating func openGreen(on hole: Hole?, ball point: Coordinate?) {
        face = .greenFocus
        self.hole = hole?.number
        ball = point
        ballPlaced = false
    }

    /// The player drags the ball to where the shot actually finished.
    @discardableResult
    public mutating func moveBall(to point: Coordinate) -> Effect? {
        guard face == .greenFocus else { return nil }
        ball = point
        ballPlaced = true
        return .ballMoved(point)
    }

    /// Close the green without saying the hole is over — reading it, or wanting
    /// the hole back. Remembered, because focus is positional and would
    /// otherwise reopen on the very next fix.
    public mutating func dismissGreen() {
        guard face == .greenFocus else { return }
        greenClosed = hole
        face = .playing
        ball = nil
        ballPlaced = false
    }

    /// "That's me." Closes the shot the phone has open, if it has one, and
    /// moves to the holding screen with the score already at par.
    public mutating func complete(hole current: Hole?, logShot: Bool) -> [Effect] {
        var effects: [Effect] = []
        if face == .greenFocus, ballPlaced, let ball { effects.append(.ballMoved(ball)) }
        if logShot { effects.append(.logFinish) }
        let number = current?.number ?? hole
        face = .holeComplete
        hole = number
        ball = nil
        ballPlaced = false
        greenClosed = nil
        lastGreen = current?.green ?? lastGreen
        score = current?.par
        if let number { effects.append(.holeComplete(hole: number)) }
        return effects
    }

    /// The + and the -. The floor is one shot, the same floor Marshal applies
    /// to the same press coming off the phone.
    @discardableResult
    public mutating func stepScore(_ delta: Int) -> Effect? {
        guard face == .holeComplete, let hole else { return nil }
        let base = score ?? 0
        let next = max(1, base + delta)
        guard next != score else { return nil }
        score = next
        return .stepScore(hole: hole, delta: delta)
    }

    /// Queue the next hole up. It is previewed, never played: the wrist has no
    /// more right than the phone to decide you are standing on a tee you have
    /// not reached.
    @discardableResult
    public mutating func queue(_ next: Hole) -> Effect {
        face = .queued
        hole = next.number
        score = nil
        ball = nil
        ballPlaced = false
        greenClosed = nil
        lockedAtGreenM = nil
        return .advance(hole: next.number)
    }

    /// Play this hole — pressed, or walked into. Both are the same commitment,
    /// which is why they are the same function.
    @discardableResult
    public mutating func play(hole next: Hole) -> Effect {
        face = .playing
        hole = next.number
        score = nil
        ball = nil
        ballPlaced = false
        greenClosed = nil
        lockedAtGreenM = nil
        lastGreen = nil
        wasLocked = false
        return .play(hole: next.number)
    }

    /// Back out of a screen without changing the round. Answers false when
    /// there was nothing to close, so the caller can fall through to whatever
    /// Back means next.
    @discardableResult
    public mutating func back() -> Bool {
        switch face {
        case .greenFocus: dismissGreen(); return true
        case .holeComplete: face = .playing; return true
        case .queued: return false
        case .playing: return false
        }
    }

    /// The round moved underneath us — the phone started a different hole, or
    /// the player used the picker. The wrist follows without argument: it owns
    /// its screens, never which hole is being played.
    public mutating func follow(hole number: Int?) {
        guard hole != number else { return }
        face = .playing
        hole = number
        ball = nil
        ballPlaced = false
        score = nil
        greenClosed = nil
        lockedAtGreenM = nil
        lastGreen = nil
        wasLocked = false
    }

    private func distance(from: Coordinate, to: Coordinate?) -> Double? {
        guard let to else { return nil }
        let d = Geo.distance(from, to)
        return d.isFinite ? d : nil
    }
}
