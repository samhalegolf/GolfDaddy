#!/usr/bin/env node
"use strict";
/* The fairway layup samples along the hole's route, and the default target is
   picked from those samples. Both must stay ON the route at any latitude.

   The bug this pins: sampleRouteProgress projected each sample along
   bearing(a,b) - the engine's degree-space angle, atan2 of raw degree deltas -
   using project(), which moves in metres with the latitude scaled in. At 45
   degrees south the two conventions disagree by ~9.5 degrees, so every sample
   veered right of the line and Millbrook hole 1's layup landed 42 m into the
   rough at 250 m (2026-09-22). The sampler now interpolates the segment
   itself; gdPointAlongLine does the same for the straight-line fallback.

   The functions are read out of their source files by name, the same way
   dev/generate-bubble-engine-client.js copies them, so this tests the code
   that ships rather than a re-typed version of it. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const PINLOCK = fs.readFileSync(path.join(ROOT, "scripts", "gd-course-library-pin-lock.js"), "utf8");
const CORE = fs.readFileSync(path.join(ROOT, "scripts", "gd-app-core.js"), "utf8");

function extract(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.ok(start >= 0, name + " must exist in its source file");
  let depth = 0, i = source.indexOf("{", start);
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

/* Haversine, the same metres Leaflet's map.distance and the app's distance
   module produce. */
function haversine(a, b) {
  const R = 6371000, toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/* Cross-track distance from p to the great-circle segment a-b, in metres. */
function offLine(p, a, b) {
  const R = 6371000, toR = d => d * Math.PI / 180;
  const brg = (x, y) => Math.atan2(Math.sin(toR(y.lng - x.lng)) * Math.cos(toR(y.lat)),
    Math.cos(toR(x.lat)) * Math.sin(toR(y.lat)) - Math.sin(toR(x.lat)) * Math.cos(toR(y.lat)) * Math.cos(toR(y.lng - x.lng)));
  const d13 = haversine(a, p) / R;
  return Math.abs(Math.asin(Math.sin(d13) * Math.sin(brg(a, p) - brg(a, b))) * R);
}

const scope = {
  L: { latLng: (lat, lng) => ({ lat, lng }) },
  map: { distance: haversine },
  toLatLng: p => (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) ? { lat: p.lat, lng: p.lng } : null,
  distance: haversine
};
const build = (source, names) => new Function(...Object.keys(scope), names.map(n => extract(source, n)).join("\n") + "\nreturn { " + names.join(", ") + " };")(...Object.values(scope));
const pinlock = build(PINLOCK, ["sampleRouteProgress", "fairwayLayupTargetByShotDistance"]);
const core = build(CORE, ["gdPointAlongLine"]);

/* Millbrook hole 1 as published: tee, two fairway pins, green - all on one line. */
const tee = { lat: -44.9492751, lng: 168.8142384 };
const near = { lat: -44.948179944, lng: 168.81596604 };
const far = { lat: -44.947328156, lng: 168.81730976 };
const green = { lat: -44.94623237, lng: 168.81902249 };
const route = [tee, near, far, green];

let passed = 0;
function check(name, fn) { try { fn(); console.log("  PASS  " + name); passed++; } catch (e) { console.log("  FAIL  " + name + "\n        " + e.message); process.exitCode = 1; } }

console.log("\n— Route sampler at 45 degrees south —");
check("every sample lies on the route it was sampled from", () => {
  const samples = pinlock.sampleRouteProgress(route, 7);
  assert.ok(samples.length > 60, "a 500 m hole at 7 m steps yields dozens of samples, got " + samples.length);
  let worst = 0;
  samples.forEach(s => { worst = Math.max(worst, offLine(s.point, tee, green)); });
  assert.ok(worst < 1.0, "worst sample is " + worst.toFixed(2) + " m off the line; the old projection put it 40 m off");
  const last = samples[samples.length - 1];
  assert.ok(haversine(last.point, green) < 0.5, "the final sample is the green");
});
check("the layup target for a 275 m bag sits on the line, 275 m out", () => {
  const target = pinlock.fairwayLayupTargetByShotDistance(route, tee, 275);
  assert.ok(target, "a hole longer than the bag must yield a layup");
  assert.ok(offLine(target, tee, green) < 1.0, "target is " + offLine(target, tee, green).toFixed(1) + " m off the fairway line");
  assert.ok(Math.abs(haversine(tee, target) - 275) <= 4, "target is " + haversine(tee, target).toFixed(1) + " m from the tee");
});
check("gdPointAlongLine walks the straight line, not a degree-space bearing", () => {
  const p = core.gdPointAlongLine(tee, green, 275);
  assert.ok(p && offLine(p, tee, green) < 0.5, "fallback point is off the line by " + (p ? offLine(p, tee, green).toFixed(1) : "?") + " m");
  assert.ok(Math.abs(haversine(tee, p) - 275) < 0.5, "fallback point is " + haversine(tee, p).toFixed(1) + " m out");
  assert.strictEqual(core.gdPointAlongLine(tee, tee, 100), null, "coincident points have no line");
  assert.ok(haversine(core.gdPointAlongLine(tee, green, 99999), green) < 0.5, "never overshoots the far end");
});
console.log(passed + " route sampler checks passed.");
