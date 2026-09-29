/* Slovenian. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("sl", {
    /* GPS Settings panel */
    "gpsSettings.title": "Nastavitve GPS",
    "gpsSettings.done": "Končano",
    "gpsSettings.groupRound": "Krog",
    "gpsSettings.units": "Enote",
    "gpsSettings.unitsHint": "Razdalje v metrih ali jardih.",
    "gpsSettings.unitsMetres": "Metri",
    "gpsSettings.unitsYards": "Jardi",
    "gpsSettings.groupShotView": "Pogled udarca",
    "gpsSettings.aimLine": "Prikaži ciljno črto",
    "gpsSettings.aimLineHint": "Vodilo od začetka do cilja.",
    "gpsSettings.shotUp": "Udarec navzgor",
    "gpsSettings.shotUpHint": "Zasuka pogled, da udarec poteka navzgor po zaslonu.",
    "gpsSettings.tightness": "Izrez pri zaklepu",
    "gpsSettings.tightnessTight": "Ozek",
    "gpsSettings.tightnessTightHint": "Ozek poudarek na udarcu",
    "gpsSettings.tightnessMedium": "Srednji",
    "gpsSettings.tightnessMediumHint": "Uravnotežen pogled udarca",
    "gpsSettings.tightnessWide": "Širok",
    "gpsSettings.tightnessWideHint": "Več luknje",
    "gpsSettings.openButton": "Nastavitve GPS",
    "gpsSettings.groupApp": "Aplikacija",
    "gpsSettings.language": "Jezik",
    "gpsSettings.languageHint": "Jezik aplikacije.",
    "gpsSettings.languageAuto": "Jezik telefona",

    /* Shared words */
    "common.on": "Vklj.",
    "common.off": "Izklj."
  });
})(typeof window !== "undefined" ? window : globalThis);
