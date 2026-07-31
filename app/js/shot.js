/* Shot loop state. Pure data, no DOM.

   A shot is start → target (the aim) → end. Placement IS both the lock-in and
   the shot advance: your first placement on a hole starts shot one; every
   later deliberate placement says "this is where that shot finished and the
   next one starts". The aim defaults to the green and moves when the player
   drags the bubble. Hole Out ends the hole's final shot where the player
   stands (green focus is where that happens in practice). */
(function () {
  "use strict";
  var app = (window.ClarityApp = window.ClarityApp || {});

  var byHole = {};
  var hole = 0;
  var active = null;
  var listeners = [];

  function pt(value) {
    var lat = Number(value && value.lat), lng = Number(value && value.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat: lat, lng: lng } : null;
  }

  function notify() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  app.shot = {
    /* A new round wipes all holes; re-entering a hole mid-round keeps its
       shots. Called on course open. */
    startRound: function () {
      byHole = {};
      active = null;
      notify();
    },
    startHole: function (n) {
      hole = Number(n) || 0;
      byHole[hole] = byHole[hole] || [];
      active = null;
      notify();
    },
    /* A deliberate placement: ends the active shot here (if any) and starts
       the next one from here, aimed at defaultTarget (the green). */
    place: function (pos, defaultTarget) {
      var here = pt(pos);
      if (!here) return;
      if (active) byHole[hole].push({ start: active.start, target: active.target, end: here });
      active = { start: here, target: pt(defaultTarget) };
      notify();
    },
    aim: function (latlng) {
      var target = pt(latlng);
      if (!active || !target) return;
      active.target = target;
      notify();
    },
    /* End the hole: the final shot finishes where the player stands (or at
       its aim if no position). Returns the hole's completed shots. */
    holeOut: function (endPos) {
      if (active) byHole[hole].push({ start: active.start, target: active.target, end: pt(endPos) || active.target });
      active = null;
      notify();
      return byHole[hole];
    },
    active: function () { return active; },
    holeShots: function (n) { return byHole[Number(n) || hole] || []; },
    onChange: function (fn) { listeners.push(fn); }
  };
})();
