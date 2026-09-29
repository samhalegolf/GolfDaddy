/* Latvian. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("lv", {
    /* GPS Settings panel */
    "gpsSettings.title": "GPS iestatījumi",
    "gpsSettings.done": "Gatavs",
    "gpsSettings.groupRound": "Raunds",
    "gpsSettings.units": "Mērvienības",
    "gpsSettings.unitsHint": "Attālumi metros vai jardos.",
    "gpsSettings.unitsMetres": "Metri",
    "gpsSettings.unitsYards": "Jardi",
    "gpsSettings.groupShotView": "Sitiena skats",
    "gpsSettings.aimLine": "Rādīt tēmēšanas līniju",
    "gpsSettings.aimLineHint": "Palīglīnija no sākuma līdz mērķim.",
    "gpsSettings.shotUp": "Sitiens uz augšu",
    "gpsSettings.shotUpHint": "Pagriež skatu, lai sitiens virzītos uz ekrāna augšu.",
    "gpsSettings.tightness": "Kadrējums fiksējot",
    "gpsSettings.tightnessTight": "Šaurs",
    "gpsSettings.tightnessTightHint": "Šaurs fokuss uz sitienu",
    "gpsSettings.tightnessMedium": "Vidējs",
    "gpsSettings.tightnessMediumHint": "Līdzsvarots sitiena skats",
    "gpsSettings.tightnessWide": "Plašs",
    "gpsSettings.tightnessWideHint": "Vairāk no bedrītes",
    "gpsSettings.openButton": "GPS iestatījumi",
    "gpsSettings.groupApp": "Lietotne",
    "gpsSettings.language": "Valoda",
    "gpsSettings.languageHint": "Lietotnes valoda.",
    "gpsSettings.languageAuto": "Tālruņa valoda",

    /* Shared words */
    "common.on": "Iesl.",
    "common.off": "Izsl."
  });
})(typeof window !== "undefined" ? window : globalThis);
