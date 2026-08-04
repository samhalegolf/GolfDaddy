/* Plays-like distance: what the shot plays to once the ground under it is
   taken into account. Ported from the legacy elevation channel in
   gd-app-core.js ("Elevation channel: opportunistic plays-like distance"),
   same endpoint and same arithmetic:

     GET https://api.open-meteo.com/v1/elevation?latitude=a,b&longitude=c,d
     adjusted = max(0, flat + (targetElevation - originElevation))

   Both ends go in one request. Elevations are cached per point (rounded to
   5dp, ~1m, which is well inside the ~90m source resolution), so walking a
   hole re-uses the green's elevation all the way up it.

   "Opportunistic" is the whole contract. It is a third-party lookup over the
   network during play: it may be slow, refused, or simply unavailable
   offline, and none of that is an error. Every failure answers null and the
   card just shows the flat number, exactly as it did before this existed.
   Nothing here blocks a render, and nothing here is awaited by the play loop.

   Rule 3 (no setInterval) holds: the debounce is a single bounded setTimeout,
   cancelled and re-armed, never a poller. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var ENDPOINT = "https://api.open-meteo.com/v1/elevation";
  var DEBOUNCE_MS = 650;      // the legacy value: long enough that a drag does not fetch per frame
  var LEVEL_BAND_M = 1;       // inside this, the shot is level rather than up or down

  var points = new Map();     // "lat,lng" → elevation metres
  var shots = new Map();      // "originKey|targetKey" → {deltaM} | null while pending
  var timer = null;
  var seq = 0;
  var listeners = [];

  function valid(p) {
    return !!(p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
      && Number(p.lat) >= -90 && Number(p.lat) <= 90
      && Number(p.lng) >= -180 && Number(p.lng) <= 180);
  }
  function key(p) { return valid(p) ? Number(p.lat).toFixed(5) + "," + Number(p.lng).toFixed(5) : null; }
  function shotKey(a, b) { var ka = key(a), kb = key(b); return (ka && kb) ? ka + "|" + kb : null; }
  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  /* One request, both ends. Resolves to a map of key → metres for whatever
     came back; anything missing simply is not in it. */
  function fetchElevations(list) {
    var lat = list.map(function (p) { return Number(p.lat).toFixed(6); }).join(",");
    var lng = list.map(function (p) { return Number(p.lng).toFixed(6); }).join(",");
    return fetch(ENDPOINT + "?latitude=" + lat + "&longitude=" + lng, { headers: { Accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        var out = new Map();
        var arr = data && Array.isArray(data.elevation) ? data.elevation : [];
        list.forEach(function (p, i) {
          var v = Number(arr[i]);
          if (Number.isFinite(v)) out.set(key(p), v);
        });
        return out;
      })
      .catch(function () { return new Map(); });
  }

  function resolve(origin, target, k) {
    var need = [];
    if (!points.has(key(origin))) need.push(origin);
    if (!points.has(key(target))) need.push(target);
    if (!need.length) {
      shots.set(k, { deltaM: points.get(key(target)) - points.get(key(origin)) });
      notify();
      return;
    }
    var mine = ++seq;
    fetchElevations(need).then(function (got) {
      if (mine !== seq) return;   // superseded: a newer shot is being asked about
      got.forEach(function (v, pk) { points.set(pk, v); });
      if (points.has(key(origin)) && points.has(key(target))) {
        shots.set(k, { deltaM: points.get(key(target)) - points.get(key(origin)) });
      } else {
        shots.set(k, null);       // answered: unavailable. Cached so it is not asked again.
      }
      notify();
    });
  }

  app.playsLike = {
    /* → {adjustedM, deltaM, plays, label} or null. Null covers every "not
       today": no answer yet, the lookup failed, or the points are unusable.
       The first call for a shot schedules the lookup and returns null; when
       it lands, onChange fires and the next render picks it up. */
    forShot: function (origin, target, flatM) {
      var k = shotKey(origin, target);
      if (!k || !Number.isFinite(Number(flatM))) return null;
      if (!shots.has(k)) {
        clearTimeout(timer);
        timer = setTimeout(function () { resolve(origin, target, k); }, DEBOUNCE_MS);
        return null;
      }
      var hit = shots.get(k);
      if (!hit || !Number.isFinite(Number(hit.deltaM))) return null;
      var delta = Number(hit.deltaM);
      var adjustedM = Math.max(0, Number(flatM) + delta);
      var plays = delta > LEVEL_BAND_M ? "uphill" : (delta < -LEVEL_BAND_M ? "downhill" : "level");
      var rounded = Math.round(delta * 10) / 10;
      return {
        adjustedM: adjustedM,
        deltaM: delta,
        plays: plays,
        label: plays === "level" ? "level" : (rounded > 0 ? "+" + rounded : String(rounded)) + "m " + plays
      };
    },
    onChange: function (fn) { listeners.push(fn); }
  };
})();
