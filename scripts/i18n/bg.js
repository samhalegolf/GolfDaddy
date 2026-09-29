/* Bulgarian. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("bg", {
    /* GPS Settings panel */
    "gpsSettings.title": "Настройки на GPS",
    "gpsSettings.done": "Готово",
    "gpsSettings.groupRound": "Кръг",
    "gpsSettings.units": "Мерни единици",
    "gpsSettings.unitsHint": "Разстояния в метри или ярдове.",
    "gpsSettings.unitsMetres": "Метри",
    "gpsSettings.unitsYards": "Ярдове",
    "gpsSettings.groupShotView": "Изглед на удара",
    "gpsSettings.aimLine": "Линия за прицелване",
    "gpsSettings.aimLineHint": "Помощна линия от старта до целта.",
    "gpsSettings.shotUp": "Ударът нагоре",
    "gpsSettings.shotUpHint": "Завърта изгледа, така че ударът да върви нагоре по екрана.",
    "gpsSettings.tightness": "Кадър при заключване",
    "gpsSettings.tightnessTight": "Тесен",
    "gpsSettings.tightnessTightHint": "Близък фокус върху удара",
    "gpsSettings.tightnessMedium": "Среден",
    "gpsSettings.tightnessMediumHint": "Балансиран изглед на удара",
    "gpsSettings.tightnessWide": "Широк",
    "gpsSettings.tightnessWideHint": "Повече от дупката",
    "gpsSettings.openButton": "Настройки на GPS",
    "gpsSettings.groupApp": "Приложение",
    "gpsSettings.language": "Език",
    "gpsSettings.languageHint": "Език на приложението.",
    "gpsSettings.languageAuto": "Език на телефона",

    /* Shared words */
    "common.on": "Вкл.",
    "common.off": "Изкл."
  });
})(typeof window !== "undefined" ? window : globalThis);
