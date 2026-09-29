/* Polish. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("pl", {
    /* GPS Settings panel */
    "gpsSettings.title": "Ustawienia GPS",
    "gpsSettings.done": "Gotowe",
    "gpsSettings.groupRound": "Runda",
    "gpsSettings.units": "Jednostki",
    "gpsSettings.unitsHint": "Odległości w metrach lub jardach.",
    "gpsSettings.unitsMetres": "Metry",
    "gpsSettings.unitsYards": "Jardy",
    "gpsSettings.groupShotView": "Widok uderzenia",
    "gpsSettings.aimLine": "Pokaż linię celowania",
    "gpsSettings.aimLineHint": "Linia od startu do celu.",
    "gpsSettings.shotUp": "Uderzenie w górę",
    "gpsSettings.shotUpHint": "Obraca widok tak, aby uderzenie biegło w górę ekranu.",
    "gpsSettings.tightness": "Kadr przy blokadzie",
    "gpsSettings.tightnessTight": "Ciasny",
    "gpsSettings.tightnessTightHint": "Bliskie ujęcie uderzenia",
    "gpsSettings.tightnessMedium": "Średni",
    "gpsSettings.tightnessMediumHint": "Zrównoważony widok uderzenia",
    "gpsSettings.tightnessWide": "Szeroki",
    "gpsSettings.tightnessWideHint": "Więcej dołka",
    "gpsSettings.openButton": "Ustawienia GPS",
    "gpsSettings.groupApp": "Aplikacja",
    "gpsSettings.language": "Język",
    "gpsSettings.languageHint": "Język aplikacji.",
    "gpsSettings.languageAuto": "Język telefonu",

    /* Shared words */
    "common.on": "Wł.",
    "common.off": "Wył."
  });
})(typeof window !== "undefined" ? window : globalThis);
