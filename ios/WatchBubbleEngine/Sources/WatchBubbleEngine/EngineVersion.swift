import Foundation

/* May this wrist compute a Bubble of its own, or must it render the phone's?
 *
 * WHY THIS IS A TYPE AND NOT AN `if`
 *
 * The phone's Bubble engine is generated — ~55 functions copied byte-for-byte
 * out of gd-app-core.js, with a CI check that fails the build on drift. The
 * Watch engine is Swift, so nothing generates it and nothing checks it. The
 * parity fixtures catch a disagreement that exists at the moment they are run;
 * they cannot catch a phone that has since shipped a new engine to a wrist that
 * has not been updated. Only a version exchanged at runtime can.
 *
 * The failure this prevents is the quiet one. Two engines that each answer
 * confidently and differently produce a Watch that shows a 6-iron where the
 * phone shows a 5, with no error anywhere and no way for the player to know
 * which to believe. Deferring costs a slightly staler Bubble — the phone's, off
 * the Scene, which is exactly what the wrist rendered before it had an engine
 * at all. That is a good trade and it should be taken automatically.
 *
 * EXACT MATCH ONLY
 *
 * There is no compatibility range. A version scheme that says "v1 and v1.1 are
 * close enough" is a claim about which changes were behavioural, and this
 * engine's changes are all behavioural — it exists to produce numbers. Any
 * difference defers.
 */
public enum BubbleEngineVersion {

    /// The engine this build of the Watch implements. Bump it in step with
    /// `BUBBLE_ENGINE_VERSION` in app/js/caddy-watch.js and with the
    /// `bubbleEngineVersion` recorded in the parity fixtures.
    public static let current = "bubble-engine-v1"

    /* What the phone has told us, from the two places it says so.
     *
     * `scene` is which engine drew the Bubble currently on screen; `snapshot`
     * is which engine the bag on this wrist was normalised for. They are
     * normally the same value from the same constant, and the interesting case
     * is when they are NOT: that is a phone mid-upgrade, where the bag on the
     * wrist predates the engine now drawing Scenes. Computing against either
     * one would be computing against half an upgrade, so it defers too. */
    public enum Agreement: Equatable, Sendable {
        /// The phone and this wrist run the same engine. Local computation is
        /// on, and its results are the phone's results.
        case agreed(String)
        /// The phone runs a different engine. Render its Bubble.
        case mismatch(phone: String, watch: String)
        /// The phone's own two declarations disagree — it is part-way through
        /// an upgrade and neither value can be trusted yet.
        case phoneInconsistent(scene: String, snapshot: String)
        /// Nothing has declared a version yet: an older phone build, or a wrist
        /// that has not received a Scene or a bag. Not an error, and not a
        /// licence to compute.
        case undeclared

        /// The only state in which the wrist may run its own engine. Written as
        /// one property so no caller has to re-derive the rule, and so that
        /// adding a state later cannot silently become permissive.
        public var mayComputeLocally: Bool {
            if case .agreed = self { return true }
            return false
        }

        /// Why the wrist is showing the phone's Bubble, for a diagnostic
        /// surface. Never phrased for a player: this is not their problem to
        /// solve, and it is deliberately not shown on the numbers face.
        public var reason: String? {
            switch self {
            case .agreed: return nil
            case .mismatch(let phone, let watch): return "phone \(phone), watch \(watch)"
            case .phoneInconsistent(let scene, let snapshot): return "phone mid-upgrade: scene \(scene), bag \(snapshot)"
            case .undeclared: return "no engine version declared"
            }
        }
    }

    /* Resolves the handshake.
     *
     * Both inputs are optional because both legitimately arrive late and in
     * either order — a Scene can land before a bag, or a bag before the first
     * Scene of a round. A single declaration is enough to decide, because a
     * phone only ever sends one value; requiring both would leave the wrist
     * deferring for no reason during the gap. */
    public static func agreement(scene: String?, snapshot: String?, watch: String = current) -> Agreement {
        let sceneVersion = scene.flatMap { $0.isEmpty ? nil : $0 }
        let snapshotVersion = snapshot.flatMap { $0.isEmpty ? nil : $0 }

        if let sceneVersion, let snapshotVersion, sceneVersion != snapshotVersion {
            return .phoneInconsistent(scene: sceneVersion, snapshot: snapshotVersion)
        }
        guard let declared = sceneVersion ?? snapshotVersion else { return .undeclared }
        return declared == watch ? .agreed(declared) : .mismatch(phone: declared, watch: watch)
    }

    /// What this wrist reports back, so the phone can see a mismatch from its
    /// own side rather than only inferring one from a Watch that never computes.
    public static var report: [String: String] { ["engineVersion": current] }
}
