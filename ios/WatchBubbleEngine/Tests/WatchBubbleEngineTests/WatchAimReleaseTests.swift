import XCTest
@testable import WatchBubbleEngine

/* Walking off a locked shot, driven at a desk.
 *
 * The rule is deliberately NOT Marshal's thirty metres — see WatchAimRelease —
 * so nothing here asserts a shared constant. What it does assert is that the
 * five-metre rule cannot fire on a fix nobody should be measuring with, and
 * cannot fire twice for one lock. */
final class WatchAimReleaseTests: XCTestCase {

    private let lockPoint = Coordinate(lat: -36.9174, lng: 174.7400)

    private func offset(_ base: Coordinate, north: Double) -> Coordinate {
        Coordinate(lat: base.lat + north / 111_320, lng: base.lng)
    }

    /// A shot locked at `lockPoint`, with the anchor already taken.
    private func held() -> WatchAimRelease {
        var rule = WatchAimRelease()
        XCTAssertFalse(rule.update(locked: true, settled: true, at: lockPoint, fix: lockPoint, accuracyM: 5))
        XCTAssertEqual(rule.anchor, lockPoint)
        return rule
    }

    // ----------------------------------------------------------------- rules

    func testTheThresholdIsFiveMetresAndIsNotMarshals() {
        XCTAssertEqual(WatchAimRelease.thresholdM, 5)
        XCTAssertNotEqual(WatchAimRelease.thresholdM, 30, "Marshal's phone rule must not leak into the wrist's")
    }

    func testAccuracyGateIsTighterThanTheTransports() {
        XCTAssertEqual(WatchAimRelease.maximumAccuracyM, 25)
        XCTAssertLessThan(WatchAimRelease.maximumAccuracyM, 100,
                          "a fix good enough to draw a player is not good enough to measure five metres")
    }

    // ---------------------------------------------------------------- firing

    func testReleasesOnceThePlayerHasWalkedPastFiveMetres() {
        var rule = held()
        XCTAssertFalse(rule.update(locked: true, settled: true, at: lockPoint,
                                   fix: offset(lockPoint, north: -4), accuracyM: 5),
                       "four metres is still standing over the shot")
        XCTAssertTrue(rule.update(locked: true, settled: true, at: lockPoint,
                                  fix: offset(lockPoint, north: -9), accuracyM: 5))
    }

    func testFiresOnASingleFixBecauseTheDistanceFilterGivesNoSecond() {
        /* CoreLocation on the wrist delivers on a five-metre filter, so a
           player who steps six metres and stops gets exactly one fix. A rule
           that waited for a second would never fire for a walk to a ball. */
        var rule = held()
        XCTAssertTrue(rule.update(locked: true, settled: true, at: lockPoint,
                                  fix: offset(lockPoint, north: -6), accuracyM: 8))
    }

    func testFiresOnlyOncePerLock() {
        var rule = held()
        XCTAssertTrue(rule.update(locked: true, settled: true, at: lockPoint,
                                  fix: offset(lockPoint, north: -20), accuracyM: 5))
        XCTAssertFalse(rule.update(locked: true, settled: true, at: lockPoint,
                                   fix: offset(lockPoint, north: -60), accuracyM: 5),
                       "one UNLOCK per lock — the phone is already letting go")
        XCTAssertTrue(rule.released)
    }

    func testUnlockingRearmsForTheNextShot() {
        var rule = held()
        XCTAssertTrue(rule.update(locked: true, settled: true, at: lockPoint,
                                  fix: offset(lockPoint, north: -20), accuracyM: 5))
        /* The shot is no longer locked: the rule forgets it entirely. */
        XCTAssertFalse(rule.update(locked: false, settled: false, at: nil, fix: nil, accuracyM: nil))
        XCTAssertNil(rule.anchor)
        XCTAssertFalse(rule.released)

        let next = offset(lockPoint, north: -25)
        XCTAssertFalse(rule.update(locked: true, settled: true, at: next, fix: next, accuracyM: 5))
        XCTAssertEqual(rule.anchor, next, "the new shot anchors where IT was locked")
        XCTAssertTrue(rule.update(locked: true, settled: true, at: next,
                                  fix: offset(next, north: -7), accuracyM: 5))
    }

    func testAButtonPressStandsDownTheWalkAwayForThatShot() {
        var rule = held()
        /* The player pressed UNLOCK. The Scene still says locked until the
           phone catches up, and the player is already walking. */
        rule.markReleased()
        XCTAssertFalse(rule.update(locked: true, settled: true, at: lockPoint,
                                   fix: offset(lockPoint, north: -30), accuracyM: 5),
                       "a second UNLOCK for a shot already being let go")
        /* Once the phone has actually let go, the next lock is watched again. */
        XCTAssertFalse(rule.update(locked: false, settled: false, at: nil, fix: nil, accuracyM: nil))
        let next = offset(lockPoint, north: -40)
        XCTAssertFalse(rule.update(locked: true, settled: true, at: next, fix: next, accuracyM: 5))
        XCTAssertTrue(rule.update(locked: true, settled: true, at: next,
                                  fix: offset(next, north: -8), accuracyM: 5))
    }

    // ------------------------------------------------------------- restraint

    func testACoarseFixCannotUnlockAShotSomebodyIsStandingOver() {
        var rule = held()
        /* Sixty metres of uncertainty reading as twenty metres of movement is
           the exact failure this gate exists for. */
        XCTAssertFalse(rule.update(locked: true, settled: true, at: lockPoint,
                                   fix: offset(lockPoint, north: -20), accuracyM: 60))
        XCTAssertFalse(rule.update(locked: true, settled: true, at: lockPoint,
                                   fix: offset(lockPoint, north: -20), accuracyM: -1),
                       "CoreLocation's negative accuracy means it does not stand behind the fix")
        XCTAssertFalse(rule.update(locked: true, settled: true, at: lockPoint,
                                   fix: offset(lockPoint, north: -20), accuracyM: nil))
    }

    func testNothingIsSentWhileTheLockIsStillInFlight() {
        var rule = held()
        XCTAssertFalse(rule.update(locked: true, settled: false, at: lockPoint,
                                   fix: offset(lockPoint, north: -20), accuracyM: 5),
                       "an UNLOCK against a LOCK the phone has not accepted is the race, not the fix")
        XCTAssertFalse(rule.released, "and it stays armed for when the phone catches up")
        XCTAssertTrue(rule.update(locked: true, settled: true, at: lockPoint,
                                  fix: offset(lockPoint, north: -20), accuracyM: 5))
    }

    func testAnchorsOnTheLockPointRatherThanWhereTheFirstFixFoundYou() {
        var rule = WatchAimRelease()
        let alreadyWalking = offset(lockPoint, north: -4)
        XCTAssertFalse(rule.update(locked: true, settled: true, at: lockPoint,
                                   fix: alreadyWalking, accuracyM: 5))
        XCTAssertEqual(rule.anchor, lockPoint)
        /* Measured from the lock, nine metres out is a release. Measured from
           the first fix it would only be five, and the shot would hang on. */
        XCTAssertTrue(rule.update(locked: true, settled: true, at: lockPoint,
                                  fix: offset(lockPoint, north: -9), accuracyM: 5))
    }

    func testFallsBackToTheFirstTrustworthyFixWhenTheWristDidNotComputeTheLock() {
        var rule = WatchAimRelease()
        /* The phone locked it: there is no local Bubble and so no lock point.
           A coarse fix must not become the anchor either. */
        XCTAssertFalse(rule.update(locked: true, settled: true, at: nil, fix: lockPoint, accuracyM: 80))
        XCTAssertNil(rule.anchor, "a fix too coarse to measure with is too coarse to anchor with")
        XCTAssertFalse(rule.update(locked: true, settled: true, at: nil, fix: lockPoint, accuracyM: 6))
        XCTAssertEqual(rule.anchor, lockPoint)
        XCTAssertTrue(rule.update(locked: true, settled: true, at: nil,
                                  fix: offset(lockPoint, north: -7), accuracyM: 6))
    }

    func testNoFixAtAllSimplyLeavesThePlayerTheButton() {
        var rule = WatchAimRelease()
        XCTAssertFalse(rule.update(locked: true, settled: true, at: nil, fix: nil, accuracyM: nil))
        XCTAssertNil(rule.anchor)
        XCTAssertFalse(rule.released)
    }
}
