import Foundation

/* The shot the wrist believes it just locked.
 *
 * WHY IT EXISTS. Pressing LOCK sends a command and then waits: for the radio,
 * for Marshal, and for the next Scene to come back saying the shot is closed.
 * On a good link that is fast enough not to notice. In a bag, at the far end of
 * a fairway, it is not — and the player has already walked off. This record
 * lets the wrist say "locked" the moment the button is pressed, from what it
 * already knows.
 *
 * WHY IT IS DANGEROUS. It is INTENT, not truth. Marshal owns the round and can
 * refuse: no live round, a stale revision, a location it will not accept. A
 * record like this that outlives its own uncertainty is not a nicety, it is a
 * lie the player will act on — a shot they believe is logged and is not.
 *
 * So every path out of the uncertainty is explicit, and there are three:
 *
 *   rejected      the lock did not happen — discard at once
 *   confirmed     the Scene has moved past it — the Scene is truth now
 *   expired       nothing came back — stop claiming, whatever the reason
 *
 * The expiry is the one that matters most, because it is the only one that
 * survives a case nobody thought of. Any bug in the other two costs at most
 * `maximumUnconfirmedAge` of a wrong screen instead of a whole round of it.
 */
public struct WatchLockedShot: Codable, Equatable, Sendable {

    /* How long the wrist will claim a lock nothing has confirmed.
     *
     * Long enough to cover a slow link and a phone waking up; short enough that
     * a player who glances down mid-hole is not still being told a stale story.
     * It is a backstop, not a timeout — the acknowledgement or the next Scene
     * normally settles this in under a second. */
    public static let maximumUnconfirmedAge: TimeInterval = 20

    /// The command this shot was sent as. The reconciliation key: an
    /// acknowledgement names it, so there is never any guessing about which
    /// local record an outcome belongs to.
    public let commandId: String
    public let roundId: String
    /// The Scene revision the lock was made against. The Scene has caught up
    /// when it moves past this.
    public let baseRevision: Int

    public let holeNumber: Int?
    public let player: Coordinate
    public let target: Coordinate
    public let club: String
    public let targetDistanceM: Double

    /* The Bubble as drawn, kept as its shape rather than its 168 ring points.
       The ring is derived, and storing derived geometry beside the inputs that
       produce it is how the two drift apart; the locked face needs a club, a
       distance and a shape, and can rebuild anything else. */
    public let widthM: Double
    public let depthM: Double
    public let tiltDeg: Double

    public let engineVersion: String
    public let createdAt: Date

    public init(commandId: String, roundId: String, baseRevision: Int, holeNumber: Int?,
                player: Coordinate, target: Coordinate, club: String, targetDistanceM: Double,
                widthM: Double, depthM: Double, tiltDeg: Double,
                engineVersion: String, createdAt: Date) {
        self.commandId = commandId
        self.roundId = roundId
        self.baseRevision = baseRevision
        self.holeNumber = holeNumber
        self.player = player
        self.target = target
        self.club = club
        self.targetDistanceM = targetDistanceM
        self.widthM = widthM
        self.depthM = depthM
        self.tiltDeg = tiltDeg
        self.engineVersion = engineVersion
        self.createdAt = createdAt
    }

    /// Built from a Bubble the wrist computed itself. There is deliberately no
    /// way to build one from the phone's numbers: if the wrist did not compute
    /// the shot, it has nothing of its own to show and should wait like it
    /// always did.
    public init(commandId: String, roundId: String, baseRevision: Int, holeNumber: Int?,
                bubble: BubbleEngine.Result, player: Coordinate, now: Date = Date()) {
        self.init(commandId: commandId, roundId: roundId, baseRevision: baseRevision,
                  holeNumber: holeNumber, player: player, target: bubble.target,
                  club: bubble.club.club, targetDistanceM: bubble.targetDistanceM,
                  widthM: bubble.widthM, depthM: bubble.depthM, tiltDeg: bubble.tiltDeg,
                  engineVersion: bubble.engineVersion, createdAt: now)
    }

    /* Should this still be shown?
     *
     * Every argument is a fact the caller already has, and the answer is a pure
     * function of them — so the rule is in one place and can be tested without
     * a radio, a Scene or a clock.
     *
     * `sceneRevision` is nil when no Scene has arrived at all, which is not
     * confirmation of anything; a round that has changed underneath, however,
     * discards outright — a lock belongs to the round it was made in. */
    public func isStillShowing(roundId currentRound: String?,
                               sceneRevision: Int?,
                               commandStillPending: Bool,
                               now: Date = Date()) -> Bool {
        guard currentRound == roundId else { return false }
        guard now.timeIntervalSince(createdAt) < Self.maximumUnconfirmedAge else { return false }
        /* The Scene has moved past the revision this was locked against, so it
           now reflects the outcome — whatever it was. Presentation goes back to
           the authoritative answer. */
        if let sceneRevision, sceneRevision > baseRevision { return false }
        /* Still queued, or acknowledged but not yet visible in a Scene. Both
           are genuinely unconfirmed and both are worth showing. */
        return commandStillPending || sceneRevision != nil
    }
}
