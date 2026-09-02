import XCTest
@testable import WatchBubbleEngine

/* The Interaction and Framing halves — the state the engine deliberately does
 * not hold, and the camera the engine is deliberately not allowed to touch.
 */
final class PlayStateAndCameraTests: XCTestCase {

    // MARK: - Fixtures

    /// 5i / 6i / 7i, totals 167 / 157 / 148 — the same bag the club-boundary
    /// parity cases use, so the boundaries here are the boundaries there.
    private let bag = WatchBagSnapshot(version: 1, clubs: [
        WatchClub(club: "5i", carryM: 155, totalM: 167),
        WatchClub(club: "6i", carryM: 146, totalM: 157),
        WatchClub(club: "7i", carryM: 138, totalM: 148)
    ], isGhost: false)
    private let profile = WatchBubbleProfile(version: 1, offsetDeg: 3.2, handedness: .right)
    private let green = Coordinate(lat: -36.9169, lng: 174.7393)

    /// A player position a given distance short of the green, along the line to
    /// it — so a test can say "put the target 160m away" and mean it.
    private func player(metresFromGreen metres: Double) -> Coordinate {
        let tee = Coordinate(lat: -36.9134, lng: 174.7411)
        let full = Geo.distance(green, tee)
        let f = metres / full
        return Coordinate(lat: green.lat + f * (tee.lat - green.lat), lng: green.lng + f * (tee.lng - green.lng))
    }

    // MARK: - The club transition band

    /* The band's whole purpose: a target parked on the boundary and jittering,
       as a real finger does, must not flicker between two clubs.

       Without hysteresis this sequence produces 5i, 6i, 5i, 6i… With it, the
       first club holds. */
    func testAJitteringTargetDoesNotFlickerBetweenClubs() throws {
        var state = WatchPlayState(player: player(metresFromGreen: 163))
        state.moveTarget(to: green, bag: bag, profile: profile)
        let settled = try XCTUnwrap(state.bubble?.club.club)

        var seen: Set<String> = [settled]
        /* Jitter either side of the 162m boundary by a metre or two — well
           inside the 3m band. */
        for metres in [161.0, 163.0, 160.5, 162.5, 161.5, 163.5] {
            state.player = player(metresFromGreen: metres)
            state.moveTarget(to: green, bag: bag, profile: profile)
            seen.insert(try XCTUnwrap(state.bubble?.club.club))
        }
        XCTAssertEqual(seen, [settled], "a target jittering inside the band must hold one club, got \(seen)")
    }

    /* And it must still change when the player genuinely means it. A band that
       never releases is just a stuck club. */
    func testADeliberateMoveStillChangesClub() throws {
        var state = WatchPlayState(player: player(metresFromGreen: 140))
        state.moveTarget(to: green, bag: bag, profile: profile)
        let short = try XCTUnwrap(state.bubble?.club.club)

        state.player = player(metresFromGreen: 185)
        state.moveTarget(to: green, bag: bag, profile: profile)
        let long = try XCTUnwrap(state.bubble?.club.club)
        XCTAssertNotEqual(short, long, "a 45m move must change the club")
    }

    /* The band is asymmetric by construction: the distance at which 6i becomes
       5i going up is not the distance at which 5i becomes 6i coming down. That
       gap IS the hysteresis — if the two thresholds were equal there would be
       no band at all. */
    func testTheSwitchUpAndSwitchDownThresholdsDiffer() {
        var state = WatchPlayState()
        // 6i (157) -> 5i (167): midpoint 162, so going up needs > 165.
        XCTAssertFalse(state.crossedBand(distanceM: 164, from: 157, to: 167))
        XCTAssertTrue(state.crossedBand(distanceM: 166, from: 157, to: 167))
        // 5i (167) -> 6i (157): midpoint 162, so coming down needs < 159.
        XCTAssertFalse(state.crossedBand(distanceM: 160, from: 167, to: 157))
        XCTAssertTrue(state.crossedBand(distanceM: 158, from: 167, to: 157))
        /* 164m is 6i-if-you-were-on-6i and 5i-if-you-were-on-5i. That is the
           band doing its job, and it is why this cannot live in the engine. */
        _ = state
    }

    /* The engine underneath stays pure. Same inputs, same answer, regardless of
       what any play state was holding — this is the property the parity
       fixtures depend on. */
    func testTheEngineItselfStillHasNoMemory() throws {
        let input = BubbleEngine.Input(player: player(metresFromGreen: 163), target: green, bag: bag, bubble: profile)
        let a = try XCTUnwrap(BubbleEngine.calculate(input))
        var state = WatchPlayState(player: player(metresFromGreen: 140))
        state.moveTarget(to: green, bag: bag, profile: profile)   // hold a different club
        let b = try XCTUnwrap(BubbleEngine.calculate(input))
        XCTAssertEqual(a, b, "the engine must not have learned anything from the play state")
    }

    /* A held club that is no longer in the bag must not strand the player on
       it — the bag was edited, and the hold is stale. */
    func testAHeldClubThatLeavesTheBagIsDropped() throws {
        var state = WatchPlayState(player: player(metresFromGreen: 163))
        state.moveTarget(to: green, bag: bag, profile: profile)
        let held = try XCTUnwrap(state.heldClub)

        let reduced = WatchBagSnapshot(version: 1,
                                       clubs: bag.byLengthDescending.filter { $0.club != held },
                                       isGhost: false)
        state.moveTarget(to: green, bag: reduced, profile: profile)
        XCTAssertNotEqual(state.heldClub, held)
        XCTAssertTrue(reduced.byLengthDescending.contains { $0.club == state.heldClub })
    }

    // MARK: - Reset and hole change

    func testResetRebuildsTheShotAndForgetsTheHeldClub() throws {
        let tee = Coordinate(lat: -36.9134, lng: 174.7411)
        var state = WatchPlayState(player: tee)
        state.moveTarget(to: Coordinate(lat: -36.9140, lng: 174.7408), bag: bag, profile: profile)
        XCTAssertNotNil(state.heldClub)

        let route = [tee, Coordinate(lat: -36.9157, lng: 174.7398), green]
        let rebuilt = state.reset(green: green, route: route, bag: bag, profile: profile)
        XCTAssertNotNil(rebuilt, "with a route and a bag, reset must produce a shot")
        XCTAssertNotNil(state.target)
        /* The green is 421m and the bag reaches 167m, so reset lays up rather
           than aiming at a green nobody can reach. */
        XCTAssertGreaterThan(Geo.distance(try XCTUnwrap(state.target), green), 100)
    }

    func testEnteringAHoleClearsEverythingAboutTheOldShot() {
        var state = WatchPlayState(player: player(metresFromGreen: 163), hole: 1)
        state.moveTarget(to: green, bag: bag, profile: profile)
        XCTAssertNotNil(state.bubble)
        state.enter(hole: 2)
        XCTAssertEqual(state.hole, 2)
        XCTAssertNil(state.target)
        XCTAssertNil(state.bubble)
        XCTAssertNil(state.heldClub, "the band must not survive into a new hole")
    }

    /* Walking changes the distance to the target — it does not move the
       target. That is the difference between a rangefinder and a map that
       drags itself around. */
    func testANewFixDoesNotMoveTheTarget() throws {
        var state = WatchPlayState(player: player(metresFromGreen: 180))
        state.moveTarget(to: green, bag: bag, profile: profile)
        let before = try XCTUnwrap(state.bubble)
        state.update(player: player(metresFromGreen: 150))
        state.moveTarget(to: try XCTUnwrap(state.target), bag: bag, profile: profile)
        let after = try XCTUnwrap(state.bubble)
        XCTAssertEqual(before.target, after.target)
        XCTAssertLessThan(after.targetDistanceM, before.targetDistanceM)
    }

    // MARK: - The camera

    private let imageSize = CGSize(width: 448, height: 1536)
    private let viewSize = CGSize(width: 176, height: 216)

    func testAViewPointRoundTripsThroughTheCamera() throws {
        let camera = WatchMapCamera(focus: CGPoint(x: 224, y: 768), scale: 1.5)
        let original = CGPoint(x: 210, y: 700)
        let onScreen = camera.place(original, imageSize: imageSize, viewSize: viewSize)
        let back = try XCTUnwrap(camera.imagePoint(fromView: onScreen, imageSize: imageSize, viewSize: viewSize))
        XCTAssertEqual(back.x, original.x, accuracy: 1e-9)
        XCTAssertEqual(back.y, original.y, accuracy: 1e-9)
    }

    /* THE rule of the drag: following pans and never zooms. Scaling the world
       under a moving finger makes the target stop tracking the touch. */
    func testFollowingNeverChangesTheScale() {
        let camera = WatchMapCamera(focus: CGPoint(x: 224, y: 768), scale: 2)
        let farOff = CGRect(x: 900, y: 1400, width: 40, height: 40)
        let followed = camera.following(region: farOff, viewSize: viewSize)
        XCTAssertEqual(followed.scale, camera.scale, "a drag pans; it does not breathe")
        XCTAssertNotEqual(followed.focus, camera.focus, "and it did need to move")
    }

    /* Minimal movement: a region already comfortably inside the view must not
       provoke a pan at all. A camera that re-centres on every frame drags the
       whole hole past the player for a one-pixel adjustment. */
    func testAComfortableRegionDoesNotMoveTheMap() {
        let camera = WatchMapCamera(focus: CGPoint(x: 224, y: 768), scale: 1)
        let centred = CGRect(x: 214, y: 758, width: 20, height: 20)
        XCTAssertEqual(camera.following(region: centred, viewSize: viewSize), camera)
    }

    func testFollowingBringsAnEscapingRegionBackInside() {
        let camera = WatchMapCamera(focus: CGPoint(x: 224, y: 768), scale: 1)
        let escaping = CGRect(x: 300, y: 768, width: 20, height: 20)
        let followed = camera.following(region: escaping, viewSize: viewSize)
        let maxX = followed.place(CGPoint(x: escaping.maxX, y: escaping.midY), imageSize: imageSize, viewSize: viewSize).x
        XCTAssertLessThanOrEqual(maxX, viewSize.width * (1 - WatchMapCamera.comfortInset) + 0.001,
                                 "the region must end up inside the comfort rect")
    }

    func testTheCrownCannotZoomIntoMushOrIntoNothing() {
        let camera = WatchMapCamera(focus: CGPoint(x: 224, y: 768), scale: 1)
        let hugelyIn = camera.zoomed(by: 100, imageSize: imageSize, viewSize: viewSize)
        XCTAssertEqual(hugelyIn.scale, WatchMapCamera.maximumScale)
        let hugelyOut = camera.zoomed(by: 0.001, imageSize: imageSize, viewSize: viewSize)
        let fit = min(viewSize.width / imageSize.width, viewSize.height / imageSize.height)
        XCTAssertEqual(hugelyOut.scale, fit, accuracy: 1e-9, "zooming out stops when the whole image fits")
        XCTAssertEqual(camera.zoomed(by: .nan, imageSize: imageSize, viewSize: viewSize), camera)
    }

    func testTheRestingCameraFramesTheSpanThatMatters() {
        let interest = [CGPoint(x: 100, y: 1200), CGPoint(x: 140, y: 900)]
        let camera = WatchMapCamera.resting(interest: interest, imageSize: imageSize, viewSize: viewSize)
        XCTAssertEqual(camera.focus.x, 120, accuracy: 0.001)
        XCTAssertEqual(camera.focus.y, 1050, accuracy: 0.001)
        XCTAssertLessThanOrEqual(camera.scale, WatchMapCamera.maximumScale)
        /* Both points must land on screen. */
        for point in interest {
            let at = camera.place(point, imageSize: imageSize, viewSize: viewSize)
            XCTAssertTrue((0...viewSize.width).contains(at.x) && (0...viewSize.height).contains(at.y),
                          "\(point) landed off screen at \(at)")
        }
    }

    // MARK: - Play framing

    /* Millbrook's 1st as actually baked: 200x1536, which is 1:7.7 against a
       1:1.2 screen. Containing it drew the hole 28pt wide with 84% of the view
       as black bars — the thing this framing exists to stop. */
    private let holeImage = CGSize(width: 200, height: 1536)

    func testALongHoleFillsTheWidthInsteadOfLeavingBlackBars() {
        let player = CGPoint(x: 100, y: 1450)
        let target = CGPoint(x: 100, y: 50)
        let camera = WatchMapCamera.play(player: player, target: target,
                                         imageSize: holeImage, viewSize: viewSize)
        let drawnWidth = holeImage.width * camera.scale
        XCTAssertGreaterThanOrEqual(drawnWidth, viewSize.width - 0.001,
                                    "the map must be at least as wide as the screen — no side bars")
        let contain = min(viewSize.width / holeImage.width, viewSize.height / holeImage.height)
        XCTAssertGreaterThan(camera.scale, contain * 5, "and far bigger than a contain-fit")
    }

    /* The player sits low with the hole running up, because that is the
       direction being played. */
    func testThePlayerSitsLowWithTheHoleAhead() {
        let player = CGPoint(x: 100, y: 1450)
        let camera = WatchMapCamera.play(player: player, target: CGPoint(x: 100, y: 50),
                                         imageSize: holeImage, viewSize: viewSize)
        let at = camera.place(player, imageSize: holeImage, viewSize: viewSize)
        XCTAssertGreaterThan(at.y, viewSize.height * 0.6, "the player belongs low on the screen")
        XCTAssertLessThan(at.y, viewSize.height, "but on it, not under the bezel")
    }

    /* A short shot is a different question, and the geometry decides — not a
       mode the player has to pick. Both ends on screen when both ends fit. */
    func testAShortShotShowsBothEnds() {
        let player = CGPoint(x: 100, y: 140)
        let target = CGPoint(x: 100, y: 50)
        let camera = WatchMapCamera.play(player: player, target: target,
                                         imageSize: holeImage, viewSize: viewSize)
        for point in [player, target] {
            let at = camera.place(point, imageSize: holeImage, viewSize: viewSize)
            XCTAssertTrue((0...viewSize.height).contains(at.y), "\(point) landed off screen at \(at)")
        }
        XCTAssertGreaterThan(camera.scale, viewSize.width / holeImage.width,
                             "a short shot zooms in past the width fill")
    }

    func testPlayFramingSurvivesMissingPoints() {
        let noTarget = WatchMapCamera.play(player: CGPoint(x: 100, y: 1450), target: nil,
                                           imageSize: holeImage, viewSize: viewSize)
        XCTAssertGreaterThanOrEqual(holeImage.width * noTarget.scale, viewSize.width - 0.001)
        let noPlayer = WatchMapCamera.play(player: nil, target: CGPoint(x: 100, y: 50),
                                           imageSize: holeImage, viewSize: viewSize)
        XCTAssertGreaterThanOrEqual(holeImage.width * noPlayer.scale, viewSize.width - 0.001)
        let nothing = WatchMapCamera.play(player: nil, target: nil,
                                          imageSize: .zero, viewSize: viewSize)
        XCTAssertEqual(nothing.scale, 1, "a degenerate image must not divide by zero")
    }

    /* The magnification ceiling still holds — a 448px bake blown up past 3x
       turns the flat vector edges to mush. */
    func testPlayFramingRespectsTheMagnificationCeiling() {
        let tiny = CGSize(width: 20, height: 40)
        let camera = WatchMapCamera.play(player: CGPoint(x: 10, y: 30), target: CGPoint(x: 10, y: 28),
                                         imageSize: tiny, viewSize: viewSize)
        XCTAssertLessThanOrEqual(camera.scale, WatchMapCamera.maximumScale)
    }

    func testDegenerateSizesDoNotCrashOrProduceNonsense() {
        let camera = WatchMapCamera.resting(interest: [], imageSize: .zero, viewSize: viewSize)
        XCTAssertEqual(camera.scale, 1)
        XCTAssertNil(WatchMapCamera(focus: .zero, scale: 0)
            .imagePoint(fromView: .zero, imageSize: imageSize, viewSize: viewSize))
    }

    // MARK: - Bubble framing

    /* The aimable page frames the BUBBLE, not the player. A Driver's cluster
       (about 83x101px on Millbrook's bake) sits centred, and the player 440px
       behind it is allowed off the bottom: the aim line pivots from a fixed
       origin instead of the map sliding under it on every re-fit. */
    func testBubbleFramingCentresTheBubbleAndLetsThePlayerGo() {
        let centre = CGPoint(x: 100, y: 700)
        let camera = WatchMapCamera.bubble(centre: centre, extent: CGSize(width: 40, height: 50),
                                           imageSize: holeImage, viewSize: viewSize)
        let at = camera.place(centre, imageSize: holeImage, viewSize: viewSize)
        XCTAssertEqual(at.x, viewSize.width / 2, accuracy: 0.5)
        XCTAssertEqual(at.y, viewSize.height / 2, accuracy: 0.5)
        XCTAssertEqual(50 * camera.scale, min(viewSize.width, viewSize.height) * WatchMapCamera.bubbleFraction,
                       accuracy: 0.5, "the Bubble's longer side takes its fixed share of the view")
        let player = camera.place(CGPoint(x: 100, y: 1140), imageSize: holeImage, viewSize: viewSize)
        XCTAssertGreaterThan(player.y, viewSize.height, "a Driver's length behind the Bubble is off the bottom")
    }

    /* A big Bubble cannot zoom out past the width fill: side bars are still
       not an option, and the ceiling still holds for a tiny one. */
    func testBubbleFramingKeepsTheNoBarsFloorAndTheMushCeiling() {
        let wide = WatchMapCamera.bubble(centre: CGPoint(x: 100, y: 700), extent: CGSize(width: 180, height: 220),
                                         imageSize: holeImage, viewSize: viewSize)
        XCTAssertEqual(wide.scale, viewSize.width / holeImage.width, accuracy: 1e-9)
        XCTAssertGreaterThanOrEqual(holeImage.width * wide.scale, viewSize.width - 0.001)
        let tiny = WatchMapCamera.bubble(centre: CGPoint(x: 100, y: 700), extent: CGSize(width: 4, height: 5),
                                         imageSize: holeImage, viewSize: viewSize)
        XCTAssertEqual(tiny.scale, WatchMapCamera.maximumScale)
    }
}
