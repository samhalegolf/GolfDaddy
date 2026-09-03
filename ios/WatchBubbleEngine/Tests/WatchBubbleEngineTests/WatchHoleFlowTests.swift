import XCTest
@testable import WatchBubbleEngine

/* The wrist's own way through a hole, driven at a desk.
 *
 * Every rule here has a twin in app/js/marshal.js and a twin check in
 * dev/marshal.test.js. Where a number appears in both, it is asserted rather
 * than used, so the pair cannot drift apart quietly. */
final class WatchHoleFlowTests: XCTestCase {

    private func offset(_ base: Coordinate, north: Double, east: Double = 0) -> Coordinate {
        Coordinate(lat: base.lat + north / 111_320,
                   lng: base.lng + east / (111_320 * cos(base.lat * .pi / 180)))
    }

    private let tee = Coordinate(lat: -36.9174, lng: 174.7400)
    private var green: Coordinate { offset(tee, north: -300) }
    private var nextTee: Coordinate { offset(tee, north: -340, east: 60) }

    private var hole1: WatchHoleFlow.Hole { .init(number: 1, par: 4, tee: tee, green: green) }
    private var hole2: WatchHoleFlow.Hole {
        .init(number: 2, par: 5, tee: nextTee, green: offset(tee, north: -640, east: 60))
    }

    // ----------------------------------------------------------------- rules

    func testConstantsMatchTheMarshal() {
        XCTAssertEqual(WatchHoleFlow.greenFocusM, 40)
        XCTAssertEqual(WatchHoleFlow.greenReleaseM, 45)
        XCTAssertEqual(WatchHoleFlow.greenApproachM, 10)
        XCTAssertEqual(WatchHoleFlow.teeZoneM, 30)
    }

    // ------------------------------------------------- arriving by bag reach

    /// Walk the flow to a queued hole 2, having completed hole 1 on its green.
    private func queuedAfterFinishingHoleOne() -> WatchHoleFlow {
        var flow = WatchHoleFlow()
        flow.update(fix: green, hole: hole1, next: hole2, locked: false)
        XCTAssertEqual(flow.face, .greenFocus)
        _ = flow.complete(hole: hole1, logShot: false)
        _ = flow.queue(hole2)
        XCTAssertEqual(flow.face, .queued)
        return flow
    }

    /* A tee the package has in the wrong place, or a tee box nobody mapped:
       thirty metres never arrives and the queued screen is a dead end. */
    func testAReachableHoleStartsEvenWhenTheTeeIsNowhereNear() {
        var flow = queuedAfterFinishingHoleOne()
        /* 120m off hole 2's tee - far outside the tee zone, and 160m from the
           green just left, so the walk has plainly happened. */
        let offPiste = offset(nextTee, north: -120)
        XCTAssertGreaterThan(WatchHoleFlow.metres(offPiste, nextTee)!, WatchHoleFlow.teeZoneM)
        let effect = flow.update(fix: offPiste, hole: nil, next: hole2, locked: false, reachM: 230)
        XCTAssertEqual(effect, .play(hole: 2), "a bag that reaches the hole says you are on it")
        XCTAssertEqual(flow.face, .playing)
    }

    /* The trap the fallback has to avoid: from the green you have just putted
       out on, the next tee is well inside a driver. Reach alone would start the
       next hole while you were still picking the ball out of the cup. */
    func testReachDoesNotStartTheNextHoleWhileStillOnTheLastGreen() {
        var flow = queuedAfterFinishingHoleOne()
        XCTAssertLessThan(WatchHoleFlow.metres(green, nextTee)!, 230, "the next tee IS within a driver of the last green")
        let effect = flow.update(fix: green, hole: nil, next: hole2, locked: false, reachM: 230)
        XCTAssertNil(effect, "the walk to the tee is what this screen is for")
        XCTAssertEqual(flow.face, .queued)
    }

    func testAHoleNoClubCanReachIsNotTheHoleYouAreStandingOn() {
        var flow = queuedAfterFinishingHoleOne()
        let milesAway = offset(nextTee, north: -900)
        XCTAssertNil(flow.update(fix: milesAway, hole: nil, next: hole2, locked: false, reachM: 230))
        XCTAssertEqual(flow.face, .queued)
    }

    func testWithoutABagTheStrictTeeZoneStillRules() {
        var flow = queuedAfterFinishingHoleOne()
        let offPiste = offset(nextTee, north: -120)
        XCTAssertNil(flow.update(fix: offPiste, hole: nil, next: hole2, locked: false, reachM: nil))
        XCTAssertEqual(flow.face, .queued)
        _ = flow.update(fix: offset(nextTee, north: -10), hole: nil, next: hole2, locked: false, reachM: nil)
        XCTAssertEqual(flow.face, .playing, "and the tee zone still works on its own")
    }

    /* A hole queued mid-round has no completed green behind it, so there is no
       walk to have finished and nothing for reach to be a fallback FOR. */
    func testAHoleQueuedMidRoundKeepsTheStrictTeeZone() {
        var flow = WatchHoleFlow()
        _ = flow.queue(hole2)
        let offPiste = offset(nextTee, north: -120)
        XCTAssertNil(flow.update(fix: offPiste, hole: nil, next: hole2, locked: false, reachM: 230))
        XCTAssertEqual(flow.face, .queued)
    }

    // ---------------------------------------------------------- green focus

    /* From a real round: putt out, "That's me", Next hole, Play - and the wrist
       snapped straight back to the green of the hole just finished, over and
       over, because the player was still standing on it and the phone's Scene
       had not caught up. Moving on is behind a deliberate button; once it has
       been pressed, position is not entitled to argue. */
    func testAStartedHoleIsNotDraggedBackToTheGreenBehindIt() {
        var flow = WatchHoleFlow()
        let onGreen = offset(green, north: 5)
        flow.update(fix: onGreen, hole: hole1, next: hole2, locked: false)
        XCTAssertEqual(flow.face, .greenFocus)
        _ = flow.complete(hole: hole1, logShot: false)
        _ = flow.queue(hole2)
        _ = flow.play(hole: hole2)
        XCTAssertEqual(flow.face, .playing)
        XCTAssertEqual(flow.hole, 2)
        /* The phone still says hole 1 - its ADVANCE and PLAY are in flight, or
           were rejected - and the feet have not moved. */
        flow.update(fix: onGreen, hole: hole1, next: nil, locked: false)
        XCTAssertEqual(flow.face, .playing, "the hole just started must not be replaced by the green just left")
        XCTAssertEqual(flow.hole, 2)
    }

    func testTheGreenStillOpensOnceThePhoneAgreesWhichHoleIsBeingPlayed() {
        var flow = WatchHoleFlow()
        _ = flow.play(hole: hole2)
        let onSecondGreen = offset(hole2.green!, north: 8)
        flow.update(fix: onSecondGreen, hole: hole2, next: nil, locked: false)
        XCTAssertEqual(flow.face, .greenFocus, "agreeing surfaces still get green focus, on position alone")
        XCTAssertEqual(flow.hole, 2)
    }

    func testGreenFocusOpensOnPositionAloneWithNothingLocked() {
        var flow = WatchHoleFlow()
        flow.update(fix: offset(green, north: 10), hole: hole1, next: nil, locked: false)
        XCTAssertEqual(flow.face, .greenFocus)
        XCTAssertNotNil(flow.ball, "there is always something to drag")
    }

    func testGreenFocusStaysAwayUntilTheBandIsReached() {
        var flow = WatchHoleFlow()
        flow.update(fix: offset(green, north: 60), hole: hole1, next: nil, locked: false)
        XCTAssertEqual(flow.face, .playing)
    }

    /* The case the whole change is named after: a chip locked from inside the
       aim-release radius. The bubble has to survive standing over it, and has
       to give way once the shot has plainly been played. */
    func testALockedChipKeepsTheBubbleUntilItIsPlayed() {
        var flow = WatchHoleFlow()
        flow.update(fix: offset(green, north: 25), hole: hole1, next: nil, locked: false)
        flow.dismissGreen()
        flow.update(fix: offset(green, north: 25), hole: hole1, next: nil, locked: true)
        XCTAssertEqual(flow.face, .playing, "still deciding")
        flow.update(fix: offset(green, north: 24), hole: hole1, next: nil, locked: true)
        XCTAssertEqual(flow.face, .playing, "a metre of jitter is not a shot")
        flow.update(fix: offset(green, north: 4), hole: hole1, next: nil, locked: true)
        XCTAssertEqual(flow.face, .greenFocus, "twenty metres of ground is")
    }

    func testAClosedGreenStaysClosedUntilYouLeaveIt() {
        var flow = WatchHoleFlow()
        flow.update(fix: offset(green, north: 10), hole: hole1, next: nil, locked: false)
        flow.dismissGreen()
        flow.update(fix: offset(green, north: 12), hole: hole1, next: nil, locked: false)
        XCTAssertEqual(flow.face, .playing, "still standing there")
        flow.update(fix: offset(green, north: 60), hole: hole1, next: nil, locked: false)
        flow.update(fix: offset(green, north: 15), hole: hole1, next: nil, locked: false)
        XCTAssertEqual(flow.face, .greenFocus, "a new arrival is a new answer")
    }

    func testAPlacedBallStopsFollowingTheFix() {
        var flow = WatchHoleFlow()
        flow.update(fix: offset(green, north: 20), hole: hole1, next: nil, locked: false)
        let placed = offset(green, north: 3)
        XCTAssertEqual(flow.moveBall(to: placed), .ballMoved(placed))
        flow.update(fix: offset(green, north: 18), hole: hole1, next: nil, locked: false)
        XCTAssertEqual(flow.ball, placed, "the ball is where the player put it")
    }

    // -------------------------------------------------------- holding screen

    func testCompleteOpensTheHoldingScreenAtPar() {
        var flow = WatchHoleFlow()
        flow.update(fix: offset(green, north: 6), hole: hole1, next: nil, locked: true)
        let effects = flow.complete(hole: hole1, logShot: true)
        XCTAssertEqual(flow.face, .holeComplete)
        XCTAssertEqual(flow.score, 4, "par, untouched")
        XCTAssertTrue(effects.contains(.logFinish))
        XCTAssertTrue(effects.contains(.holeComplete(hole: 1)))
    }

    func testTheStepperCannotGoBelowOneShot() {
        var flow = WatchHoleFlow()
        _ = flow.complete(hole: hole1, logShot: false)
        XCTAssertEqual(flow.stepScore(1), .stepScore(hole: 1, delta: 1))
        XCTAssertEqual(flow.score, 5)
        for _ in 0..<8 { _ = flow.stepScore(-1) }
        XCTAssertEqual(flow.score, 1)
    }

    func testTheHoldingScreenIgnoresPositionEntirely() {
        var flow = WatchHoleFlow()
        _ = flow.complete(hole: hole1, logShot: false)
        flow.update(fix: nextTee, hole: hole1, next: hole2, locked: false)
        XCTAssertEqual(flow.face, .holeComplete, "standing on the next tee changes nothing here")
    }

    // ----------------------------------------------------------- queued hole

    func testQueueingPreviewsAndNeverPlays() {
        var flow = WatchHoleFlow()
        _ = flow.complete(hole: hole1, logShot: false)
        XCTAssertEqual(flow.queue(hole2), .advance(hole: 2))
        XCTAssertEqual(flow.face, .queued)
        XCTAssertEqual(flow.hole, 2)
        /* Standing on the 1st green, 46m from the 2nd tee — outside the tee
           zone, and well inside the arrival radius the old rule would have
           committed on. */
        flow.update(fix: offset(green, north: 6), hole: hole1, next: hole2, locked: false)
        XCTAssertEqual(flow.face, .queued, "not there yet")
    }

    func testWalkingIntoTheTeeZonePressesPlay() {
        var flow = WatchHoleFlow()
        _ = flow.complete(hole: hole1, logShot: false)
        _ = flow.queue(hole2)
        flow.update(fix: offset(nextTee, north: 40), hole: hole1, next: hole2, locked: false)
        XCTAssertEqual(flow.face, .queued, "still walking")
        let effect = flow.update(fix: offset(nextTee, north: -5), hole: hole1, next: hole2, locked: false)
        XCTAssertEqual(effect, .play(hole: 2), "arriving IS the press")
        XCTAssertEqual(flow.face, .playing)
        XCTAssertEqual(flow.hole, 2)
    }

    func testPlayThisHoleWorksFromAnywhere() {
        var flow = WatchHoleFlow()
        _ = flow.complete(hole: hole1, logShot: false)
        _ = flow.queue(hole2)
        XCTAssertEqual(flow.play(hole: hole2), .play(hole: 2))
        XCTAssertEqual(flow.face, .playing)
    }

    /* The wrist owns its screens and never which hole is being played. When the
       phone (or the picker) moves the round, the wrist follows. */
    func testTheWristFollowsTheRoundRatherThanArguingWithIt() {
        var flow = WatchHoleFlow()
        flow.update(fix: offset(green, north: 6), hole: hole1, next: nil, locked: false)
        XCTAssertEqual(flow.face, .greenFocus)
        flow.follow(hole: 7)
        XCTAssertEqual(flow.face, .playing)
        XCTAssertEqual(flow.hole, 7)
    }
}
