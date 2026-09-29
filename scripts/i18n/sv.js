/* Swedish. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("sv", {
    /* GPS Settings panel */
    "gpsSettings.title": "GPS-inställningar",
    "gpsSettings.done": "Klar",
    "gpsSettings.groupRound": "Runda",
    "gpsSettings.units": "Enheter",
    "gpsSettings.unitsHint": "Avstånd i meter eller yards.",
    "gpsSettings.unitsMetres": "Meter",
    "gpsSettings.unitsYards": "Yards",
    "gpsSettings.groupShotView": "Slagvy",
    "gpsSettings.aimLine": "Visa siktlinje",
    "gpsSettings.aimLineHint": "Hjälplinje från start till mål.",
    "gpsSettings.shotUp": "Slag uppåt",
    "gpsSettings.shotUpHint": "Vrider vyn så att slaget går uppåt på skärmen.",
    "gpsSettings.tightness": "Utsnitt vid låsning",
    "gpsSettings.tightnessTight": "Tätt",
    "gpsSettings.tightnessTightHint": "Tätt fokus på slaget",
    "gpsSettings.tightnessMedium": "Mellan",
    "gpsSettings.tightnessMediumHint": "Balanserad slagvy",
    "gpsSettings.tightnessWide": "Brett",
    "gpsSettings.tightnessWideHint": "Mer av hålet",
    "gpsSettings.openButton": "GPS-inställningar",
    "gpsSettings.groupApp": "App",
    "gpsSettings.language": "Språk",
    "gpsSettings.languageHint": "Språket i appen.",
    "gpsSettings.languageAuto": "Telefonens språk",

    /* Shared words */
    "common.on": "På",
    "common.off": "Av"
  });
})(typeof window !== "undefined" ? window : globalThis);
