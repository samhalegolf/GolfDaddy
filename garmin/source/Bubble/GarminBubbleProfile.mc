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

    function initialize(club, baseCarryM, totalM, faceAlignmentOffsetDeg, aimOffsetDeg, aimOffsetM,
            clusterWidthM, clusterDepthM, clusterTiltDeg, faceWindowDeg, carryWindowPct, distanceTendencyPct) {
        self.club = club;
        self.baseCarryM = baseCarryM;
        self.totalM = totalM;
        self.faceAlignmentOffsetDeg = faceAlignmentOffsetDeg;
        self.aimOffsetDeg = aimOffsetDeg;
        self.aimOffsetM = aimOffsetM;
        self.clusterWidthM = clusterWidthM;
        self.clusterDepthM = clusterDepthM;
        self.clusterTiltDeg = clusterTiltDeg;
        self.faceWindowDeg = faceWindowDeg;
        self.carryWindowPct = carryWindowPct;
        self.distanceTendencyPct = distanceTendencyPct;
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
        var multiplier = GarminJS.clamp(GarminBubbleTables.BASE_DISPERSION_MULTIPLIER, 0.6, 1.8);
        var clusterWidthM = GarminJS.roundTo(baseCarryM * ratios["width"] * multiplier * GarminBubbleTables.GEOMETRY_WIDTH_SCALE, 1);
        var clusterDepthM = GarminJS.roundTo(baseCarryM * ratios["depth"] * multiplier * GarminBubbleTables.GEOMETRY_DEPTH_SCALE, 1);

        // gdDeriveAimOffset — tan(deg) x the CARRY, not the shot.
        var aimOffsetDeg = GarminJS.roundTo(faceAlignmentOffsetDeg, 2);
        var aimOffsetM = GarminJS.roundTo(Math.tan(GarminGeo.degToRad(faceAlignmentOffsetDeg)) * baseCarryM, 2);

        // gdDeriveDistanceTendency, fed the WINDOW as the face delta — not
        // the player's aim.
        var hand = handedness.handSign();
        var strength;
        if (group.equals("driver")) { strength = 0.42; }
        else if (group.equals("woodHybrid")) { strength = 0.36; }
        else if (group.equals("wedge")) { strength = 0.18; }
        else { strength = 0.30; } // iron
        var distanceTendencyPct = GarminJS.roundTo(GarminJS.clamp(-(hand * faceWindowDeg) * strength, -5.0, 5.0), 2);

        // gdDeriveClusterTilt
        var offsetInfluence = faceAlignmentOffsetDeg.abs() * 0.12;
        var windowInfluence = faceWindowDeg.abs() * 0.9;
        var carryInfluence = carryWindowPct.abs() * 0.08;
        var tiltRaw = hand * (ratios["tiltBaseDeg"] + offsetInfluence + windowInfluence + carryInfluence) * GarminBubbleTables.GEOMETRY_TILT_SCALE;
        var clusterTiltDeg = GarminJS.roundTo(
            GarminJS.clamp(tiltRaw, -GarminBubbleTables.GEOMETRY_TILT_MAX_DEG, GarminBubbleTables.GEOMETRY_TILT_MAX_DEG), 2);

        var totalRounded = (totalM != null) ? GarminJS.roundTo(totalM, 1) : null;

        return new GarminBubbleProfile(
            club, GarminJS.roundTo(baseCarryM, 1), totalRounded,
            GarminJS.roundTo(faceAlignmentOffsetDeg, 2), aimOffsetDeg, aimOffsetM,
            clusterWidthM, clusterDepthM, clusterTiltDeg,
            faceWindowDeg, carryWindowPct, distanceTendencyPct
        );
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
        var hand = 1.0; // deliberately not profile handedness — see note above
        var offsetNorm = GarminJS.clamp((hand * profile.faceAlignmentOffsetDeg) / 6.0, -1.0, 1.0);
        var faceWindow = (profile.faceWindowDeg == 0) ? 0.7 : profile.faceWindowDeg;
        var windowNorm = GarminJS.clamp(faceWindow / 1.5, 0.0, 1.0);
        var carryWindow = (profile.carryWindowPct == 0) ? 4.2 : profile.carryWindowPct;
        var carryNorm = GarminJS.clamp(carryWindow / 8.0, 0.0, 1.0);
        return new GarminVisualBubble(
            GarminJS.roundTo(profile.clusterWidthM * (1.0 + windowNorm * 0.1 + offsetNorm.abs() * 0.06), 1),
            GarminJS.roundTo(profile.clusterDepthM * (1.0 + carryNorm * 0.08 + windowNorm * 0.06), 1),
            GarminJS.roundTo(profile.clusterTiltDeg + offsetNorm * 1.5 + hand * windowNorm * 1.2, 2),
            GarminJS.roundTo(offsetNorm * 5.0, 2),
            GarminJS.roundTo(offsetNorm * 0.035, 3)
        );
    }
}
