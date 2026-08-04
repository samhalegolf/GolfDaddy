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
  /* Fires once per COMPLETED shot, with the hole it belongs to and how it was
     ended. Separate from onChange, which fires on every aim nudge: Course Data
     wants the finished thing, once, not a stream of intermediate states.
     Kept here rather than in play.js because this module is where a shot is
     actually completed - both places that close one are below. */
  var completeListeners = [];

  function complete(record, method) {
    byHole[hole].push(record);
    completeListeners.forEach(function (fn) {
      try { fn(record, { hole: hole, captureMethod: method }); } catch (e) {}
    });
  }

  /* The null checks are load-bearing, not defensive noise: Number(null) is 0,
     and 0 is finite. Without them pt(null) answered {lat:0, lng:0} - a real
     point in the Gulf of Guinea - so holeOut(null) recorded the ball at null
     island instead of falling back to the aim, and any caller that lost a
     position placed a shot there rather than declining to place one. Harmless
     while shots lived in memory for one round; not harmless now that Course
     Data persists them as measurements. */
  function pt(value) {
    if (!value || value.lat == null || value.lng == null) return null;
    var lat = Number(value.lat), lng = Number(value.lng);
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
      if (active) complete({ start: active.start, target: active.target, end: here }, "placement");
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
      if (active) {
        var landed = pt(endPos);
        /* No fix and no placement means the aim is standing in for where the
           ball finished. Course Data is told which it was rather than being
           handed a guess dressed as an observation. */
        complete(
          { start: active.start, target: active.target, end: landed || active.target },
          landed ? "hole-out" : "hole-out-assumed-target"
        );
      }
      active = null;
      notify();
      return byHole[hole];
    },
    active: function () { return active; },
    holeShots: function (n) { return byHole[Number(n) || hole] || []; },
    onChange: function (fn) { listeners.push(fn); },
    onComplete: function (fn) { completeListeners.push(fn); }
  };
})();
