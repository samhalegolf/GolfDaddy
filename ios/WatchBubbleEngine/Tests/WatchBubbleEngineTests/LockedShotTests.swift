import XCTest
@testable import WatchBubbleEngine

/* The locked shot's lifecycle.
 *
 * The record itself is trivial — a club, a distance, two coordinates. What
 * needs testing is when it STOPS being shown, because a record that outlives
 * its own uncertainty is a shot the player believes is logged and is not.
 *
 * There are exactly three ways out, and each has its own way of going wrong:
 * a rejection that does not clear it leaves a lock that never happened on
 * screen; a Scene check that never fires leaves the wrist's guess overriding
 * the truth that has since arrived; and an expiry that is missing turns any bug
 * in the other two from twenty seconds of a wrong screen into a whole round of
 * one.
 */
final class LockedShotTests: XCTestCase {

    private let round = "round-1"
    private let player = Coordinate(lat: -36.9157, lng: 174.7398)
    private let target = Coordinate(lat: -36.9169, lng: 174.7393)

    private func shot(baseRevision: Int = 10, created: Date = Date()) -> WatchLockedShot {
        WatchLockedShot(
            commandId: "cmd-1", roundId: round, baseRevision: baseRevision, holeNumber: 7,
            player: player, target: target, club: "7i", targetDistanceM: 140.6,
            widthM: 22, depthM: 28.8, tiltDeg: 6.71,
            engineVersion: BubbleEngineVersion.current, createdAt: created)
    }

    // MARK: - While it is genuinely unconfirmed

    func testItShowsWhileItsCommandIsStillQueued() {
        XCTAssertTrue(shot().isStillShowing(roundId: round, sceneRevision: 10, commandStillPending: true))
    }

    /* Acknowledged but not yet visible in a Scene. The command has left the
       outbox and the Scene has not moved — the gap this record exists for. */
    func testItShowsAfterTheAcknowledgementAndBeforeTheScene() {
        XCTAssertTrue(shot().isStillShowing(roundId: round, sceneRevision: 10, commandStillPending: false))
    }

    // MARK: - Ending 1: the Scene catches up

    func testItStopsWhenTheSceneMovesPastTheLock() {
        XCTAssertFalse(shot(baseRevision: 10)
            .isStillShowing(roundId: round, sceneRevision: 11, commandStillPending: false),
            "once the Scene reflects the outcome, the authoritative answer takes over")
        /* Even while the command is somehow still queued: the Scene is truth
           and the local record has nothing left to add. */
        XCTAssertFalse(shot(baseRevision: 10)
            .isStillShowing(roundId: round, sceneRevision: 11, commandStillPending: true))
    }

    func testTheSameRevisionIsNotYetConfirmation() {
        XCTAssertTrue(shot(baseRevision: 10)
            .isStillShowing(roundId: round, sceneRevision: 10, commandStillPending: false),
            "the Scene has not moved, so it cannot be reflecting this lock yet")
    }

    // MARK: - Ending 2: the round changes

    func testALockBelongsToTheRoundItWasMadeIn() {
        XCTAssertFalse(shot().isStillShowing(roundId: "round-2", sceneRevision: 1, commandStillPending: true))
        XCTAssertFalse(shot().isStillShowing(roundId: nil, sceneRevision: nil, commandStillPending: true),
                       "no round at all is not this round")
    }

    // MARK: - Ending 3: expiry, the backstop

    func testItStopsClaimingAfterTheMaximumAge() {
        let old = Date().addingTimeInterval(-(WatchLockedShot.maximumUnconfirmedAge + 1))
        XCTAssertFalse(shot(created: old)
            .isStillShowing(roundId: round, sceneRevision: 10, commandStillPending: true),
            "a lock nothing has confirmed must not be claimed forever")
    }

    func testItStillShowsJustInsideTheMaximumAge() {
        let recent = Date().addingTimeInterval(-(WatchLockedShot.maximumUnconfirmedAge - 2))
        XCTAssertTrue(shot(created: recent)
            .isStillShowing(roundId: round, sceneRevision: 10, commandStillPending: true))
    }

    /* The expiry must be reachable by a wedged link, and short enough that a
       player glancing down mid-hole is not still being told a stale story. */
    func testTheExpiryIsBoundedSensibly() {
        XCTAssertGreaterThanOrEqual(WatchLockedShot.maximumUnconfirmedAge, 5)
        XCTAssertLessThanOrEqual(WatchLockedShot.maximumUnconfirmedAge, 60)
    }

    // MARK: - No Scene at all

    /* A wrist with no Scene has nothing to be superseded by, and no evidence
       the lock landed either. It shows only while the command is still queued —
       once that has gone with nothing having arrived, there is nothing left
       supporting the claim. */
    func testWithNoSceneItShowsOnlyWhileQueued() {
        XCTAssertFalse(shot().isStillShowing(roundId: round, sceneRevision: nil, commandStillPending: false))
        /* The round guard runs first, so a nil round id fails regardless — this
           is the case where the round is known but no Scene revision is. */
        XCTAssertTrue(shot().isStillShowing(roundId: round, sceneRevision: nil, commandStillPending: true))
    }

    // MARK: - What it records

    /* Built from a Bubble the wrist computed, and it must carry that Bubble's
       own answers rather than anything the phone said — the phone has not
       answered yet, and its stale numbers under a "locked" heading would be the
       one genuinely misleading thing this could show. */
    func testItRecordsTheWristsOwnAnswer() throws {
        let bag = WatchBagSnapshot(version: 1, clubs: [
            WatchClub(club: "Driver", carryM: 205, totalM: 228),
            WatchClub(club: "7i", carryM: 138, totalM: 148)
        ], isGhost: false)
        let bubble = try XCTUnwrap(BubbleEngine.calculate(.init(
            player: player, target: target, bag: bag,
            bubble: WatchBubbleProfile(version: 1, offsetDeg: 3.2, handedness: .right))))

        let locked = WatchLockedShot(commandId: "cmd-9", roundId: round, baseRevision: 4,
                                     holeNumber: 7, bubble: bubble, player: player)
        XCTAssertEqual(locked.club, bubble.club.club)
        XCTAssertEqual(locked.targetDistanceM, bubble.targetDistanceM)
        XCTAssertEqual(locked.target, bubble.target)
        XCTAssertEqual(locked.widthM, bubble.widthM)
        XCTAssertEqual(locked.engineVersion, BubbleEngineVersion.current,
                       "which engine produced it travels with it")
        XCTAssertEqual(locked.commandId, "cmd-9", "the command id is the reconciliation key")
    }

    /* It survives a relaunch — the outbox does, and a lock that vanished while
       its command did not would leave the wrist waiting with no explanation. */
    func testItRoundTripsThroughItsWireEncoding() throws {
        let original = shot()
        let decoded = try JSONDecoder().decode(
            WatchLockedShot.self, from: try JSONEncoder().encode(original))
        XCTAssertEqual(decoded, original)
    }
}
