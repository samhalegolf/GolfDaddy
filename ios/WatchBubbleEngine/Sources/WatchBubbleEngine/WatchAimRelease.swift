import Foundation

/* Walking off the shot IS the unlock.
 *
 * WHY THE WRIST NEEDS ITS OWN RULE. Marshal already lets go of an aim on its
 * own — app/js/marshal.js AIM_RELEASE_M, thirty metres, confirmed over two
 * fixes — and that is the right number for a PHONE. A phone in a pocket cannot
 * be told to unlock, so its rule has to be conservative enough that it never
 * fires while the player is standing over the ball with the screen dark.
 *
 * The wrist is a different instrument. It is on the arm, its screen is showing
 * the locked Bubble, and the moment the player walks the picture is of a shot
 * that has already been played. Thirty metres of walking with a stale Bubble on
 * the wrist is most of the way to the ball. Five is the distance at which the
 * player has plainly left, and the wrist is the surface that can say so.
 *
 * SO THE TWO NUMBERS ARE DELIBERATELY DIFFERENT, and neither is derived from
 * the other: Marshal's thirty stays exactly where it is, as the phone's own
 * backstop for a round the wrist is not driving. This is the wrist's rule for
 * a round the wrist IS driving, and it reaches the record the same way every
 * other wrist decision does — as an UNLOCK command the phone applies.
 *
 * WHY ONE FIX IS ENOUGH, where Marshal insists on two. Marshal counts fixes
 * because it is watching a thirty-metre boundary that a jittery fix can cross
 * and re-cross while the player stands still. This is not that: CoreLocation
 * on the wrist runs with a five-metre distance filter, so a player who steps
 * six metres and stops gets ONE fix and then silence — waiting for a second
 * would mean the rule simply never fires for a short walk to a ball. The
 * accuracy gate below is what does the work a second fix would have done.
 *
 * AND WHY THAT IS SAFE. Unlocking costs the picture and nothing else: Marshal's
 * own UNLOCK "returns you to the resting state... you lose the picture, never
 * the record". A shot released a few metres early is re-locked with one tap. A
 * shot held while the player walks away is a lie on the wrist.
 *
 * Pure — no CoreLocation, no clock, no Scene. Everything it needs is an
 * argument, which is what lets WatchAimReleaseTests drive it off a golf course.
 */
public struct WatchAimRelease: Equatable, Sendable {

    // ------------------------------------------------------------- the rules

    /// How far from where the shot was locked counts as having walked off it.
    public static let thresholdM: Double = 5

    /// How good a fix has to be before it may be measured against a five-metre
    /// threshold at all.
    ///
    /// The transport's own gate is a hundred metres, which is the bound LOCK_AT
    /// trusts and the right one for "may this fix draw a player on a hole map".
    /// It is far too coarse here: a fix accurate to sixty metres can read as
    /// twenty metres of movement from a player who has not moved at all, and
    /// every one of those would unlock a shot somebody is standing over.
    public static let maximumAccuracyM: Double = 25

    // ------------------------------------------------------------- the state

    /// Where the shot was locked. Nil means nothing is being watched — either
    /// no shot is locked, or one is and no trustworthy anchor has been found
    /// for it yet, which simply leaves the player the button.
    public private(set) var anchor: Coordinate?

    /// Whether this lock has already been released. It fires ONCE: a second
    /// UNLOCK for a shot the phone has not finished letting go of would be a
    /// command against a state that no longer exists, and the anchor is not
    /// re-taken until the shot is genuinely locked again.
    public private(set) var released = false

    public init() {}

    /// Forgets the shot entirely — used when the wrist stops driving or the
    /// round changes underneath.
    public mutating func reset() {
        anchor = nil
        released = false
    }

    /* The shot has been let go by some other hand — the button, Double Tap,
       the phone. Not `reset()`: the Scene will keep saying `locked` until the
       phone catches up, and a rule that forgot the shot would re-anchor where
       the player is standing NOW and fire again five metres later, against a
       shot already on its way out. Staying released until `locked` genuinely
       goes false is the same "once per lock" promise the walk-away makes. */
    public mutating func markReleased() {
        released = true
    }

    /* One call, every fix and every Scene.
     *
     * `locked`   a shot is locked as far as the wrist is concerned, the wrist's
     *            own unconfirmed lock included. Anchoring on the optimistic one
     *            matters: it is the earliest moment the player can start
     *            walking, and an anchor taken later is taken from further away.
     *
     * `settled`  the phone has confirmed it. UNLOCK is only sent against a shot
     *            the phone agrees exists — sending one while a LOCK is still in
     *            flight is the race ShotView's "SENDING" state exists to avoid.
     *
     * `at`       where the lock was made, when the wrist computed it itself.
     *            Preferred over the current fix because it is the shot's actual
     *            start, not wherever the player had got to by the first fix.
     *
     * Returns true exactly once, on the fix that proves the player has left.
     */
    @discardableResult
    public mutating func update(locked: Bool,
                                settled: Bool,
                                at lockPoint: Coordinate?,
                                fix: Coordinate?,
                                accuracyM: Double?) -> Bool {
        guard locked else { reset(); return false }
        if released { return false }

        let trustworthy = Self.trustworthy(fix: fix, accuracyM: accuracyM)

        if anchor == nil {
            /* The lock's own point first, and it needs no accuracy gate: the
               wrist computed the shot from it, so it is already the point the
               whole Bubble was drawn against. Otherwise the first trustworthy
               fix while the shot is locked. */
            anchor = lockPoint ?? trustworthy
            return false
        }

        guard settled, let anchor, let here = trustworthy else { return false }
        guard let moved = WatchHoleFlow.metres(anchor, here), moved > Self.thresholdM else { return false }
        released = true
        return true
    }

    /// The fix, if it is one this rule is willing to measure with. A missing
    /// accuracy is not trusted — CoreLocation reports a negative
    /// `horizontalAccuracy` for a fix it does not stand behind, and an absent
    /// one comes from a transport that never had it.
    private static func trustworthy(fix: Coordinate?, accuracyM: Double?) -> Coordinate? {
        guard let fix, fix.isFinite else { return nil }
        guard let accuracyM, accuracyM >= 0, accuracyM <= maximumAccuracyM else { return nil }
        return fix
    }
}
