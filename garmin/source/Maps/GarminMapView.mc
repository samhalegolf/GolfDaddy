using Toybox.Lang;
using Toybox.WatchUi;
using Toybox.Graphics;
using Toybox.Math;

// Phase 2 + 3's map face. Mirrors
// ios/App/ClarityCaddyWatch/HoleMapView.swift (the phone-authoritative,
// read-only picture, still what's drawn while `aiming` is false and no
// local target has been placed) and
// ios/App/ClarityCaddyWatch/AimableHoleMap.swift (drag/nudge interaction and
// the Bubble-ring drawing) — everything AimableHoleMap does through its own
// private `WatchPlayState`, this drives through GarminSessionManager's
// SHARED `playState` instead (see GarminSessionManager.localBubble()'s
// header comment for why one shared instance reproduces the same outcome
// as Apple's two separate ones).
//
// Draws one delivered lite map and the points that matter on it: player,
// green, target, and — when Garmin's own Bubble Engine can compute locally
// (GarminSessionManager.localBubble(), gated by GarminEngineVersion
// agreement) — the actual 168-point ring rather than an approximation.
// Nothing here decides anything about the round: every point comes from the
// authoritative Scene, Garmin's own GPS fix, or the player's own drag/nudge;
// a missing point is simply not drawn, never guessed.
//
// Draw order (Garmin Phase 2+3 plan step 11): hole image, Bubble fill/ring,
// target marker, player marker, small UI chrome.
//
// THE WHOLE PHASE 3 INTERACTION PATH, in one place (mirrors
// AimableHoleMap.swift's own header comment):
//
//     finger/nudge -> view point
//               -> image point      (GarminMapCamera.imagePointFromView)
//               -> clamped to image bounds — LOCAL UX ONLY (plan step 19)
//               -> coordinate        (GarminMapSpatialReference.coordinate)
//               -> Bubble            (GarminSessionManager.playState.moveTarget)
//               -> drawn immediately
//     release/confirm -> AIM_AT to the phone, ONCE (never per-frame)
//
// AIMING ONLY. Dragging/nudging moves the TARGET. Nothing here can move the
// player — that comes from GPS and only from GPS (see
// [[mapped-vs-manual-play-boundary]]: tap-to-place is not part of
// geo-mapped play, and this is exactly that boundary, not a violation of it
// — the thing being placed is the AIM, never the golfer's own position).
class GarminMapView extends WatchUi.View {
    var session;   // GarminSessionManager

    // The resting camera is recomputed only on a hole change (or the first
    // draw), never on every GPS tick or Scene revision — this IS the
    // "camera should not continuously jump on small GPS movements"
    // stability rule (plan step 6), ported as the same mechanism
    // AimableHoleMap.swift uses: settle() runs on appear/hole-change/first-fix
    // only, never on every onChange(of: player). A confirmed or cancelled
    // aim likewise does NOT re-fit the camera — AimableHoleMap.swift's own
    // rule: "the framing STAYS. A re-fit here slid the map under a player
    // who had just put the target where they wanted it."
    var framedHoleNumber;
    var camera;         // GarminMapCamera or null

    // Phase 3 interaction state — mirrors AimableHoleMap.swift's @State
    // fields (dragging, camera) rather than putting UI-transient state in
    // GarminPlayState, which stays pure shot state (target/heldClub/bubble)
    // shared with the rest of the session.
    var aiming;          // Boolean: SELECT/enterAimMode has been pressed, or a drag is in progress
    var dragActive;       // Boolean: a touch drag is currently down

    // Cached from the last onUpdate, so input handlers (called from
    // CaddyInputDelegate, outside the draw pass) can convert a screen point
    // without re-deriving the hole/manifest/viewport lookup.
    var lastReference;      // GarminMapSpatialReference or null
    var lastImageWidth;
    var lastImageHeight;
    var lastViewWidth;
    var lastViewHeight;

    static var NUDGE_STEP_IMAGE_PX = 10.0;

    function initialize(session) {
        View.initialize();
        self.session = session;
        framedHoleNumber = null;
        camera = null;
        aiming = false;
        dragActive = false;
        lastReference = null;
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

        // Cached for dragTo()/nudge(), called from CaddyInputDelegate
        // outside this draw pass.
        lastReference = reference;
        lastImageWidth = imageWidth;
        lastImageHeight = imageHeight;
        lastViewWidth = viewWidth;
        lastViewHeight = viewHeight;

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
            // Bigger while actively being dragged — the thing under the
            // finger should be visible beside the finger (AimableHoleMap's
            // own dragging ? 6 : 4).
            drawDot(dc, tx, ty, dragActive ? 6 : 4, Graphics.COLOR_GREEN);
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

        if (aiming) {
            dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
            dc.drawText(viewWidth / 2, 2, Graphics.FONT_XTINY, "AIMING", Graphics.TEXT_JUSTIFY_CENTER);
        }
    }

    // ------------------------------------------------------- interaction
    //
    // Everything below is called from CaddyInputDelegate, never from
    // onUpdate. All of it operates on session.playState directly — the
    // single shared instance GarminSessionManager.localBubble() also reads
    // — so a drag/nudge is visible immediately on the next onUpdate/redraw
    // with no extra plumbing.

    // SELECT (not currently aiming), or the first touch of a drag: seeds
    // playState.target from whatever is CURRENTLY DISPLAYED (its own prior
    // local target if one survived a hole, otherwise the Scene's target) so
    // there is something to nudge/drag from. A bag/profile snapshot is
    // required — without one there is nothing to compute a Bubble from, and
    // the map stays a picture (matching AimableHoleMap's canAim gate).
    function enterAimMode() {
        if (!canAimNow()) { return; }
        if (session.playState.target == null) {
            var seed = session.scene.aimTarget();
            if (seed == null) { return; }
            session.playState.moveTarget(seed, session.playerStore.snapshot.bag, session.playerStore.snapshot.bubble);
        }
        aiming = true;
    }

    // The aim, sent once — never per drag/nudge frame (plan step 13/39).
    function confirmAim() {
        if (session.playState.target != null) {
            session.sendAim(session.playState.target);
        }
        aiming = false;
    }

    // BACK while aiming: restore the last authoritative target and leave
    // Aim Mode (plan step 21). Clearing playState.target makes
    // GarminSessionManager.localBubble() fall back to the Scene's target on
    // the very next read — "restoring" is simply no longer overriding it.
    // Never sends AIM_AT.
    function cancelAim() {
        session.playState.target = null;
        session.playState.bubble = null;
        session.playState.heldClub = null;
        aiming = false;
        dragActive = false;
    }

    // UP/DOWN/LEFT/RIGHT nudge, for button devices (plan step 14). Moves
    // the current target by NUDGE_STEP_IMAGE_PX in image space — screen/map
    // space, not a raw compass direction, so the nudge always matches what
    // is actually displayed regardless of the bake's own orientation.
    function nudge(dxImagePx, dyImagePx) {
        if (!aiming || !canAimNow() || lastReference == null) { return; }
        var current = session.playState.target;
        if (current == null) { return; }
        var img = lastReference.imagePoint(current.lat, current.lng);
        if (img == null) { return; }
        applyImagePoint(img["x"] + dxImagePx, img["y"] + dyImagePx);
    }

    // ---- Touch drag (plan step 13) ----
    //
    // UNVERIFIED: wired defensively from CaddyInputDelegate against this
    // session's best guess at Connect IQ's touch event shape — see
    // CaddyInputDelegate.onTouch's header comment. This trio
    // (dragStart/dragTo/dragEnd) is the part that IS confidently correct:
    // the state machine and the screen->image->coordinate->Bubble pipeline,
    // independent of exactly how the OS hands over touch coordinates.

    function dragStart(viewX, viewY) {
        if (!canAimNow()) { return; }
        enterAimMode();
        dragActive = true;
        dragTo(viewX, viewY);
    }

    function dragTo(viewX, viewY) {
        if (!dragActive || !canAimNow() || camera == null || lastReference == null) { return; }
        var img = camera.imagePointFromView(viewX, viewY, lastImageWidth, lastImageHeight, lastViewWidth, lastViewHeight);
        if (img == null) { return; }
        applyImagePoint(img["x"], img["y"]);
    }

    function dragEnd() {
        if (!dragActive) { return; }
        dragActive = false;
        confirmAim();
    }

    // Common tail for nudge()/dragTo(): clamp to the actual hole image
    // bounds — a LOCAL UX constraint so the target stays drawable, NEVER a
    // stand-in for Marshal's aim-roof authority (plan step 19's explicit
    // distinction; the bag-roof clamp Marshal also enforces is
    // GarminPlayState.clampedToBag, already applied inside moveTarget for
    // the same reason WatchPlayState.swift applies it on the wrist: so a
    // drag past the bag lands at its edge instead of somewhere no club
    // goes, matching what the phone will do anyway).
    function applyImagePoint(imageX, imageY) {
        var clampedX = imageX;
        if (clampedX < 0) { clampedX = 0; }
        if (clampedX > lastImageWidth) { clampedX = lastImageWidth; }
        var clampedY = imageY;
        if (clampedY < 0) { clampedY = 0; }
        if (clampedY > lastImageHeight) { clampedY = lastImageHeight; }
        var coordinate = lastReference.coordinate(clampedX, clampedY);
        if (coordinate == null) { return; }
        session.playState.moveTarget(coordinate, session.playerStore.snapshot.bag, session.playerStore.snapshot.bubble);
    }

    // Whether Garmin may compute/aim at all right now — the version
    // handshake plus a player snapshot to compute from (mirrors
    // AimableHoleMap's `canAim` gate: false and the map is a picture, no
    // drag, no local Bubble, the phone's numbers).
    function canAimNow() {
        if (session.scene == null || !session.scene.hasRound()) { return false; }
        if (!session.engineAgreement()["mayComputeLocally"]) { return false; }
        if (session.playerStore.snapshot == null) { return false; }
        if (session.playState.player == null) { return false; }
        return true;
    }
}
