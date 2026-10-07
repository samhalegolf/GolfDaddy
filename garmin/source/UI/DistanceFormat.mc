using Toybox.Lang;
using Toybox.System;

// Every distance on the wrist is metres internally and is shown in the
// watch's own unit: the player's Garmin distance setting (yards when it is
// statute, metres otherwise). Nothing in the Scene or the player snapshot
// carries a unit choice, and a Garmin owner has already made this one on
// the watch itself.
module DistanceFormat {

    function yards() {
        return System.getDeviceSettings().distanceUnits == System.UNIT_STATUTE;
    }

    // The whole number shown for `metres`, or null for null.
    function value(metres) {
        if (metres == null) { return null; }
        var shown = yards() ? metres * 1.0936133 : metres;
        return (shown + 0.5).toNumber();
    }

    function suffix() {
        return yards() ? "y" : "m";
    }

    // "142" or "-": the number alone, for faces that print the unit once.
    function number(metres) {
        var shown = value(metres);
        return (shown != null) ? shown.toString() : "-";
    }

    // "142m" / "155y".
    function withUnit(metres) {
        return number(metres) + suffix();
    }
}
