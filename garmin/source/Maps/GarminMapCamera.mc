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
// Phase 2 ports the RESTING framings (play/bubble) and the render transform
// (origin/place) — everything a read-only map needs. Edge-panning and
// crown-equivalent live zoom (WatchMapCamera.swift's panned()/zoomed()) are
// Phase 3 interactive-drag features and are not ported here; add them
// alongside GarminMapView's own aim-mode input handling when that lands.
class GarminMapCamera {
    // Never magnify a lite-map bake past this — the flat vector edges turn
    // to mush and the map reads as broken rather than close-up.
    static var MAXIMUM_SCALE = 3.0;

    var focusX;    // where the camera is looking, in image pixels
    var focusY;
    var scale;      // image pixels per screen point

    function initialize(focusX, focusY, scale) {
        self.focusX = focusX;
        self.focusY = focusY;
        self.scale = scale;
    }

    // ---------------------------------------------------------- framing

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

    // BUBBLE framing: the shot being shaped, with its surroundings. Frames
    // the Bubble itself (its computed ring, or a nominal extent around a
    // target with no ring yet) at a fixed share of the view and lets the
    // player fall off the bottom if need be — the aim line still reaches
    // the edge and pivots as the target moves. bubbleFraction is how much
    // of the view's shorter side the Bubble's longer side takes.
    static var BUBBLE_FRACTION = 0.42;

    static function bubble(centreX, centreY, extentWidth, extentHeight, imageWidth, imageHeight, viewWidth, viewHeight) {
        if (imageWidth <= 0 || imageHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) {
            return new GarminMapCamera(imageWidth / 2.0, imageHeight / 2.0, 1.0);
        }
        var fillWidth = viewWidth / imageWidth;
        var longest = extentWidth > extentHeight ? extentWidth : extentHeight;
        var shorterView = viewWidth < viewHeight ? viewWidth : viewHeight;
        var wanted = (longest > 0) ? (shorterView * BUBBLE_FRACTION) / longest : MAXIMUM_SCALE;
        var scale = wanted > fillWidth ? wanted : fillWidth;
        if (scale > MAXIMUM_SCALE) { scale = MAXIMUM_SCALE; }
        return new GarminMapCamera(centreX, centreY, scale);
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

    // Where image pixel (0,0) sits in view coordinates. Centres on the
    // focus, then refuses to show background past an edge — an off-centre
    // hole is better than a map that appears to float.
    function originX(imageWidth, viewWidth) {
        return axisOrigin(imageWidth * scale, viewWidth, focusX * scale);
    }
    function originY(imageHeight, viewHeight) {
        return axisOrigin(imageHeight * scale, viewHeight, focusY * scale);
    }

    function placeX(imageX, imageWidth, viewWidth) {
        return originX(imageWidth, viewWidth) + imageX * scale;
    }
    function placeY(imageY, imageHeight, viewHeight) {
        return originY(imageHeight, viewHeight) + imageY * scale;
    }

    static function axisOrigin(scaledLength, viewLength, focus) {
        if (scaledLength <= viewLength) { return (viewLength - scaledLength) / 2.0; }
        var a = 0.0;
        var b = viewLength - scaledLength;
        var c = viewLength / 2.0 - focus;
        var lower = a < b ? a : b;
        return lower < c ? lower : c;
    }

    // The inverse of place() — Phase 3's whole interaction path starts here:
    // finger/nudge -> view point -> IMAGE point (this) -> lat/lng
    // (GarminMapSpatialReference.coordinate) -> GarminPlayState.moveTarget.
    // Mirrors WatchMapCamera.swift's imagePoint(fromView:imageSize:viewSize:),
    // which itself was written as "the half that proves the transform
    // round-trips" before Apple's own aiming existed — this is that same
    // day for Garmin.
    function imagePointFromView(viewX, viewY, imageWidth, imageHeight, viewWidth, viewHeight) {
        if (scale <= 0) { return null; }
        var oX = originX(imageWidth, viewWidth);
        var oY = originY(imageHeight, viewHeight);
        return { "x" => (viewX - oX) / scale, "y" => (viewY - oY) / scale };
    }
}
