/* Portuguese (Portugal). Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("pt", {
    /* GPS Settings panel */
    "gpsSettings.title": "Definições de GPS",
    "gpsSettings.done": "Concluído",
    "gpsSettings.groupRound": "Volta",
    "gpsSettings.units": "Unidades",
    "gpsSettings.unitsHint": "Distâncias em metros ou jardas.",
    "gpsSettings.unitsMetres": "Metros",
    "gpsSettings.unitsYards": "Jardas",
    "gpsSettings.groupShotView": "Vista da pancada",
    "gpsSettings.aimLine": "Mostrar linha de mira",
    "gpsSettings.aimLineHint": "Guia do início ao alvo.",
    "gpsSettings.shotUp": "Pancada para cima",
    "gpsSettings.shotUpHint": "Roda a vista para que a pancada suba no ecrã.",
    "gpsSettings.tightness": "Enquadramento ao bloquear",
    "gpsSettings.tightnessTight": "Apertado",
    "gpsSettings.tightnessTightHint": "Foco apertado na pancada",
    "gpsSettings.tightnessMedium": "Médio",
    "gpsSettings.tightnessMediumHint": "Vista equilibrada da pancada",
    "gpsSettings.tightnessWide": "Amplo",
    "gpsSettings.tightnessWideHint": "Mais do buraco",
    "gpsSettings.openButton": "Definições de GPS",
    "gpsSettings.groupApp": "Aplicação",
    "gpsSettings.language": "Idioma",
    "gpsSettings.languageHint": "Idioma da aplicação.",
    "gpsSettings.languageAuto": "Idioma do telemóvel",

    /* Shared words */
    "common.on": "Sim",
    "common.off": "Não"
  });
})(typeof window !== "undefined" ? window : globalThis);
