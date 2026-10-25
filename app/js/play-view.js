/* The hybrid look Play draws with: the illustrated map blended over the photo, as saved in
   Clarity Studio > 3D Course Viewer (GET /api/play-view, functions/play-view.mjs).

   Read once a launch and kept on the device, so a round with no signal still draws the look
   the last good read saw. Until anything has been read, and if the read never answers, it is
   the defaults (scripts/gd-hybrid-look.js) - the hole is never held up for it. painter.js
   rebuilds the mesh when it changes. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var STORE_KEY = "clarity:play-view:v1";
  var lib = window.GDHybridLook;
  var listeners = [];

  function stored() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { return null; }
  }

  var hybrid = lib ? lib.normalize(stored()) : null;

  function adopt(next) {
    if (!lib) return;
    var clean = lib.normalize(next);
    if (JSON.stringify(clean) === JSON.stringify(hybrid)) return;
    hybrid = clean;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(clean)); } catch (e) {}
    listeners.forEach(function (fn) { try { fn(hybrid); } catch (e) {} });
  }

  app.playView = {
    /* GDHybridLook.normalize()'s shape, or null without the library. */
    hybrid: function () { return hybrid; },
    onChange: function (fn) { listeners.push(fn); }
  };

  if (lib && typeof fetch === "function") {
    fetch("/api/play-view", { headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) { if (data && data.hybrid) adopt(data.hybrid); })
      .catch(function () {});
  }
})();
