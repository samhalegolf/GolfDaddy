/* Dutch. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("nl", {
    /* GPS Settings panel */
    "gpsSettings.title": "GPS-instellingen",
    "gpsSettings.done": "Klaar",
    "gpsSettings.groupRound": "Ronde",
    "gpsSettings.units": "Eenheden",
    "gpsSettings.unitsHint": "Afstanden in meters of yards.",
    "gpsSettings.unitsMetres": "Meters",
    "gpsSettings.unitsYards": "Yards",
    "gpsSettings.groupShotView": "Slagweergave",
    "gpsSettings.aimLine": "Richtlijn tonen",
    "gpsSettings.aimLineHint": "Hulplijn van start tot doel.",
    "gpsSettings.shotUp": "Slag omhoog",
    "gpsSettings.shotUpHint": "Draait het beeld zodat de slag omhoog over het scherm loopt.",
    "gpsSettings.tightness": "Kader bij vastzetten",
    "gpsSettings.tightnessTight": "Strak",
    "gpsSettings.tightnessTightHint": "Strakke focus op de slag",
    "gpsSettings.tightnessMedium": "Middel",
    "gpsSettings.tightnessMediumHint": "Gebalanceerde slagweergave",
    "gpsSettings.tightnessWide": "Breed",
    "gpsSettings.tightnessWideHint": "Meer van de hole",
    "gpsSettings.openButton": "GPS-instellingen",
    "gpsSettings.groupApp": "App",
    "gpsSettings.language": "Taal",
    "gpsSettings.languageHint": "Taal van de app.",
    "gpsSettings.languageAuto": "Taal van telefoon",

    /* Shared words */
    "common.on": "Aan",
    "common.off": "Uit"
  });
})(typeof window !== "undefined" ? window : globalThis);
