/* Greek. Same keys as en.js; anything left out falls back to English. */
(function (root) {
  "use strict";
  var i18n = root.GDI18n || (typeof require === "function" ? require("../gd-i18n.js") : null);
  i18n.add("el", {
    /* GPS Settings panel */
    "gpsSettings.title": "Ρυθμίσεις GPS",
    "gpsSettings.done": "Τέλος",
    "gpsSettings.groupRound": "Γύρος",
    "gpsSettings.units": "Μονάδες",
    "gpsSettings.unitsHint": "Αποστάσεις σε μέτρα ή γιάρδες.",
    "gpsSettings.unitsMetres": "Μέτρα",
    "gpsSettings.unitsYards": "Γιάρδες",
    "gpsSettings.groupShotView": "Προβολή χτυπήματος",
    "gpsSettings.aimLine": "Γραμμή στόχευσης",
    "gpsSettings.aimLineHint": "Οδηγός από την αφετηρία στον στόχο.",
    "gpsSettings.shotUp": "Χτύπημα προς τα πάνω",
    "gpsSettings.shotUpHint": "Περιστρέφει την προβολή ώστε το χτύπημα να κινείται προς τα πάνω στην οθόνη.",
    "gpsSettings.tightness": "Κάδρο κλειδώματος",
    "gpsSettings.tightnessTight": "Στενό",
    "gpsSettings.tightnessTightHint": "Στενή εστίαση στο χτύπημα",
    "gpsSettings.tightnessMedium": "Μεσαίο",
    "gpsSettings.tightnessMediumHint": "Ισορροπημένη προβολή",
    "gpsSettings.tightnessWide": "Ευρύ",
    "gpsSettings.tightnessWideHint": "Περισσότερο από την τρύπα",
    "gpsSettings.openButton": "Ρυθμίσεις GPS",
    "gpsSettings.groupApp": "Εφαρμογή",
    "gpsSettings.language": "Γλώσσα",
    "gpsSettings.languageHint": "Γλώσσα της εφαρμογής.",
    "gpsSettings.languageAuto": "Γλώσσα τηλεφώνου",

    /* Shared words */
    "common.on": "Ναι",
    "common.off": "Όχι"
  });
})(typeof window !== "undefined" ? window : globalThis);
