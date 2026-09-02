import XCTest
@testable import WatchBubbleEngine

/* Engine properties the parity fixtures cannot express.
 *
 * The fixtures pin the engine's ANSWERS against the phone's. These pin the
 * things that are true of the engine regardless of any particular answer —
 * determinism, the absence of hysteresis, and the JavaScript arithmetic
 * conventions it is built on.
 *
 * The rounding tests exist because a mutation check found the gap: replacing
 * `JS.round` with Swift's `.rounded()` did NOT fail a single parity case, since
 * no recorded value happens to land on an exact half. The difference is real
 * and it is aimed squarely at left-handed players — their cluster tilt is the
 * negation of a right-hander's, so they are the ones who reach negative halves
 * — and it would have sat here undetected until a bag edit moved a number onto
 * one. A fixture cannot be relied on to cover a case nobody chose; this can.
 */
final class BubbleEngineTests: XCTestCase {

    // MARK: - JavaScript arithmetic

    /* Math.round rounds halves toward POSITIVE INFINITY. Swift's .rounded()
       rounds them away from zero. They agree on every positive half and
       disagree on every negative one. */
    func testRoundingFollowsJavaScriptAndNotSwift() {
        XCTAssertEqual(JS.round(0.5), 1)
        XCTAssertEqual(JS.round(1.5), 2)
        XCTAssertEqual(JS.round(2.5), 3, "not banker's rounding either")

        XCTAssertEqual(JS.round(-0.5), 0, "Math.round(-0.5) is 0; Swift's rounded() gives -1")
        XCTAssertEqual(JS.round(-1.5), -1, "Math.round(-1.5) is -1; Swift's rounded() gives -2")
        XCTAssertEqual(JS.round(-2.5), -2)

        XCTAssertNotEqual(JS.round(-0.5), (-0.5).rounded(), "if these ever agree, this test has stopped meaning anything")
    }

    func testDecimalRoundingMatchesGdRound() {
        XCTAssertEqual(JS.round(5.345, 2), 5.35, accuracy: 1e-12)
        XCTAssertEqual(JS.round(-5.345, 2), -5.34, accuracy: 1e-12, "the negative half goes the other way")
        XCTAssertEqual(JS.round(.nan, 2), 0, "gdRound coerces a non-number to 0")
        XCTAssertEqual(JS.round(.infinity, 2), 0)
    }

    /* gdClamp coerces before it clamps: `Number(value)||0`. A NaN lands on 0,
       which may be outside the bounds it was given, and that is the JavaScript's
       behaviour rather than an oversight to tidy. */
    func testClampCoercesBeforeClamping() {
        XCTAssertEqual(JS.clamp(5, 0, 3), 3)
        XCTAssertEqual(JS.clamp(-5, 0, 3), 0)
        XCTAssertEqual(JS.clamp(.nan, 1, 3), 1, "NaN becomes 0, then clamps up to the minimum")
    }

    /* The engine's own bearing has no cosine correction, and that is
       deliberate — it is what the phone lays every Bubble down with. Pinned so
       nobody "fixes" it into a real compass bearing and rotates every Watch
       Bubble away from the phone's. */
    func testEngineBearingIsTheUncorrectedConvention() {
        let a = Coordinate(lat: -36.9134, lng: 174.7411)
        let b = Coordinate(lat: -36.9134, lng: 174.7511)   // due east
        XCTAssertEqual(Geo.bearing(a, b), Double.pi / 2, accuracy: 1e-12,
                       "uncorrected atan2(dLng, dLat) reads a pure longitude change as exactly 90 degrees")
        /* The reported compass bearing IS corrected, and the two differ. */
        XCTAssertEqual(BubbleEngine.compassBearingDeg(from: a, to: b), 90, accuracy: 0.01)
        let north = Coordinate(lat: -36.9034, lng: 174.7411)
        XCTAssertEqual(BubbleEngine.compassBearingDeg(from: a, to: north), 0, accuracy: 0.01)
    }

    // MARK: - Engine properties

    private func bag(_ clubs: [(String, Double, Double)], ghost: Bool = false) -> WatchBagSnapshot {
        WatchBagSnapshot(version: 1, clubs: clubs.map { WatchClub(club: $0.0, carryM: $0.1, totalM: $0.2) }, isGhost: ghost)
    }
    private let player = Coordinate(lat: -36.9157, lng: 174.7398)
    private let target = Coordinate(lat: -36.9169, lng: 174.7393)

    /* Same inputs, same Bubble — the property the whole design rests on. Run
       twice and compare everything, including all 168 ring points. */
    func testTheEngineIsDeterministic() throws {
        let input = BubbleEngine.Input(
            player: player, target: target,
            bag: bag([("Driver", 205, 228), ("7i", 138, 148)]),
            bubble: WatchBubbleProfile(version: 1, offsetDeg: 3.2, handedness: .right))
        let first = try XCTUnwrap(BubbleEngine.calculate(input))
        let second = try XCTUnwrap(BubbleEngine.calculate(input))
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.ring.count, 168)
    }

    /* NO HYSTERESIS IN THE ENGINE. The transition band that stops a dragging
       finger flickering between two clubs belongs to WatchPlayState; if it ever
       leaked in here the engine would stop being a pure function of its inputs
       and the parity fixtures would stop being reproducible.

       Tested by approaching the same distance from both sides: the answer must
       depend only on where the target IS, never on where it has been. */
    func testTheEngineHasNoMemoryOfTheLastClub() throws {
        let clubs = bag([("5i", 155, 167), ("6i", 146, 157), ("7i", 138, 148)])
        let profile = WatchBubbleProfile(version: 1, offsetDeg: 3.2, handedness: .right)
        let near = Coordinate(lat: -36.915578, lng: 174.73998)
        let far = Coordinate(lat: -36.915544, lng: 174.739997)

        let approachingFromNear = [near, far].compactMap {
            BubbleEngine.calculate(.init(player: $0, target: target, bag: clubs, bubble: profile))?.club.club
        }
        let approachingFromFar = [far, near].compactMap {
            BubbleEngine.calculate(.init(player: $0, target: target, bag: clubs, bubble: profile))?.club.club
        }
        XCTAssertEqual(approachingFromNear, approachingFromFar.reversed(),
                       "the club must depend on the target alone, never on the order it was reached")
        XCTAssertNotEqual(approachingFromNear.first, approachingFromNear.last,
                          "these two positions must actually straddle a boundary, or this proves nothing")
    }

    /* An empty bag has no answer. It must not fall back to a stand-in here —
       the phone decides what a ghost bag is and sends one; a wrist inventing
       clubs would present numbers the player has never seen. */
    func testAnEmptyBagProducesNothing() {
        XCTAssertNil(BubbleEngine.calculate(.init(
            player: player, target: target, bag: bag([]),
            bubble: WatchBubbleProfile(version: 1, offsetDeg: nil, handedness: .right))))
    }

    func testAZeroLengthShotProducesNothing() {
        XCTAssertNil(BubbleEngine.calculate(.init(
            player: player, target: player, bag: bag([("7i", 138, 148)]),
            bubble: WatchBubbleProfile(version: 1, offsetDeg: nil, handedness: .right))))
    }

    /* With no My Bubble the Bubble sits ON the target. With one it does not —
       that displacement IS the aim, and a wrist that drew it centred would be
       throwing away the only thing My Bubble contributes. */
    func testTheAimMovesTheBubbleOffTheTarget() throws {
        let clubs = bag([("7i", 138, 148)])
        let centred = try XCTUnwrap(BubbleEngine.calculate(.init(
            player: player, target: target, bag: clubs,
            bubble: WatchBubbleProfile(version: 1, offsetDeg: nil, handedness: .right))))
        let aimed = try XCTUnwrap(BubbleEngine.calculate(.init(
            player: player, target: target, bag: clubs,
            bubble: WatchBubbleProfile(version: 1, offsetDeg: 3.2, handedness: .right))))

        XCTAssertEqual(centred.aimOffsetM, 0, accuracy: 0.01)
        XCTAssertGreaterThan(abs(aimed.aimOffsetM), 5, "3.2 degrees over ~140m is about 8m")
        XCTAssertGreaterThan(Geo.distance(aimed.centre, centred.centre), 5)

        /* And it is measured at the SHOT, not the club's carry: the same aim on
           a longer shot is worth more metres. */
        let longer = Coordinate(lat: -36.9134, lng: 174.7411)
        let far = try XCTUnwrap(BubbleEngine.calculate(.init(
            player: longer, target: target, bag: bag([("Driver", 205, 228)]),
            bubble: WatchBubbleProfile(version: 1, offsetDeg: 3.2, handedness: .right))))
        XCTAssertGreaterThan(abs(far.aimOffsetM), abs(aimed.aimOffsetM),
                             "a carry-based offset would not grow with the shot")
    }

    // MARK: - The default target

    func testTheDefaultTargetIsTheGreenWhenTheBagReachesIt() {
        let green = Coordinate(lat: -36.9169, lng: 174.7393)
        let route = [Coordinate(lat: -36.9134, lng: 174.7411), green]
        let target = BubbleEngine.defaultTarget(
            player: Coordinate(lat: -36.9157, lng: 174.7398), green: green, route: route,
            bag: bag([("Driver", 205, 228)]))
        XCTAssertEqual(target, green)
    }

    /* Out of range, the answer walks the hole's own route rather than the
       straight line — which on a dogleg is through the trees. */
    func testAnOutOfRangeGreenLaysUpAlongTheRoute() throws {
        let tee = Coordinate(lat: -36.9134, lng: 174.7411)
        let green = Coordinate(lat: -36.9169, lng: 174.7393)
        let bend = Coordinate(lat: -36.9145, lng: 174.7403)
        let route = [tee, bend, Coordinate(lat: -36.9157, lng: 174.7398), green]
        let clubs = bag([("9i", 118, 127), ("PW", 103, 108)])

        let layup = try XCTUnwrap(BubbleEngine.defaultTarget(player: tee, green: green, route: route, bag: clubs))
        XCTAssertNotEqual(layup, green)
        XCTAssertLessThanOrEqual(Geo.distance(tee, layup), 127 + 3, "a lay-up must stay inside the bag")
        XCTAssertGreaterThan(Geo.distance(layup, green), 100, "the green is well out of range here")
    }

    /* No route, no answer — and that is the point. The phone gates its
       fairway-line grab on a mapped tee area the wrist cannot see, so rather
       than guess with a straight line the wrist returns nil and the caller
       keeps the phone's target. */
    func testNoRouteMeansNoOpinion() {
        let green = Coordinate(lat: -36.9169, lng: 174.7393)
        XCTAssertNil(BubbleEngine.defaultTarget(
            player: Coordinate(lat: -36.9134, lng: 174.7411), green: green, route: [],
            bag: bag([("PW", 103, 108)])))
    }

    func testNoBagMeansNoOpinion() {
        let green = Coordinate(lat: -36.9169, lng: 174.7393)
        XCTAssertNil(BubbleEngine.defaultTarget(
            player: Coordinate(lat: -36.9134, lng: 174.7411), green: green,
            route: [Coordinate(lat: -36.9134, lng: 174.7411), green], bag: bag([])))
    }
}
