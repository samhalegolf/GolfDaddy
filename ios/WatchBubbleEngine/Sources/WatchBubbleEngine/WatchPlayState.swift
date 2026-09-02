import Foundation

/* Everything about the shot that CHANGES.
 *
 * The engine is a pure function of its inputs and has no memory. That is what
 * makes it reproducible against the phone, and it is why the one piece of
 * genuinely stateful golf behaviour — the club transition band — lives here
 * instead.
 *
 * WHY HYSTERESIS IS NOT IN THE ENGINE. A finger dragging a target across the
 * boundary between two clubs crosses it many times a second. Without a band the
 * answer flickers 6i, 5i, 6i, 5i and the Bubble jumps with it. But a band is
 * memory: the answer depends on which club was showing a moment ago, not only
 * on where the target is. Put that in the engine and it stops being a function
 * of its inputs, the parity fixtures stop being reproducible, and the one check
 * holding the two engines together stops meaning anything.
 *
 * So the band is here, the engine is told which club to hold, and the fixtures
 * keep working.
 */
public struct WatchPlayState: Equatable {

    /* How far past the midpoint between two clubs the target must travel before
       the selection actually changes.
     *
     * 3m is a starting value, chosen against real bag gaps rather than picked
     * from the air: adjacent clubs in a full bag sit roughly 10-13m apart by
     * total, so a 3m band is under a third of the gap — wide enough that a
     * hand shaking on a cold morning does not flip the club, narrow enough that
     * a deliberate 5m adjustment still does. Tune it with a wrist on a course,
     * not on a desk. */
    public static let clubBandM: Double = 3

    public var player: Coordinate?
    public var hole: Int?
    public var target: Coordinate?
    /// The club currently showing. Held across drags so the band has something
    /// to be a band around; cleared whenever the shot itself changes.
    public private(set) var heldClub: String?
    public private(set) var bubble: BubbleEngine.Result?

    public init(player: Coordinate? = nil, hole: Int? = nil, target: Coordinate? = nil) {
        self.player = player
        self.hole = hole
        self.target = target
    }

    /* Moves the target and recomputes, applying the band.
     *
     * Returns the new Bubble, or nil when there is nothing to compute from —
     * which the caller renders as the phone's Bubble, not as an error.
     *
     * Call it on every frame of a drag. It is one engine call. */
    @discardableResult
    public mutating func moveTarget(to newTarget: Coordinate,
                                    bag: WatchBagSnapshot,
                                    profile: WatchBubbleProfile) -> BubbleEngine.Result? {
        guard let player else { return nil }
        target = newTarget

        /* Ask twice: once with no hold, to learn what the distance alone would
           choose, and then — only if that differs from what is showing — decide
           whether the target has travelled far enough to justify the change.
           Two engine calls on a drag frame is nothing; the alternative is
           reimplementing club selection out here, which is how the two
           surfaces would start to disagree about it. */
        let free = BubbleEngine.calculate(.init(player: player, target: newTarget, bag: bag, bubble: profile))
        guard let free else { bubble = nil; return nil }

        let resolved: String
        if let heldClub, heldClub != free.club.club,
           let held = bag.byLengthDescending.first(where: { $0.club == heldClub }),
           !crossedBand(distanceM: free.targetDistanceM, from: held.totalM, to: free.club.totalM) {
            resolved = heldClub
        } else {
            resolved = free.club.club
        }

        let result = resolved == free.club.club
            ? free
            : BubbleEngine.calculate(.init(player: player, target: newTarget, bag: bag, bubble: profile, heldClub: resolved))

        heldClub = result?.club.club ?? free.club.club
        bubble = result ?? free
        return bubble
    }

    /* Has the target moved far enough past the midpoint of the two clubs to
       change the answer?
     *
     * The boundary is the midpoint of the two TOTALS — the same quantity club
     * selection ranks on — and the band is applied on the side the target is
     * moving towards. Going up the bag the target must pass the midpoint plus
     * the band; coming down it must pass the midpoint minus it. That asymmetry
     * is the whole point: it means the switch-up and switch-down thresholds are
     * different distances, which is exactly what stops a target parked on the
     * midpoint oscillating. */
    func crossedBand(distanceM: Double, from currentTotal: Double, to candidateTotal: Double) -> Bool {
        let boundary = (currentTotal + candidateTotal) / 2
        return candidateTotal > currentTotal
            ? distanceM > boundary + Self.clubBandM
            : distanceM < boundary - Self.clubBandM
    }

    /* Rebuilds a logical shot state: current fix, current hole, the default
       target, the engine run against it.
     *
     * Deliberately NOT a saved camera position. A reset that restored where the
     * map happened to be looking would put the player back in a view they had
     * already decided was wrong; a reset that recomputes the shot puts them
     * back at a sensible one.
     *
     * The held club is cleared first, because the band exists to smooth a drag
     * and carrying it through a reset would let a club the player has left
     * behind survive the thing meant to start over. */
    @discardableResult
    public mutating func reset(green: Coordinate,
                               route: [Coordinate],
                               bag: WatchBagSnapshot,
                               profile: WatchBubbleProfile) -> BubbleEngine.Result? {
        heldClub = nil
        bubble = nil
        guard let player else { return nil }
        guard let defaulted = BubbleEngine.defaultTarget(player: player, green: green, route: route, bag: bag) else {
            /* No route and an out-of-range green: the wrist has no honest
               opinion, so it keeps whatever the phone last placed. */
            return nil
        }
        return moveTarget(to: defaulted, bag: bag, profile: profile)
    }

    /// A new hole is a new shot. Everything about the old one goes, including
    /// the band — see `reset`.
    public mutating func enter(hole newHole: Int) {
        hole = newHole
        heldClub = nil
        target = nil
        bubble = nil
    }

    /// A fresh GPS fix. The target stays where the player put it — walking
    /// forward changes the distance to it, which is the point.
    public mutating func update(player newPlayer: Coordinate) {
        player = newPlayer
    }
}
