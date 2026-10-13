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
// frames it - the target in the middle of the glass, the player at about six
// o'clock, and the map TURNED so the shot runs straight up the screen. The
// aim line is always vertical, never across the face, whichever way the
// bake was cut. PLAY, for a hole with no target yet: the player low with the
// ground ahead above them, in the bake's own orientation. The old BUBBLE
// framing (the ring at a fixed share of the view, the player falling off
// the bottom, the line pivoting across the glass) is gone: it is what put
// the aim line across the watch.
//
// Everything downstream places a point through frame(): one affine
// [tx, ty, a, b] with sx = tx + x*a - y*b, sy = ty + x*b + y*a, so a
// rotated framing costs the same per point as an unrotated one.
class GarminMapCamera {
    // Never magnify a lite-map bake past this — the flat vector edges turn
    // to mush and the map reads as broken rather than close-up.
    static var MAXIMUM_SCALE = 3.0;
    // Where the player sits on the SHOT framing: this far down the glass.
    // 0.82 is "about six o'clock" on a round face while the chord there is
    // still three quarters of the width, so the dot is on the glass, not in
    // the bezel. The target is always at 0.5.
    static var PLAYER_HEIGHT_FRACTION = 0.82;

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

    // SHOT framing: the target centred, the player PLAYER_HEIGHT_FRACTION
    // down the glass, the shot straight up. The scale is whatever puts the
    // player there - a drive is small, a chip is close - capped at
    // MAXIMUM_SCALE, where the player comes up the screen instead. No floor:
    // "about six o'clock" was the ask, and the phone frames a drive the
    // same way. Both points are image pixels.
    static function shot(player, target, imageWidth, imageHeight, viewWidth, viewHeight) {
        var dx = target["x"] - player["x"];
        var dy = target["y"] - player["y"];
        var distance = Math.sqrt(dx * dx + dy * dy);
        var camera = new GarminMapCamera(target["x"], target["y"], MAXIMUM_SCALE);
        camera.clampsToImage = false;
        if (distance < 1.0 || viewHeight <= 0) { return camera; }
        var wanted = ((PLAYER_HEIGHT_FRACTION - 0.5) * viewHeight) / distance;
        camera.scale = wanted < MAXIMUM_SCALE ? wanted : MAXIMUM_SCALE;
        // The angle that turns the player->target vector to straight up
        // (0, -1): up is -pi/2 in y-down screen space.
        camera.rotation = -Math.PI / 2.0 - Math.atan2(dy, dx);
        return camera;
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
