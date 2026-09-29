/* Slovak. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("sk", {
    /* GPS Settings panel */
    "gpsSettings.title": "Nastavenia GPS",
    "gpsSettings.done": "Hotovo",
    "gpsSettings.groupRound": "Kolo",
    "gpsSettings.units": "Jednotky",
    "gpsSettings.unitsHint": "Vzdialenosti v metroch alebo yardoch.",
    "gpsSettings.unitsMetres": "Metre",
    "gpsSettings.unitsYards": "Yardy",
    "gpsSettings.groupShotView": "Pohľad na úder",
    "gpsSettings.aimLine": "Zobraziť zameriavaciu čiaru",
    "gpsSettings.aimLineHint": "Vodiaca čiara od štartu k cieľu.",
    "gpsSettings.shotUp": "Úder nahor",
    "gpsSettings.shotUpHint": "Otočí pohľad tak, aby úder smeroval nahor po obrazovke.",
    "gpsSettings.tightness": "Výrez pri uzamknutí",
    "gpsSettings.tightnessTight": "Tesný",
    "gpsSettings.tightnessTightHint": "Detail na úder",
    "gpsSettings.tightnessMedium": "Stredný",
    "gpsSettings.tightnessMediumHint": "Vyvážený pohľad na úder",
    "gpsSettings.tightnessWide": "Široký",
    "gpsSettings.tightnessWideHint": "Viac z jamky",
    "gpsSettings.openButton": "Nastavenia GPS",
    "gpsSettings.groupApp": "Aplikácia",
    "gpsSettings.language": "Jazyk",
    "gpsSettings.languageHint": "Jazyk aplikácie.",
    "gpsSettings.languageAuto": "Jazyk telefónu",

    /* Shared words */
    "common.on": "Zap.",
    "common.off": "Vyp."
  });
})(typeof window !== "undefined" ? window : globalThis);
