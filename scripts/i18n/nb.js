/* Norwegian (Bokmål). Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("nb", {
    /* GPS Settings panel */
    "gpsSettings.title": "GPS-innstillinger",
    "gpsSettings.done": "Ferdig",
    "gpsSettings.groupRound": "Runde",
    "gpsSettings.units": "Enheter",
    "gpsSettings.unitsHint": "Avstander i meter eller yards.",
    "gpsSettings.unitsMetres": "Meter",
    "gpsSettings.unitsYards": "Yards",
    "gpsSettings.groupShotView": "Slagvisning",
    "gpsSettings.aimLine": "Vis siktelinje",
    "gpsSettings.aimLineHint": "Hjelpelinje fra start til mål.",
    "gpsSettings.shotUp": "Slag oppover",
    "gpsSettings.shotUpHint": "Roterer visningen slik at slaget går oppover skjermen.",
    "gpsSettings.tightness": "Utsnitt ved låsing",
    "gpsSettings.tightnessTight": "Tett",
    "gpsSettings.tightnessTightHint": "Tett fokus på slaget",
    "gpsSettings.tightnessMedium": "Middels",
    "gpsSettings.tightnessMediumHint": "Balansert slagvisning",
    "gpsSettings.tightnessWide": "Vid",
    "gpsSettings.tightnessWideHint": "Mer av hullet",
    "gpsSettings.openButton": "GPS-innstillinger",
    "gpsSettings.groupApp": "App",
    "gpsSettings.language": "Språk",
    "gpsSettings.languageHint": "Språket i appen.",
    "gpsSettings.languageAuto": "Telefonens språk",

    /* Shared words */
    "common.on": "På",
    "common.off": "Av"
  });
})(typeof window !== "undefined" ? window : globalThis);
