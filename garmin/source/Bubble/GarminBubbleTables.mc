using Toybox.Lang;

// The engine's constants, copied from app/js/bubble-engine.js via
// ios/WatchBubbleEngine/Sources/WatchBubbleEngine/BubbleTables.swift.
//
// These are not tuning knobs to adjust on the wrist. The only correct way to
// change one is to change it in scripts/gd-app-core.js, re-run the client
// generator, re-record the parity fixtures and bump the engine version — at
// which point this file changes too, with the same value.
// EVERY DECIMAL LITERAL IN THIS FILE CARRIES A `d` SUFFIX, AND MUST.
//
// A bare `0.19` in Monkey C is a Float — 32 bits, about seven significant
// digits. `0.19d` is a Double, which is what JavaScript numbers are, and this
// whole file is constants ported from JavaScript that feed rounded results.
//
// The difference is not academic and it is not small. The driver ratio is the
// case that proved it: a 205m carry gives 205 x 0.19 = 38.95 exactly in
// Double, which gdRound takes up to 39.0 — but 38.949997 in Float, which
// rounds DOWN to 38.9. That 0.1m then multiplies through the visual width to
// 41.5 against the JavaScript's 41.6, and dev/fixtures/bubble-engine-parity
// .json's driver-off-the-tee case failed on exactly that, alone, out of
// eleven. Any constant here can sit on a .05 boundary for some carry; the
// suffix is what stops it mattering.
//
// The same rule holds in GarminBubbleProfile/Payload/Engine/Math and
// GarminBag, for the same reason. Run the fixtures after touching any of
// them: garmin/README.md, "Parity fixtures".
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
            return { "width" => 0.19d, "depth" => 0.23d, "carryWindowPct" => 5.4d, "faceWindowDeg" => 0.95d, "tiltBaseDeg" => 5.0d };
        } else if (group.equals("woodHybrid")) {
            return { "width" => 0.17d, "depth" => 0.215d, "carryWindowPct" => 4.9d, "faceWindowDeg" => 0.85d, "tiltBaseDeg" => 4.5d };
        } else if (group.equals("wedge")) {
            return { "width" => 0.12d, "depth" => 0.16d, "carryWindowPct" => 3.4d, "faceWindowDeg" => 0.55d, "tiltBaseDeg" => 2.5d };
        }
        // iron, the default
        return { "width" => 0.148d, "depth" => 0.195d, "carryWindowPct" => 4.2d, "faceWindowDeg" => 0.7d, "tiltBaseDeg" => 4.0d };
    }

    // gdRolloutBasePct — roll-out as a fraction of carry, before the firmness
    // multiplier. Wood/hybrid is the iron value times 1.35, so it is not a
    // fourth table entry.
    function rolloutBasePctFor(club) {
        var group = groupFor(club);
        if (group.equals("driver")) { return 0.11d; }
        if (group.equals("woodHybrid")) { return 0.075d * 1.35d; }
        if (group.equals("wedge")) { return 0.047d; }
        return 0.075d; // iron
    }

    // The firmness preset multiplier. The wrist has no such setting — the bag
    // it receives already had the player's preset applied on the phone. This
    // constant is reached only when a bag row arrives without its own total.
    // Medium (1) is the only honest choice here.
    var FIRMNESS_MULTIPLIER = 1.0d;

    // PLACEHOLDER_PLAYER_PROFILE.baseCalibration — the shape every GPS Bubble
    // is derived from, with only club/carry/aim replaced per shot. NOTE: the
    // per-club faceWindowDeg/carryWindowPct in ratiosFor() above are shadowed
    // by these constants on the actual derivation path — see
    // GarminBubbleProfile.derive() for why.
    var BASE_FACE_WINDOW_DEG = 0.7d;
    var BASE_CARRY_WINDOW_PCT = 4.2d;
    var BASE_DISPERSION_MULTIPLIER = 1.0d;

    // DEV_DEFAULTS, the shipped values. Garmin has no admin board to override
    // them from, so unlike the phone these are simply the numbers.
    var DEV_BUBBLE_RADIUS_PCT = 0.082d;
    var DEV_MINIMUM_BUBBLE_RADIUS_M = 7.0d;

    // gdBubbleGeometryTuning() with no admin overrides — DEV_DEFAULTS ships
    // bubbleGeometry: {}, so every lookup falls back. Written out so the
    // fallbacks are visible.
    var GEOMETRY_WIDTH_SCALE = 1.0d;
    var GEOMETRY_DEPTH_SCALE = 1.0d;
    var GEOMETRY_TILT_SCALE = 1.0d;
    var GEOMETRY_TILT_MAX_DEG = 14.0d;
    var GEOMETRY_GPS_MAX_LATERAL_PCT = 0.13d;
    var GEOMETRY_GPS_MAX_DEPTH_PCT = 0.18d;
    var GEOMETRY_GPS_MAX_LATERAL_M = 28.0d;
    var GEOMETRY_GPS_MAX_DEPTH_M = 38.0d;

    // The ring's fixed resolution. Changing it changes every recorded ring
    // sample in the parity fixtures — the intended alarm if it ever drifts.
    var RING_STEPS = 168;

    // DEV_DEFAULTS.bubbleVisuals — the MAIN ring (the Bubble's actual
    // outline, and the one the fixtures record) draws at 1.02, not 1. The
    // outer/inner shading rings are not drawn on Garmin any more than they
    // are on the wrist, so only this scale is ported.
    var MAIN_RING_SCALE = 1.02d;
}
