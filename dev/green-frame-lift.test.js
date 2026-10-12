#!/usr/bin/env node
/* The green frame (#surfaceGreen, the green at its own resolution composited over the hole
   frame) rides the mesh's relief lift in lock.

   In the tilted lock stage gd-terrain-mesh.js moves every pixel of the hole frame by its
   height, and painter.js's projector lifts the dot, the pin and the bubble the same way. The
   green frame used to be placed flat: on a raised green with relief on, the pin and the bubble
   sat on the stood-up green while its picture stayed tens of pixels lower, and the view read
   as the shot flying past the green. Pinned here: applyGreenFrame asks the mesh for the lift
   at the green frame's centre, through the same offsetAt the projector's lift is built on,
   and attachMesh re-places the green once the mesh is up.

   Run: node dev/green-frame-lift.test.js */
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const PAINTER_SRC = fs.readFileSync(path.join(ROOT, "app", "js", "painter.js"), "utf8");

function body(name) {
  const at = PAINTER_SRC.indexOf("function " + name + "(");
  assert.ok(at >= 0, name + " exists in painter.js");
  const next = PAINTER_SRC.indexOf("\n  function ", at + 1);
  return PAINTER_SRC.slice(at, next > 0 ? next : undefined);
}

/* applyGreenFrame lifts through the mesh, at the green frame's centre. */
{
  const src = body("applyGreenFrame");
  assert.ok(/relief\.offsetAt\(/.test(src), "the green frame is lifted through mesh.offsetAt");
  assert.ok(/classList\.contains\("surface-mesh"\)/.test(src), "only while the mesh is the picture (surface-mesh), as the projector's lift is");
  assert.ok(/outputDimensions\.width\) \* k\) \/ 2/.test(src) && /outputDimensions\.height\) \* k\) \/ 2/.test(src),
    "the lift is read at the centre of the green frame, in hole-frame px");
  assert.ok(src.indexOf("relief.offsetAt(") < src.indexOf("green.style.transform = \"matrix("),
    "the lift goes into the translation the matrix is written from");
}

/* The projector's lift and the green frame's lift are the same number: offsetAt IS lift - px. */
{
  const root = {};
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "app", "js", "gd-terrain-mesh.js"), "utf8"), { window: root, document: undefined });
  const d = root.GDTerrainMesh.makeDisplacer({
    heightAt: (u, v) => 100 + 12 * v + 2 * Math.sin(u * 7),
    framePx: [1000, 2000], metres: [200, 400],
    state: { tiltDeg: 32, frameRotationDeg: 23, exaggeration: 2.5, seaLevel: 100 }
  });
  const centre = { x: 420, y: 650 };
  const lifted = d.lift(centre), off = d.offsetAt(centre);
  assert.ok(Math.abs(lifted.x - centre.x - off.x) < 1e-9 && Math.abs(lifted.y - centre.y - off.y) < 1e-9,
    "offsetAt at the green centre is exactly what lift would move an overlay there by");
  assert.ok(Math.hypot(off.x, off.y) > 1, "a raised green moves by a visible amount: " + JSON.stringify(off));
  const flat = root.GDTerrainMesh.makeDisplacer({
    heightAt: () => 112, framePx: [1000, 2000], metres: [200, 400],
    state: { tiltDeg: 0, frameRotationDeg: 23, exaggeration: 2.5, seaLevel: 100 }
  });
  const none = flat.offsetAt(centre);
  assert.strictEqual(none.x, 0); assert.strictEqual(none.y, 0);
}

/* The mesh arrives after the camera was solved (the textures decode later), so the green
   placed flat has to be placed again once the mesh is up, after the class that makes the
   lift count. */
{
  const src = body("attachMesh");
  const cls = src.indexOf('classList.add("surface-mesh")');
  const place = src.indexOf("applyGreenFrame(meta)");
  assert.ok(cls >= 0 && place > cls, "attachMesh re-places the green frame once surface-mesh is on");
}

console.log("green-frame-lift: ok");
