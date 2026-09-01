#!/usr/bin/env node
"use strict";

const assert = require("assert");
const path = require("path");

const core = require(path.join(__dirname, "..", "scripts", "gd-watch-map-core.js"));

function longHole() {
  return {
    tee: { lat: -45.010, lng: 169.100 },
    green: { lat: -45.013, lng: 169.104 },
    greenShape: [
      { lat: -45.0129, lng: 169.1039 }, { lat: -45.0131, lng: 169.1041 },
      { lat: -45.0130, lng: 169.1042 }, { lat: -45.0128, lng: 169.1040 }
    ],
    fairways: [[
      { lat: -45.0105, lng: 169.1005 }, { lat: -45.0125, lng: 169.1030 },
      { lat: -45.0120, lng: 169.1035 }, { lat: -45.0100, lng: 169.1010 }
    ]],
    bunkers: [[
      { lat: -45.0122, lng: 169.1032 }, { lat: -45.0123, lng: 169.1033 }, { lat: -45.0121, lng: 169.1034 }
    ]],
    water: []
  };
}

// --- worldPx / latLngFromWorldPx round-trip -------------------------------------------------

(function testMercatorRoundTrip() {
  const zoom = 20;
  const original = { lat: -45.0123, lng: 169.1041 };
  const px = core.worldPx(original.lat, original.lng, zoom);
  const back = core.latLngFromWorldPx(px, zoom);
  assert.ok(Math.abs(back.lat - original.lat) < 1e-9, "lat should round-trip through worldPx/latLngFromWorldPx");
  assert.ok(Math.abs(back.lng - original.lng) < 1e-9, "lng should round-trip through worldPx/latLngFromWorldPx");
  assert.throws(() => core.worldPx(0, 0, 19.5), /integer/, "worldPx must reject a fractional zoom");
})();

// --- transform round-trip (forward then inverse must return the same point) ----------------

(function testTransformRoundTrip() {
  const t = core.anchoredTransform({ x: 1000, y: 2000 }, { x: 50, y: 60 }, 0.7, 2.3);
  const world = { x: 1234.5, y: 4321.6 };
  const image = core.applyTransform(t, world);
  const back = core.invertTransform(t, image);
  assert.ok(Math.abs(back.x - world.x) < 1e-6, "invertTransform should undo applyTransform (x)");
  assert.ok(Math.abs(back.y - world.y) < 1e-6, "invertTransform should undo applyTransform (y)");
})();

// --- objectsForHole grouping -----------------------------------------------------------------

(function testObjectsForHole() {
  const objectsJson = {
    a: { type: "tee", holeNumber: 1, position: { lat: 1, lng: 1 } },
    b: { type: "green", holeNumber: 1, position: { lat: 2, lng: 2 }, greenShape: [{ lat: 2, lng: 2 }, { lat: 2.001, lng: 2 }, { lat: 2, lng: 2.001 }] },
    c: { type: "bunker", holeNumber: 1, shape: [{ lat: 1.5, lng: 1.5 }, { lat: 1.6, lng: 1.5 }, { lat: 1.5, lng: 1.6 }] },
    d: { type: "tee", holeNumber: 2, position: { lat: 9, lng: 9 } },
    e: { type: "bunker", holeNumber: 1, shape: [{ lat: 1, lng: 1 }] } // degenerate, < 3 points, dropped
  };
  const hole1 = core.objectsForHole(objectsJson, 1);
  assert.deepStrictEqual(hole1.tee, { lat: 1, lng: 1 });
  assert.deepStrictEqual(hole1.green, { lat: 2, lng: 2 });
  assert.ok(hole1.greenShape && hole1.greenShape.length === 3);
  assert.strictEqual(hole1.bunkers.length, 1, "degenerate < 3 point shapes must be dropped");
  assert.strictEqual(hole1.fairways.length, 0);
  assert.strictEqual(hole1.water.length, 0);
  const hole2 = core.objectsForHole(objectsJson, 2);
  assert.strictEqual(hole2.green, null, "a hole with no green object must report green:null, not throw");
})();

// --- buildWatchHoleFrame: full geometry ------------------------------------------------------

(function testFullFrame() {
  const frame = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, longHole());
  assert.strictEqual(frame.ok, true);
  assert.ok(frame.width > 0 && frame.width <= core.WATCH_MAP_RECIPE_V1.canvas.targetWidthPx, "width must respect the recipe's width ceiling");
  assert.ok(frame.height > 0 && frame.height <= core.WATCH_MAP_RECIPE_V1.canvas.maxHeightPx, "height must respect the recipe's height ceiling");
  assert.strictEqual(frame.validation.ok, true, "a normal tee->green hole must pass its own spatial validation: " + JSON.stringify(frame.validation.issues));
  assert.strictEqual(frame.layers.fairwaysMapped, 1);
  assert.strictEqual(frame.layers.fairways, 1, "the fairway polygon should survive simplification");
  assert.strictEqual(frame.layers.bunkersMapped, 1);
  assert.ok(frame.svg.indexOf("<svg") === 0, "buildHoleSvg must return a well-formed SVG document");
  assert.ok(frame.svg.indexOf(core.WATCH_MAP_RECIPE_V1.colors.fairway) > -1, "fairway colour must appear in the SVG");
  assert.ok(frame.svg.indexOf(core.WATCH_MAP_RECIPE_V1.colors.green) > -1, "green colour must appear in the SVG");
  assert.ok(frame.svg.indexOf(core.WATCH_MAP_RECIPE_V1.colors.bunker) > -1, "bunker colour must appear in the SVG");
  // The whole point of the framing: green sits above tee in image space (smaller y = higher on
  // the canvas), whatever the hole's real compass bearing.
  const teePx = core.projectLatLngToImage(frame.spatialReference, longHole().tee.lat, longHole().tee.lng);
  const greenPx = core.projectLatLngToImage(frame.spatialReference, longHole().green.lat, longHole().green.lng);
  assert.ok(teePx.y > greenPx.y, "tee must render below green (GREEN up / TEE down framing)");
})();

// --- graceful degradation: missing optional layers must not fail generation ----------------

(function testMissingWaterAndBunkers() {
  const geometry = {
    tee: { lat: -45.010, lng: 169.100 },
    green: { lat: -45.011, lng: 169.101 },
    greenShape: null,
    fairways: [],
    bunkers: [],
    water: []
    // no rough/OOB fields at all - the object type this codebase does not collect
  };
  const frame = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, geometry);
  assert.strictEqual(frame.ok, true, "a hole with only tee+green must still generate a valid Watch map");
  assert.strictEqual(frame.layers.fairways, 0);
  assert.strictEqual(frame.layers.bunkers, 0);
  assert.strictEqual(frame.layers.water, 0);
  assert.strictEqual(frame.validation.ok, true);
})();

// --- a hole with no green at all must be refused, not silently faked -----------------------

(function testNoGreenRefused() {
  const frame = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, { tee: { lat: 0, lng: 0 } });
  assert.strictEqual(frame.ok, false);
  assert.ok(/green/i.test(frame.reason));
})();

// --- a hole with no tee (rare, but real: tee is "useful but not sacred" per the mapper docs) -

(function testMissingTeeFallsBackToGreen() {
  const frame = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, { green: { lat: -45.013, lng: 169.104 } });
  assert.strictEqual(frame.ok, true, "a green with no tee must still produce a Watch map, framed on the green alone");
  assert.strictEqual(frame.layers.tee, false);
})();

// --- validation catches an obviously broken transform (regression guard for the axis) ------

(function testValidationCatchesFlippedAxis() {
  const frame = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, longHole());
  const broken = Object.assign({}, frame.spatialReference, {
    transform: Object.assign({}, frame.spatialReference.transform, { b: -frame.spatialReference.transform.b, a: -frame.spatialReference.transform.a })
  });
  const result = core.validateSpatialReference(broken, frame.checkpoints);
  assert.strictEqual(result.ok, false, "flipping the rotation sign must be caught by validation");
})();

// --- simplification: a hole with hundreds of near-duplicate points must still bake small ---

(function testSimplificationShrinksDenseShapes() {
  const dense = [];
  for (let i = 0; i < 400; i++) {
    const a = (i / 400) * Math.PI * 2;
    dense.push({ lat: -45.0121 + Math.sin(a) * 0.00006, lng: 169.1032 + Math.cos(a) * 0.00006 });
  }
  const geometry = Object.assign({}, longHole(), { bunkers: [dense] });
  const frame = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, geometry);
  assert.strictEqual(frame.ok, true);
  const bunkerPointCount = (frame.svg.match(/fill="#e9d9a8"/g) || []).length;
  assert.strictEqual(bunkerPointCount, 1, "the dense bunker must still render as exactly one polygon");
  assert.ok(frame.svg.length < 4000, "simplification should keep a 400-point bunker from bloating the SVG");
})();

// --- an insignificant sliver must be dropped, not drawn as noise ---------------------------

(function testTinyPolygonDropped() {
  const geometry = Object.assign({}, longHole(), {
    bunkers: [[
      { lat: -45.01220, lng: 169.10320 },
      { lat: -45.012201, lng: 169.10320 },
      { lat: -45.012200, lng: 169.103201 }
    ]]
  });
  const frame = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, geometry);
  assert.strictEqual(frame.ok, true);
  assert.strictEqual(frame.layers.bunkers, 0, "a sub-pixel bunker sliver must be dropped as noise, not drawn");
  assert.strictEqual(frame.layers.bunkersMapped, 1, "but it must still be counted as mapped-but-omitted, for the generation report");
})();


// --- the play corridor: framing follows the hole, drawing does not -------------------------

/* A neighbouring hole's fairway, 150m off the play line, is exactly the case that
   made Millbrook's 1st unreadable: six corridors framed together at 1.45 m/px. */
function neighbouringRibbon() {
  return [
    { lat: -45.0100, lng: 169.1025 }, { lat: -45.0135, lng: 169.1060 },
    { lat: -45.0137, lng: 169.1064 }, { lat: -45.0102, lng: 169.1029 }
  ];
}

(function testCorridorFramesOnTheHoleNotTheNeighbourhood() {
  const own = longHole();
  const withNeighbour = Object.assign({}, own, { fairways: own.fairways.concat([neighbouringRibbon()]) });
  const alone = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, own);
  const crowded = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, withNeighbour);
  assert.strictEqual(alone.ok, true);
  assert.strictEqual(crowded.ok, true);
  assert.strictEqual(
    crowded.spatialReference.metresPerPixel.toFixed(6),
    alone.spatialReference.metresPerPixel.toFixed(6),
    "a fairway outside the corridor must not change the frame's ground resolution"
  );
  assert.strictEqual(crowded.width, alone.width, "nor the canvas width");
  assert.strictEqual(crowded.height, alone.height, "nor the canvas height");
})();

(function testOutOfCorridorGeometryIsStillDrawnWhenItReachesTheCanvas() {
  const own = longHole();
  /* Runs the length of the hole a short way off the line: outside nothing, and
     plainly visible to the player, so it must be drawn. */
  const adjacent = [
    { lat: -45.0102, lng: 169.1006 }, { lat: -45.0126, lng: 169.1031 },
    { lat: -45.0127, lng: 169.1029 }, { lat: -45.0103, lng: 169.1004 }
  ];
  const frame = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1,
    Object.assign({}, own, { fairways: own.fairways.concat([adjacent]) }));
  assert.strictEqual(frame.layers.fairwaysMapped, 2, "both fairways are mapped onto the hole");
  assert.strictEqual(frame.layers.fairways, 2, "and both are drawn - the corridor frames, it does not filter");
})();

(function testFullyOffCanvasGeometryIsCulled() {
  const own = longHole();
  const frame = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1,
    Object.assign({}, own, { fairways: own.fairways.concat([neighbouringRibbon()]) }));
  assert.strictEqual(frame.layers.fairwaysMapped, 2);
  assert.strictEqual(frame.layers.fairways, 1, "a ribbon entirely off the canvas is bytes nobody can see");
  assert.ok(frame.svg.indexOf("#6fbf5e") > 0, "the hole's own fairway is still drawn");
})();

(function testRouteBendsOrderTheCorridorByGeometryNotKeyOrder() {
  /* The same three bends in two different key orders must give one identical
     bake - the corridor is measured along the hole, not along insertion order. */
  const base = {
    "green-x": { type: "green", holeNumber: 4, position: { lat: -45.013, lng: 169.104 },
      greenShape: [{ lat: -45.0129, lng: 169.1039 }, { lat: -45.0131, lng: 169.1041 }, { lat: -45.0130, lng: 169.1042 }] },
    "tee-x": { type: "tee", holeNumber: 4, position: { lat: -45.010, lng: 169.100 } }
  };
  const bends = {
    a: { type: "fairway", holeNumber: 4, position: { lat: -45.0110, lng: 169.1013 } },
    b: { type: "fairway", holeNumber: 4, position: { lat: -45.0119, lng: 169.1025 } },
    c: { type: "fairway", holeNumber: 4, position: { lat: -45.0126, lng: 169.1034 } }
  };
  const forwards = Object.assign({}, base, { "f-1": bends.a, "f-2": bends.b, "f-3": bends.c });
  const shuffled = Object.assign({}, base, { "f-1": bends.c, "f-2": bends.a, "f-3": bends.b });
  const a = core.objectsForHole(forwards, 4);
  const b = core.objectsForHole(shuffled, 4);
  assert.strictEqual(a.route.length, 3, "route bend points come off type \"fairway\", not \"fairway_area\"");
  const frameA = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, a);
  const frameB = core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, b);
  assert.strictEqual(frameA.svg, frameB.svg, "key order must not change the bake");
  assert.strictEqual(frameA.layers.routePoints, 5, "tee + three bends + green");
})();

(function testFairwayAreaIsNotMistakenForARouteBend() {
  const objects = {
    "green-y": { type: "green", holeNumber: 7, position: { lat: -45.013, lng: 169.104 } },
    "tee-y": { type: "tee", holeNumber: 7, position: { lat: -45.010, lng: 169.100 } },
    "fw-y": { type: "fairway_area", holeNumber: 7, shape: [
      { lat: -45.0105, lng: 169.1005 }, { lat: -45.0125, lng: 169.1030 }, { lat: -45.0120, lng: 169.1035 }] }
  };
  const geometry = core.objectsForHole(objects, 7);
  assert.strictEqual(geometry.route.length, 0, "a fairway_area polygon is a surface, never a route point");
  assert.strictEqual(geometry.fairways.length, 1);
  assert.strictEqual(core.buildWatchHoleFrame(core.WATCH_MAP_RECIPE_V1, geometry).layers.routePoints, 2,
    "with no bends the route is simply tee -> green");
})();

console.log("watch-map-core passed");
