/* The one canonical course key. Rule 1 of the handover: lowercase, collapse
   non-alphanumerics to hyphens, trim hyphens, fall back to "course" rather than
   an empty key. Every storage key, lookup, and API param derives from this —
   there is no other slug function in app/. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.courseKey = factory().courseKey;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  function courseKey(value) {
    return String(value || "course").toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "course";
  }
  return { courseKey: courseKey };
});
