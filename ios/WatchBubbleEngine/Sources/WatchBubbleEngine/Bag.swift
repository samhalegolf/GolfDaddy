import Foundation

/* Club selection and the bag's own arithmetic.
 *
 * The phone normalises the bag before it sends it, so most of this is already
 * done by the time a snapshot reaches the wrist. What is genuinely needed here
 * is the SELECTION policy — which club a given distance resolves to — because
 * that runs on every drag and must give the phone's answer every time.
 */
enum Bag {

    /// `gdBagTotalForCarry` — carry plus roll-out, never less than the carry.
    /// Only reached for a row that arrived without a total of its own; the
    /// phone has normally already applied the player's firmness preset.
    static func totalForCarry(club: String, carryM: Double) -> Double {
        let c = max(0, JS.round(carryM))
        guard c > 0 else { return 0 }
        let pct = max(0, BubbleTables.rolloutBasePct(for: club) * BubbleTables.firmnessMultiplier)
        return max(c, JS.round(c * (1 + pct)))
    }

    /* `gdResolveShotBagClub` with club "Bag" — the on-course case, where the
       player has not named a club and the distance chooses.
     *
     * Nearest TOTAL, not nearest carry. That is the whole policy and it is why
     * a 228m target picks a Driver whose carry is only 205: the ball finishes
     * where the total says, and that is what the player is aiming at.
     *
     * The reduce keeps the FIRST of equal candidates, matching JavaScript's
     * `Math.abs(a) < Math.abs(b)` strict comparison over a longest-first list —
     * so an exact tie resolves to the longer club. Reproduced rather than
     * tidied, because the two boundary fixtures sit four metres apart and a
     * flipped tie-break would move one of them.
     *
     * NO HYSTERESIS. The engine is a pure function of its inputs; the
     * transition band that stops a dragging finger flickering between two clubs
     * is interaction state and lives in WatchPlayState. If it ever leaked in
     * here the parity fixtures would stop being reproducible, which is the
     * intended alarm.
     */
    static func resolveClub(in bag: WatchBagSnapshot, targetDistanceM: Double, named: String? = nil) -> WatchClub? {
        let rows = bag.byLengthDescending
        guard !rows.isEmpty else { return nil }
        /* A named club wins outright, matching the JavaScript's `club` argument
           — an exact, case-insensitive match on the label. This is the path the
           play state uses to HOLD a club across a drag: the transition band
           lives out there, and it needs a way to say "keep using the 6-iron"
           without the engine second-guessing it. A name that is not in the bag
           falls through to the distance, so a stale hold can never strand the
           player on a club they no longer carry. */
        if let named, !named.isEmpty, named.lowercased() != "bag",
           let exact = rows.first(where: { $0.club.lowercased() == named.lowercased() }) {
            return exact
        }
        let d = max(1, targetDistanceM.isFinite ? targetDistanceM : 155)
        /* The JavaScript seeds the reduce with the 7i when the bag has one and
           the longest club otherwise, then compares every row against it. The
           seed only decides ties against itself, which the strict `<` already
           settles in the seed's favour — so seeding with the same row the
           JavaScript picks is the part that has to match. */
        let seed = rows.first { $0.club.lowercased() == "7i" } ?? rows[0]
        return rows.reduce(seed) { best, row in
            abs(row.totalM - d) < abs(best.totalM - d) ? row : best
        }
    }

    /// `gdMaxPlayableCarryM` — despite the name, the longest TOTAL in the bag.
    /// It is what decides whether a green is reachable.
    static func maxPlayableM(in bag: WatchBagSnapshot) -> Double? {
        let totals = bag.byLengthDescending.map(\.totalM).filter { $0.isFinite && $0 > 0 }
        return totals.max()
    }
}
