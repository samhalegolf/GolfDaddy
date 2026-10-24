/* The one canonical course key. Rule 1 of the handover: fold accents (ā → a),
   lowercase, collapse non-alphanumerics to hyphens, trim hyphens, fall back to
   "course" rather than an empty key. Every storage key, lookup, and API param
   derives from this — there is no other slug function in app/. Must match
   courseSlug() in functions/lib/gd-course-slug.mjs, which mints the ids. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.courseKey = factory().courseKey;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  function courseKey(value) {
    return String(value || "course").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "course";
  }
  return { courseKey: courseKey };
});
