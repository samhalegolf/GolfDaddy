using Toybox.Lang;

// Everything about the shot that CHANGES. Mirrors
// ios/WatchBubbleEngine/Sources/WatchBubbleEngine/WatchPlayState.swift.
//
// The engine is a pure function of its inputs and has no memory — that is
// what makes it reproducible against the phone. The one genuinely stateful
// golf behaviour, the club transition band, lives here instead: a target
// dragged across the boundary between two clubs crosses it many times a
// second, and without a band the answer flickers 6i/5i/6i/5i. A band is
// memory, so it cannot live in the engine without breaking the parity
// fixtures.
class GarminPlayState {

    // How far past the midpoint between two clubs the target must travel
    // before the selection actually changes. 3m: adjacent clubs in a full
    // bag sit roughly 10-13m apart by total, so this is under a third of the
    // gap.
    static var CLUB_BAND_M = 3.0;

    var player;      // GarminCoordinate or null
    var hole;        // Number or null
    var target;      // GarminCoordinate or null
    var heldClub;    // String or null - held across drags
    var bubble;      // GarminBubbleResult or null

    function initialize() {
        player = null;
        hole = null;
        target = null;
        heldClub = null;
        bubble = null;
    }

    // Moves the target and recomputes, applying the band. Returns the new
    // Bubble, or null when there is nothing to compute from — the caller
    // renders the phone's Bubble in that case, not an error. Call on every
    // frame of a drag; it is one or two engine calls, both cheap.
    function moveTarget(newTarget, bag, profile) {
        if (player == null) { return null; }
        newTarget = clampedToBag(newTarget, player, bag);
        target = newTarget;

        var free = GarminBubbleEngine.calculate({ "player" => player, "target" => newTarget, "bag" => bag, "bubble" => profile });
        if (free == null) { bubble = null; return null; }

        var resolved;
        var held = null;
        if (heldClub != null && !heldClub.equals(free.club.club)) {
            var rows = bag.byLengthDescending();
            for (var i = 0; i < rows.size(); i += 1) {
                if (rows[i].club.equals(heldClub)) { held = rows[i]; break; }
            }
        }
        if (held != null && !crossedBand(free.targetDistanceM, held.totalM, free.club.totalM)) {
            resolved = heldClub;
        } else {
            resolved = free.club.club;
        }

        var result;
        if (resolved.equals(free.club.club)) {
            result = free;
        } else {
            result = GarminBubbleEngine.calculate(
                { "player" => player, "target" => newTarget, "bag" => bag, "bubble" => profile, "heldClub" => resolved });
        }

        heldClub = (result != null) ? result.club.club : free.club.club;
        bubble = (result != null) ? result : free;
        return bubble;
    }

    // The bag's roof on an aim, applied to Garmin's own target along its own
    // bearing, so a nudge/drag past the bag lands at the far edge of the bag
    // instead of somewhere no club goes. Marshal's clampAim (maxAimM = the
    // longest total in the bag) is the SAME rule applied on the phone; this
    // is a local UX constraint only, never a substitute for phone authority.
    // No roof when the bag has no finite total — the drag stays free.
    static function clampedToBag(target, player, bag) {
        var roof = GarminBag.maxPlayableM(bag);
        if (roof == null || roof <= 0) { return target; }
        var metres = GarminGeo.distance(player, target);
        if (metres == null || !metres.isFinite() || metres <= roof) { return target; }
        // Scaled back along the player->target vector itself, not
        // re-projected from a bearing — GarminGeo.bearing is the engine's
        // degree-space convention, not a geodesic, so projecting along it
        // would step off the line the finger drew.
        var fraction = roof / metres;
        return new GarminCoordinate(
            player.lat + (target.lat - player.lat) * fraction,
            player.lng + (target.lng - player.lng) * fraction
        );
    }

    // Has the target moved far enough past the midpoint of the two clubs to
    // change the answer? The boundary is the midpoint of the two TOTALS, and
    // the band is applied on the side the target is moving towards — going
    // up the bag it must pass midpoint+band; coming down, midpoint-band.
    // That asymmetry is what stops a target parked on the midpoint
    // oscillating.
    function crossedBand(distanceM, currentTotal, candidateTotal) {
        var boundary = (currentTotal + candidateTotal) / 2.0;
        if (candidateTotal > currentTotal) {
            return distanceM > boundary + CLUB_BAND_M;
        }
        return distanceM < boundary - CLUB_BAND_M;
    }

    // Rebuilds a logical shot state: current fix, current hole, the default
    // target, the engine run against it. Deliberately NOT a saved camera
    // position — see WatchPlayState.swift's note on why a reset recomputes
    // the shot rather than restoring a view already decided to be wrong.
    // The held club is cleared first so a club the player has left behind
    // cannot survive the thing meant to start over.
    function reset(green, route, bag, profile) {
        heldClub = null;
        bubble = null;
        if (player == null) { return null; }
        var defaulted = GarminBubbleEngine.defaultTarget(player, green, route, bag);
        if (defaulted == null) {
            // No route and an out-of-range green: keep whatever the phone
            // last placed rather than guessing.
            return null;
        }
        return moveTarget(defaulted, bag, profile);
    }

    // A new hole is a new shot. Everything about the old one goes, including
    // the band.
    function enter(newHole) {
        hole = newHole;
        heldClub = null;
        target = null;
        bubble = null;
    }

    // A fresh GPS fix. The target stays where the player put it — walking
    // forward changes the distance to it, which is the point.
    function update(newPlayer) {
        player = newPlayer;
    }
}
