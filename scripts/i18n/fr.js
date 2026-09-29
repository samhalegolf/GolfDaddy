/* French. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("fr", {
    /* GPS Settings panel */
    "gpsSettings.title": "Réglages GPS",
    "gpsSettings.done": "OK",
    "gpsSettings.groupRound": "Partie",
    "gpsSettings.units": "Unités",
    "gpsSettings.unitsHint": "Distances en mètres ou en yards.",
    "gpsSettings.unitsMetres": "Mètres",
    "gpsSettings.unitsYards": "Yards",
    "gpsSettings.groupShotView": "Vue du coup",
    "gpsSettings.aimLine": "Afficher la ligne de visée",
    "gpsSettings.aimLineHint": "Guide du départ à la cible.",
    "gpsSettings.shotUp": "Coup vers le haut",
    "gpsSettings.shotUpHint": "Fait pivoter la vue pour que le coup monte vers le haut de l’écran.",
    "gpsSettings.tightness": "Cadrage au verrouillage",
    "gpsSettings.tightnessTight": "Serré",
    "gpsSettings.tightnessTightHint": "Coup cadré de près",
    "gpsSettings.tightnessMedium": "Moyen",
    "gpsSettings.tightnessMediumHint": "Vue du coup équilibrée",
    "gpsSettings.tightnessWide": "Large",
    "gpsSettings.tightnessWideHint": "Plus du trou",
    "gpsSettings.openButton": "Réglages GPS",
    "gpsSettings.groupApp": "Application",
    "gpsSettings.language": "Langue",
    "gpsSettings.languageHint": "Langue de l’application.",
    "gpsSettings.languageAuto": "Langue du téléphone",

    /* Shared words */
    "common.on": "Oui",
    "common.off": "Non"
  });
})(typeof window !== "undefined" ? window : globalThis);
