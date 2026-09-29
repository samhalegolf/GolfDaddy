/* Estonian. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("et", {
    /* GPS Settings panel */
    "gpsSettings.title": "GPS-i seaded",
    "gpsSettings.done": "Valmis",
    "gpsSettings.groupRound": "Ring",
    "gpsSettings.units": "Ühikud",
    "gpsSettings.unitsHint": "Kaugused meetrites või jardides.",
    "gpsSettings.unitsMetres": "Meetrid",
    "gpsSettings.unitsYards": "Jardid",
    "gpsSettings.groupShotView": "Löögivaade",
    "gpsSettings.aimLine": "Näita sihtimisjoont",
    "gpsSettings.aimLineHint": "Abijoon algusest sihtmärgini.",
    "gpsSettings.shotUp": "Löök üles",
    "gpsSettings.shotUpHint": "Pöörab vaadet nii, et löök liigub ekraanil üles.",
    "gpsSettings.tightness": "Kaader lukustamisel",
    "gpsSettings.tightnessTight": "Kitsas",
    "gpsSettings.tightnessTightHint": "Kitsas fookus löögil",
    "gpsSettings.tightnessMedium": "Keskmine",
    "gpsSettings.tightnessMediumHint": "Tasakaalus löögivaade",
    "gpsSettings.tightnessWide": "Lai",
    "gpsSettings.tightnessWideHint": "Rohkem rajast",
    "gpsSettings.openButton": "GPS-i seaded",
    "gpsSettings.groupApp": "Rakendus",
    "gpsSettings.language": "Keel",
    "gpsSettings.languageHint": "Rakenduse keel.",
    "gpsSettings.languageAuto": "Telefoni keel",

    /* Shared words */
    "common.on": "Sees",
    "common.off": "Väljas"
  });
})(typeof window !== "undefined" ? window : globalThis);
