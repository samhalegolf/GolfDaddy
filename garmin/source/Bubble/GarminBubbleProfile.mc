using Toybox.Lang;
using Toybox.Math;

// The Bubble's shape, derived from a club and a carry. Mirrors
// ios/WatchBubbleEngine/Sources/WatchBubbleEngine/BubbleProfile.swift
// (calculateBubbleProfile and everything it calls).
//
// Two things that look like mistakes and are not:
//
// 1. faceWindowDeg/carryWindowPct do NOT come from the club's pattern ratios.
//    getActiveBubbleProfile spreads PLACEHOLDER_PLAYER_PROFILE's base
//    calibration underneath every derivation, and that base supplies 0.7/4.2
//    for every club — so groupFor()'s per-club window defaults are always
//    shadowed and never reached on this path. A Driver derives its tilt with
//    an iron's 0.7 degree window. That is what the phone does.
// 2. The tilt's own per-club base (tiltBaseDeg) IS used, so clubs still
//    differ. Only the window terms are flat.
class GarminBubbleProfile {
    var club;
    var baseCarryM;
    var totalM;
    var faceAlignmentOffsetDeg;
    var aimOffsetDeg;
    var aimOffsetM;
    var clusterWidthM;
    var clusterDepthM;
    var clusterTiltDeg;
    var faceWindowDeg;
    var carryWindowPct;
    var distanceTendencyPct;

    // Monkey C caps a method at 9 arguments and this record carries 12
    // fields. Construct with `new GarminBubbleProfile()` and assign every
    // field — derive() below is the only site.
    function initialize() {
    }

    // calculateBubbleProfile, entered the way getActiveBubbleProfile enters
    // it: base calibration underneath, club/carry/aim on top.
    static function derive(club, baseCarryM, totalM, faceAlignmentOffsetDeg, handedness) {
        var group = GarminBubbleTables.groupFor(club);
        var ratios = GarminBubbleTables.ratiosFor(group);

        // gdDerivePatternWindow — see note 1 above.
        var faceWindowDeg = GarminJS.roundTo(GarminBubbleTables.BASE_FACE_WINDOW_DEG, 2);
        var carryWindowPct = GarminJS.roundTo(GarminBubbleTables.BASE_CARRY_WINDOW_PCT, 2);

        // gdDeriveBasePatternSize
        var multiplier = GarminJS.clamp(GarminBubbleTables.BASE_DISPERSION_MULTIPLIER, 0.6d, 1.8d);
        var clusterWidthM = GarminJS.roundTo(baseCarryM * ratios["width"] * multiplier * GarminBubbleTables.GEOMETRY_WIDTH_SCALE, 1);
        var clusterDepthM = GarminJS.roundTo(baseCarryM * ratios["depth"] * multiplier * GarminBubbleTables.GEOMETRY_DEPTH_SCALE, 1);

        // gdDeriveAimOffset — tan(deg) x the CARRY, not the shot.
        var aimOffsetDeg = GarminJS.roundTo(faceAlignmentOffsetDeg, 2);
        var aimOffsetM = GarminJS.roundTo(Math.tan(GarminGeo.degToRad(faceAlignmentOffsetDeg)) * baseCarryM, 2);

        // gdDeriveDistanceTendency, fed the WINDOW as the face delta — not
        // the player's aim.
        var hand = handedness.handSign();
        var strength;
        if (group.equals("driver")) { strength = 0.42d; }
        else if (group.equals("woodHybrid")) { strength = 0.36d; }
        else if (group.equals("wedge")) { strength = 0.18d; }
        else { strength = 0.30d; } // iron
        var distanceTendencyPct = GarminJS.roundTo(GarminJS.clamp(-(hand * faceWindowDeg) * strength, -5.0d, 5.0d), 2);

        // gdDeriveClusterTilt
        var offsetInfluence = faceAlignmentOffsetDeg.abs() * 0.12d;
        var windowInfluence = faceWindowDeg.abs() * 0.9d;
        var carryInfluence = carryWindowPct.abs() * 0.08d;
        var tiltRaw = hand * (ratios["tiltBaseDeg"] + offsetInfluence + windowInfluence + carryInfluence) * GarminBubbleTables.GEOMETRY_TILT_SCALE;
        var clusterTiltDeg = GarminJS.roundTo(
            GarminJS.clamp(tiltRaw, -GarminBubbleTables.GEOMETRY_TILT_MAX_DEG, GarminBubbleTables.GEOMETRY_TILT_MAX_DEG), 2);

        var totalRounded = (totalM != null) ? GarminJS.roundTo(totalM, 1) : null;

        var out = new GarminBubbleProfile();
        out.club = club;
        out.baseCarryM = GarminJS.roundTo(baseCarryM, 1);
        out.totalM = totalRounded;
        out.faceAlignmentOffsetDeg = GarminJS.roundTo(faceAlignmentOffsetDeg, 2);
        out.aimOffsetDeg = aimOffsetDeg;
        out.aimOffsetM = aimOffsetM;
        out.clusterWidthM = clusterWidthM;
        out.clusterDepthM = clusterDepthM;
        out.clusterTiltDeg = clusterTiltDeg;
        out.faceWindowDeg = faceWindowDeg;
        out.carryWindowPct = carryWindowPct;
        out.distanceTendencyPct = distanceTendencyPct;
        return out;
    }
}

// calculateVisualBubbleRender — the drawn shape, slightly larger and more
// tilted than the derived cluster.
//
// THE HANDEDNESS QUIRK, reproduced deliberately. On the phone this is called
// with a hard-coded hand=+1 fallback for every player, including
// left-handers, whose cluster tilt is already negative. A "corrected" Garmin
// engine would draw a visibly different Bubble from the phone for every
// left-handed player. If it should be mirrored, fix it in
// scripts/gd-app-core.js and let every surface move together.
class GarminVisualBubble {
    var visualWidthM;
    var visualDepthM;
    var visualTiltDeg;
    var visualSkewDeg;
    var visualYBias;

    function initialize(visualWidthM, visualDepthM, visualTiltDeg, visualSkewDeg, visualYBias) {
        self.visualWidthM = visualWidthM;
        self.visualDepthM = visualDepthM;
        self.visualTiltDeg = visualTiltDeg;
        self.visualSkewDeg = visualSkewDeg;
        self.visualYBias = visualYBias;
    }

    static function render(profile) {
        var hand = 1.0d; // deliberately not profile handedness — see note above
        var offsetNorm = GarminJS.clamp((hand * profile.faceAlignmentOffsetDeg) / 6.0d, -1.0d, 1.0d);
        var faceWindow = (profile.faceWindowDeg == 0) ? 0.7d : profile.faceWindowDeg;
        var windowNorm = GarminJS.clamp(faceWindow / 1.5d, 0.0d, 1.0d);
        var carryWindow = (profile.carryWindowPct == 0) ? 4.2d : profile.carryWindowPct;
        var carryNorm = GarminJS.clamp(carryWindow / 8.0d, 0.0d, 1.0d);
        return new GarminVisualBubble(
            GarminJS.roundTo(profile.clusterWidthM * (1.0d + windowNorm * 0.1d + offsetNorm.abs() * 0.06d), 1),
            GarminJS.roundTo(profile.clusterDepthM * (1.0d + carryNorm * 0.08d + windowNorm * 0.06d), 1),
            GarminJS.roundTo(profile.clusterTiltDeg + offsetNorm * 1.5d + hand * windowNorm * 1.2d, 2),
            GarminJS.roundTo(offsetNorm * 5.0d, 2),
            GarminJS.roundTo(offsetNorm * 0.035d, 3)
        );
    }
}
