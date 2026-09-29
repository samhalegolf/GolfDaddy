/* Danish. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("da", {
    /* GPS Settings panel */
    "gpsSettings.title": "GPS-indstillinger",
    "gpsSettings.done": "Færdig",
    "gpsSettings.groupRound": "Runde",
    "gpsSettings.units": "Enheder",
    "gpsSettings.unitsHint": "Afstande i meter eller yards.",
    "gpsSettings.unitsMetres": "Meter",
    "gpsSettings.unitsYards": "Yards",
    "gpsSettings.groupShotView": "Slagvisning",
    "gpsSettings.aimLine": "Vis sigtelinje",
    "gpsSettings.aimLineHint": "Hjælpelinje fra start til mål.",
    "gpsSettings.shotUp": "Slag opad",
    "gpsSettings.shotUpHint": "Drejer visningen, så slaget går op ad skærmen.",
    "gpsSettings.tightness": "Udsnit ved låsning",
    "gpsSettings.tightnessTight": "Tæt",
    "gpsSettings.tightnessTightHint": "Tæt fokus på slaget",
    "gpsSettings.tightnessMedium": "Mellem",
    "gpsSettings.tightnessMediumHint": "Afbalanceret slagvisning",
    "gpsSettings.tightnessWide": "Bred",
    "gpsSettings.tightnessWideHint": "Mere af hullet",
    "gpsSettings.openButton": "GPS-indstillinger",
    "gpsSettings.groupApp": "App",
    "gpsSettings.language": "Sprog",
    "gpsSettings.languageHint": "Sproget i appen.",
    "gpsSettings.languageAuto": "Telefonens sprog",

    /* Shared words */
    "common.on": "Til",
    "common.off": "Fra"
  });
})(typeof window !== "undefined" ? window : globalThis);
