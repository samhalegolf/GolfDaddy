/* The one course-package -> GPS presentation decision.
   Server status owns course viability. This controller validates only the wire
   shape and the requested hole; it never promotes "18 holes" into a client
   business rule. Pure/CommonJS-compatible so the transition table is testable. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root.ClarityApp = root.ClarityApp || {};
    root.ClarityApp.createMapReadiness = factory().createMapReadiness;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var STATES = {
    READY: "READY", PARTIAL_READY: "PARTIAL_READY", PROCESSING: "PROCESSING",
    CURRENT_HOLE_MISSING: "CURRENT_HOLE_MISSING", FAILED: "FAILED",
    MANUAL_ACTION_REQUIRED: "MANUAL_ACTION_REQUIRED"
  };

  function point(value) {
    return !!(value && Number.isFinite(Number(value.lat)) && Number.isFinite(Number(value.lng)));
  }

  function playableHole(pkg, hole) {
    var rows = pkg && Array.isArray(pkg.holes) ? pkg.holes : [];
    var row = rows.find(function (item) { return Number(item && item.holeNumber) === Number(hole); });
    var geometry = row && (row.geometry || row);
    return !!(geometry && point(geometry.green));
  }

  function classify(pkg, hole, manualHoles) {
    if (manualHoles && manualHoles[Number(hole)]) return { state: STATES.READY, manual: true, hole: Number(hole) };
    var status = pkg && String(pkg.status || "");
    if (status === "processing") return { state: STATES.PROCESSING, hole: Number(hole) };
    if (status === "manual-required") return { state: STATES.MANUAL_ACTION_REQUIRED, hole: Number(hole), reason: pkg.reason || "" };
    if (status === "failed") return { state: STATES.FAILED, hole: Number(hole), reason: pkg.reason || "" };
    if (status !== "full-map-ready" && status !== "lite-geo-ready") {
      return { state: STATES.FAILED, hole: Number(hole), reason: "package-unavailable" };
    }
    if (!Array.isArray(pkg.holes) || !pkg.holes.length) {
      return { state: STATES.FAILED, hole: Number(hole), reason: "published-package-unreadable" };
    }
    if (!playableHole(pkg, hole)) {
      return { state: STATES.CURRENT_HOLE_MISSING, hole: Number(hole) };
    }
    return {
      state: pkg.readiness === "partial" ? STATES.PARTIAL_READY : STATES.READY,
      hole: Number(hole), mappedHoleCount: Number(pkg.mappedHoleCount) || pkg.holes.length,
      expectedHoleCount: Number(pkg.expectedHoleCount) || null
    };
  }

  function createMapReadiness() {
    var pkg = null, hole = 1, manualHoles = {}, listeners = [], value = classify(null, hole, manualHoles);
    function publish() {
      value = classify(pkg, hole, manualHoles);
      listeners.forEach(function (fn) { fn(value); });
      return value;
    }
    return {
      states: STATES,
      observePackage: function (next) { pkg = next || null; return publish(); },
      enterHole: function (next) { hole = Number(next) || 1; return publish(); },
      setManualHole: function (next) { manualHoles[Number(next) || hole] = true; return publish(); },
      clearManualHole: function (next) { delete manualHoles[Number(next) || hole]; return publish(); },
      current: function () { return value; },
      onChange: function (fn) { if (typeof fn === "function") listeners.push(fn); },
      playableHole: playableHole
    };
  }

  return { STATES: STATES, classify: classify, playableHole: playableHole, createMapReadiness: createMapReadiness };
});
