using Toybox.Lang;
using Toybox.System;
using Toybox.Graphics;

// Centralises runtime facts about the device so the rest of the app never
// writes `if (device == "fenix6")` — per the Garmin Phase 1 plan step 26:
// "Avoid code like `if device == "fenix6"` where capability checks would
// work. Specific device overrides are acceptable only for proven
// device-specific problems."
//
// Phase 1 keeps this deliberately small (screen shape/size and touch), since
// numbers-first UI barely needs more. Phase 2/3's raster-profile and layout
// needs extend this module rather than replacing it.
module DeviceCapabilities {

    // "round" | "rectangle" | "semiround" — matches
    // Toybox.System.getDeviceSettings().screenShape's SCREEN_SHAPE_*
    // constants, translated to a string so callers do not need to import
    // Toybox.System just to branch on shape.
    function screenShape() {
        var settings = System.getDeviceSettings();
        if (settings.screenShape == System.SCREEN_SHAPE_ROUND) { return "round"; }
        if (settings.screenShape == System.SCREEN_SHAPE_SEMI_ROUND) { return "semiround"; }
        return "rectangle";
    }

    function screenWidth() { return System.getDeviceSettings().screenWidth; }
    function screenHeight() { return System.getDeviceSettings().screenHeight; }

    // Whether this device has a touchscreen. Connect IQ does not expose a
    // single definitive "hasTouch" flag on every API level; the widely-used
    // signal is System.getDeviceSettings().isTouchScreen where present, with
    // a conservative false fallback so a button-only device is never
    // mistakenly given a touch-only interaction (the reverse mistake, a
    // touch device without button fallback, is the one the plan explicitly
    // warns against in step 24 — "Do not make touch mandatory").
    function hasTouch() {
        var settings = System.getDeviceSettings();
        if (settings has :isTouchScreen) {
            return settings.isTouchScreen;
        }
        return false;
    }

    // A coarse memory tier, since Connect IQ does not expose installed RAM
    // directly. System.getSystemStats().totalMemory is the closest available
    // signal on API levels that provide it; devices that do not are treated
    // as the conservative "compact" tier. Verify this against real devices
    // in the Phase 1 matrix (Approach S62 / Fenix 6 / Forerunner 55 /
    // Approach S70) once building against the actual SDK — see
    // garmin/README.md.
    function memoryTier() {
        var stats = System.getSystemStats();
        if (stats has :totalMemory && stats.totalMemory != null) {
            if (stats.totalMemory >= 250000) { return "capable"; }
        }
        return "compact";
    }

    // The raster profile selected in the Garmin Phase 1 plan step 18/27.
    // Phase 1's numbers-first UI does not draw a map, so this exists now
    // only so the manifest-fetch/raster-selection code Phase 2 adds has
    // something to call rather than inventing device checks at that point.
    function rasterProfile() {
        var width = screenWidth();
        if (width <= 160) { return "GARMIN_COMPACT"; }
        if (width <= 260) { return "GARMIN_MIP"; }
        return "GARMIN_AMOLED";
    }
}
