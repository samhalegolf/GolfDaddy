/* scripts/gd-watch-terrain-core.js: the ground cut into pieces a watch fills in. These
   checks cover the mow lines - fairway stripes that follow the hole's play line - and the
   flat hole (no heights) that still gets them. */
const assert = require("assert");
const terrain = require("../scripts/gd-watch-terrain-core.js");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  PASS  " + name); }

/* A 200 x 400 px frame at 0.5 m/px, one fairway: a 60 px wide band up the middle that bends
   right at the top, and the play line down its centre. */
const SR = { imageWidth: 200, imageHeight: 400, metresPerPixel: 0.5 };
const fairway = [70, 390, 130, 390, 130, 150, 170, 60, 110, 40, 70, 150];
const mowLine = [{ x: 100, y: 390 }, { x: 100, y: 150 }, { x: 140, y: 50 }];
const outlines = { f: [fairway], b: [], w: [], k: [], h: [], z: [], g: null };
const flatSample = () => 100;   // perfectly flat ground
const toLatLng = (px) => ({ lat: px.y / 1e5, lng: px.x / 1e5 });

test("a flat hole with no play line has nothing to cut", () => {
  assert.strictEqual(terrain.buildHoleTerrain(SR, null, toLatLng, outlines, {}), null);
  assert.strictEqual(terrain.buildHoleTerrain(SR, null, toLatLng, outlines, { mowLine: [{ x: 1, y: 1 }] }), null, "one point is not a line");
});

test("mow lines are fairway-lit pieces, every other stripe, the width asked for", () => {
  const t = terrain.buildHoleTerrain(SR, null, toLatLng, outlines, { mowLine, stripeM: 5 });
  assert.ok(t && t.version === 1 && t.p.length === 3, "six 5 m stripes across a 30 m fairway, three of them lit");
  t.p.forEach((piece) => {
    assert.ok(piece[0] === 5 || piece[0] === 4, "fairway lit, or a hole in one (fairway mid)");
    assert.ok((piece.length - 1) / 2 <= terrain.DEFAULTS.maxPoints, "under the fillPolygon limit");
    assert.ok(piece.slice(1).every(Number.isInteger), "whole image pixels");
  });
  /* On the straight lower half the stripes are vertical bands 10 px (5 m) wide: at y = 300
     the lit ones cover x in [100,110), [80,90), [120,130), ... and nothing else. */
  const litAt = (x) => t.p.some((piece) => piece[0] === 5 && inside(piece.slice(1), x, 300));
  assert.ok(litAt(105) && litAt(85) && litAt(125), "even stripes from the centre line are lit");
  assert.ok(!litAt(95) && !litAt(115) && !litAt(75), "odd stripes keep the fairway's own colour");
  assert.ok(!litAt(50) && !litAt(150), "nothing outside the fairway");
});

test("the stripes bend with the play line", () => {
  const t = terrain.buildHoleTerrain(SR, null, toLatLng, outlines, { mowLine, stripeM: 5 });
  /* Up the dogleg the centre stripe is still the one just right of the line: the line
     passes (128, 80), and (131, 81) is 3 px to its right. */
  const on = t.p.filter((piece) => piece[0] === 5 && inside(piece.slice(1), 131, 81));
  assert.ok(on.length === 1, "the centre stripe follows the line round the bend");
  /* ...and that same piece reaches the straight part: one continuous bent stripe. */
  assert.ok(inside(on[0].slice(1), 103, 300), "the same piece runs the length of the fairway");
});

test("with heights, the rough is shaded and the fairway striped, never both", () => {
  const bumpy = (lat, lng) => 3 * Math.sin(lng * 1e5 / 15) * Math.cos(lat * 1e5 / 15);   // 3 m humps and hollows
  const t = terrain.buildHoleTerrain(SR, bumpy, toLatLng, outlines, { mowLine, stripeM: 5 });
  const labels = new Set(t.p.map((p) => p[0]));
  assert.ok(labels.has(0) || labels.has(2), "the rough has light or shadow pieces");
  assert.ok(labels.has(5), "the fairway has mow lines");
  assert.ok(!labels.has(3), "no fairway shadow: stripes replace the relief on the fairway");
  const without = terrain.buildHoleTerrain(SR, bumpy, toLatLng, outlines, {});
  assert.ok(new Set(without.p.map((p) => p[0])).has(3) || new Set(without.p.map((p) => p[0])).has(5), "without a play line the fairway is shaded by the relief as before");
});

test("signed distance: negative on the left of the line, continuous round a bend", () => {
  const line = [{ x: 0, y: 100 }, { x: 0, y: 0 }, { x: 100, y: 0 }];   // up, then right: a right turn
  assert.ok(terrain.signedDistanceToPolyline(-10, 50, line) < 0 && terrain.signedDistanceToPolyline(10, 50, line) > 0);
  const outer = terrain.signedDistanceToPolyline(-7, -7, line);   // outside the corner
  assert.ok(Math.abs(Math.abs(outer) - Math.hypot(7, 7)) < 1e-9, "distance to the corner itself");
  assert.ok(outer < 0 && terrain.signedDistanceToPolyline(-10, 50, line) < 0 && terrain.signedDistanceToPolyline(50, -10, line) < 0, "the outside of the turn is one side all the way round");
});

function inside(flat, x, y) {
  let hit = false;
  for (let i = 0, j = flat.length - 2; i < flat.length; j = i, i += 2) {
    const xi = flat[i], yi = flat[i + 1], xj = flat[j], yj = flat[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

console.log("\n" + passed + " watch terrain core checks passed.");
