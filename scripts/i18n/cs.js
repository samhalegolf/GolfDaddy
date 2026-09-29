/* Czech. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("cs", {
    /* GPS Settings panel */
    "gpsSettings.title": "Nastavení GPS",
    "gpsSettings.done": "Hotovo",
    "gpsSettings.groupRound": "Kolo",
    "gpsSettings.units": "Jednotky",
    "gpsSettings.unitsHint": "Vzdálenosti v metrech nebo yardech.",
    "gpsSettings.unitsMetres": "Metry",
    "gpsSettings.unitsYards": "Yardy",
    "gpsSettings.groupShotView": "Pohled na ránu",
    "gpsSettings.aimLine": "Zobrazit záměrnou čáru",
    "gpsSettings.aimLineHint": "Vodicí čára od startu k cíli.",
    "gpsSettings.shotUp": "Rána nahoru",
    "gpsSettings.shotUpHint": "Otočí pohled tak, aby rána směřovala nahoru po obrazovce.",
    "gpsSettings.tightness": "Výřez při uzamčení",
    "gpsSettings.tightnessTight": "Těsný",
    "gpsSettings.tightnessTightHint": "Detail na ránu",
    "gpsSettings.tightnessMedium": "Střední",
    "gpsSettings.tightnessMediumHint": "Vyvážený pohled na ránu",
    "gpsSettings.tightnessWide": "Široký",
    "gpsSettings.tightnessWideHint": "Více z jamky",
    "gpsSettings.openButton": "Nastavení GPS",
    "gpsSettings.groupApp": "Aplikace",
    "gpsSettings.language": "Jazyk",
    "gpsSettings.languageHint": "Jazyk aplikace.",
    "gpsSettings.languageAuto": "Jazyk telefonu",

    /* Shared words */
    "common.on": "Zap.",
    "common.off": "Vyp."
  });
})(typeof window !== "undefined" ? window : globalThis);
