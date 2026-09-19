using Toybox.Lang;

// The rendered Bubble: a shape with real radii, ready to be laid on the map.
// Mirrors ios/WatchBubbleEngine/Sources/WatchBubbleEngine/BubblePayload.swift
// (getGDBForClub, gdNormalizeGpsBubblePayload's floors, and
// gdGpsBubbleDisplayPayload's caps). Deliberately does NOT port the pixel
// clamp at the end of the display payload — that measures against the
// phone's map viewport, a framing question for the Camera, not the engine.
// The parity fixtures are recorded with no projection installed, i.e.
// exactly this un-clamped path.
class GarminBubblePayload {
    var club;
    var baseCarryM;
    var totalM;
    var rolloutM;
    var aimOffsetDeg;
    var aimOffsetM;
    var clusterWidthM;
    var clusterDepthM;
    var clusterTiltDeg;
    var distanceTendencyPct;
    var visual;          // GarminVisualBubble
    var radiusM;
    var lateralRadiusM;
    var depthRadiusM;
    var isGhostBag;

    // Monkey C caps a method at 9 arguments and this record carries 15
    // fields, so there is no memberwise initialize() to be had. Construct
    // with `new GarminBubblePayload()` and assign every field. The three
    // sites below are the only ones; each sets all 15, deliberately, because
    // a field left unset here is a null that only shows up as a missing
    // Bubble on the watch.
    function initialize() {
    }

    // getGDBForClub. The roll-out term gets a DEEPER Bubble: a Driver
    // carrying 205 and finishing at 228 gets 23m of roll-out folded into its
    // depth; a wedge that stops dead gets none.
    static function build(profile, isGhostBag) {
        var carryM = profile.baseCarryM > 0 ? profile.baseCarryM : 0.0;
        var derivedTotal = profile.totalM != null ? profile.totalM : GarminBag.totalForCarry(profile.club, carryM);
        var totalM = carryM > derivedTotal ? carryM : derivedTotal;
        var rolloutM = totalM - carryM;
        if (rolloutM < 0) { rolloutM = 0.0; }

        var baseVisual = GarminVisualBubble.render(profile);
        var lateralRadius = profile.clusterWidthM / 2.0;
        if (lateralRadius < 1.0) { lateralRadius = 1.0; }
        var baseDepthRadius = profile.clusterDepthM / 2.0;
        if (baseDepthRadius < 1.0) { baseDepthRadius = 1.0; }

        var totalDepthRadius;
        if (rolloutM > 0) {
            var alt = rolloutM + (7.0 < baseDepthRadius * 0.22 ? 7.0 : baseDepthRadius * 0.22);
            totalDepthRadius = baseDepthRadius > alt ? baseDepthRadius : alt;
        } else {
            totalDepthRadius = baseDepthRadius;
        }

        var visualDepthCandidate = totalDepthRadius * 2.0;
        var visualDepthM = GarminJS.roundTo(
            baseVisual.visualDepthM > visualDepthCandidate ? baseVisual.visualDepthM : visualDepthCandidate, 1);
        var visual = new GarminVisualBubble(
            baseVisual.visualWidthM, visualDepthM, baseVisual.visualTiltDeg, baseVisual.visualSkewDeg, baseVisual.visualYBias);

        var depthRadius = totalDepthRadius > (visual.visualDepthM / 2.0) ? totalDepthRadius : (visual.visualDepthM / 2.0);
        var radius = GarminBubbleTables.DEV_MINIMUM_BUBBLE_RADIUS_M;
        if (lateralRadius > radius) { radius = lateralRadius; }
        if (depthRadius > radius) { radius = depthRadius; }

        var out = new GarminBubblePayload();
        out.club = profile.club;
        out.baseCarryM = carryM;
        out.totalM = GarminJS.roundTo(totalM, 1);
        out.rolloutM = GarminJS.roundTo(rolloutM, 1);
        out.aimOffsetDeg = profile.aimOffsetDeg;
        out.aimOffsetM = profile.aimOffsetM;
        out.clusterWidthM = profile.clusterWidthM;
        out.clusterDepthM = profile.clusterDepthM;
        out.clusterTiltDeg = profile.clusterTiltDeg;
        out.distanceTendencyPct = profile.distanceTendencyPct;
        out.visual = visual;
        out.radiusM = GarminJS.roundTo(radius, 1);
        out.lateralRadiusM = GarminJS.roundTo(lateralRadius, 1);
        out.depthRadiusM = GarminJS.roundTo(depthRadius, 1);
        out.isGhostBag = isGhostBag;
        return out;
    }

    // gdNormalizeGpsBubblePayload — floors, applied after the engine has had
    // its say. minRadius * 0.55 on the half-axes, not minRadius, because the
    // floor is on the Bubble as a whole.
    function normalised() {
        var minRadius = GarminBubbleTables.DEV_MINIMUM_BUBBLE_RADIUS_M;
        if (minRadius < 1.0) { minRadius = 1.0; }
        if (visual.visualWidthM <= 0 || visual.visualDepthM <= 0) { return self; }

        var lateral = visual.visualWidthM / 2.0;
        if (lateral < minRadius * 0.55) { lateral = minRadius * 0.55; }
        var depth = visual.visualDepthM / 2.0;
        if (depth < minRadius * 0.55) { depth = minRadius * 0.55; }
        var radius = minRadius;
        if (radiusM > radius) { radius = radiusM; }
        if (lateral > radius) { radius = lateral; }
        if (depth > radius) { radius = depth; }

        var out = new GarminBubblePayload();
        out.club = club;
        out.baseCarryM = baseCarryM;
        out.totalM = totalM;
        out.rolloutM = rolloutM;
        out.aimOffsetDeg = aimOffsetDeg;
        out.aimOffsetM = GarminJS.roundTo(aimOffsetM, 2);
        out.clusterWidthM = clusterWidthM;
        out.clusterDepthM = clusterDepthM;
        out.clusterTiltDeg = clusterTiltDeg;
        out.distanceTendencyPct = GarminJS.roundTo(GarminJS.clamp(distanceTendencyPct, -10.0, 10.0), 2);
        out.visual = new GarminVisualBubble(
            GarminJS.roundTo(visual.visualWidthM, 1),
            GarminJS.roundTo(visual.visualDepthM, 1),
            GarminJS.roundTo(GarminJS.clamp(visual.visualTiltDeg, -18.0, 18.0), 2),
            GarminJS.roundTo(GarminJS.clamp(visual.visualSkewDeg, -16.0, 16.0), 2),
            GarminJS.roundTo(GarminJS.clamp(visual.visualYBias, -0.18, 0.18), 3)
        );
        out.radiusM = GarminJS.roundTo(radius, 1);
        out.lateralRadiusM = GarminJS.roundTo(lateral, 1);
        out.depthRadiusM = GarminJS.roundTo(depth, 1);
        out.isGhostBag = isGhostBag;
        return out;
    }

    // gdGpsBubbleDisplayPayload, minus the pixel clamp. Caps first, then
    // floors, then the whole scale is bounded to [0.42, 1.08] — and a scale
    // within 1.5% of 1 is left alone entirely. Order matters: a Bubble can be
    // pushed UP by the floors after being pushed down by the caps.
    function displayed(shotDistanceM) {
        var d = (shotDistanceM != null && shotDistanceM.toDouble().isFinite() && shotDistanceM > 0) ? shotDistanceM : 155.0;
        var lateral = lateralRadiusM > 1.0 ? lateralRadiusM : 1.0;
        var depth = depthRadiusM > 1.0 ? depthRadiusM : 1.0;

        var maxLateral = GarminJS.clamp(d * GarminBubbleTables.GEOMETRY_GPS_MAX_LATERAL_PCT, 9.0, GarminBubbleTables.GEOMETRY_GPS_MAX_LATERAL_M);
        var maxDepth = GarminJS.clamp(d * GarminBubbleTables.GEOMETRY_GPS_MAX_DEPTH_PCT, 12.0, GarminBubbleTables.GEOMETRY_GPS_MAX_DEPTH_M);
        var minLateral = GarminJS.clamp(d * 0.028, 3.8, 7.5);
        var minDepth = GarminJS.clamp(d * 0.038, 5.2, 11.0);

        var scale = 1.0;
        var latScale = maxLateral / lateral;
        var depScale = maxDepth / depth;
        if (latScale < scale) { scale = latScale; }
        if (depScale < scale) { scale = depScale; }
        if (scale < 1.0) {
            lateral *= scale;
            depth *= scale;
        }
        var minScaleCandidate = minLateral / lateral;
        var minScaleCandidate2 = minDepth / depth;
        var minScale = minScaleCandidate > minScaleCandidate2 ? minScaleCandidate : minScaleCandidate2;
        if (minScale > 1.0) { minScale = 1.0; }
        if (minScale > scale) { scale = minScale; }
        scale = GarminJS.clamp(scale, 0.42, 1.08);

        if ((scale - 1.0).abs() < 0.015) { return self; }
        return scaledForDisplay(scale);
    }

    // gdScaleGpsBubblePayloadForDisplay.
    function scaledForDisplay(scale) {
        var w = visual.visualWidthM > 1.0 ? visual.visualWidthM : 1.0;
        var dep = visual.visualDepthM > 1.0 ? visual.visualDepthM : 1.0;
        var r = radiusM > 1.0 ? radiusM : 1.0;
        var lat = lateralRadiusM > 1.0 ? lateralRadiusM : 1.0;
        var dr = depthRadiusM > 1.0 ? depthRadiusM : 1.0;
        var out = new GarminBubblePayload();
        out.club = club;
        out.baseCarryM = baseCarryM;
        out.totalM = totalM;
        out.rolloutM = rolloutM;
        out.aimOffsetDeg = aimOffsetDeg;
        out.aimOffsetM = aimOffsetM;
        out.clusterWidthM = clusterWidthM;
        out.clusterDepthM = clusterDepthM;
        out.clusterTiltDeg = clusterTiltDeg;
        out.distanceTendencyPct = distanceTendencyPct;
        out.visual = new GarminVisualBubble(
            GarminJS.roundTo(w * scale, 1), GarminJS.roundTo(dep * scale, 1),
            visual.visualTiltDeg, visual.visualSkewDeg, visual.visualYBias
        );
        out.radiusM = GarminJS.roundTo(r * scale, 1);
        out.lateralRadiusM = GarminJS.roundTo(lat * scale, 1);
        out.depthRadiusM = GarminJS.roundTo(dr * scale, 1);
        out.isGhostBag = isGhostBag;
        return out;
    }
}
