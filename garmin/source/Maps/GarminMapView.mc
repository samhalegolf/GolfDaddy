using Toybox.Lang;
using Toybox.WatchUi;
using Toybox.Graphics;
using Toybox.Math;

// Phase 2's map face. Mirrors
// ios/App/ClarityCaddyWatch/HoleMapView.swift (the phone-authoritative,
// read-only picture) and, for the Bubble-ring drawing specifically,
// ios/App/ClarityCaddyWatch/AimableHoleMap.swift's Canvas block — minus all
// interaction (drag/crown/edge-pan), which is Phase 3.
//
// Draws one delivered lite map and the points that matter on it: player,
// green, target, and — when Garmin's own Bubble Engine can compute locally
// (GarminSessionManager.localBubble(), gated by GarminEngineVersion
// agreement) — the actual 168-point ring rather than an approximation.
// Nothing here decides anything about the round: every point comes from the
// authoritative Scene or Garmin's own GPS fix; a missing point is simply
// not drawn, never guessed.
//
// Draw order (Garmin Phase 2+3 plan step 11): hole image, Bubble fill/ring,
// target marker, player marker, small UI chrome. Route/shot aids are not
// drawn in Phase 2 — there is no route overlay need yet without aiming.
class GarminMapView extends WatchUi.View {
    var session;   // GarminSessionManager

    // The resting camera is recomputed only on a hole change (or the first
    // draw), never on every GPS tick or Scene revision — this IS the
    // "camera should not continuously jump on small GPS movements"
    // stability rule (plan step 6), ported as the same mechanism
    // AimableHoleMap.swift uses: settle() runs on appear/hole-change/first-fix
    // only, never on every onChange(of: player).
    var framedHoleNumber;
    var camera;         // GarminMapCamera or null

    function initialize(session) {
        View.initialize();
        self.session = session;
        framedHoleNumber = null;
        camera = null;
    }

    function onUpdate(dc) {
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_BLACK);
        dc.clear();

        var scene = session.scene;
        if (scene == null || !scene.hasRound()) {
            drawCentredText(dc, "No round", dc.getHeight() / 2, Graphics.FONT_MEDIUM);
            return;
        }

        var holeNumber = scene.holeNumber();
        var courseKey = scene.courseKey();
        var manifest = session.mapStore.manifest;
        var hole = (manifest != null && holeNumber != null) ? manifest.hole(holeNumber) : null;

        // Never block the round on a map (plan step 32): fall back to a
        // minimal state rather than a blank or broken screen. The numbers
        // face remains reachable via OPEN_NUMBERS regardless.
        if (hole == null || !hole.spatialReference.isUsable()) {
            drawUnavailable(dc, "Map not available");
            return;
        }

        var bitmap = session.mapStore.bitmapFor(holeNumber, courseKey);
        if (bitmap == null) {
            drawUnavailable(dc, "Loading map...");
            return;
        }

        var reference = hole.spatialReference;
        var imageWidth = reference.imageWidth;
        var imageHeight = reference.imageHeight;
        var viewWidth = dc.getWidth();
        var viewHeight = dc.getHeight();

        var playerGeo = session.playerPoint();
        var greenGeo = (hole.greenLat != null) ? new GarminCoordinate(hole.greenLat, hole.greenLng) : null;
        var local = session.localBubble();
        var targetGeo = (local != null) ? local.target : scene.aimTarget();

        var playerImg = imagePoint(playerGeo, reference);
        var greenImg = imagePoint(greenGeo, reference);
        var targetImg = imagePoint(targetGeo, reference);

        if (framedHoleNumber != holeNumber || camera == null) {
            camera = restingCamera(local, playerImg, targetImg, greenImg, reference, imageWidth, imageHeight, viewWidth, viewHeight);
            framedHoleNumber = holeNumber;
        }

        drawBitmapCropped(dc, bitmap, camera, imageWidth, imageHeight, viewWidth, viewHeight);

        // Dashed aim line, player -> aim point.
        var aimImg = (targetImg != null) ? targetImg : greenImg;
        if (playerImg != null && aimImg != null) {
            drawDashedLine(dc,
                camera.placeX(playerImg["x"], imageWidth, viewWidth), camera.placeY(playerImg["y"], imageHeight, viewHeight),
                camera.placeX(aimImg["x"], imageWidth, viewWidth), camera.placeY(aimImg["y"], imageHeight, viewHeight));
        }

        // The Bubble Garmin computed, drawn as its real shape — every one
        // of the ring points is a coordinate the engine produced — rather
        // than an ellipse approximating it. Falls back to a plain target
        // dot + club label when no local Bubble is available, matching
        // HoleMapView.swift's read-only behaviour exactly.
        if (local != null && local.ring != null && local.ring.size() >= 3) {
            drawRing(dc, local.ring, camera, reference, imageWidth, imageHeight, viewWidth, viewHeight);
        }

        if (greenImg != null) {
            drawRingMarker(dc,
                camera.placeX(greenImg["x"], imageWidth, viewWidth), camera.placeY(greenImg["y"], imageHeight, viewHeight),
                6, Graphics.COLOR_GREEN);
        }

        if (targetImg != null) {
            var tx = camera.placeX(targetImg["x"], imageWidth, viewWidth);
            var ty = camera.placeY(targetImg["y"], imageHeight, viewHeight);
            drawDot(dc, tx, ty, 4, Graphics.COLOR_GREEN);
            var club = (local != null) ? local.club.club : scene.suggestedClub();
            if (club != null) { drawLabel(dc, club, tx, ty - 14); }
        }

        if (playerImg != null) {
            drawDot(dc, camera.placeX(playerImg["x"], imageWidth, viewWidth), camera.placeY(playerImg["y"], imageHeight, viewHeight), 4, Graphics.COLOR_WHITE);
        }

        drawChrome(dc, scene, viewWidth, viewHeight);
    }

    // Mirrors AimableHoleMap.restingCamera's priority order exactly: the
    // local Bubble ring's own bounding box first (with its surroundings),
    // then a nominal extent around the target, then PLAY framing (player
    // low, hole ahead) for a hole with no target at all.
    function restingCamera(local, playerImg, targetImg, greenImg, reference, imageWidth, imageHeight, viewWidth, viewHeight) {
        if (local != null && local.ring != null && local.ring.size() >= 3) {
            var box = imageBoxOfRing(local.ring, reference);
            if (box != null) {
                return GarminMapCamera.bubble(
                    (box["minX"] + box["maxX"]) / 2.0, (box["minY"] + box["maxY"]) / 2.0,
                    box["maxX"] - box["minX"], box["maxY"] - box["minY"],
                    imageWidth, imageHeight, viewWidth, viewHeight);
            }
        }
        if (targetImg != null) {
            var metresPerPixel = (reference has :metresPerPixel && reference.metresPerPixel != null) ? reference.metresPerPixel : 0.5;
            var extentW = 45.0 / metresPerPixel;
            var extentH = 55.0 / metresPerPixel;
            return GarminMapCamera.bubble(targetImg["x"], targetImg["y"], extentW, extentH, imageWidth, imageHeight, viewWidth, viewHeight);
        }
        return GarminMapCamera.play(playerImg, greenImg, imageWidth, imageHeight, viewWidth, viewHeight);
    }

    function imageBoxOfRing(ring, reference) {
        var minX = null; var maxX = null; var minY = null; var maxY = null;
        for (var i = 0; i < ring.size(); i += 1) {
            var p = reference.imagePoint(ring[i].lat, ring[i].lng);
            if (p == null) { continue; }
            if (minX == null || p["x"] < minX) { minX = p["x"]; }
            if (maxX == null || p["x"] > maxX) { maxX = p["x"]; }
            if (minY == null || p["y"] < minY) { minY = p["y"]; }
            if (maxY == null || p["y"] > maxY) { maxY = p["y"]; }
        }
        if (minX == null) { return null; }
        return { "minX" => minX, "maxX" => maxX, "minY" => minY, "maxY" => maxY };
    }

    function imagePoint(geo, reference) {
        if (geo == null) { return null; }
        return reference.imagePoint(geo.lat, geo.lng);
    }

    // ------------------------------------------------------------ draw

    function drawBitmapCropped(dc, bitmap, camera, imageWidth, imageHeight, viewWidth, viewHeight) {
        var x = camera.originX(imageWidth, viewWidth);
        var y = camera.originY(imageHeight, viewHeight);
        var destW = (imageWidth * camera.scale).toNumber();
        var destH = (imageHeight * camera.scale).toNumber();
        // UNVERIFIED: drawBitmap2 (scaled bitmap draw) availability/options
        // shape needs confirming against the installed SDK — see
        // garmin/README.md. Falls back to an unscaled 1:1 draw, which will
        // misalign the overlay markers computed via camera.place() whenever
        // scale != 1; acceptable only as a last resort on devices/SDK
        // versions that truly lack scaled bitmap drawing.
        if (dc has :drawBitmap2) {
            dc.drawBitmap2(x, y, bitmap, { :destWidth => destW, :destHeight => destH, :filterMode => Graphics.FILTER_MODE_BILINEAR });
        } else {
            dc.drawBitmap(x, y, bitmap);
        }
    }

    function drawDashedLine(dc, x1, y1, x2, y2) {
        dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(1);
        var dx = x2 - x1;
        var dy = y2 - y1;
        var length = Math.sqrt(dx * dx + dy * dy);
        if (length < 1) { return; }
        var dashLen = 4.0;
        var gapLen = 3.0;
        var step = dashLen + gapLen;
        var steps = (length / step).toNumber();
        var ux = dx / length;
        var uy = dy / length;
        var travelled = 0.0;
        for (var i = 0; i <= steps; i += 1) {
            var startX = x1 + ux * travelled;
            var startY = y1 + uy * travelled;
            var endTravel = travelled + dashLen;
            if (endTravel > length) { endTravel = length; }
            var endX = x1 + ux * endTravel;
            var endY = y1 + uy * endTravel;
            dc.drawLine(startX, startY, endX, endY);
            travelled += step;
        }
    }

    function drawRing(dc, ring, camera, reference, imageWidth, imageHeight, viewWidth, viewHeight) {
        var points = [];
        for (var i = 0; i < ring.size(); i += 1) {
            var p = reference.imagePoint(ring[i].lat, ring[i].lng);
            if (p == null) { continue; }
            points.add([camera.placeX(p["x"], imageWidth, viewWidth), camera.placeY(p["y"], imageHeight, viewHeight)]);
        }
        if (points.size() < 3) { return; }
        dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
        for (var i = 0; i < points.size(); i += 1) {
            var a = points[i];
            var b = points[(i + 1) % points.size()];
            dc.drawLine(a[0], a[1], b[0], b[1]);
        }
    }

    function drawRingMarker(dc, x, y, radius, color) {
        dc.setColor(color, Graphics.COLOR_TRANSPARENT);
        dc.setPenWidth(2);
        dc.drawCircle(x, y, radius);
    }

    function drawDot(dc, x, y, radius, fillColor) {
        dc.setColor(fillColor, Graphics.COLOR_TRANSPARENT);
        dc.fillCircle(x, y, radius);
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_TRANSPARENT);
        dc.drawCircle(x, y, radius);
    }

    function drawLabel(dc, text, x, y) {
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_TRANSPARENT);
        dc.drawText(x + 1, y + 1, Graphics.FONT_XTINY, text.toUpper(), Graphics.TEXT_JUSTIFY_CENTER);
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(x, y, Graphics.FONT_XTINY, text.toUpper(), Graphics.TEXT_JUSTIFY_CENTER);
    }

    function drawCentredText(dc, text, y, font) {
        dc.drawText(dc.getWidth() / 2, y, font, text, Graphics.TEXT_JUSTIFY_CENTER);
    }

    function drawUnavailable(dc, message) {
        dc.drawText(dc.getWidth() / 2, dc.getHeight() * 0.42, Graphics.FONT_SMALL, message, Graphics.TEXT_JUSTIFY_CENTER);
        dc.drawText(dc.getWidth() / 2, dc.getHeight() * 0.58, Graphics.FONT_XTINY, "BACK for numbers", Graphics.TEXT_JUSTIFY_CENTER);
    }

    // Small UI chrome only — the map stays visually dominant (plan step 11).
    function drawChrome(dc, scene, viewWidth, viewHeight) {
        var holeNumber = scene.holeNumber();
        var label = "H" + (holeNumber != null ? holeNumber.toString() : "-");
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(4, 2, Graphics.FONT_XTINY, label, Graphics.TEXT_JUSTIFY_LEFT);

        var centreM = scene.distanceCentreM();
        if (centreM != null) {
            var text = centreM.toNumber().toString() + "m";
            dc.drawText(viewWidth - 4, 2, Graphics.FONT_XTINY, text, Graphics.TEXT_JUSTIFY_RIGHT);
        }
    }
}
