/* Position watcher. Event-driven — the browser calls us, nothing polls (rule 3).
   Fail-open: no geolocation API, denied permission, or no fix yet all mean "no
   marker", which is a normal state the play surface already renders fine. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});
  var watchId = null;
  var lastFix = null;
  var listeners = [];
  var statusListeners = [];
  /* "" until the browser answers. "denied" is the only value that means the
     player has to do something; the others stay silent on purpose. */
  var status = "";

  function setStatus(next) {
    if (status === next) return;
    status = next;
    statusListeners.forEach(function (fn) { try { fn(status); } catch (e) {} });
  }

  app.gps = {
    start: function () {
      if (watchId !== null) return;
      if (!navigator.geolocation || typeof navigator.geolocation.watchPosition !== "function") {
        setStatus("unsupported");
        return;
      }
      setStatus("pending");
      watchId = navigator.geolocation.watchPosition(
        function (position) {
          lastFix = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy
          };
          setStatus("ok");
          listeners.forEach(function (fn) { try { fn(lastFix); } catch (e) {} });
        },
        /* Still fail-open - no marker is a state the surface renders fine, and
           there is still no retry loop. What changed is that a HARD DENIAL is no
           longer indistinguishable from "no fix yet": that one is not going to
           resolve by waiting, and a player watching a dotless map has no way to
           know the app is not simply still looking. PERMISSION_DENIED is 1;
           POSITION_UNAVAILABLE and TIMEOUT are transient and stay quiet. */
        function (error) {
          if (error && error.code === 1) setStatus("denied");
          else if (status !== "ok") setStatus("pending");
        },
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
      );
    },
    stop: function () {
      if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
      watchId = null;
      lastFix = null;
      setStatus("");
    },
    onFix: function (fn) { listeners.push(fn); },
    onStatus: function (fn) { statusListeners.push(fn); },
    status: function () { return status; },
    lastFix: function () { return lastFix; }
  };
})();
