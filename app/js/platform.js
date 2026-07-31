/* Tiny platform shims the reused clean modules expect. This is the complete
   list — a module needing more than this is not clean enough to reuse verbatim.

   gdSafeLocalSet: clarity-supabase-auth.js's commit() calls it as a bare
   identifier (defined by gd-app-core.js in the old tree). Quota errors are
   swallowed: localStorage is a cache (audit rule 7) and a failed write must
   never take down a login. */
(function () {
  "use strict";
  if (typeof window.gdSafeLocalSet !== "function") {
    window.gdSafeLocalSet = function (key, value) {
      try { localStorage.setItem(key, value); return true; } catch (e) { return false; }
    };
  }
})();
