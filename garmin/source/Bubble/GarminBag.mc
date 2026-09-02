using Toybox.Lang;

// Club selection and the bag's own arithmetic. Mirrors
// ios/WatchBubbleEngine/Sources/WatchBubbleEngine/Bag.swift. The phone
// normalises the bag before it sends it; what is genuinely needed here is the
// SELECTION policy, because it runs on every drag/frame and must match the
// phone's answer every time.
module GarminBag {

    // gdBagTotalForCarry — carry plus roll-out, never less than the carry.
    // Only reached for a row that arrived without a total of its own.
    function totalForCarry(club, carryM) {
        var c = carryM > 0 ? GarminJS.round(carryM) : 0.0;
        if (c <= 0) { return 0.0; }
        var pct = GarminBubbleTables.rolloutBasePctFor(club) * GarminBubbleTables.FIRMNESS_MULTIPLIER;
        if (pct < 0) { pct = 0.0; }
        var withRollout = GarminJS.round(c * (1.0 + pct));
        return c > withRollout ? c : withRollout;
    }

    // gdResolveShotBagClub with club "Bag" — nearest TOTAL, not nearest
    // carry. The ball finishes where the total says, so a 228m target picks
    // a Driver whose carry is only 205. Reduce keeps the FIRST of equal
    // candidates (matching JavaScript's strict `<`), which is why the club
    // list must already be sorted longest-total-first before this runs.
    //
    // NO HYSTERESIS here. The engine is a pure function of its inputs; the
    // transition band lives in GarminPlayState. If it leaked in here the
    // parity fixtures would stop being reproducible.
    function resolveClub(bag, targetDistanceM, namedClub) {
        var rows = bag.byLengthDescending();
        if (rows.size() == 0) { return null; }

        if (namedClub != null && namedClub.length() > 0 && !namedClub.toLower().equals("bag")) {
            var lowerNamed = namedClub.toLower();
            for (var i = 0; i < rows.size(); i += 1) {
                if (rows[i].club.toLower().equals(lowerNamed)) { return rows[i]; }
            }
        }

        var d = targetDistanceM;
        if (d == null || d < 1) { d = 155.0; }

        var seed = rows[0];
        for (var i = 0; i < rows.size(); i += 1) {
            if (rows[i].club.toLower().equals("7i")) { seed = rows[i]; break; }
        }

        var best = seed;
        var bestDelta = (best.totalM - d).abs();
        for (var i = 0; i < rows.size(); i += 1) {
            var delta = (rows[i].totalM - d).abs();
            if (delta < bestDelta) {
                best = rows[i];
                bestDelta = delta;
            }
        }
        return best;
    }

    // gdMaxPlayableCarryM — despite the name, the longest TOTAL in the bag.
    // Decides whether a green is reachable.
    function maxPlayableM(bag) {
        var rows = bag.byLengthDescending();
        var best = null;
        for (var i = 0; i < rows.size(); i += 1) {
            var t = rows[i].totalM;
            if (t != null && t > 0 && (best == null || t > best)) {
                best = t;
            }
        }
        return best;
    }
}
