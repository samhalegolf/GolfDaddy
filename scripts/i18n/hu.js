/* Hungarian. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("hu", {
    /* GPS Settings panel */
    "gpsSettings.title": "GPS-beállítások",
    "gpsSettings.done": "Kész",
    "gpsSettings.groupRound": "Kör",
    "gpsSettings.units": "Mértékegységek",
    "gpsSettings.unitsHint": "Távolságok méterben vagy yardban.",
    "gpsSettings.unitsMetres": "Méter",
    "gpsSettings.unitsYards": "Yard",
    "gpsSettings.groupShotView": "Ütésnézet",
    "gpsSettings.aimLine": "Célvonal mutatása",
    "gpsSettings.aimLineHint": "Segédvonal a kiindulástól a célig.",
    "gpsSettings.shotUp": "Ütés felfelé",
    "gpsSettings.shotUpHint": "Elforgatja a nézetet, hogy az ütés felfelé haladjon a képernyőn.",
    "gpsSettings.tightness": "Kivágás rögzítéskor",
    "gpsSettings.tightnessTight": "Szűk",
    "gpsSettings.tightnessTightHint": "Szoros fókusz az ütésen",
    "gpsSettings.tightnessMedium": "Közepes",
    "gpsSettings.tightnessMediumHint": "Kiegyensúlyozott ütésnézet",
    "gpsSettings.tightnessWide": "Tág",
    "gpsSettings.tightnessWideHint": "Többet a szakaszból",
    "gpsSettings.openButton": "GPS-beállítások",
    "gpsSettings.groupApp": "Alkalmazás",
    "gpsSettings.language": "Nyelv",
    "gpsSettings.languageHint": "Az alkalmazás nyelve.",
    "gpsSettings.languageAuto": "Telefon nyelve",

    /* Shared words */
    "common.on": "Be",
    "common.off": "Ki"
  });
})(typeof window !== "undefined" ? window : globalThis);
