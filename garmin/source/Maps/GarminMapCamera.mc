using Toybox.Lang;
using Toybox.Math;

// The Framing Engine, mirroring
// ios/WatchBubbleEngine/Sources/WatchBubbleEngine/WatchMapCamera.swift.
// Strictly separate from the Bubble Engine, and the separation runs one way:
// the Bubble Engine answers where the Bubble IS, in metres and degrees, and
// never calls anything here. This answers where that lands on a small
// screen, and never has an opinion about golf. Works entirely in the lite
// map's IMAGE pixels — geography is the Bubble Engine's, screen points are
// GarminMapView's, this is the middle.
//
// Two framings. SHOT (2026-10-13, Sam): the shot being played, as the phone
// frames it - the Bubble fitted to the glass with the target in the middle,
// and the map TURNED so the shot runs straight up the screen. The aim line
// comes up from the bottom edge and says where the shot comes from, and it
// is always vertical, never across the face, whichever way the bake was
// cut. The player is on the glass for a chip and off the bottom for a
// drive: the Bubble is what the shot is about, so the Bubble is what fits.
// (Sizing the shot to put the player's dot at six o'clock instead shrank a
// drive's Bubble to a speck - the "origin" to keep was the direction, never
// the dot.) PLAY, for a hole with no target yet: the player low with the
// ground ahead above them, in the bake's own orientation.
//
// Everything downstream places a point through frame(): one affine
// [tx, ty, a, b] with sx = tx + x*a - y*b, sy = ty + x*b + y*a, so a
// rotated framing costs the same per point as an unrotated one.
class GarminMapCamera {
    // Never magnify a lite-map bake past this — the flat vector edges turn
    // to mush and the map reads as broken rather than close-up.
    static var MAXIMUM_SCALE = 3.0;
    // How much of the view's shorter side the Bubble's longest reach takes
    // on the SHOT framing: the ring whole on a round face with the chrome
    // (the hole and green number at the top, the plays box at the foot)
    // still clear of it. The target is always at 0.5.
    static var BUBBLE_FRACTION = 0.6;
    // A Bubble's worth of ground for a target with no ring computed yet:
    // about a Driver's cluster at its longest, in metres.
    static var NOMINAL_BUBBLE_M = 55.0;

    var focusX;    // where the camera is looking, in image pixels
    var focusY;
    var scale;      // image pixels per screen point
    // Screen rotation applied about the focus, radians, clockwise positive
    // in screen space (y down). 0 for the PLAY framing.
    var rotation = 0.0;
    // Whether the view may show past the image's edges. The SHOT framing
    // may (the target always sits centred, and GarminMapView fills the
    // overspill with the map's own dark green); PLAY framing may not.
    // Mirrors WatchMapCamera.swift's clampsToImage.
    var clampsToImage = true;

    function initialize(focusX, focusY, scale) {
        self.focusX = focusX;
        self.focusY = focusY;
        self.scale = scale;
    }

    // ---------------------------------------------------------- framing

    // SHOT framing: the target centred, the map turned so the shot runs
    // straight up, and the scale whatever fits the Bubble - bubbleExtent,
    // its longest reach across the target in image pixels - at
    // BUBBLE_FRACTION of the glass, capped at MAXIMUM_SCALE. The player
    // lands wherever that puts them. Both points are image pixels.
    static function shot(player, target, bubbleExtent, imageWidth, imageHeight, viewWidth, viewHeight) {
        var camera = new GarminMapCamera(target["x"], target["y"], MAXIMUM_SCALE);
        camera.clampsToImage = false;
        var shorterView = viewWidth < viewHeight ? viewWidth : viewHeight;
        if (bubbleExtent != null && bubbleExtent > 0 && shorterView > 0) {
            var wanted = (shorterView * BUBBLE_FRACTION) / bubbleExtent;
            camera.scale = wanted < MAXIMUM_SCALE ? wanted : MAXIMUM_SCALE;
        }
        var dx = target["x"] - player["x"];
        var dy = target["y"] - player["y"];
        // The angle that turns the player->target vector to straight up
        // (0, -1): up is -pi/2 in y-down screen space. A player standing on
        // the target has no direction to turn to.
        if (dx * dx + dy * dy >= 1.0) {
            camera.rotation = -Math.PI / 2.0 - Math.atan2(dy, dx);
        }
        return camera;
    }

    // The Bubble's longest reach across the target, in image pixels: twice
    // the farthest ring point from the target, so a ring the engine sits
    // off to one side of the target is still whole on the glass whichever
    // way the map is turned. A target with no ring yet gets NOMINAL_BUBBLE_M
    // of ground through the map's metresPerPixel.
    static function bubbleExtent(ring, target, reference) {
        var farthest = 0.0;
        if (ring != null) {
            for (var i = 0; i < ring.size(); i += 1) {
                var p = reference.imagePoint(ring[i].lat, ring[i].lng);
                if (p == null) { continue; }
                var dx = p["x"] - target["x"];
                var dy = p["y"] - target["y"];
                var d = Math.sqrt(dx * dx + dy * dy);
                if (d > farthest) { farthest = d; }
            }
        }
        if (farthest > 0.0) { return 2.0 * farthest; }
        var metresPerPixel = (reference has :metresPerPixel && reference.metresPerPixel != null) ? reference.metresPerPixel : 0.5;
        return NOMINAL_BUBBLE_M / metresPerPixel;
    }

    // PLAY framing: the shot, filling the screen. A par 5 bakes to roughly
    // 1:7.7 and a small watch screen is close to 1:1.2 — containing the
    // whole image would draw it a sliver wide with most of the screen as
    // black bars. This fills the width and shows the part being played,
    // oriented the way the bake already is (tee at the bottom, green at the
    // top): player low on the screen with the ground ahead above them. When
    // the shot is short enough for both ends to fit at fill-width, the span
    // wins and both dots are on screen — the choice is geometry, not a mode.
    static function play(player, target, imageWidth, imageHeight, viewWidth, viewHeight) {
        if (imageWidth <= 0 || imageHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) {
            return new GarminMapCamera(imageWidth / 2.0, imageHeight / 2.0, 1.0);
        }
        var fillWidth = viewWidth / imageWidth;
        var centreX = imageWidth / 2.0;
        var centreY = imageHeight / 2.0;

        if (player == null) {
            var focusY = (target != null) ? target["y"] : centreY;
            var s = fillWidth < MAXIMUM_SCALE ? fillWidth : MAXIMUM_SCALE;
            return new GarminMapCamera(centreX, focusY, s);
        }
        if (target == null) {
            var s = fillWidth < MAXIMUM_SCALE ? fillWidth : MAXIMUM_SCALE;
            return low(player, centreX, s, viewHeight);
        }

        // Would both ends fit, with margin, at a scale that still fills the
        // width? spanFraction leaves room top and bottom so the dots are
        // not against the bezel.
        var spanFraction = 0.72;
        var span = (target["y"] - player["y"]).abs();
        var spanScale = span > 0 ? (viewHeight * spanFraction) / span : MAXIMUM_SCALE;
        var scale = spanScale > fillWidth ? spanScale : fillWidth;
        if (scale > MAXIMUM_SCALE) { scale = MAXIMUM_SCALE; }

        if (span * scale <= viewHeight * spanFraction) {
            return new GarminMapCamera(centreX, (player["y"] + target["y"]) / 2.0, scale);
        }
        return low(player, centreX, scale, viewHeight);
    }

    // The player sitting low, with the hole running up the screen.
    // playerHeightFraction: how far down the view the player sits — 0.78
    // gives roughly three quarters of the screen to the ground ahead.
    static function low(player, centreX, scale, viewHeight) {
        var playerHeightFraction = 0.78;
        var visibleImageHeight = viewHeight / scale;
        var focusY = player["y"] - (playerHeightFraction - 0.5) * visibleImageHeight;
        return new GarminMapCamera(centreX, focusY, scale);
    }

    // -------------------------------------------------------- rendering

    // Where image pixel (0,0) sits in view coordinates, for an UNROTATED
    // framing. Centres on the focus, then refuses to show background past
    // an edge — an off-centre hole is better than a map that appears to
    // float.
    function originX(imageWidth, viewWidth) {
        if (!clampsToImage) { return viewWidth / 2.0 - focusX * scale; }
        return axisOrigin(imageWidth * scale, viewWidth, focusX * scale);
    }
    function originY(imageHeight, viewHeight) {
        if (!clampsToImage) { return viewHeight / 2.0 - focusY * scale; }
        return axisOrigin(imageHeight * scale, viewHeight, focusY * scale);
    }

    static function axisOrigin(scaledLength, viewLength, focus) {
        if (scaledLength <= viewLength) { return (viewLength - scaledLength) / 2.0; }
        // The origin that puts `focus` at the view's centre, clamped so the
        // image still covers the whole view: no further right/down than 0,
        // no further left/up than (view - image). That is max(b, min(a, c)).
        // It used to be min(b, c), which is never above b, so every framing
        // pinned the image's far edge to the view's far edge and the player
        // sat off-screen above it (seen 2026-09-21 on the simulator: focus
        // 1158 of 1536 rows, origin -1736.8 = exactly the bottom-edge clamp).
        var a = 0.0;
        var b = viewLength - scaledLength;
        var c = viewLength / 2.0 - focus;
        var centred = c < a ? c : a;
        return centred > b ? centred : b;
    }

    // The image->screen affine for this framing: [tx, ty, a, b] with
    //     sx = tx + x*a - y*b
    //     sy = ty + x*b + y*a
    // Rotation 0 is the plain origin + x*scale of before; a rotated framing
    // turns about the focus, which sits at the centre of the glass.
    function frame(imageWidth, imageHeight, viewWidth, viewHeight) {
        if (rotation == 0.0) {
            return [originX(imageWidth, viewWidth), originY(imageHeight, viewHeight), scale, 0.0];
        }
        var a = Math.cos(rotation) * scale;
        var b = Math.sin(rotation) * scale;
        return [viewWidth / 2.0 - (focusX * a - focusY * b), viewHeight / 2.0 - (focusX * b + focusY * a), a, b];
    }

    // One image point on screen, as [x, y].
    function place(imageX, imageY, imageWidth, imageHeight, viewWidth, viewHeight) {
        var f = frame(imageWidth, imageHeight, viewWidth, viewHeight);
        return [f[0] + imageX * f[2] - imageY * f[3], f[1] + imageX * f[3] + imageY * f[2]];
    }

    // The inverse of place() — Phase 3's whole interaction path starts here:
    // finger/nudge -> view point -> IMAGE point (this) -> lat/lng
    // (GarminMapSpatialReference.coordinate) -> GarminPlayState.moveTarget.
    function imagePointFromView(viewX, viewY, imageWidth, imageHeight, viewWidth, viewHeight) {
        if (scale <= 0) { return null; }
        var f = frame(imageWidth, imageHeight, viewWidth, viewHeight);
        var sx = viewX - f[0];
        var sy = viewY - f[1];
        var det = f[2] * f[2] + f[3] * f[3];
        return { "x" => (f[2] * sx + f[3] * sy) / det, "y" => (f[2] * sy - f[3] * sx) / det };
    }

    // A screen-space direction turned into image space (unscaled): what an
    // edge pan or a button nudge in screen terms means on the bake.
    function imageDirection(screenDx, screenDy) {
        var c = Math.cos(rotation);
        var s = Math.sin(rotation);
        return [screenDx * c + screenDy * s, screenDy * c - screenDx * s];
    }
}
