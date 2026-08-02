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

  app.pin = {
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
