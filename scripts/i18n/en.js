/* English: the base language. Every key the app uses lives here first; other
   language files translate the same keys and may leave any out (they fall
   back to this wording). Grouped by screen. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("en", {
    /* GPS Settings panel (app/index.html #gpsSettingsPanel, app/js/gps-settings.js) */
    "gpsSettings.title": "GPS Settings",
    "gpsSettings.done": "Done",
    "gpsSettings.groupRound": "Round",
    "gpsSettings.units": "Units",
    "gpsSettings.unitsHint": "Distances shown in metres or yards.",
    "gpsSettings.unitsMetres": "Metres",
    "gpsSettings.unitsYards": "Yards",
    "gpsSettings.groupShotView": "Shot view",
    "gpsSettings.aimLine": "Show aim line",
    "gpsSettings.aimLineHint": "Start to target guide.",
    "gpsSettings.shotUp": "Shot-up frame",
    "gpsSettings.shotUpHint": "Rotate the view so the shot runs up the screen.",
    "gpsSettings.tightness": "Lock frame tightness",
    "gpsSettings.tightnessTight": "Tight",
    "gpsSettings.tightnessTightHint": "Tight shot focus",
    "gpsSettings.tightnessMedium": "Medium",
    "gpsSettings.tightnessMediumHint": "Balanced shot view",
    "gpsSettings.tightnessWide": "Wide",
    "gpsSettings.tightnessWideHint": "More of the hole",
    "gpsSettings.openButton": "GPS Settings",

    /* Shared words */
    "common.on": "On",
    "common.off": "Off"
  });
})(typeof window !== "undefined" ? window : globalThis);
