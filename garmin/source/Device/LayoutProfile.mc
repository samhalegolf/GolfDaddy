using Toybox.Lang;

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

    // Whether there is room for a four-line numbers layout (hole, F/C/B,
    // target distance, club + LOCK) without crowding — small screens drop to
    // a denser three-line layout.
    function isCompactHeight() {
        return DeviceCapabilities.screenHeight() < 200;
    }
}
