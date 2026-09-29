/* German. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("de", {
    /* GPS Settings panel */
    "gpsSettings.title": "GPS-Einstellungen",
    "gpsSettings.done": "Fertig",
    "gpsSettings.groupRound": "Runde",
    "gpsSettings.units": "Einheiten",
    "gpsSettings.unitsHint": "Entfernungen in Metern oder Yards.",
    "gpsSettings.unitsMetres": "Meter",
    "gpsSettings.unitsYards": "Yards",
    "gpsSettings.groupShotView": "Schlagansicht",
    "gpsSettings.aimLine": "Ziellinie anzeigen",
    "gpsSettings.aimLineHint": "Hilfslinie vom Start zum Ziel.",
    "gpsSettings.shotUp": "Schlag nach oben",
    "gpsSettings.shotUpHint": "Dreht die Ansicht, sodass der Schlag auf dem Bildschirm nach oben verläuft.",
    "gpsSettings.tightness": "Ausschnitt beim Fixieren",
    "gpsSettings.tightnessTight": "Eng",
    "gpsSettings.tightnessTightHint": "Enger Fokus auf den Schlag",
    "gpsSettings.tightnessMedium": "Mittel",
    "gpsSettings.tightnessMediumHint": "Ausgewogene Schlagansicht",
    "gpsSettings.tightnessWide": "Weit",
    "gpsSettings.tightnessWideHint": "Mehr von der Bahn",
    "gpsSettings.openButton": "GPS-Einstellungen",
    "gpsSettings.groupApp": "App",
    "gpsSettings.language": "Sprache",
    "gpsSettings.languageHint": "Sprache der App.",
    "gpsSettings.languageAuto": "Telefonsprache",

    /* Shared words */
    "common.on": "An",
    "common.off": "Aus"
  });
})(typeof window !== "undefined" ? window : globalThis);
