import XCTest
@testable import WatchBubbleEngine

/* The bag/profile snapshot fingerprint, held to the same cases as the phone.
 *
 * This one is not a nicety. The wrist RECOMPUTES the fingerprint from the
 * contents of an arriving snapshot and refuses one that does not match its own
 * answer — that check is what stops a payload which lost clubs crossing the
 * Capacitor bridge, the plist encoding and the radio from being cached and
 * played on, and a silently short bag picks the wrong club for every shot of
 * the round.
 *
 * The consequence is that a disagreement between this implementation and
 * app/js/watch-player-delivery.js is not cosmetic drift: the wrist would reject
 * every bag the phone ever sends, and nothing would say why. So both read the
 * same cases out of dev/fixtures/bubble-engine-parity.json.
 */
final class PlayerSnapshotParityTests: XCTestCase {

    struct Fixture: Decodable {
        let playerFingerprints: Section

        struct Section: Decodable {
            let engineVersion: String
            let cases: [Case]
        }
        struct Case: Decodable {
            let name: String
            let why: String
            let expect: Expect
        }
        struct Expect: Decodable {
            let fingerprint: String
            let clubs: [Club]
            let isGhost: Bool
            let bubble: Bubble

            struct Club: Decodable { let club: String; let carryM: Double; let totalM: Double }
            struct Bubble: Decodable { let handedness: String; let offsetDeg: Double? }
        }
    }

    func loadFixture() throws -> Fixture {
        let url = try BubbleEngineParityTests.fixtureURL()
        return try JSONDecoder().decode(Fixture.self, from: try Data(contentsOf: url))
    }

    /* Rebuilds each case from the CONTENTS the phone recorded and requires the
       identical string. Deliberately built from `expect.clubs` rather than from
       the raw input bag: this test is about the fingerprint function, and
       feeding it the phone's own normalised output isolates that from bag
       normalisation, which the JavaScript side already covers. */
    func testFingerprintsMatchTheJavaScriptImplementation() throws {
        let fixture = try loadFixture()
        XCTAssertGreaterThanOrEqual(fixture.playerFingerprints.cases.count, 6,
                                    "the corners of this one are cheap and the failure mode is total")

        for entry in fixture.playerFingerprints.cases {
            let bag = WatchBagSnapshot(
                version: 1,
                clubs: entry.expect.clubs.map { WatchClub(club: $0.club, carryM: $0.carryM, totalM: $0.totalM) },
                isGhost: entry.expect.isGhost
            )
            let bubble = WatchBubbleProfile(
                version: 1,
                offsetDeg: entry.expect.bubble.offsetDeg,
                handedness: .init(lenient: entry.expect.bubble.handedness)
            )
            let actual = WatchPlayerSnapshot.fingerprint(
                bag: bag, bubble: bubble, engineVersion: fixture.playerFingerprints.engineVersion)
            XCTAssertEqual(actual, entry.expect.fingerprint, "\(entry.name): \(entry.why)")
        }
    }

    /* A snapshot verifies its own contents. This is the check that makes a
       truncated payload a rejection rather than a wrong bag. */
    func testSnapshotVerifiesItsOwnFingerprint() throws {
        let bag = WatchBagSnapshot(version: 1, clubs: [
            WatchClub(club: "Driver", carryM: 205, totalM: 228),
            WatchClub(club: "7i", carryM: 138, totalM: 148)
        ], isGhost: false)
        let bubble = WatchBubbleProfile(version: 1, offsetDeg: 3.2, handedness: .right)
        let good = WatchPlayerSnapshot(
            version: 1,
            fingerprint: WatchPlayerSnapshot.fingerprint(bag: bag, bubble: bubble, engineVersion: "bubble-engine-v1"),
            bag: bag, bubble: bubble, engineVersion: "bubble-engine-v1")
        XCTAssertTrue(good.isUsable)

        /* A club lost in transit, with the fingerprint the full bag had. This
           is the exact shape of the failure the check exists for. */
        let short = WatchPlayerSnapshot(
            version: 1, fingerprint: good.fingerprint,
            bag: WatchBagSnapshot(version: 1, clubs: [WatchClub(club: "Driver", carryM: 205, totalM: 228)], isGhost: false),
            bubble: bubble, engineVersion: "bubble-engine-v1")
        XCTAssertFalse(short.isUsable, "a bag that lost a club must not pass as the bag it claims to be")

        /* The aim quietly replaced by a fabricated zero. */
        let zeroed = WatchPlayerSnapshot(
            version: 1, fingerprint: good.fingerprint, bag: bag,
            bubble: WatchBubbleProfile(version: 1, offsetDeg: 0, handedness: .right),
            engineVersion: "bubble-engine-v1")
        XCTAssertFalse(zeroed.isUsable)

        /* Right numbers, wrong engine. */
        let otherEngine = WatchPlayerSnapshot(
            version: 1, fingerprint: good.fingerprint, bag: bag, bubble: bubble, engineVersion: "bubble-engine-v2")
        XCTAssertFalse(otherEngine.isUsable, "the engine version is in the fingerprint on purpose")

        let futureSchema = WatchPlayerSnapshot(
            version: 2, fingerprint: good.fingerprint, bag: bag, bubble: bubble, engineVersion: "bubble-engine-v1")
        XCTAssertFalse(futureSchema.isUsable)

        let empty = WatchPlayerSnapshot(
            version: 1,
            fingerprint: WatchPlayerSnapshot.fingerprint(
                bag: WatchBagSnapshot(version: 1, clubs: [], isGhost: false), bubble: bubble, engineVersion: "bubble-engine-v1"),
            bag: WatchBagSnapshot(version: 1, clubs: [], isGhost: false),
            bubble: bubble, engineVersion: "bubble-engine-v1")
        XCTAssertFalse(empty.isUsable, "an empty bag would let the wrist compute against nothing")
    }

    /* Absent and zero are different aims, and the fingerprint has to say so —
       the same distinction the payload preserves by omitting the field. */
    func testAbsentAimAndSavedZeroDoNotShareAFingerprint() {
        let bag = WatchBagSnapshot(version: 1, clubs: [WatchClub(club: "Driver", carryM: 205, totalM: 228)], isGhost: false)
        let absent = WatchPlayerSnapshot.fingerprint(
            bag: bag, bubble: WatchBubbleProfile(version: 1, offsetDeg: nil, handedness: .right), engineVersion: "e")
        let zero = WatchPlayerSnapshot.fingerprint(
            bag: bag, bubble: WatchBubbleProfile(version: 1, offsetDeg: 0, handedness: .right), engineVersion: "e")
        XCTAssertNotEqual(absent, zero)
        XCTAssertTrue(absent.contains("b:-:right"), absent)
        XCTAssertTrue(zero.contains("b:0.00:right"), zero)
    }

    /* A snapshot round-trips through the wire encoding the phone actually
       uses — an omitted offset must decode as nil rather than defaulting to
       zero, which is how a fabricated aim would get back in on this side. */
    func testWireDecodeKeepsAnOmittedAimAbsent() throws {
        let json = """
        {"version":1,"fingerprint":"x","engineVersion":"bubble-engine-v1",
         "bag":{"version":1,"isGhost":false,"clubs":[{"club":"Driver","carryM":205,"totalM":228}]},
         "bubble":{"version":1,"handedness":"right"}}
        """
        let snapshot = try JSONDecoder().decode(WatchPlayerSnapshot.self, from: Data(json.utf8))
        XCTAssertNil(snapshot.bubble.offsetDeg, "an omitted aim must stay absent through the wire")
        XCTAssertEqual(snapshot.bubble.effectiveOffsetDeg, 0, "and still play as 0.0 degrees")
        XCTAssertFalse(snapshot.isUsable, "the placeholder fingerprint must not verify")
    }

    func testInventoryReportsWhatIsHeld() {
        let bag = WatchBagSnapshot(version: 1, clubs: [WatchClub(club: "Driver", carryM: 205, totalM: 228)], isGhost: false)
        let bubble = WatchBubbleProfile(version: 1, offsetDeg: nil, handedness: .right)
        let snapshot = WatchPlayerSnapshot(
            version: 1,
            fingerprint: WatchPlayerSnapshot.fingerprint(bag: bag, bubble: bubble, engineVersion: "bubble-engine-v1"),
            bag: bag, bubble: bubble, engineVersion: "bubble-engine-v1")
        XCTAssertEqual(snapshot.inventory["fingerprint"], snapshot.fingerprint)
    }
}
