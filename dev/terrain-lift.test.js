#!/usr/bin/env node
/* app/js/gd-terrain-mesh.js makeDisplacer: the vertex shader's height shear restated on the
   CPU so the painter's projector can lift overlays onto the stood-up ground in lock, and
   ground a tap back. Pure, so it runs here with a synthetic DEM.

   Run: npm run test:terrain-lift */
"use strict";
const assert = require("assert");
const path = require("path");
const root = {};
require("vm").runInNewContext(require("fs").readFileSync(path.join(__dirname, "..", "app", "js", "gd-terrain-mesh.js"), "utf8"), { window: root, document: undefined });
const makeDisplacer = root.GDTerrainMesh.makeDisplacer;
/* The module runs in its own realm, so its objects have a different prototype: compare by field. */
function same(actual, expected, msg) { assert.strictEqual(actual.x, expected.x, msg); assert.strictEqual(actual.y, expected.y, msg); }

const framePx = [1000, 2000];          // frame is 1000px wide ...
const metres = [200, 400];             // ... over 200m, so 5 px per metre
const state = { tiltDeg: 30, frameRotationDeg: 0, exaggeration: 2.5, seaLevel: 100 };
const tan30 = Math.tan(Math.PI / 6);

/* Flat ground at sea level: nothing moves, forwards or back. */
{
  const d = makeDisplacer({ heightAt: () => 100, framePx, metres, state });
  same(d.lift({ x: 500, y: 1000 }), { x: 500, y: 1000 });
  same(d.ground({ x: 500, y: 1000 }), { x: 500, y: 1000 });
}

/* A 4m plateau in the middle of the frame, north-up frame: pushed straight up the image by
   4 * 2.5 * 5 * tan(30) px, exactly the shader's uShear * h. */
{
  const d = makeDisplacer({ heightAt: () => 104, framePx, metres, state });
  const p = d.lift({ x: 500, y: 1000 });
  const expect = 4 * 2.5 * 5 * tan30;
  assert.ok(Math.abs(p.x - 500) < 1e-9, "no sideways shear with no frame rotation");
  assert.ok(Math.abs((1000 - p.y) - expect) < 1e-9, "lifted up the image by uShear*h: " + (1000 - p.y) + " vs " + expect);
  /* No tilt, no lift - every stage but lock. */
  const flat = makeDisplacer({ heightAt: () => 104, framePx, metres, state: Object.assign({}, state, { tiltDeg: 0 }) });
  same(flat.lift({ x: 500, y: 1000 }), { x: 500, y: 1000 });
}

/* Frame rotated 90 degrees: "up after rotation" is the shader's (sin(rot), -cos(rot)). */
{
  const d = makeDisplacer({ heightAt: () => 104, framePx, metres, state: Object.assign({}, state, { frameRotationDeg: 90 }) });
  const p = d.lift({ x: 500, y: 1000 });
  const mag = 4 * 2.5 * 5 * tan30;
  assert.ok(Math.abs((p.x - 500) - (-mag)) < 1e-9 && Math.abs(p.y - 1000) < 1e-9, "rotated frame shears along the rotated up: " + JSON.stringify(p));
}

/* A sloping field: ground(lift(p)) comes back to p within a small fraction of a pixel, and
   lift(ground(s)) returns the screen point - the tap path. */
{
  /* 12m of rise across the 400m frame with a couple of metres of undulation - a real
     parkland hole, and with exaggeration 2.5 still a stiff test of the inverse. */
  const slope = (u, v) => 100 + 12 * v + 2 * Math.sin(u * 7);
  const d = makeDisplacer({ heightAt: slope, framePx, metres, state });
  [{ x: 120, y: 300 }, { x: 500, y: 1000 }, { x: 900, y: 1700 }].forEach(p => {
    const back = d.ground(d.lift(p));
    assert.ok(Math.hypot(back.x - p.x, back.y - p.y) < 0.05, "round trip " + JSON.stringify(p) + " -> " + JSON.stringify(back));
    const s = d.lift(d.ground(p));
    assert.ok(Math.hypot(s.x - p.x, s.y - p.y) < 0.05, "tap round trip " + JSON.stringify(p) + " -> " + JSON.stringify(s));
  });
}

/* Outside the frame and on its rim: no lift, matching the shader's edge tuck. */
{
  const d = makeDisplacer({ heightAt: () => 150, framePx, metres, state });
  same(d.lift({ x: -5, y: 100 }), { x: -5, y: 100 });
  same(d.lift({ x: 500, y: 0 }), { x: 500, y: 0 });
  const rim = d.lift({ x: 500, y: 6 }), inside = d.lift({ x: 500, y: 1000 });
  assert.ok((6 - rim.y) < (1000 - inside.y), "the rim fades in");
}

console.log("terrain-lift: ok");
