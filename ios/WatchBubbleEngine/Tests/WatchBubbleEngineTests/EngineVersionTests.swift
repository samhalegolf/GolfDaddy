import XCTest
@testable import WatchBubbleEngine

/* The engine version handshake.
 *
 * The parity fixtures catch a disagreement between the two engines at the
 * moment they are run. They cannot catch a phone that has since shipped a new
 * engine to a wrist that has not been updated — and that is the failure with no
 * symptom: two engines each answering confidently and differently, a Watch
 * showing a 6-iron where the phone shows a 5, no error anywhere, and no way for
 * the player to know which to believe.
 *
 * So the rule under test is deliberately blunt: compute locally ONLY on an
 * exact version match. Every other state renders the phone's Bubble, which is
 * exactly what the wrist did before it had an engine at all.
 */
final class EngineVersionTests: XCTestCase {

    func testMatchingVersionsAreTheOnlyStateThatComputes() {
        let agreed = BubbleEngineVersion.agreement(
            scene: "bubble-engine-v1", snapshot: "bubble-engine-v1", watch: "bubble-engine-v1")
        XCTAssertEqual(agreed, .agreed("bubble-engine-v1"))
        XCTAssertTrue(agreed.mayComputeLocally)
        XCTAssertNil(agreed.reason, "there is nothing to explain when the engines agree")
    }

    func testAnyDifferenceDefersToThePhone() {
        /* No compatibility range on purpose. A scheme that called two versions
           "close enough" would be a claim about which changes were behavioural,
           and every change to this engine is behavioural — it exists to produce
           numbers. */
        for phone in ["bubble-engine-v2", "bubble-engine-v0", "bubble-engine-v1.1", "BUBBLE-ENGINE-V1", "bubble-engine-v10"] {
            let agreement = BubbleEngineVersion.agreement(scene: phone, snapshot: phone, watch: "bubble-engine-v1")
            XCTAssertEqual(agreement, .mismatch(phone: phone, watch: "bubble-engine-v1"))
            XCTAssertFalse(agreement.mayComputeLocally, "\(phone) must not be treated as compatible with v1")
            XCTAssertNotNil(agreement.reason)
        }
    }

    func testUndeclaredIsNotALicenceToCompute() {
        /* An older phone build declares nothing. That is not an error and not
           permission — the whole point is that silence never enables local
           computation. */
        let none = BubbleEngineVersion.agreement(scene: nil, snapshot: nil, watch: "bubble-engine-v1")
        XCTAssertEqual(none, .undeclared)
        XCTAssertFalse(none.mayComputeLocally)

        /* An empty string is silence too, not a version that happens to differ.
           WatchConnectivity payloads are stripped of nulls on the way over, so
           "absent" can legitimately arrive as "". */
        XCTAssertEqual(BubbleEngineVersion.agreement(scene: "", snapshot: "", watch: "bubble-engine-v1"), .undeclared)
        XCTAssertEqual(BubbleEngineVersion.agreement(scene: "", snapshot: nil, watch: "bubble-engine-v1"), .undeclared)
    }

    func testOneDeclarationIsEnoughToDecide() {
        /* A Scene can land before a bag or a bag before the first Scene, and a
           phone only ever sends one value. Requiring both would leave the wrist
           deferring through the gap for no reason. */
        XCTAssertTrue(BubbleEngineVersion.agreement(scene: "bubble-engine-v1", snapshot: nil, watch: "bubble-engine-v1").mayComputeLocally)
        XCTAssertTrue(BubbleEngineVersion.agreement(scene: nil, snapshot: "bubble-engine-v1", watch: "bubble-engine-v1").mayComputeLocally)
        XCTAssertEqual(BubbleEngineVersion.agreement(scene: "bubble-engine-v2", snapshot: nil, watch: "bubble-engine-v1"),
                       .mismatch(phone: "bubble-engine-v2", watch: "bubble-engine-v1"))
    }

    func testAPhoneMidUpgradeDefersEvenWhenOneHalfMatches() {
        /* The bag on this wrist was normalised by one engine and the Bubble on
           screen was drawn by another. Computing against either is computing
           against half an upgrade, so neither is trusted — including the half
           that happens to match this wrist. */
        let inconsistent = BubbleEngineVersion.agreement(
            scene: "bubble-engine-v2", snapshot: "bubble-engine-v1", watch: "bubble-engine-v1")
        XCTAssertEqual(inconsistent, .phoneInconsistent(scene: "bubble-engine-v2", snapshot: "bubble-engine-v1"))
        XCTAssertFalse(inconsistent.mayComputeLocally,
                       "a matching bag does not license computing against a Bubble from another engine")
        XCTAssertEqual(
            BubbleEngineVersion.agreement(scene: "bubble-engine-v1", snapshot: "bubble-engine-v2", watch: "bubble-engine-v1"),
            .phoneInconsistent(scene: "bubble-engine-v1", snapshot: "bubble-engine-v2"))
    }

    /* Only `.agreed` may ever be permissive. Written as a check over every
       state so that adding one later cannot quietly default to allowing local
       computation — the safe answer must stay the one you get by doing nothing. */
    func testNoStateOtherThanAgreedIsPermissive() {
        let states: [BubbleEngineVersion.Agreement] = [
            .agreed("x"),
            .mismatch(phone: "a", watch: "b"),
            .phoneInconsistent(scene: "a", snapshot: "b"),
            .undeclared
        ]
        XCTAssertEqual(states.filter(\.mayComputeLocally).count, 1)
        XCTAssertEqual(states.filter { $0.reason == nil }.count, 1, "every deferring state must be able to say why")
    }

    func testTheWristReportsTheEngineItImplements() {
        XCTAssertEqual(BubbleEngineVersion.report["engineVersion"], BubbleEngineVersion.current)
        XCTAssertFalse(BubbleEngineVersion.current.isEmpty)
    }

    /* The version this build implements must be the version the fixtures were
       recorded against. If someone bumps one without the other, the wrist would
       be held to numbers from an engine it does not claim to be. */
    func testCurrentVersionMatchesTheParityFixture() throws {
        struct Fixture: Decodable { let bubbleEngineVersion: String }
        let url = try BubbleEngineParityTests.fixtureURL()
        let fixture = try JSONDecoder().decode(Fixture.self, from: try Data(contentsOf: url))
        XCTAssertEqual(BubbleEngineVersion.current, fixture.bubbleEngineVersion,
                       "bump BubbleEngineVersion.current, app/js/caddy-watch.js and the fixture together")
    }
}
