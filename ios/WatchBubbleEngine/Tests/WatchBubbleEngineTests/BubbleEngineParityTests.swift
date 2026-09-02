import XCTest
@testable import WatchBubbleEngine

/* Cross-platform Bubble parity — the Swift half.
 *
 * This reads dev/fixtures/bubble-engine-parity.json, the SAME file
 * dev/bubble-engine-parity.test.js runs through app/js/bubble-engine.js. Not a
 * copy of it: the path is resolved from #filePath up to the repo root, so there
 * is exactly one fixture file in the repository and no way for the two sides to
 * be held to different numbers.
 *
 * Why this exists before the engine does. The phone's engine is generated —
 * ~55 functions copied byte-for-byte out of gd-app-core.js with a CI check that
 * fails on drift. Nothing produces Swift from JavaScript, so at this boundary
 * that protection stops existing. The codebase has already been here once:
 * WatchMap.swift's header cites dev/watch-map-projection.test.js as pinning its
 * projection against the JavaScript, and that file has never existed. The
 * harness therefore lands first and the engine is written against it.
 *
 * WHAT PASSES TODAY. The engine itself is step 5 of the build order and is not
 * written yet, so `testEveryCaseMatchesTheJavaScriptEngine` is skipped with a
 * reason rather than silently vacuous. Everything else is live and already
 * earning its keep: the fixture is found, it decodes into the real input types,
 * and the corners are present. That is not a placeholder — a fixture format
 * that does not round-trip into Swift is the failure this file is most likely
 * to catch, and it catches it now rather than after an engine is built on it.
 */
final class BubbleEngineParityTests: XCTestCase {

    // MARK: - Fixture

    /* Walks up from this source file to the repo root rather than copying the
       fixture in as a bundle resource. A resource copy is a second source of
       truth, and the whole point of the file is that there is only one. */
    static func fixtureURL() throws -> URL {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = directory
                .appendingPathComponent("dev")
                .appendingPathComponent("fixtures")
                .appendingPathComponent("bubble-engine-parity.json")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            directory = directory.deletingLastPathComponent()
        }
        throw XCTSkip("dev/fixtures/bubble-engine-parity.json not found above \(#filePath)")
    }

    struct Fixture: Decodable {
        let bubbleEngineVersion: String
        let tolerances: Tolerances
        let cases: [Case]

        struct Tolerances: Decodable {
            let metres: Double
            let degrees: Double
            let distanceM: Double
            let coordinate: Double
        }

        struct Case: Decodable {
            let name: String
            let why: String
            let input: Input
            let expect: Expect
        }

        /* Mirrors what dev/bubble-engine-parity.test.js feeds the engine. `bag`
           carries carries only — the phone derives each total from the roll-out
           preset before it sends a WatchBagSnapshot, so the fixture pins that
           derivation too rather than assuming it. */
        struct Input: Decodable {
            let bag: [BagRow]
            let bubble: Bubble?
            let hole: Hole
            let player: Coordinate
            let target: Coordinate?

            struct BagRow: Decodable {
                let club: String
                let baseCarry: Double
                let totalM: Double?
            }
            struct Bubble: Decodable {
                let offsetDeg: Double?
                let handedness: String?
            }
            struct Hole: Decodable {
                let number: Int
                let tee: Coordinate
                let green: Coordinate
                let route: [Coordinate]
            }
        }

        struct Expect: Decodable {
            let defaultTarget: Coordinate
            let targetDistanceM: Double
            let shotBearingDeg: Double
            let club: String
            let carryM: Double
            let totalM: Double
            let aimOffsetDeg: Double
            let aimOffsetM: Double
            let clusterWidthM: Double
            let clusterDepthM: Double
            let clusterTiltDeg: Double
            let visualWidthM: Double
            let visualDepthM: Double
            let visualTiltDeg: Double
            let ghostBag: Bool
            let bubbleCentre: Coordinate
            let ringResolution: Int
            let ringSample: [Coordinate]
        }
    }

    func loadFixture() throws -> Fixture {
        let url = try Self.fixtureURL()
        return try JSONDecoder().decode(Fixture.self, from: try Data(contentsOf: url))
    }

    // MARK: - Live now

    func testFixtureDecodesIntoTheSwiftContract() throws {
        let fixture = try loadFixture()
        XCTAssertFalse(fixture.bubbleEngineVersion.isEmpty,
                       "the fixture must name the engine version the Swift side is held to")
        XCTAssertGreaterThanOrEqual(fixture.cases.count, 8,
                                    "a parity set this small protects nothing")

        for entry in fixture.cases {
            XCTAssertFalse(entry.why.isEmpty, "\(entry.name): a case that cannot say why it exists will be deleted by the next person")
            XCTAssertTrue(entry.input.player.isFinite, "\(entry.name): player")
            XCTAssertTrue(entry.input.hole.green.isFinite, "\(entry.name): green")
            XCTAssertGreaterThanOrEqual(entry.input.hole.route.count, 2, "\(entry.name): a play line needs two points")
            XCTAssertEqual(entry.expect.ringSample.count, 8, "\(entry.name): ring sample width changed — regenerate both sides together")
            XCTAssertGreaterThan(entry.expect.clusterWidthM, 0, "\(entry.name)")
            XCTAssertGreaterThan(entry.expect.clusterDepthM, 0, "\(entry.name)")
        }
    }

    /* The inputs are not just decodable, they map onto the types the engine will
       actually take. This is the half of the format risk that a JSON round-trip
       alone would not catch. */
    func testInputsMapOntoTheEngineInputTypes() throws {
        let fixture = try loadFixture()

        for entry in fixture.cases {
            let clubs = entry.input.bag.map {
                WatchClub(club: $0.club, carryM: $0.baseCarry, totalM: $0.totalM ?? $0.baseCarry)
            }
            let bag = WatchBagSnapshot(version: 1, clubs: clubs, isGhost: entry.expect.ghostBag)
            let profile = WatchBubbleProfile(
                version: 1,
                offsetDeg: entry.input.bubble?.offsetDeg,
                handedness: .init(lenient: entry.input.bubble?.handedness)
            )

            if entry.input.bag.isEmpty {
                XCTAssertTrue(bag.byLengthDescending.isEmpty, "\(entry.name): an empty bag is empty, not a fabricated one")
                XCTAssertTrue(entry.expect.ghostBag, "\(entry.name): no account bag must produce a ghost-bag answer")
            } else {
                XCTAssertEqual(bag.byLengthDescending.count, clubs.count, "\(entry.name)")
                XCTAssertEqual(bag.byLengthDescending.first?.club, clubs.map(\.club).first,
                               "\(entry.name): the fixture bags are written longest-first, and sorting must agree")
            }

            /* The sign IS the convention, and it is the thing a render-chain
               mirror would quietly invert. Pinned against the recorded tilt. */
            if abs(entry.expect.clusterTiltDeg) > 0.001 {
                XCTAssertEqual(profile.handedness.sign, entry.expect.clusterTiltDeg > 0 ? 1 : -1,
                               "\(entry.name): handedness must agree with the sign of the recorded tilt")
            }
        }
    }

    /* Bubble Bible s8, in the type system. A missing My Bubble is 0.0° stated
       out loud, never the engine's 1.4°-right placeholder — and never a zero
       that arrived by defaulting a nil, which is how a fabricated aim gets back
       in. */
    func testAbsentMyBubbleIsZeroAndNotAPlaceholder() throws {
        let absent = WatchBubbleProfile(version: 1, offsetDeg: nil, handedness: .right)
        XCTAssertEqual(absent.effectiveOffsetDeg, 0)
        XCTAssertNil(absent.offsetDeg, "the absence itself must survive — it is what tells the wrist there is no My Bubble")

        let notANumber = WatchBubbleProfile(version: 1, offsetDeg: .nan, handedness: .right)
        XCTAssertEqual(notANumber.effectiveOffsetDeg, 0)

        let fixture = try loadFixture()
        let recorded = try XCTUnwrap(fixture.cases.first { $0.name == "no-my-bubble" })
        XCTAssertEqual(recorded.expect.aimOffsetDeg, 0, accuracy: fixture.tolerances.degrees,
                       "the recorded no-My-Bubble aim must be 0.0, not 1.4")
    }

    func testTheCornersArePresent() throws {
        let fixture = try loadFixture()
        let names = Set(fixture.cases.map(\.name))
        for required in ["ghost-bag", "no-my-bubble", "left-handed", "beyond-bag-reach",
                         "club-boundary-just-long", "club-boundary-just-short"] {
            XCTAssertTrue(names.contains(required), "the corners are the point: no '\(required)' case")
        }

        /* The two boundary cases must disagree about the club. One case cannot
           tell a working selector from one stuck on the longest club in the bag,
           and this pair is also what proves the ENGINE has no hysteresis — the
           transition band belongs to WatchPlayState. */
        let long = try XCTUnwrap(fixture.cases.first { $0.name == "club-boundary-just-long" })
        let short = try XCTUnwrap(fixture.cases.first { $0.name == "club-boundary-just-short" })
        XCTAssertNotEqual(long.expect.club, short.expect.club,
                          "four metres either side of a club boundary must select different clubs")

        /* Mirrored handedness, equal magnitude. */
        let right = try XCTUnwrap(fixture.cases.first { $0.name == "mid-iron approach" })
        let left = try XCTUnwrap(fixture.cases.first { $0.name == "left-handed" })
        XCTAssertEqual(left.expect.clusterTiltDeg, -right.expect.clusterTiltDeg,
                       accuracy: fixture.tolerances.degrees,
                       "left-handed tilt is the right-handed tilt negated, not merely different")
    }

    // MARK: - Waiting on the engine

    /* Step 5 of docs/WATCH_BUBBLE_ENGINE_SPEC.md. Skipped rather than absent so
       that the work it is waiting for is visible in the test output instead of
       being something a reader has to know to look for.

       When the engine lands, this becomes: build a WatchBubbleInput from
       entry.input, call BubbleEngine.calculate, and compare every field of
       entry.expect at the fixture's own per-field tolerances — metres to 0.1,
       degrees to 0.01, distance to 0.5, coordinates to 1e-7 (~11mm). Do not
       loosen a tolerance to make a case pass. A disagreement here is the two
       engines diverging, which is the single failure this whole harness exists
       to catch. */
    func testEveryCaseMatchesTheJavaScriptEngine() throws {
        let fixture = try loadFixture()
        throw XCTSkip("""
            Swift Bubble engine not implemented yet (spec step 5). \
            \(fixture.cases.count) cases are recorded and waiting at \
            \(fixture.bubbleEngineVersion).
            """)
    }
}
