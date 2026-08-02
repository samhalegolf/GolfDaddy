/* The player's position — one value, one owner. Sources:
     "tee" — hole entry heads to the tee
     "tap" — the player tapped where they are standing
     "gps" — a real fix (play.js gates these to near-the-hole only)
     "shotend" — the Shot End button: the player deliberately says "this is
       where that shot finished," promoting the current fix into a shot
       advance the same way a tap does (a passive GPS fix alone never does)
   Policy about which source wins lives in play.js; this file just holds the
   value and tells listeners when it changes. Event-driven, nothing polls. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var current = null;   // {lat, lng, source}
  var listeners = [];

  app.position = {
    set: function (point, source) {
      var lat = Number(point && point.lat), lng = Number(point && point.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      current = { lat: lat, lng: lng, source: String(source || "tap") };
      listeners.forEach(function (fn) { try { fn(current); } catch (e) {} });
    },
    clear: function () { current = null; },
    current: function () { return current; },
    onChange: function (fn) { listeners.push(fn); }
  };
})();
