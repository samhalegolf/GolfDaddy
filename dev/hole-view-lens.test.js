#!/usr/bin/env node
/* The corridor's hole-view lens (functions/lib/gd-visual-plan-core.mjs HOLE_VIEW): how far the
   published hole frame reaches past the green and how wide it is.

   Past the green is the tilted lock stage's need: the top of the screen looks about 1.3 shot
   lengths beyond the target, so a 140m approach sees 180m past the green, and a par 3 from the
   tee sees further than the hole is long. Half the hole's length, never less than 180m.

   Across is the flat hole stage's need: 0.375 of the hole each side is exactly a 9:19.5 phone,
   and the frame carries 0.38. It used to carry 0.42, which was bytes for ground the phone never
   shows. Measured here on straight north-south holes so the planner's own capture bounds can be
   read in metres without any rotation maths.

   Run: node dev/hole-view-lens.test.js */
"use strict";
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const M_PER_DEG_LAT = 111320;
const SOURCE = {
  key: "test-xyz", label: "Test",
  imagery: { adapter: "xyz", urlTemplate: "https://tiles.test/{z}/{x}/{y}.webp", maxUsefulZoom: 20 },
  terrain: null
};

/* One straight hole, tee north of green on the same longitude, `lengthM` long, with a small
   green shape so the ground points never decide the width. */
function course(lengthM) {
  const lat0 = -45.02, lng0 = 168.72;
  const gLat = lat0 - lengthM / M_PER_DEG_LAT;
  const d = 0.00004;
  return {
    courseId: "lens-course", courseName: "Lens Course", holes: {},
    objects: {
      t1: { id: "t1", type: "tee", holeNumber: 1, position: { lat: lat0, lng: lng0 } },
      g1: {
        id: "g1", type: "green", holeNumber: 1, position: { lat: gLat, lng: lng0 },
        greenShape: [{ lat: gLat + d, lng: lng0 }, { lat: gLat, lng: lng0 + d }, { lat: gLat - d, lng: lng0 }, { lat: gLat, lng: lng0 - d }]
      }
    },
    _tee: { lat: lat0, lng: lng0 }, _green: { lat: gLat, lng: lng0 }
  };
}

(async function run() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "functions", "lib", "gd-visual-plan-core.mjs")).href);
  const { planCourseCaptures, captureGrid } = mod;

  function frameOf(lengthM) {
    const pkg = course(lengthM);
    const plan = planCourseCaptures(pkg, { source: SOURCE, maxOutputPx: 2048 });
    const segments = plan.filter(i => i.role === "play-corridor" && Number(i.holeNumber) === 1);
    assert.ok(segments.length >= 1, lengthM + "m hole must plan a corridor");
    const last = segments[segments.length - 1];
    const g = captureGrid(last, { source: SOURCE });
    assert.ok(g, "the corridor must shoot");
    const mPerDegLng = M_PER_DEG_LAT * Math.cos(pkg._green.lat * Math.PI / 180);
    return {
      zoom: g.captureZoom,
      beyondGreenM: (pkg._green.lat - g.imageBounds.south) * M_PER_DEG_LAT,
      halfWidthM: (g.imageBounds.east - g.imageBounds.west) / 2 * mPerDegLng,
      segments: segments.length
    };
  }

  /* A 140m par 3: half its length is 70m, so the 180m floor is what reaches past the green. */
  const par3 = frameOf(140);
  assert.strictEqual(par3.zoom, 19, "a par 3 frames at z19");
  assert.ok(Math.abs(par3.beyondGreenM - 180) < 3, "a par 3 reaches 180m past its green, got " + par3.beyondGreenM.toFixed(1));

  /* A 400m par 4: half its length, 200m, is past the floor. Its width is the lens, not the
     bleed: 0.38 of the hole each side. */
  const par4 = frameOf(400);
  assert.ok(Math.abs(par4.beyondGreenM - 200) < 3, "a 400m hole reaches 200m past its green, got " + par4.beyondGreenM.toFixed(1));
  assert.ok(Math.abs(par4.halfWidthM - 0.38 * 400) < 4, "a 400m hole is 0.38 of its length to each side, got " + par4.halfWidthM.toFixed(1));
  assert.ok(par4.halfWidthM >= 0.375 * 400, "and never narrower than a 9:19.5 phone shows in the hole stage");

  /* The reach is the LAST segment's: a long hole split along its route still ends past the green. */
  const par5 = frameOf(560);
  assert.ok(par5.segments >= 2, "a 560m hole splits into segments, got " + par5.segments);
  assert.ok(Math.abs(par5.beyondGreenM - 280) < 3, "the last segment of a 560m hole reaches 280m past the green, got " + par5.beyondGreenM.toFixed(1));

  console.log("hole-view-lens: ok (par 3 +" + par3.beyondGreenM.toFixed(0) + "m, par 4 +" + par4.beyondGreenM.toFixed(0)
    + "m / half " + par4.halfWidthM.toFixed(0) + "m, par 5 +" + par5.beyondGreenM.toFixed(0) + "m)");
})().catch(e => { console.error(e); process.exit(1); });
