/* Position watcher. Event-driven — the browser calls us, nothing polls (rule 3).
   Fail-open: no geolocation API, denied permission, or no fix yet all mean "no
   marker", which is a normal state the play surface already renders fine. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var watchId = null;
  var lastFix = null;
  var listeners = [];

  app.gps = {
    start: function () {
      if (watchId !== null) return;
      if (!navigator.geolocation || typeof navigator.geolocation.watchPosition !== "function") return;
      watchId = navigator.geolocation.watchPosition(
        function (position) {
          lastFix = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy
          };
          listeners.forEach(function (fn) { try { fn(lastFix); } catch (e) {} });
        },
        function () { /* denied or unavailable: stay markerless, no retry loop */ },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
      );
    },
    stop: function () {
      if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      lastFix = null;
    },
    onFix: function (fn) { listeners.push(fn); },
    lastFix: function () { return lastFix; }
  };
})();
