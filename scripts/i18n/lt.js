/* Lithuanian. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("lt", {
    /* GPS Settings panel */
    "gpsSettings.title": "GPS nustatymai",
    "gpsSettings.done": "Atlikta",
    "gpsSettings.groupRound": "Raundas",
    "gpsSettings.units": "Vienetai",
    "gpsSettings.unitsHint": "Atstumai metrais arba jardais.",
    "gpsSettings.unitsMetres": "Metrai",
    "gpsSettings.unitsYards": "Jardai",
    "gpsSettings.groupShotView": "Smūgio vaizdas",
    "gpsSettings.aimLine": "Rodyti taikymo liniją",
    "gpsSettings.aimLineHint": "Pagalbinė linija nuo pradžios iki tikslo.",
    "gpsSettings.shotUp": "Smūgis į viršų",
    "gpsSettings.shotUpHint": "Pasuka vaizdą, kad smūgis eitų ekrano viršaus link.",
    "gpsSettings.tightness": "Kadras užfiksavus",
    "gpsSettings.tightnessTight": "Siauras",
    "gpsSettings.tightnessTightHint": "Siauras dėmesys smūgiui",
    "gpsSettings.tightnessMedium": "Vidutinis",
    "gpsSettings.tightnessMediumHint": "Subalansuotas smūgio vaizdas",
    "gpsSettings.tightnessWide": "Platus",
    "gpsSettings.tightnessWideHint": "Daugiau duobutės",
    "gpsSettings.openButton": "GPS nustatymai",
    "gpsSettings.groupApp": "Programėlė",
    "gpsSettings.language": "Kalba",
    "gpsSettings.languageHint": "Programėlės kalba.",
    "gpsSettings.languageAuto": "Telefono kalba",

    /* Shared words */
    "common.on": "Įj.",
    "common.off": "Išj."
  });
})(typeof window !== "undefined" ? window : globalThis);
