using Toybox.Lang;

// The Garmin Bubble Engine's inputs. Mirrors ios/WatchBubbleEngine/Sources/WatchBubbleEngine/Inputs.swift
// field-for-field. Nothing here has behaviour beyond construction: the engine
// is a pure function of these values, and everything mutable (current target,
// held club, the club-transition band) belongs to GarminPlayState, not here.

class GarminCoordinate {
    var lat;
    var lng;

    function initialize(lat, lng) {
        self.lat = lat;
        self.lng = lng;
    }

    function isFinite() {
        return lat != null && lng != null;
    }
}

// One club, as the phone hands it over. Already normalised/sorted/roll-out
// applied on the phone side (gdNormaliseShotBagRows / gdTotalM) — this side
// consumes finished numbers.
class GarminClub {
    var club;
    var carryM;
    var totalM;

    function initialize(club, carryM, totalM) {
        self.club = club;
        self.carryM = carryM;
        self.totalM = totalM;
    }
}

// The playable bag at a moment in time. `isGhost` is load-bearing and must
// cross the wire: a Bubble built on the stand-in default carries is a guess,
// never presented as the player's own measured bag.
class GarminBagSnapshot {
    var version;
    var clubs;      // Array of GarminClub
    var isGhost;

    function initialize(version, clubs, isGhost) {
        self.version = version;
        self.clubs = clubs;
        self.isGhost = isGhost;
    }

    // Longest total first, matching gdNormaliseShotBagRows — sorted rather
    // than trusting arrival order, so a bag that arrived unsorted cannot
    // silently change which club a tie resolves to.
    function byLengthDescending() {
        var filtered = [];
        for (var i = 0; i < clubs.size(); i += 1) {
            var c = clubs[i];
            if (c.carryM != null && c.carryM > 0 && c.club != null && c.club.length() > 0) {
                filtered.add(c);
            }
        }
        // Simple insertion sort by totalM descending — bags are small (a
        // dozen clubs), so O(n^2) costs nothing and keeps this dependency-free.
        for (var i = 1; i < filtered.size(); i += 1) {
            var key = filtered[i];
            var j = i - 1;
            while (j >= 0 && filtered[j].totalM < key.totalM) {
                filtered[j + 1] = filtered[j];
                j -= 1;
            }
            filtered[j + 1] = key;
        }
        return filtered;
    }

    function maxTotalM() {
        var sorted = byLengthDescending();
        return sorted.size() > 0 ? sorted[0].totalM : null;
    }
}

// The saved My Bubble, reduced to the only two things a GPS Bubble takes from
// it (Bubble Bible s2): a degree value and a handedness. Size comes from the
// bag. `offsetDeg` genuinely means "no My Bubble" when null/absent — it must
// never default to 0, which is how "no My Bubble" once became a fabricated
// 0.0 degree aim.
class GarminMyBubble {
    var version;
    var offsetDeg;    // null means "no My Bubble set"
    var handedness;   // "left" or "right"

    function initialize(version, offsetDeg, handedness) {
        self.version = version;
        self.offsetDeg = offsetDeg;
        self.handedness = (handedness != null && handedness.equals("left")) ? "left" : "right";
    }

    // Right is +1, left is -1 — the sign IS the convention, mirroring the
    // cluster tilt.
    function handSign() {
        return handedness.equals("left") ? -1.0 : 1.0;
    }

    // The aim to actually use: 0.0 when no My Bubble is set, explicitly, and
    // never the engine's placeholder aim.
    function effectiveOffsetDeg() {
        if (offsetDeg == null) {
            return 0.0;
        }
        return offsetDeg;
    }
}
