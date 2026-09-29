/* Spanish. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("es", {
    /* GPS Settings panel */
    "gpsSettings.title": "Ajustes de GPS",
    "gpsSettings.done": "Listo",
    "gpsSettings.groupRound": "Ronda",
    "gpsSettings.units": "Unidades",
    "gpsSettings.unitsHint": "Distancias en metros o yardas.",
    "gpsSettings.unitsMetres": "Metros",
    "gpsSettings.unitsYards": "Yardas",
    "gpsSettings.groupShotView": "Vista del golpe",
    "gpsSettings.aimLine": "Mostrar línea de tiro",
    "gpsSettings.aimLineHint": "Guía desde la salida hasta el objetivo.",
    "gpsSettings.shotUp": "Golpe hacia arriba",
    "gpsSettings.shotUpHint": "Gira la vista para que el golpe vaya hacia arriba en la pantalla.",
    "gpsSettings.tightness": "Encuadre al fijar",
    "gpsSettings.tightnessTight": "Cerrado",
    "gpsSettings.tightnessTightHint": "Enfoque cerrado en el golpe",
    "gpsSettings.tightnessMedium": "Medio",
    "gpsSettings.tightnessMediumHint": "Vista equilibrada del golpe",
    "gpsSettings.tightnessWide": "Amplio",
    "gpsSettings.tightnessWideHint": "Más del hoyo",
    "gpsSettings.openButton": "Ajustes de GPS",
    "gpsSettings.groupApp": "Aplicación",
    "gpsSettings.language": "Idioma",
    "gpsSettings.languageHint": "Idioma de la aplicación.",
    "gpsSettings.languageAuto": "Idioma del teléfono",

    /* Shared words */
    "common.on": "Sí",
    "common.off": "No"
  });
})(typeof window !== "undefined" ? window : globalThis);
