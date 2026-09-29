/* Finnish. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("fi", {
    /* GPS Settings panel */
    "gpsSettings.title": "GPS-asetukset",
    "gpsSettings.done": "Valmis",
    "gpsSettings.groupRound": "Kierros",
    "gpsSettings.units": "Yksiköt",
    "gpsSettings.unitsHint": "Etäisyydet metreinä tai jaardeina.",
    "gpsSettings.unitsMetres": "Metrit",
    "gpsSettings.unitsYards": "Jaardit",
    "gpsSettings.groupShotView": "Lyöntinäkymä",
    "gpsSettings.aimLine": "Näytä tähtäyslinja",
    "gpsSettings.aimLineHint": "Apuviiva lähtöpisteestä kohteeseen.",
    "gpsSettings.shotUp": "Lyönti ylöspäin",
    "gpsSettings.shotUpHint": "Kääntää näkymää niin, että lyönti kulkee näytöllä ylöspäin.",
    "gpsSettings.tightness": "Rajaus lukittaessa",
    "gpsSettings.tightnessTight": "Tiivis",
    "gpsSettings.tightnessTightHint": "Tarkka rajaus lyöntiin",
    "gpsSettings.tightnessMedium": "Keski",
    "gpsSettings.tightnessMediumHint": "Tasapainoinen lyöntinäkymä",
    "gpsSettings.tightnessWide": "Laaja",
    "gpsSettings.tightnessWideHint": "Enemmän väylästä",
    "gpsSettings.openButton": "GPS-asetukset",
    "gpsSettings.groupApp": "Sovellus",
    "gpsSettings.language": "Kieli",
    "gpsSettings.languageHint": "Sovelluksen kieli.",
    "gpsSettings.languageAuto": "Puhelimen kieli",

    /* Shared words */
    "common.on": "Päällä",
    "common.off": "Pois"
  });
})(typeof window !== "undefined" ? window : globalThis);
