#!/usr/bin/env node
/* The phone's bubble carries a forward bias; the watch engines do not.
 *
 * gdBubbleRenderCenter nudges the phone's bubble centre along the shot by
 * visualYBias x depth radius - a face-offset-driven push of under two metres
 * for most clubs that the phone has always drawn. The Swift and Monkey C
 * engines sit the centre ON the target, and the parity fixture records that
 * shared maths with the bias switched off. A watch camera change on 5 Oct
 * 2026 removed the bias from the phone as well, which is what this pins
 * against: the phone ships with it ON, it moves the centre by exactly the
 * engine's own numbers, and off it is the wrist's centre.
 *
 * Run: node dev/bubble-forward-bias.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

function bootEngine() {
  const distanceLib = require(path.join(ROOT, "app", "js", "distance.js"));
  const sandbox = {
    console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { body: { classList: { contains: () => false } } },
    L: {
      latLng: (lat, lng) => ({ lat, lng }),
      point: (x, y) => ({ x, y, distanceTo(o) { return Math.hypot(o.x - x, o.y - y); } })
    }
  };
  sandbox.window = sandbox;
  sandbox.window.ClarityApp = { distance: distanceLib };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "app", "js", "bubble-engine.js"), "utf8"), sandbox, { filename: "bubble-engine.js" });
  return { engine: sandbox.window.GDBubbleEngine, distance: distanceLib };
}

const { engine, distance } = bootEngine();

/* A mid-iron with a saved My Bubble: the face offset is what gives the bias a
   value (visualYBias is derived from it), so a 0 deg bubble would pin nothing. */
const hole = { number: 1, tee: { lat: -36.9168, lng: 174.7405 }, green: { lat: -36.9155, lng: 174.7409 } };
const player = { lat: -36.9165, lng: 174.7406 };
function place(forwardBias) {
  engine.setBag([{ club: "7i", baseCarry: 138, totalM: 148 }, { club: "Driver", baseCarry: 205, totalM: 228 }]);
  engine.setBubble({ offsetDeg: 3.2, handedness: "right" });
  engine.clearWind();
  engine.setMicroGeometry(null);
  engine.setForwardBias(forwardBias);
  engine.setHoleContext({ hole: hole.number, tee: hole.tee, green: hole.green, route: [] });
  engine.setShot(player, hole.green);
  const model = engine.renderModel();
  assert.ok(model, "the engine answers for a placed shot");
  return model;
}

/* Along-shot and across-shot components of (from -> to), in metres. */
function alongAcross(from, to, bearingRad) {
  const north = (to.lat - from.lat) * 111320;
  const east = (to.lng - from.lng) * 111320 * Math.cos(((from.lat + to.lat) / 2) * Math.PI / 180);
  return {
    along: north * Math.cos(bearingRad) + east * Math.sin(bearingRad),
    across: east * Math.cos(bearingRad) - north * Math.sin(bearingRad)
  };
}

const withBias = place(true);
const noBias = place(false);
const shipped = (function () {
  /* A fresh engine, never told either way: what the app actually gets. */
  const fresh = bootEngine().engine;
  fresh.setBag([{ club: "7i", baseCarry: 138, totalM: 148 }, { club: "Driver", baseCarry: 205, totalM: 228 }]);
  fresh.setBubble({ offsetDeg: 3.2, handedness: "right" });
  fresh.setHoleContext({ hole: hole.number, tee: hole.tee, green: hole.green, route: [] });
  fresh.setShot(player, hole.green);
  return fresh.renderModel();
})();

const payload = withBias.payload;
const expectedBiasM = Math.max(-.18, Math.min(.18, Number(payload.visual.visualYBias))) * Math.max(1, Number(payload.depthRadiusM));
assert.ok(Math.abs(expectedBiasM) > 0.05, "the fixture's face offset gives the bias a real value: " + expectedBiasM + "m");

const bearing = distance.bearingRad(player, hole.green);
const moved = alongAcross(noBias.center, withBias.center, bearing);
assert.ok(Math.abs(moved.along - expectedBiasM) < 0.02,
  "the bias moves the centre along the shot by visualYBias x depth radius: " + moved.along.toFixed(3) + "m vs " + expectedBiasM.toFixed(3) + "m");
assert.ok(Math.abs(moved.across) < 0.02, "and not across it: " + moved.across.toFixed(3) + "m");

assert.ok(distance.haversineMeters(shipped.center, withBias.center) < 0.01,
  "the phone ships with the bias ON - a fresh engine draws the biased centre");
assert.ok(distance.haversineMeters(shipped.center, noBias.center) > 0.05,
  "and that is not the wrist's centre");

/* The parity fixture is the wrist's maths: recorded with the bias off. */
const parity = fs.readFileSync(path.join(__dirname, "bubble-engine-parity.test.js"), "utf8");
assert.ok(/engine\.setForwardBias\(false\)/.test(parity), "the parity test records the shared maths with the phone's bias off");

console.log("bubble-forward-bias: ok");
