using Toybox.Lang;
using Toybox.Math;

// The Garmin Bubble Engine. Mirrors
// ios/WatchBubbleEngine/Sources/WatchBubbleEngine/BubbleEngine.swift exactly.
//
// One function: player + target + bag + My Bubble in, the Bubble Garmin
// draws out. Stateless — GarminBubbleEngine.calculate(input), never
// engine.moveSomething(). Everything mutable (current target, selected club,
// club-transition band) belongs to GarminPlayState. It answers where the
// Bubble is, what shape it is, which club and what distance — nothing about
// the screen: no panning, no zoom, no camera.

class GarminClubSelection {
    var club;
    var carryM;
    var totalM;
    var isGhost;
    function initialize(club, carryM, totalM, isGhost) {
        self.club = club;
        self.carryM = carryM;
        self.totalM = totalM;
        self.isGhost = isGhost;
    }
}

class GarminBubbleResult {
    var target;           // GarminCoordinate
    var targetDistanceM;
    var shotBearingDeg;   // compass bearing, for display
    var club;             // GarminClubSelection
    var centre;           // GarminCoordinate - where the Bubble is drawn
    var ring;              // Array of GarminCoordinate, world coordinates
    var widthM;
    var depthM;
    var tiltDeg;
    var aimOffsetDeg;
    var aimOffsetM;
    var engineVersion;

    function initialize(target, targetDistanceM, shotBearingDeg, club, centre, ring,
            widthM, depthM, tiltDeg, aimOffsetDeg, aimOffsetM, engineVersion) {
        self.target = target;
        self.targetDistanceM = targetDistanceM;
        self.shotBearingDeg = shotBearingDeg;
        self.club = club;
        self.centre = centre;
        self.ring = ring;
        self.widthM = widthM;
        self.depthM = depthM;
        self.tiltDeg = tiltDeg;
        self.aimOffsetDeg = aimOffsetDeg;
        self.aimOffsetM = aimOffsetM;
        self.engineVersion = engineVersion;
    }
}

module GarminBubbleEngine {

    // Cheap enough to run on every frame of a drag: coordinate maths, a bag
    // lookup, the profile derivation and a 168-point ring. Input is a
    // Dictionary: { "player" => Coordinate, "target" => Coordinate,
    // "bag" => GarminBagSnapshot, "bubble" => GarminMyBubble,
    // "heldClub" => String or null }.
    function calculate(input) {
        var player = input["player"];
        var target = input["target"];
        var bag = input["bag"];
        var bubble = input["bubble"];
        var heldClub = input.hasKey("heldClub") ? input["heldClub"] : null;

        var distanceM = GarminGeo.distance(player, target);
        if (distanceM == null || !distanceM.isFinite() || distanceM <= 0) { return null; }

        var row = GarminBag.resolveClub(bag, distanceM, heldClub);
        if (row == null) { return null; }

        var profile = GarminBubbleProfile.derive(
            row.club, GarminJS.round(row.carryM), row.totalM, bubble.effectiveOffsetDeg(), bubble
        );
        var payload = GarminBubblePayload.build(profile, bag.isGhost).normalised().displayed(distanceM);

        var shotBearing = GarminGeo.bearing(player, target);
        var aimOffsetM = gpsAimOffsetM(payload, distanceM);
        var centre = renderCentre(target, payload, shotBearing, aimOffsetM);

        return new GarminBubbleResult(
            target, distanceM, compassBearingDeg(player, target),
            new GarminClubSelection(row.club, row.carryM, row.totalM, bag.isGhost),
            centre, buildRing(centre, payload, shotBearing),
            payload.visual.visualWidthM, payload.visual.visualDepthM, payload.visual.visualTiltDeg,
            payload.aimOffsetDeg, aimOffsetM, GarminEngineVersion.CURRENT
        );
    }

    // gdGpsAimOffsetM — tan(My Bubble degrees) x the SHOT distance, not the
    // club's carry. A quarter-of-the-shot bound is geometric sanity: 14.04
    // degrees, far outside any aim a player can set.
    function gpsAimOffsetM(payload, shotDistanceM) {
        var deg = payload.aimOffsetDeg;
        if (shotDistanceM == null || shotDistanceM <= 0) { return GarminJS.roundTo(payload.aimOffsetM, 2); }
        var limit = shotDistanceM * 0.25;
        if (limit < 2.0) { limit = 2.0; }
        return GarminJS.roundTo(GarminJS.clamp(Math.tan(GarminGeo.degToRad(deg)) * shotDistanceM, -limit, limit), 2);
    }

    // gdBubbleRenderCenter — the target, pushed sideways by the aim and
    // forward by the visual Y bias. The side offset is bounded a second time
    // at a quarter of the aim base; either bound can bind first depending on
    // the shot, so both are reproduced.
    function renderCentre(target, payload, shotBearing, aimOffsetM) {
        var aimBase = payload.baseCarryM > 0 ? payload.baseCarryM : payload.radiusM * 10.0;
        if (aimBase < 1.0) { aimBase = 1.0; }
        var sideLimit = aimBase * 0.25;
        if (sideLimit < 2.0) { sideLimit = 2.0; }
        var sideOffset = GarminJS.clamp(aimOffsetM, -sideLimit, sideLimit);
        var forwardBias = GarminJS.clamp(payload.visual.visualYBias, -0.18, 0.18) * (payload.depthRadiusM > 1.0 ? payload.depthRadiusM : 1.0);
        return GarminGeo.projectOffset(target, shotBearing, forwardBias, sideOffset);
    }

    // bubbleRadiusFactor — the distance tendency, breathing the ring in and
    // out by at most 4% front to back. bubbleTextureFactor is deliberately
    // NOT ported — it is gated on phone display state Garmin has no
    // equivalent of, and the fixtures were recorded with it inactive.
    function radiusFactor(rel, payload) {
        var front = Math.cos(rel);
        var frontPos = front > 0 ? front : 0.0;
        var backPos = front < 0 ? -front : 0.0;
        var tendency = GarminJS.clamp(payload.distanceTendencyPct, -5.0, 5.0) / 5.0;
        var factor = 1.0 + tendency * (0.026 * frontPos - 0.018 * backPos);
        if (factor < 0.96) { return 0.96; }
        if (factor > 1.04) { return 1.04; }
        return factor;
    }

    // buildBubbleShape + gdSmoothBubbleLocalRing + gdBubbleLocalToLatLng.
    //
    // ORIENTATION, which this codebase has been bitten by once: the ACROSS
    // axis (lateral) lies on x, square to the shot; the ALONG axis (depth)
    // lies on y. rel = 0 is Long, rel = pi/2 is Right — see
    // scripts/gd-bubble-frame-core.js for the shared definition. Writing it
    // the other way round lays the Bubble's longer axis straight down the
    // target line.
    function buildRing(centre, payload, shotBearing) {
        var lateral = payload.lateralRadiusM > 1.0 ? payload.lateralRadiusM : 1.0;
        lateral *= GarminBubbleTables.MAIN_RING_SCALE;
        var depth = payload.depthRadiusM > 1.0 ? payload.depthRadiusM : 1.0;
        depth *= GarminBubbleTables.MAIN_RING_SCALE;
        var steps = GarminBubbleTables.RING_STEPS;

        var xs = new [steps];
        var ys = new [steps];
        for (var i = 0; i < steps; i += 1) {
            var rel = (Math.PI * 2.0 * i) / steps;
            var rf = radiusFactor(rel, payload);
            xs[i] = Math.cos(rel) * lateral * rf;
            ys[i] = Math.sin(rel) * depth * rf;
        }

        // Two smoothing passes, each a weighted average with both neighbours
        // around the closed ring. Weights (0.72 + 0.14*2 = 1.0) copied as
        // written, not rebalanced.
        for (var pass = 0; pass < 2; pass += 1) {
            var sx = new [steps];
            var sy = new [steps];
            for (var i = 0; i < steps; i += 1) {
                var prev = (i - 1 + steps) % steps;
                var next = (i + 1) % steps;
                sx[i] = xs[i] * 0.72 + (xs[prev] + xs[next]) * 0.14;
                sy[i] = ys[i] * 0.72 + (ys[prev] + ys[next]) * 0.14;
            }
            xs = sx;
            ys = sy;
        }

        var tilt = GarminGeo.degToRad(payload.visual.visualTiltDeg);
        var skew = GarminGeo.degToRad(payload.visual.visualSkewDeg);
        var ring = new [steps];
        for (var i = 0; i < steps; i += 1) {
            var skewedY = ys[i] + Math.tan(skew) * xs[i] * 0.42;
            var rx = xs[i] * Math.cos(tilt) - skewedY * Math.sin(tilt);
            var ry = xs[i] * Math.sin(tilt) + skewedY * Math.cos(tilt);
            ring[i] = GarminGeo.localPointToLatLng(centre, shotBearing, rx, ry);
        }
        return ring;
    }

    // gdTargetForGreenCentre, reduced to the part Garmin can honestly
    // answer: the green when the bag reaches it (plus 3m grace), otherwise a
    // point down the hole's own ROUTE at the edge of the bag — never a point
    // on the straight line to the green, which on a dogleg is through the
    // trees.
    //
    // WHAT IS NOT PORTED: the phone's fairway-line grab gate
    // (gdStartIsInMappedTeeArea) needs the mapped tee area, which is not in
    // the hole reference. With a route, this uses the route; with no route,
    // it returns null and the caller keeps the phone's target — the honest
    // version of not knowing.
    function defaultTarget(player, green, route, bag) {
        var maxM = GarminBag.maxPlayableM(bag);
        if (maxM == null || maxM <= 0) { return null; }
        var toGreen = GarminGeo.distance(player, green);
        if (toGreen == null || !toGreen.isFinite()) { return null; }
        if (toGreen <= maxM + 3.0) { return green; }
        return layupAlong(route, player, maxM);
    }

    // fairwayLayupTargetByShotDistance — walk the route in 7m steps, ignore
    // everything behind the player, take the sample closest to the edge of
    // the bag without exceeding it. The `+6` keeps the answer ahead of where
    // the player stands; the final floor (max(45, maxM*0.58)) refuses an
    // answer so short it would be a worse suggestion than none.
    function layupAlong(route, player, maxM) {
        var samples = sampleRoute(route, 7.0);
        if (samples.size() < 2) { return null; }

        var nearestIndex = 0;
        var nearestScore = GarminGeo.distance(player, samples[0]["point"]);
        for (var i = 0; i < samples.size(); i += 1) {
            var score = GarminGeo.distance(player, samples[i]["point"]);
            if (score < nearestScore) { nearestIndex = i; nearestScore = score; }
        }
        var minProgress = samples[nearestIndex]["progress"];
        if (minProgress < 0) { minProgress = 0.0; }

        var bestPoint = null;
        var bestProgress = null;
        var bestDirect = null;
        var bestScore = null;
        for (var i = 0; i < samples.size(); i += 1) {
            var progress = samples[i]["progress"];
            if (progress < minProgress + 6.0) { continue; }
            var direct = GarminGeo.distance(player, samples[i]["point"]);
            if (direct == null || !direct.isFinite() || direct > maxM + 3.0) { continue; }
            var score = (maxM - direct).abs();
            var take = false;
            if (bestPoint == null) { take = true; }
            else if (score < bestScore - 0.75) { take = true; }
            else if ((score - bestScore).abs() <= 0.75 && progress > bestProgress) { take = true; }
            if (take) {
                bestPoint = samples[i]["point"];
                bestProgress = progress;
                bestDirect = direct;
                bestScore = score;
            }
        }
        if (bestPoint == null) { return null; }
        var floor = maxM * 0.58;
        if (floor < 45.0) { floor = 45.0; }
        if (bestDirect < floor) { return null; }
        return bestPoint;
    }

    // sampleRouteProgress — evenly spaced points along the route, each
    // carrying how far along the hole it sits. Returns an Array of
    // Dictionary { "point" => Coordinate, "progress" => Double }.
    function sampleRoute(route, stepM) {
        if (route.size() == 0) { return []; }
        var samples = [{ "point" => route[0], "progress" => 0.0 }];
        var progress = 0.0;
        for (var i = 1; i < route.size(); i += 1) {
            var a = route[i - 1];
            var b = route[i];
            var segment = GarminGeo.distance(a, b);
            if (segment == null || !segment.isFinite() || segment <= 0) { continue; }
            var brg = GarminGeo.bearing(a, b);
            var stepFloor = stepM > 3.0 ? stepM : 3.0;
            var steps = Math.ceil(segment / stepFloor).toNumber();
            if (steps < 1) { steps = 1; }
            for (var s = 1; s <= steps; s += 1) {
                var along = segment * (s.toDouble() / steps.toDouble());
                samples.add({ "point" => GarminGeo.project(a, brg, along), "progress" => progress + along });
            }
            progress += segment;
        }
        return samples;
    }

    // The compass bearing player -> target, cosine-corrected, for display
    // and for the parity fixtures. Deliberately NOT GarminGeo.bearing, which
    // is the engine's own uncorrected convention used to lay the Bubble
    // down: this one is a number a person might read.
    function compassBearingDeg(from, to) {
        var north = (to.lat - from.lat) * GarminGeo.METRES_PER_DEGREE;
        var east = (to.lng - from.lng) * GarminGeo.METRES_PER_DEGREE * Math.cos(GarminGeo.degToRad((from.lat + to.lat) / 2.0));
        var deg = GarminGeo.radToDeg(Math.atan2(east, north)) + 360.0;
        // truncatingRemainder(dividingBy: 360) equivalent
        var wrapped = deg - (Math.floor(deg / 360.0) * 360.0);
        return GarminJS.roundTo(wrapped, 2);
    }
}
