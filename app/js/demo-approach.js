/* Demo approach: play a hole from the couch.

   Preview has no position, so nothing that needs one - Play, the handover to
   a Watch, the wrist's own rangefinder - can be shown off the course. This
   puts the player on the hole's play line 100-130m short of the green, makes
   that hole live through Marshal's DEMO_APPROACH, and holds the position there
   until the demo ends. While it is on:

   - real GPS fixes are not forwarded to Marshal (boot.js asks active()),
     except the first one that puts the player AT the course: that ends the
     demo (endIfAtCourse) and the round goes down the real path;
   - the planted fix is re-sent every few seconds so nothing downstream ages
     it into "stale";
   - the wearable Scene carries `demo` (caddy-watch.js), so a wrist uses this
     point instead of its own GPS and runs none of its walk-away rules;
   - boot.js keeps resume, scorecard and Course Data writes away from it.

   It is only offered while nothing real is live. A demo started while a demo
   is already running simply moves to the new hole. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var MIN_M = 100;
  var MAX_M = 130;
  var REFRESH_MS = 4000;

  var state = null; // { hole, point, metres }
  var timer = null;
  var listeners = [];

  function finite(n) { return Number.isFinite(Number(n)); }
  function point(p) { return p && finite(p.lat) && finite(p.lng) ? { lat: Number(p.lat), lng: Number(p.lng) } : null; }
  function metres(a, b) { return app.distance ? app.distance.haversineMeters(a, b) : null; }

  /* Tee, the mapped route, green - the line a player actually walks. Ends the
     route already shares with the tee or green are not doubled. */
  function playLine(rec) {
    var line = [];
    function push(p) {
      p = point(p);
      if (!p) return;
      var last = line[line.length - 1];
      if (last && metres(last, p) < 1) return;
      line.push(p);
    }
    push(rec.tee);
    (rec.route || []).forEach(push);
    push(rec.green);
    return line;
  }

  /* Walk back from the green along the line. Each segment is interpolated
     rather than projected along a bearing, the same choice the route sampler
     made (bubble-engine-v2) - at these lengths the two agree, and this one
     cannot drift off the line. A hole shorter than the walk starts at the tee. */
  function pointShortOfGreen(rec, back) {
    var line = playLine(rec);
    if (line.length < 2) return null;
    var left = back;
    for (var i = line.length - 1; i > 0; i--) {
      var a = line[i], b = line[i - 1];
      var seg = metres(a, b);
      if (!(seg > 0)) continue;
      if (seg >= left) {
        var t = left / seg;
        return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      }
      left -= seg;
    }
    return line[0];
  }

  function marshal() { return app.marshal || null; }

  function canStart() {
    var m = marshal();
    if (!m || !m.round) return false;
    var round = m.round();
    if (!round.open) return false;
    return round.liveHole === null || round.liveHole === undefined || !!state;
  }

  function notify() {
    listeners.forEach(function (fn) { try { fn(api.state()); } catch (e) {} });
  }

  function refresh() {
    var m = marshal();
    if (!state || !m) return;
    m.signal("FIX_RECEIVED", { point: { lat: state.point.lat, lng: state.point.lng }, speed: 0 });
  }

  function start(hole) {
    var m = marshal();
    if (!canStart()) return false;
    hole = Number(hole);
    var rec = app.createMarshal && app.createMarshal.holeRecord ? app.createMarshal.holeRecord(m.pkg(), hole) : null;
    if (!rec || !rec.green) return false;
    var back = MIN_M + Math.random() * (MAX_M - MIN_M);
    var at = pointShortOfGreen(rec, back);
    if (!at) return false;
    /* Set before the signal: the Scene this publishes must already say demo,
       or a wrist would spend one revision measuring from its own GPS. */
    var before = state;
    state = { hole: hole, point: at, metres: Math.round(metres(at, rec.green)) };
    if (!m.signal("DEMO_APPROACH", { hole: hole, point: at })) { state = before; return false; }
    if (!timer) timer = setInterval(refresh, REFRESH_MS);
    notify();
    return true;
  }

  function stop() {
    if (!state) return false;
    state = null;
    if (timer) { clearInterval(timer); timer = null; }
    var m = marshal();
    if (app.caddyWatch && app.caddyWatch.takeBack) app.caddyWatch.takeBack();
    if (m) m.signal("DEMO_ENDED");
    /* Hand the real GPS its job back straight away rather than at the next
       watchPosition callback. */
    var fix = app.gps && app.gps.lastFix ? app.gps.lastFix() : null;
    if (m && fix) m.signal("FIX_RECEIVED", { point: fix, speed: fix.speed });
    notify();
    return true;
  }

  /* The real round's own entry test, asked of a real fix: is the player at
     the course (Marshal's AT_COURSE_M from the round's centre)? If so the demo
     ends. The fix itself is NOT applied here; the caller sends it on. */
  function endIfAtCourse(fix) {
    var m = marshal();
    if (!state || !m || !fix) return false;
    var centre = m.round && m.round().centre;
    var limit = m.constants && m.constants.AT_COURSE_M;
    var away = centre ? metres(fix, centre) : null;
    if (away === null || !(away <= limit)) return false;
    stop();
    return true;
  }

  var api = app.demoApproach = {
    active: function () { return !!state; },
    available: canStart,
    hole: function () { return state ? state.hole : null; },
    point: function () { return state ? { lat: state.point.lat, lng: state.point.lng } : null; },
    state: function () { return state ? { hole: state.hole, point: { lat: state.point.lat, lng: state.point.lng }, metres: state.metres } : null; },
    start: start,
    stop: stop,
    endIfAtCourse: endIfAtCourse,
    onChange: function (fn) { if (typeof fn === "function") listeners.push(fn); },
    /* A different round is a different course; a demo never follows it. */
    reset: function () {
      state = null;
      if (timer) { clearInterval(timer); timer = null; }
      notify();
    },
    __test: { pointShortOfGreen: pointShortOfGreen, playLine: playLine }
  };
})();
