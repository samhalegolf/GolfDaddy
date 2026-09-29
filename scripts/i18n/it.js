/* Italian. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("it", {
    /* GPS Settings panel */
    "gpsSettings.title": "Impostazioni GPS",
    "gpsSettings.done": "Fine",
    "gpsSettings.groupRound": "Giro",
    "gpsSettings.units": "Unità",
    "gpsSettings.unitsHint": "Distanze in metri o iarde.",
    "gpsSettings.unitsMetres": "Metri",
    "gpsSettings.unitsYards": "Iarde",
    "gpsSettings.groupShotView": "Vista del colpo",
    "gpsSettings.aimLine": "Mostra linea di mira",
    "gpsSettings.aimLineHint": "Guida dalla partenza al bersaglio.",
    "gpsSettings.shotUp": "Colpo verso l'alto",
    "gpsSettings.shotUpHint": "Ruota la vista in modo che il colpo vada verso l'alto dello schermo.",
    "gpsSettings.tightness": "Inquadratura al blocco",
    "gpsSettings.tightnessTight": "Stretta",
    "gpsSettings.tightnessTightHint": "Colpo in primo piano",
    "gpsSettings.tightnessMedium": "Media",
    "gpsSettings.tightnessMediumHint": "Vista del colpo bilanciata",
    "gpsSettings.tightnessWide": "Ampia",
    "gpsSettings.tightnessWideHint": "Più della buca",
    "gpsSettings.openButton": "Impostazioni GPS",
    "gpsSettings.groupApp": "App",
    "gpsSettings.language": "Lingua",
    "gpsSettings.languageHint": "Lingua dell'app.",
    "gpsSettings.languageAuto": "Lingua del telefono",

    /* Shared words */
    "common.on": "Sì",
    "common.off": "No"
  });
})(typeof window !== "undefined" ? window : globalThis);
