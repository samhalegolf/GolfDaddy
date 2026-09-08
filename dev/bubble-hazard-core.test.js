#!/usr/bin/env node
"use strict";

const assert = require("assert");
const path = require("path");

const core = require(path.join(__dirname, "..", "scripts", "gd-bubble-hazard-core.js"));

/* Small local frame: ~1e-5 deg is about a metre. Rings are built in "metres" around an
   origin so the cases read as distances rather than as raw coordinates. */
const ORIGIN = { lat: -45.01, lng: 169.10 };
function m(x, y) {
  return { lat: ORIGIN.lat + y / 111320, lng: ORIGIN.lng + x / (111320 * Math.cos(ORIGIN.lat * Math.PI / 180)) };
}
function rect(x0, y0, x1, y1) {
  return [m(x0, y0), m(x1, y0), m(x1, y1), m(x0, y1)];
}
function circle(cx, cy, r, steps = 48) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const a = (Math.PI * 2 * i) / steps;
    pts.push(m(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return pts;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log("  ok  " + name);
}

test("pointInRing: inside, outside, and a point beyond the bbox", () => {
  const box = rect(0, 0, 10, 10);
  assert.strictEqual(core.pointInRing(m(5, 5), box), true);
  assert.strictEqual(core.pointInRing(m(15, 5), box), false);
  assert.strictEqual(core.pointInRing(m(5, -1), box), false);
});

test("cleanRing drops junk points and a closing duplicate, rejects <3 points", () => {
  const closed = rect(0, 0, 10, 10).concat([m(0, 0)]);
  assert.strictEqual(core.cleanRing(closed).length, 4);
  assert.strictEqual(core.cleanRing([m(0, 0), null, { lat: "x", lng: 1 }, m(1, 1), m(1, 0)]).length, 3);
  assert.strictEqual(core.cleanRing([m(0, 0), m(1, 1)]), null);
  assert.strictEqual(core.cleanRing("nope"), null);
});

test("ringsOverlap: disjoint rings do not overlap", () => {
  assert.strictEqual(core.ringsOverlap(rect(0, 0, 10, 10), rect(20, 20, 30, 30)), false);
});

test("ringsOverlap: a ring fully inside another overlaps (either direction)", () => {
  const big = rect(0, 0, 100, 100), small = rect(40, 40, 50, 50);
  assert.strictEqual(core.ringsOverlap(big, small), true);
  assert.strictEqual(core.ringsOverlap(small, big), true);
});

test("ringsOverlap: crossing edges with no vertex inside either ring (plus sign)", () => {
  const horizontal = rect(-30, -5, 30, 5), vertical = rect(-5, -30, 5, 30);
  assert.strictEqual(core.ringsOverlap(horizontal, vertical), true);
});

test("ringsOverlap: rings whose bounding boxes touch but shapes do not", () => {
  /* A bubble sitting in the concave notch of an L-shaped bunker: bboxes overlap, area does not. */
  const lShape = [m(0, 0), m(30, 0), m(30, 10), m(10, 10), m(10, 30), m(0, 30)];
  const bubble = circle(22, 22, 6);
  assert.strictEqual(core.boundsIntersect(core.ringBounds(lShape), core.ringBounds(bubble)), true);
  assert.strictEqual(core.ringsOverlap(lShape, bubble), false);
});

test("collectSurfaces: buckets by type, ignores bunker pins without a shape, reads greenShape", () => {
  const objects = {
    a: { id: "a", type: "fairway_area", holeNumber: 3, shape: rect(0, 0, 40, 200) },
    b: { id: "b", type: "bunker", holeNumber: 3, shape: rect(50, 120, 60, 130) },
    pin: { id: "pin", type: "bunker", holeNumber: 3, position: m(70, 70) },
    w: { id: "w", type: "water", hazardClass: "penalty_area", shape: rect(-40, 100, -10, 140) },
    g: { id: "g", type: "green", holeNumber: 3, position: m(20, 230), greenShape: circle(20, 230, 12) },
    t: { id: "t", type: "tee", position: m(20, -10) },
    bend: { id: "bend", type: "fairway", position: m(20, 100) }
  };
  const surfaces = core.collectSurfaces(objects);
  assert.strictEqual(surfaces.fairways.length, 1);
  assert.strictEqual(surfaces.bunkers.length, 1);
  assert.strictEqual(surfaces.water.length, 1);
  assert.strictEqual(surfaces.water[0].hazardClass, "penalty_area");
  assert.strictEqual(surfaces.greens.length, 1);
  assert.strictEqual(surfaces.greens[0].ring.length, 48);
  assert.strictEqual(core.hasAnySurface(surfaces), true);
  assert.strictEqual(core.hasAnySurface(core.collectSurfaces([])), false);
  /* Array input works the same as the id map. */
  assert.strictEqual(core.collectSurfaces(Object.values(objects)).bunkers.length, 1);
});

const HOLE = core.collectSurfaces({
  fw: { id: "fw", type: "fairway_area", shape: rect(0, 0, 40, 200) },
  b1: { id: "b1", type: "bunker", shape: rect(45, 120, 60, 135) },
  b2: { id: "b2", type: "bunker", shape: rect(-60, 0, -50, 10) },
  w1: { id: "w1", type: "water", shape: rect(-40, 100, -10, 140) },
  g: { id: "g", type: "green", greenShape: circle(20, 240, 12) }
});

test("bubbleSurfaceState: bubble on the fairway touching one bunker and the water", () => {
  const state = core.bubbleSurfaceState(circle(18, 125, 30), HOLE);
  assert.deepStrictEqual(state.bunkers.map(s => s.id), ["b1"]);
  assert.deepStrictEqual(state.water.map(s => s.id), ["w1"]);
  assert.strictEqual(state.onFairway, true);
  assert.strictEqual(state.offFairway, false);
});

test("bubbleSurfaceState: bubble entirely in the rough is off the fairway", () => {
  const state = core.bubbleSurfaceState(circle(90, 60, 12), HOLE);
  assert.strictEqual(state.bunkers.length, 0);
  assert.strictEqual(state.water.length, 0);
  assert.strictEqual(state.hasFairways, true);
  assert.strictEqual(state.onFairway, false);
  assert.strictEqual(state.offFairway, true);
});

test("bubbleSurfaceState: bubble clipping the fairway edge is NOT off the fairway", () => {
  const state = core.bubbleSurfaceState(circle(48, 60, 12), HOLE);
  assert.strictEqual(state.onFairway, true);
  assert.strictEqual(state.offFairway, false);
});

test("bubbleSurfaceState: bubble on the green is not off the fairway (approach shots stay quiet)", () => {
  const state = core.bubbleSurfaceState(circle(20, 240, 10), HOLE);
  assert.strictEqual(state.onFairway, false);
  assert.strictEqual(state.onGreen, true);
  assert.strictEqual(state.offFairway, false);
});

test("bubbleSurfaceState: extraSafe rings count as green", () => {
  const noGreen = core.collectSurfaces({ fw: { type: "fairway_area", shape: rect(0, 0, 40, 200) } });
  const rough = core.bubbleSurfaceState(circle(200, 200, 10), noGreen);
  assert.strictEqual(rough.offFairway, true);
  const onLiveGreen = core.bubbleSurfaceState(circle(200, 200, 10), noGreen, [circle(200, 200, 14)]);
  assert.strictEqual(onLiveGreen.onGreen, true);
  assert.strictEqual(onLiveGreen.offFairway, false);
});

test("bubbleSurfaceState: a course with no fairway surfaces never warns", () => {
  const bunkersOnly = core.collectSurfaces({ b: { type: "bunker", shape: rect(0, 0, 10, 10) } });
  const state = core.bubbleSurfaceState(circle(200, 200, 10), bunkersOnly);
  assert.strictEqual(state.hasFairways, false);
  assert.strictEqual(state.offFairway, false);
});

test("bubbleSurfaceState: garbage in, empty state out", () => {
  const state = core.bubbleSurfaceState(null, HOLE);
  assert.deepStrictEqual(state, { bunkers: [], water: [], hasFairways: false, onFairway: false, onGreen: false, offFairway: false });
  assert.strictEqual(core.bubbleSurfaceState(circle(0, 0, 5), null).offFairway, false);
});

console.log("bubble-hazard-core: " + passed + " tests passed");
