using Toybox.Lang;
using Toybox.Math;

// Derives a few layout numbers from DeviceCapabilities so NumbersView does
// not scatter its own device-shape branching. Deliberately small for Phase 1
// — it exists so Phase 2/3's richer map layout has a place to grow rather
// than starting from nothing.
module LayoutProfile {

    // Horizontal inset that keeps text off a round bezel. A rectangular
    // panel needs none; a round one needs enough that the F/C/B row and the
    // LOCK affordance stay inside the visible circle.
    function horizontalInsetPx() {
        return DeviceCapabilities.screenShape().equals("rectangle") ? 6 : 18;
    }

    // Half the drawable width at a given vertical band, measured out from
    // the screen's horizontal centre.
    //
    // On a round screen the glass narrows towards the top and bottom, so a
    // label placed at a fixed inset from the LEFT EDGE of the drawing buffer
    // lands outside the visible circle and is never seen. That is not
    // theoretical: until 2026-09-22 the map face drew its hole number at
    // (4, 2) and its distance-to-green at (width - 4, 2) — the two top
    // corners — and neither had ever been visible on any device in the
    // matrix, because every one of them is round. The bug came straight
    // across from the Apple port: HoleMapView.swift draws into a rectangle.
    //
    // `top` and `bottom` are the vertical extent of the thing being placed.
    // The edge further from the middle is the one that has to fit, so that
    // is the one measured. A rectangle gets the full half-width.
    function chordHalfWidthPx(top, bottom, viewWidth, viewHeight) {
        if (DeviceCapabilities.screenShape().equals("rectangle")) {
            return viewWidth / 2.0;
        }
        var rx = viewWidth / 2.0;
        var ry = viewHeight / 2.0;
        var dyTop = ry - top;
        if (dyTop < 0) { dyTop = -dyTop; }
        var dyBottom = bottom - ry;
        if (dyBottom < 0) { dyBottom = -dyBottom; }
        var dy = dyTop > dyBottom ? dyTop : dyBottom;
        if (dy >= ry) { return 0.0; }
        // Circle (every product in the matrix) written as the ellipse chord,
        // so a semiround or a non-square round screen is right too.
        return rx * Math.sqrt(1.0 - (dy * dy) / (ry * ry));
    }

    // Where the map face's top row of chrome sits: far enough down that the
    // chord above is wide enough to hold it, and no further — the map is
    // meant to stay visually dominant (plan step 11).
    function chromeTopY(viewHeight) {
        return (viewHeight * 0.07).toNumber();
    }

    // Whether there is room for a four-line numbers layout (hole, F/C/B,
    // target distance, club + LOCK) without crowding — small screens drop to
    // a denser three-line layout.
    function isCompactHeight() {
        return DeviceCapabilities.screenHeight() < 200;
    }
}
