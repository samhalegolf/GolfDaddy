/* Pixel -> lat/lng for AI-read shapes, locked.
 *
 * The conversion is where an AI's answer about a picture becomes a claim about the ground,
 * and a metre of error here is a fairway linked to the wrong green. So the three ways of
 * saying where an image is are checked against each other and against the projection the
 * visual pipeline captures frames with (projectPoint / unprojectPoint), then a full run: pixel
 * shapes off a synthetic satellite frame, through the overlay, through the real resolver.
 *
 * Run: node dev/overlay-georef-core.test.js
 */
const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let georef = null;
let plan = null;
let overlay = null;
let resolver = null;

const CENTRE = { lat: 54.66015, lng: -5.78477 };
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos(CENTRE.lat * Math.PI / 180);
function at(eastM, northM) { return { lat: CENTRE.lat + northM / M_PER_DEG_LAT, lng: CENTRE.lng + eastM / M_PER_DEG_LNG }; }
function metres(a, b) {
  const dLat = (b.lat - a.lat) * M_PER_DEG_LAT, dLng = (b.lng - a.lng) * M_PER_DEG_LNG;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}
function close(a, b, tolM, what) { assert.ok(metres(a, b) < tolM, what + ": " + metres(a, b).toFixed(2) + "m apart"); }

/* A 1024x768 capture centred on the course at z17, as a live map would report it. */
const CAPTURE = { centre: CENTRE, zoom: 17, width: 1024, height: 768 };

test("centre+zoom reproduces the visual pipeline's own projection exactly", () => {
  const g = georef.imageGeoreference(CAPTURE);
  assert.ok(!g.error, g.error);
  assert.strictEqual(g.mode, "centre");
  close(g.toLatLng({ x: 512, y: 384 }), CENTRE, 0.01, "the middle pixel is the centre");
  /* The same thing plan-core would compute for a frame whose originPx is centre - half size. */
  const c = plan.projectPoint(CENTRE.lat, CENTRE.lng, 17);
  const expected = plan.unprojectPoint(c.x - 512 + 100, c.y - 384 + 50, 17);
  close(g.toLatLng({ x: 100, y: 50 }), expected, 0.001, "an off-centre pixel matches projectPoint/unprojectPoint");
  const back = g.toPx(expected);
  assert.ok(Math.abs(back.x - 100) < 1e-6 && Math.abs(back.y - 50) < 1e-6, "toPx inverts toLatLng");
  assert.ok(g.metresPerPixel > 0.6 && g.metresPerPixel < 0.8, "z17 at 54.66N is ~0.69m/px, got " + g.metresPerPixel);
});

test("a playSurface georef is the frame's own metadata, and bounds interpolate in mercator", () => {
  const c = plan.projectPoint(CENTRE.lat, CENTRE.lng, 17);
  const ps = { playSurface: { originPx: { x: c.x - 512, y: c.y - 384 }, captureZoom: 17, outputDimensions: { width: 1024, height: 768 } } };
  const fromPs = georef.imageGeoreference(ps);
  assert.strictEqual(fromPs.mode, "playSurface");
  const fromCentre = georef.imageGeoreference(CAPTURE);
  const nw = fromPs.toLatLng({ x: 0, y: 0 }), se = fromPs.toLatLng({ x: 1024, y: 768 });
  const fromBounds = georef.imageGeoreference({ bounds: { north: nw.lat, south: se.lat, west: nw.lng, east: se.lng }, width: 1024, height: 768 });
  assert.strictEqual(fromBounds.mode, "bounds");
  [{ x: 0, y: 0 }, { x: 1024, y: 768 }, { x: 512, y: 384 }, { x: 37, y: 700 }, { x: 990, y: 12 }].forEach(px => {
    close(fromPs.toLatLng(px), fromCentre.toLatLng(px), 0.001, "playSurface vs centre at " + JSON.stringify(px));
    /* Bounds are interpolated in mercator, so the vertical middle lands where the frame's
       middle actually is - a linear-in-degrees interpolation would miss by metres here. */
    close(fromPs.toLatLng(px), fromBounds.toLatLng(px), 0.01, "playSurface vs bounds at " + JSON.stringify(px));
  });
  /* A retina capture: the same view at scale 2 is twice the pixels for the same ground. */
  const retina = georef.imageGeoreference({ centre: CENTRE, zoom: 17, scale: 2, width: 2048, height: 1536 });
  close(retina.toLatLng({ x: 200, y: 100 }), fromCentre.toLatLng({ x: 100, y: 50 }), 0.001, "scale folds into zoom");
});

test("a georef that cannot place the image says which field is missing", () => {
  assert.ok(/width and height/.test(georef.imageGeoreference({ centre: CENTRE, zoom: 17 }).error));
  assert.ok(/zoom/.test(georef.imageGeoreference({ centre: CENTRE, width: 10, height: 10 }).error));
  assert.ok(/north > south/.test(georef.imageGeoreference({ bounds: { north: 1, south: 2, east: 2, west: 1 }, width: 10, height: 10 }).error));
  assert.ok(georef.imageGeoreference({ width: 10, height: 10 }).error);
  assert.ok(georef.imageGeoreference(null).error);
  assert.strictEqual(georef.aiShapesToOverlay({ features: [] }, null).error, "georef required");
});

test("the AI's answer converts, whatever it called things, and every drop is explained", () => {
  const g = georef.imageGeoreference(CAPTURE);
  const answer = {
    features: [
      { type: "fairways", polygon: [[100, 100], [400, 100], [400, 160], [100, 160]] },
      { kind: "green", hole: 7, points: [{ x: 430, y: 120 }, { x: 460, y: 110 }, { x: 470, y: 140 }, { x: 440, y: 150 }] },
      { label: "centerline", line: [[100, 400], [600, 400]] },
      { kind: "water", points: [[1, 1], [2, 2], [3, 3]] },
      { kind: "fairway", points: [[10, 10], [20, 10]] },
      { kind: "green", points: [[5000, 5000], [5100, 5000], [5100, 5100], [5000, 5100]] },
      "junk"
    ]
  };
  const out = georef.aiShapesToOverlay(answer, g);
  assert.ok(!out.error, out.error);
  assert.deepStrictEqual(out.features.map(f => f.kind), ["fairway", "green", "hole"]);
  assert.ok(out.features.every(f => f.source === "ai"), "AI shapes are stamped source:ai");
  assert.strictEqual(out.features[1].hole, 7);
  assert.strictEqual(out.features[0].points.length, 4, "a rectangle stays four corners");
  close(out.features[0].points[0], g.toLatLng({ x: 100, y: 100 }), 0.001, "the first corner is where the pixel is");
  assert.deepStrictEqual(out.dropped.map(d => d.reason), [
    "unknown kind: water", "too few points", "4 of 4 points outside the image", "not an object"
  ]);
  assert.strictEqual(out.pixels.length, 3, "kept shapes come back with their pixels for drawing over the image");
  /* Tees and bunkers convert too: the first live tee answers were all dropped as unknown. */
  const more = georef.aiShapesToOverlay({ features: [
    { kind: "tee", points: [[100, 100], [130, 100], [130, 120], [100, 120]] },
    { kind: "bunker", points: [[200, 200], [220, 200], [220, 215], [200, 215]] }
  ] }, g);
  assert.deepStrictEqual(more.features.map(f => f.kind), ["tee", "bunker"], JSON.stringify(more.dropped));
  assert.strictEqual(out.georef.width, 1024);
  assert.ok(out.georef.bounds.north > out.georef.bounds.south);

  /* Fractions of the image mean the same shape. */
  const frac = georef.aiShapesToOverlay({ units: "fraction", features: [{ kind: "fairway", points: [[0.1, 0.5], [0.6, 0.5], [0.6, 0.6], [0.1, 0.6]] }] }, g);
  close(frac.features[0].points[0], g.toLatLng({ x: 102.4, y: 384 }), 0.001, "fraction units scale to pixels");
  const pct = georef.aiShapesToOverlay({ features: [{ kind: "fairway", points: [[10, 50], [60, 50], [60, 60], [10, 60]] }] }, g, { units: "percent" });
  close(pct.features[0].points[0], frac.features[0].points[0], 0.001, "percent and fraction agree");
  assert.ok(georef.aiShapesToOverlay({ features: [] }, g, { units: "furlongs" }).error);
});

test("a vertex a pixel off the edge is kept, and a partially-outside shape is marked", () => {
  const g = georef.imageGeoreference(CAPTURE);
  const out = georef.aiShapesToOverlay({ features: [{ kind: "fairway", points: [[-3, 100], [400, 100], [400, 160], [-3, 160], [-900, 130]] }] }, g);
  assert.strictEqual(out.features.length, 1);
  assert.strictEqual(out.features[0].points.length, 4, "the far-outside vertex is dropped, the edge ones kept");
  assert.strictEqual(out.pixels[0].partial, true);
});

test("pixel shapes off a satellite frame resolve holes through the real resolver", async () => {
  /* Two greens 400m and 290m from a shared tee, as pixels on a z16 capture (a z17 one is
     only ~700m across here and the long hole would run off it). */
  const g = georef.imageGeoreference(Object.assign({}, CAPTURE, { zoom: 16 }));
  const px = p => g.toPx(p);
  const rect = (a, b, halfM) => {
    /* A corridor from ground point a to ground point b, halfM wide, as pixel corners. */
    const dx = b.lng - a.lng, dy = b.lat - a.lat;
    const len = Math.sqrt((dx * M_PER_DEG_LNG) ** 2 + (dy * M_PER_DEG_LAT) ** 2);
    const nx = -dy * M_PER_DEG_LAT / len * halfM / M_PER_DEG_LNG, ny = dx * M_PER_DEG_LNG / len * halfM / M_PER_DEG_LAT;
    return [px({ lat: a.lat + ny, lng: a.lng + nx }), px({ lat: b.lat + ny, lng: b.lng + nx }), px({ lat: b.lat - ny, lng: b.lng - nx }), px({ lat: a.lat - ny, lng: a.lng - nx })];
  };
  const blob = (c, rM) => [0, 1, 2, 3, 4, 5].map(i => px({ lat: c.lat + rM * Math.sin(i / 6 * Math.PI * 2) / M_PER_DEG_LAT, lng: c.lng + rM * Math.cos(i / 6 * Math.PI * 2) / M_PER_DEG_LNG }));
  const answer = {
    features: [
      { kind: "fairway", points: rect(at(20, 0), at(390, 0), 20) },
      { kind: "green", points: blob(at(420, 0), 12) },
      { kind: "fairway", points: rect(at(0, 20), at(0, 270), 20) },
      { kind: "green", points: blob(at(0, 300), 10) }
    ]
  };
  const out = georef.aiShapesToOverlay(answer, g);
  assert.strictEqual(out.features.length, 4, JSON.stringify(out.dropped));
  close(out.features[1].points[0], at(432, 0), 1.5, "the green's first vertex lands within a pixel of where it was placed");

  const merged = overlay.mergeOverlayIntoPayload({ elements: [] }, out.features);
  const result = await resolver.resolveCourseGeometryForAutoMapper({
    osmPayload: merged, courseId: "ai-frame", expectedHoleCount: 2,
    scorecardHoles: [{ holeNumber: 1, distanceM: 400 }, { holeNumber: 2, distanceM: 290 }]
  });
  assert.strictEqual(result.holes.length, 2, result.status + " " + JSON.stringify(result.warnings));
  const byHole = {};
  result.holes.forEach(h => { byHole[h.holeNumber] = h; });
  assert.ok(byHole[1].candidate.pathDistanceM > byHole[2].candidate.pathDistanceM, "the longer card hole took the longer corridor");

  /* And back onto the image, for a reviewer. */
  const back = georef.overlayToPixels(out.features, g);
  assert.strictEqual(back.length, 4);
  assert.ok(Math.abs(back[1].pixels[0].x - answer.features[1].points[0].x) < 0.01, "round trip to the pixel");
});

(async () => {
  georef = await import(path.join(root, "functions", "lib", "gd-overlay-georef-core.mjs"));
  plan = await import(path.join(root, "functions", "lib", "gd-visual-plan-core.mjs"));
  overlay = await import(path.join(root, "functions", "lib", "gd-map-overlay-core.mjs"));
  resolver = await import(path.join(root, "functions", "lib", "gd-geometry-resolver-core.mjs"));
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.stack || error)); }
  }
  console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " overlay georef checks");
  process.exit(failed ? 1 : 0);
})();
