/* Romanian. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("ro", {
    /* GPS Settings panel */
    "gpsSettings.title": "Setări GPS",
    "gpsSettings.done": "Gata",
    "gpsSettings.groupRound": "Rundă",
    "gpsSettings.units": "Unități",
    "gpsSettings.unitsHint": "Distanțe în metri sau iarzi.",
    "gpsSettings.unitsMetres": "Metri",
    "gpsSettings.unitsYards": "Iarzi",
    "gpsSettings.groupShotView": "Vizualizare lovitură",
    "gpsSettings.aimLine": "Arată linia de țintire",
    "gpsSettings.aimLineHint": "Ghidaj de la start la țintă.",
    "gpsSettings.shotUp": "Lovitură în sus",
    "gpsSettings.shotUpHint": "Rotește vizualizarea astfel încât lovitura să urce pe ecran.",
    "gpsSettings.tightness": "Încadrare la blocare",
    "gpsSettings.tightnessTight": "Strâns",
    "gpsSettings.tightnessTightHint": "Focus strâns pe lovitură",
    "gpsSettings.tightnessMedium": "Mediu",
    "gpsSettings.tightnessMediumHint": "Vizualizare echilibrată",
    "gpsSettings.tightnessWide": "Larg",
    "gpsSettings.tightnessWideHint": "Mai mult din gaură",
    "gpsSettings.openButton": "Setări GPS",
    "gpsSettings.groupApp": "Aplicație",
    "gpsSettings.language": "Limbă",
    "gpsSettings.languageHint": "Limba aplicației.",
    "gpsSettings.languageAuto": "Limba telefonului",

    /* Shared words */
    "common.on": "Da",
    "common.off": "Nu"
  });
})(typeof window !== "undefined" ? window : globalThis);
