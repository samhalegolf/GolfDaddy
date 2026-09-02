using Toybox.Lang;

// The engine's constants, copied from app/js/bubble-engine.js via
// ios/WatchBubbleEngine/Sources/WatchBubbleEngine/BubbleTables.swift.
//
// These are not tuning knobs to adjust on the wrist. The only correct way to
// change one is to change it in scripts/gd-app-core.js, re-run the client
// generator, re-record the parity fixtures and bump the engine version — at
// which point this file changes too, with the same value.
module GarminBubbleTables {

    // GD_CLUB_PATTERN_RATIOS groups. The ORDER is the JavaScript if-chain
    // order — driver, then wood/hybrid, then wedge, then iron as the default —
    // and it decides overlaps: "4H" matches woodHybrid before anything else
    // can claim it.
    function groupFor(club) {
        var name = club.toLower();
        if (name.find("driver") != null) { return "driver"; }
        var woodTokens = ["3w", "wood", "hybrid", "4h"];
        for (var i = 0; i < woodTokens.size(); i += 1) {
            if (name.find(woodTokens[i]) != null) { return "woodHybrid"; }
        }
        var wedgeTokens = ["pw", "gw", "sw", "lw", "wedge"];
        for (var i = 0; i < wedgeTokens.size(); i += 1) {
            if (name.find(wedgeTokens[i]) != null) { return "wedge"; }
        }
        return "iron";
    }

    // GD_CLUB_PATTERN_RATIOS — { width, depth, carryWindowPct, faceWindowDeg, tiltBaseDeg }
    function ratiosFor(group) {
        if (group.equals("driver")) {
            return { "width" => 0.19, "depth" => 0.23, "carryWindowPct" => 5.4, "faceWindowDeg" => 0.95, "tiltBaseDeg" => 5.0 };
        } else if (group.equals("woodHybrid")) {
            return { "width" => 0.17, "depth" => 0.215, "carryWindowPct" => 4.9, "faceWindowDeg" => 0.85, "tiltBaseDeg" => 4.5 };
        } else if (group.equals("wedge")) {
            return { "width" => 0.12, "depth" => 0.16, "carryWindowPct" => 3.4, "faceWindowDeg" => 0.55, "tiltBaseDeg" => 2.5 };
        }
        // iron, the default
        return { "width" => 0.148, "depth" => 0.195, "carryWindowPct" => 4.2, "faceWindowDeg" => 0.7, "tiltBaseDeg" => 4.0 };
    }

    // gdRolloutBasePct — roll-out as a fraction of carry, before the firmness
    // multiplier. Wood/hybrid is the iron value times 1.35, so it is not a
    // fourth table entry.
    function rolloutBasePctFor(club) {
        var group = groupFor(club);
        if (group.equals("driver")) { return 0.11; }
        if (group.equals("woodHybrid")) { return 0.075 * 1.35; }
        if (group.equals("wedge")) { return 0.047; }
        return 0.075; // iron
    }

    // The firmness preset multiplier. The wrist has no such setting — the bag
    // it receives already had the player's preset applied on the phone. This
    // constant is reached only when a bag row arrives without its own total.
    // Medium (1) is the only honest choice here.
    var FIRMNESS_MULTIPLIER = 1.0;

    // PLACEHOLDER_PLAYER_PROFILE.baseCalibration — the shape every GPS Bubble
    // is derived from, with only club/carry/aim replaced per shot. NOTE: the
    // per-club faceWindowDeg/carryWindowPct in ratiosFor() above are shadowed
    // by these constants on the actual derivation path — see
    // GarminBubbleProfile.derive() for why.
    var BASE_FACE_WINDOW_DEG = 0.7;
    var BASE_CARRY_WINDOW_PCT = 4.2;
    var BASE_DISPERSION_MULTIPLIER = 1.0;

    // DEV_DEFAULTS, the shipped values. Garmin has no admin board to override
    // them from, so unlike the phone these are simply the numbers.
    var DEV_BUBBLE_RADIUS_PCT = 0.082;
    var DEV_MINIMUM_BUBBLE_RADIUS_M = 7.0;

    // gdBubbleGeometryTuning() with no admin overrides — DEV_DEFAULTS ships
    // bubbleGeometry: {}, so every lookup falls back. Written out so the
    // fallbacks are visible.
    var GEOMETRY_WIDTH_SCALE = 1.0;
    var GEOMETRY_DEPTH_SCALE = 1.0;
    var GEOMETRY_TILT_SCALE = 1.0;
    var GEOMETRY_TILT_MAX_DEG = 14.0;
    var GEOMETRY_GPS_MAX_LATERAL_PCT = 0.13;
    var GEOMETRY_GPS_MAX_DEPTH_PCT = 0.18;
    var GEOMETRY_GPS_MAX_LATERAL_M = 28.0;
    var GEOMETRY_GPS_MAX_DEPTH_M = 38.0;

    // The ring's fixed resolution. Changing it changes every recorded ring
    // sample in the parity fixtures — the intended alarm if it ever drifts.
    var RING_STEPS = 168;

    // DEV_DEFAULTS.bubbleVisuals — the MAIN ring (the Bubble's actual
    // outline, and the one the fixtures record) draws at 1.02, not 1. The
    // outer/inner shading rings are not drawn on Garmin any more than they
    // are on the wrist, so only this scale is ported.
    var MAIN_RING_SCALE = 1.02;
}
