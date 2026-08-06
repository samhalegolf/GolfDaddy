/* The pin (flag) position on the green — a player-set exact point, separate
   from the green centre/shape the course package provides. Mirrors shot.js's
   shape: pure data, no DOM, per-hole. Unset is a normal state (rule: absence
   is a state) — resets on every hole/round change like shot.js and
   position.js already do; nothing persists across a hole. */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var byHole = {};
  var hole = 0;
  var armed = false;
  var listeners = [];

  function pt(value) {
    var lat = Number(value && value.lat), lng = Number(value && value.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  var DEFAULT_GREEN_RADIUS_M = 14;   // a green of unknown size, for the quadrant offsets only
  var QUADRANT_FRACTION = 0.45;      // how far into the quadrant the offsets reach

  /* Pin Lock: where the pin is, worked out rather than pointed at.

     The player answers two things a rangefinder round gives them: WHICH
     quadrant of the green the flag is in, and HOW FAR it read. Those are
     different kinds of evidence and they are used differently.

     The quadrant sets the DIRECTION. Offsetting from the green centre — across
     the shot line for left/right, along it for front/back — gives a point in
     the right corner of the green, which fixes the bearing from the player.

     The measured distance then sets the RANGE along that bearing. It is the
     precise number of the two, so it wins on how far; the quadrant only had to
     get the direction right. With no distance entered the quadrant point
     stands on its own.

     Returns null when it cannot be answered — no position, no green — rather
     than dropping a pin somewhere defensible-looking. */
  function lockedPin(opts) {
    var d = app.distance;
    var from = pt(opts && opts.position);
    var centre = pt(opts && opts.green);
    if (!d || !from || !centre) return null;

    var quadrant = String((opts && opts.quadrant) || "");
    var side = /right/i.test(quadrant) ? 1 : (/left/i.test(quadrant) ? -1 : 0);
    var depth = /back/i.test(quadrant) ? 1 : (/front/i.test(quadrant) ? -1 : 0);

    var shotBearing = d.bearingRad(from, centre);
    if (!Number.isFinite(shotBearing)) return null;

    var radius = d.greenRadiusMeters({ green: centre, greenShape: (opts && opts.greenShape) || [] });
    if (!Number.isFinite(radius) || radius <= 0) radius = DEFAULT_GREEN_RADIUS_M;
    var reach = radius * QUADRANT_FRACTION;

    /* Along the shot line for front/back, across it for left/right. */
    var corner = centre;
    if (depth) corner = d.project(corner, shotBearing, depth * reach) || corner;
    if (side) corner = d.project(corner, shotBearing + side * Math.PI / 2, reach) || corner;

    var measured = Number(opts && opts.distanceM);
    if (!Number.isFinite(measured) || measured <= 0) return pt(corner);

    var aim = d.bearingRad(from, corner);
    if (!Number.isFinite(aim)) aim = shotBearing;
    return pt(d.project(from, aim, measured));
  }

  app.pin = {
    /* Exposed for the Pin Lock sheet, and pure enough to check on its own. */
    lockedPin: lockedPin,
    startRound: function () {
      byHole = {};
      armed = false;
      notify();
    },
    startHole: function (n) {
      hole = Number(n) || 0;
      armed = false;
      notify();
    },
    set: function (pos) {
      var here = pt(pos);
      if (!here) return;
      var atHole = hole, prev = byHole[hole] || null;
      if (app.undo) app.undo.push(function () {
        if (prev) byHole[atHole] = prev; else delete byHole[atHole];
        notify();
      });
      byHole[hole] = here;
      notify();
    },
    clear: function () {
      var atHole = hole, prev = byHole[hole] || null;
      if (prev && app.undo) app.undo.push(function () { byHole[atHole] = prev; notify(); });
      delete byHole[hole];
      notify();
    },
    current: function () { return byHole[hole] || null; },
    arm: function () { armed = true; notify(); },
    disarm: function () { armed = false; notify(); },
    armed: function () { return armed; },
    togglePlacement: function () { if (armed) this.disarm(); else this.arm(); },
    onChange: function (fn) { listeners.push(fn); }
  };
})();
