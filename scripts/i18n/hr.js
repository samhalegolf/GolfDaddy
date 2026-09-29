/* Croatian. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("hr", {
    /* GPS Settings panel */
    "gpsSettings.title": "Postavke GPS-a",
    "gpsSettings.done": "Gotovo",
    "gpsSettings.groupRound": "Runda",
    "gpsSettings.units": "Jedinice",
    "gpsSettings.unitsHint": "Udaljenosti u metrima ili jardima.",
    "gpsSettings.unitsMetres": "Metri",
    "gpsSettings.unitsYards": "Jardi",
    "gpsSettings.groupShotView": "Prikaz udarca",
    "gpsSettings.aimLine": "Prikaži liniju ciljanja",
    "gpsSettings.aimLineHint": "Vodilica od početka do cilja.",
    "gpsSettings.shotUp": "Udarac prema gore",
    "gpsSettings.shotUpHint": "Okreće prikaz tako da udarac ide prema vrhu zaslona.",
    "gpsSettings.tightness": "Kadar pri zaključavanju",
    "gpsSettings.tightnessTight": "Uzak",
    "gpsSettings.tightnessTightHint": "Uski fokus na udarac",
    "gpsSettings.tightnessMedium": "Srednji",
    "gpsSettings.tightnessMediumHint": "Uravnotežen prikaz udarca",
    "gpsSettings.tightnessWide": "Širok",
    "gpsSettings.tightnessWideHint": "Više od rupe",
    "gpsSettings.openButton": "Postavke GPS-a",
    "gpsSettings.groupApp": "Aplikacija",
    "gpsSettings.language": "Jezik",
    "gpsSettings.languageHint": "Jezik aplikacije.",
    "gpsSettings.languageAuto": "Jezik telefona",

    /* Shared words */
    "common.on": "Uklj.",
    "common.off": "Isklj."
  });
})(typeof window !== "undefined" ? window : globalThis);
