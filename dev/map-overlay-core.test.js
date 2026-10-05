/* Mapping overlay, locked.
 *
 * The case this exists for: a course whose OSM data is greens and nothing else (Royal Belfast
 * - 11 greens, 0 fairways, 0 hole lines, 0 tees). The resolver has nothing to build a
 * centre-line from and the run fails at "no numbered hole geometry". A hand-drawn overlay of
 * fairway polygons, merged into the payload as golf=fairway ways, is what turns that into a
 * resolved course - so the assertions here go all the way through the real resolver rather
 * than stopping at "the merge produced elements".
 *
 * Run: node dev/map-overlay-core.test.js
 */
const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let overlay = null;
let core = null;
let resolver = null;

/* A course-sized patch of ground: metres east/north of a centre, so the fixtures read as
   distances rather than as raw degrees. */
const CENTRE = { lat: 54.66015, lng: -5.78477 };
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos(CENTRE.lat * Math.PI / 180);
function at(eastM, northM) {
  return { lat: CENTRE.lat + northM / M_PER_DEG_LAT, lng: CENTRE.lng + eastM / M_PER_DEG_LNG };
}
function ring(points) { return points.map(p => ({ lat: p.lat, lon: p.lng })); }
function greenWay(id, eastM, northM, radiusM) {
  const pts = [];
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2;
    pts.push(at(eastM + radiusM * Math.cos(a), northM + radiusM * Math.sin(a)));
  }
  pts.push(pts[0]);
  return { type: "way", id, tags: { golf: "green" }, geometry: ring(pts) };
}
/* A rectangle of fairway from (x0,y) to (x1,y), 40m wide, ending short of the green. */
function fairwayFeature(id, x0, x1, y, hole) {
  return { id, kind: "fairway", hole: hole || null, points: [at(x0, y - 20), at(x1, y - 20), at(x1, y + 20), at(x0, y + 20)] };
}

/* Greens only, as Royal Belfast's OSM data is. Two holes' worth: a long one and a short one. */
const GREENS_ONLY = {
  elements: [
    greenWay(11, 420, 0, 12),
    greenWay(12, 0, 300, 10)
  ]
};

test("normalisation keeps only features that mean something on the ground", () => {
  const out = overlay.normalizeOverlayFeatures([
    { id: "ok", kind: "fairway", hole: "7", points: [at(0, 0), at(100, 0), at(100, 40), at(0, 40), at(0, 0)] },
    { id: "two-points", kind: "fairway", points: [at(0, 0), at(100, 0)] },
    { id: "line", kind: "hole", hole: 99, points: [at(0, 0), at(300, 0)] },
    { id: "what", kind: "lava", points: [at(0, 0), at(10, 0), at(10, 10)] },
    { id: "ok", kind: "hole", points: [[54.66, -5.78], [54.661, -5.78]] },
    null, "junk"
  ]);
  assert.deepStrictEqual(out.map(f => f.id), ["ok", "line", "ok-5"], "ids: kept the good ones, made the duplicate unique");
  assert.strictEqual(out[0].points.length, 4, "a closing point that repeats the first is dropped");
  assert.strictEqual(out[0].hole, 7, "hole number accepted as a string");
  assert.strictEqual(out[1].hole, null, "hole 99 is not a hole number");
  assert.deepStrictEqual(out[2].points[0], { lat: 54.66, lng: -5.78 }, "[lat, lng] pairs are accepted");
});

test("the overlay becomes OSM-shaped ways the parsers already understand", () => {
  const elements = overlay.overlayToOsmElements([
    fairwayFeature("f1", 0, 380, 0, 4),
    { id: "h2", kind: "hole", hole: 2, points: [at(0, 0), at(0, 280)] }
  ]);
  assert.strictEqual(elements.length, 2);
  assert.strictEqual(elements[0].type, "way");
  assert.ok(elements[0].id < 0 && elements[1].id < 0 && elements[0].id !== elements[1].id, "negative, distinct ids that cannot collide with Overpass");
  assert.strictEqual(elements[0].tags.golf, "fairway");
  assert.strictEqual(elements[0].tags.ref, "4");
  assert.strictEqual(elements[0].tags[overlay.OVERLAY_TAG], "f1");
  assert.strictEqual(elements[0].geometry.length, 5, "a fairway ring is closed the way OSM closes areas");
  assert.deepStrictEqual(elements[0].geometry[0], elements[0].geometry[4]);
  assert.ok("lon" in elements[0].geometry[0] && !("lng" in elements[0].geometry[0]), "geometry uses Overpass's lat/lon");
  assert.strictEqual(elements[1].tags.golf, "hole");
  assert.strictEqual(elements[1].tags.ref, "2");
  assert.strictEqual(elements[1].geometry.length, 2, "a hole line is not closed");
  assert.ok(overlay.isOverlayElement(elements[0]) && !overlay.isOverlayElement(GREENS_ONLY.elements[0]));
});

test("merging adds to the payload and never replaces it", () => {
  const merged = overlay.mergeOverlayIntoPayload(GREENS_ONLY, [fairwayFeature("f1", 0, 380, 0)]);
  assert.strictEqual(merged.elements.length, 3);
  assert.strictEqual(merged.elements[0].id, 11, "real OSM elements come first and untouched");
  assert.notStrictEqual(merged, GREENS_ONLY, "the input payload is not mutated");
  assert.strictEqual(GREENS_ONLY.elements.length, 2);
  /* Merging the same overlay twice (a job merges into every payload it fetches, and a
     requery can be merged into an already-merged one) adds nothing the second time. */
  const twice = overlay.mergeOverlayIntoPayload(merged, [fairwayFeature("f1", 0, 380, 0)]);
  assert.strictEqual(twice.elements.length, 3);
  assert.strictEqual(overlay.mergeOverlayIntoPayload(GREENS_ONLY, []), GREENS_ONLY, "an empty overlay returns the very same payload");
  assert.strictEqual(overlay.mergeOverlayIntoPayload(GREENS_ONLY, null), GREENS_ONLY);
  assert.deepStrictEqual(overlay.overlaySummary([fairwayFeature("a", 0, 100, 0, 3), fairwayFeature("b", 0, 100, 60), { kind: "hole", hole: 1, points: [at(0, 0), at(1, 100)] }]),
    { features: 3, fairways: 2, holeLines: 1, greens: 0, tees: 0, bunkers: 0, water: 0, trees: 0, singleTrees: 0, hazards: 0, waste: 0, pins: 0, numbered: 2 });
  const tee = overlay.overlayToOsmElements([{ kind: "tee", points: [at(0, 0), at(8, 0), at(8, 6), at(0, 6)] }]);
  assert.strictEqual(tee[0].tags.golf, "tee", "a tee polygon becomes a golf=tee way");
  assert.strictEqual(tee[0].geometry.length, 5, "closed like every polygon kind");
});

test("the automapper's surface pass sees an overlay fairway as a fairway_area", () => {
  const merged = overlay.mergeOverlayIntoPayload(GREENS_ONLY, [fairwayFeature("f1", 0, 380, 0)]);
  const surfaces = core.parseOsmSurfaces(merged);
  assert.strictEqual(surfaces.length, 1);
  assert.strictEqual(surfaces[0].type, "fairway_area");
  assert.ok(surfaces[0].osmId.startsWith("way/-"), "the surface remembers it came from an overlay id: " + surfaces[0].osmId);
});

test("greens alone cannot resolve; greens plus overlay fairways resolve and number from the scorecard", async () => {
  const scorecard = { courseId: "greens-only", expectedHoleCount: 2, scorecardHoles: [{ holeNumber: 1, distanceM: 400 }, { holeNumber: 2, distanceM: 290 }] };

  /* Before: exactly Royal Belfast's failure. */
  assert.strictEqual(resolver.hasNumberingIssue({ osmPayload: GREENS_ONLY }), true, "greens with no numbering is the resolver's case");
  const before = await resolver.resolveCourseGeometryForAutoMapper(Object.assign({ osmPayload: GREENS_ONLY }, scorecard));
  assert.strictEqual(before.holes.length, 0, "with nothing to build a centre-line from, no hole resolves");
  assert.ok(before.warnings.some(w => /centre-line|candidate/i.test(w)), "and it says why: " + JSON.stringify(before.warnings));

  /* After: two fairway polygons drawn towards the two greens. */
  const merged = overlay.mergeOverlayIntoPayload(GREENS_ONLY, [
    fairwayFeature("long", 20, 390, 0),
    { id: "short", kind: "fairway", points: [at(-20, 20), at(20, 20), at(20, 270), at(-20, 270)] }
  ]);
  const after = await resolver.resolveCourseGeometryForAutoMapper(Object.assign({ osmPayload: merged }, scorecard));
  assert.ok(["resolved", "partially-resolved"].includes(after.status), "status was " + after.status + " " + JSON.stringify(after.warnings));
  assert.strictEqual(after.holes.length, 2, "both holes resolve");
  const byHole = {};
  after.holes.forEach(h => { byHole[h.holeNumber] = h; });
  assert.ok(byHole[1] && byHole[2]);
  assert.ok(byHole[1].candidate.pathDistanceM > byHole[2].candidate.pathDistanceM, "the longer card hole took the longer fairway");
  assert.ok(byHole[1].candidate.evidence.some(e => /^fairway:way[\/-]-\d+/.test(e)), "the evidence names the overlay way: " + JSON.stringify(byHole[1].candidate.evidence));

  /* And what the resolver hands back feeds the same object pipeline as any OSM course. */
  const guides = after.holes.map(h => resolver.guideFromResolvedHole(h, after)).filter(Boolean);
  assert.strictEqual(guides.length, 2, "both assignments clear the confidence gate");
  const built = core.resolveGuidesIntoObjects(guides, "greens-only", core.parseOsmGuideBundle(merged).greens, [], merged);
  assert.strictEqual(Object.keys(built.holes).sort().join(","), "1,2");
  const objects = Object.values(built.objects);
  assert.ok(objects.some(o => o.type === "green" && o.holeNumber === 1) && objects.some(o => o.type === "green" && o.holeNumber === 2));
  assert.ok(objects.some(o => o.type === "fairway_area"), "the overlay fairways also land as fairway_area surfaces for visuals and the bubble");
});

test("a hole whose green OSM lacks resolves from an overlay green plus an overlay fairway", async () => {
  /* Only one of the two greens is in OSM. The other is drawn. */
  const oneGreen = { elements: [GREENS_ONLY.elements[0]] };
  const drawnGreen = { id: "g2", kind: "green", points: [at(-12, 290), at(12, 290), at(12, 312), at(-12, 312)] };
  const merged = overlay.mergeOverlayIntoPayload(oneGreen, [
    fairwayFeature("long", 20, 390, 0),
    { id: "short", kind: "fairway", points: [at(-20, 20), at(20, 20), at(20, 270), at(-20, 270)] },
    drawnGreen
  ]);
  const greenWays = merged.elements.filter(e => e.tags && e.tags.golf === "green");
  assert.strictEqual(greenWays.length, 2, "the drawn green is a golf=green way like the OSM one");
  assert.strictEqual(greenWays[1].geometry.length, 5, "and its ring is closed");
  const result = await resolver.resolveCourseGeometryForAutoMapper({ osmPayload: merged, courseId: "one-green", expectedHoleCount: 2, scorecardHoles: [{ holeNumber: 1, distanceM: 400 }, { holeNumber: 2, distanceM: 290 }] });
  assert.strictEqual(result.holes.length, 2, JSON.stringify(result.warnings));
  const hole2 = result.holes.filter(h => h.holeNumber === 2)[0];
  assert.ok(hole2 && hole2.candidate.evidence.some(e => /^green:way[\/-]-\d+/.test(e)),
    "hole 2 hangs off the drawn green: " + JSON.stringify(hole2 && hole2.candidate.evidence));
  const bundle = core.parseOsmGuideBundle(merged);
  assert.strictEqual(bundle.greens.length, 2, "the automapper's green parser also sees the drawn green");
});

test("a numbered overlay hole line is the resolver's strongest evidence", async () => {
  const merged = overlay.mergeOverlayIntoPayload(GREENS_ONLY, [
    { id: "h1", kind: "hole", hole: 1, points: [at(0, 0), at(410, 0)] },
    { id: "h2", kind: "hole", hole: 2, points: [at(0, 0), at(0, 290)] }
  ]);
  const result = await resolver.resolveCourseGeometryForAutoMapper({ osmPayload: merged, courseId: "lines", expectedHoleCount: 2, scorecardHoles: [{ holeNumber: 1, distanceM: 400 }, { holeNumber: 2, distanceM: 290 }] });
  assert.strictEqual(result.holes.length, 2, JSON.stringify(result.warnings));
  const byHole = {};
  result.holes.forEach(h => { byHole[h.holeNumber] = h; });
  assert.ok(byHole[1].candidate.evidence.some(e => e === "existing-ref:1"), "the drawn number is carried as an existing ref: " + JSON.stringify(byHole[1].candidate.evidence));
});

test("a drawn bunker reaches the mapper as a golf=bunker way and lands as a bunker object", () => {
  const merged = overlay.mergeOverlayIntoPayload(GREENS_ONLY, [
    { id: "h1", kind: "hole", hole: 1, points: [at(0, 0), at(410, 0)] },
    { id: "h2", kind: "hole", hole: 2, points: [at(0, 0), at(0, 290)] },
    { id: "b1", kind: "bunker", hole: 1, points: [at(380, 14), at(392, 14), at(392, 24), at(380, 24)] }
  ]);
  const way = merged.elements.filter(e => e.tags && e.tags.golf === "bunker")[0];
  assert.ok(way, "no golf=bunker way in the merged payload");
  assert.strictEqual(way.tags.ref, "1", "a numbered bunker carries its hole as ref");
  assert.strictEqual(way.geometry.length, 5, "and its ring is closed");
  assert.strictEqual(overlay.overlaySummary([{ id: "b1", kind: "bunker", points: [at(0, 0), at(10, 0), at(10, 10)] }]).bunkers, 1);
  const geometry = core.resolveCourseGeometry(merged, "bunkers", at(0, 0), [], []);
  const bunkers = Object.values(geometry.objects || {}).filter(o => o && o.type === "bunker");
  assert.strictEqual(bunkers.length, 1, "the surface pass writes the drawn bunker as a bunker object: " + JSON.stringify(Object.values(geometry.objects || {}).map(o => o.type)));
});

test("a drawn water hazard reaches the mapper as a golf=water_hazard way and lands as a water object", () => {
  const merged = overlay.mergeOverlayIntoPayload(GREENS_ONLY, [
    { id: "h1", kind: "hole", hole: 1, points: [at(0, 0), at(410, 0)] },
    { id: "h2", kind: "hole", hole: 2, points: [at(0, 0), at(0, 290)] },
    { id: "w1", kind: "water", hole: 1, points: [at(200, 20), at(240, 20), at(240, 45), at(200, 45)] }
  ]);
  const way = merged.elements.filter(e => e.tags && e.tags.golf === "water_hazard")[0];
  assert.ok(way, "no golf=water_hazard way in the merged payload");
  assert.strictEqual(way.tags.ref, "1");
  assert.strictEqual(way.geometry.length, 5, "and its ring is closed");
  assert.strictEqual(overlay.overlaySummary([{ id: "w1", kind: "water", points: [at(0, 0), at(10, 0), at(10, 10)] }]).water, 1);
  const pin = overlay.overlayToOsmElements([{ id: "wp", kind: "water", pin: true, points: [at(0, 0)] }])[0];
  assert.ok(pin && pin.tags.golf === "water_hazard" && pin.geometry.length === 17, "a water pin stands for a round pond");
  const geometry = core.resolveCourseGeometry(merged, "water", at(0, 0), [], []);
  const water = Object.values(geometry.objects || {}).filter(o => o && o.type === "water");
  assert.strictEqual(water.length, 1, "the surface pass writes the drawn water as a water object: " + JSON.stringify(Object.values(geometry.objects || {}).map(o => o.type)));
});

test("pins keep only their points, and a hole line has no pin form", () => {
  const out = overlay.normalizeOverlayFeatures([
    { id: "g", kind: "green", pin: true, points: [at(0, 0), at(5, 5)] },
    { id: "f", kind: "fairway", pin: true, points: [at(0, 0), at(0, 200)] },
    { id: "short", kind: "fairway", pin: true, points: [at(0, 0)] },
    { id: "h", kind: "hole", pin: true, points: [at(0, 0)] },
    { id: "b", kind: "bunker", pin: "yes", points: [at(0, 0)] }
  ]);
  assert.deepStrictEqual(out.map(f => f.id), ["g", "f"], "a one-point fairway, a hole 'pin' and a non-boolean pin flag are refused");
  assert.strictEqual(out[0].points.length, 1, "a green pin is its centre");
  assert.strictEqual(out[0].pin, true);
  assert.strictEqual(out[1].points.length, 2, "a fairway pin is its start and end");
  assert.strictEqual(overlay.overlaySummary(out).pins, 2);
});

test("a course placed as pins alone resolves: pinned greens and fairway start/end pins", async () => {
  const pinned = overlay.mergeOverlayIntoPayload({ elements: [] }, [
    { id: "g1", kind: "green", pin: true, points: [at(420, 0)] },
    { id: "g2", kind: "green", pin: true, points: [at(0, 300)] },
    { id: "f1", kind: "fairway", pin: true, points: [at(20, 0), at(390, 0)] },
    { id: "f2", kind: "fairway", pin: true, points: [at(0, 20), at(0, 270)] },
    { id: "t1", kind: "tee", pin: true, points: [at(-10, 0)] }
  ]);
  const greens = pinned.elements.filter(e => e.tags.golf === "green");
  assert.strictEqual(greens.length, 2, "each green pin is a golf=green way");
  assert.strictEqual(greens[0].geometry.length, 17, "a round green, closed");
  const result = await resolver.resolveCourseGeometryForAutoMapper({ osmPayload: pinned, courseId: "pins", expectedHoleCount: 2, scorecardHoles: [{ holeNumber: 1, distanceM: 400 }, { holeNumber: 2, distanceM: 290 }] });
  assert.strictEqual(result.holes.length, 2, JSON.stringify(result.warnings));
  const byHole = {};
  result.holes.forEach(h => { byHole[h.holeNumber] = h; });
  assert.ok(byHole[1].candidate.pathDistanceM > byHole[2].candidate.pathDistanceM, "the longer card hole took the longer fairway pin");
});

test("trees and hazard: overlay shapes reach the surface pass as their own kinds", () => {
  const square = (dx) => [at(dx, 0), at(dx + 40, 0), at(dx + 40, 40), at(dx, 40)];
  const elements = overlay.overlayToOsmElements([
    { kind: "trees", points: square(0) },
    { kind: "hazard", points: square(100) }
  ]);
  assert.strictEqual(elements[0].tags.natural, "wood");
  assert.strictEqual(elements[1].tags.golf, "hazard");
  const surfaces = core.parseOsmSurfaces({ elements });
  assert.deepStrictEqual(surfaces.map(s => s.type).sort(), ["hazard", "trees"]);
  /* A real OSM wood is never read: its course-shaped inner ring would be dropped. */
  const real = core.parseOsmSurfaces({ elements: [{ type: "way", id: 5, tags: { natural: "wood" }, geometry: elements[0].geometry }] });
  assert.strictEqual(real.length, 0);
});

test("single trees and waste areas are kept and tagged; waste is a surface, a single tree not yet", () => {
  const square = (dx) => [at(dx, 0), at(dx + 8, 0), at(dx + 8, 8), at(dx, 8)];
  const features = [{ kind: "tree", points: square(0) }, { kind: "waste", points: square(50) }];
  assert.deepStrictEqual(overlay.normalizeOverlayFeatures(features).map(f => f.kind), ["tree", "waste"]);
  const elements = overlay.overlayToOsmElements(features);
  assert.strictEqual(elements[0].tags.natural, "tree");
  assert.strictEqual(elements[1].tags.golf, "waste_area");
  assert.deepStrictEqual(core.parseOsmSurfaces({ elements }).map(s => s.type), ["waste"], "waste reaches the surface pass; single trees wait for tree rendering");
  /* golf=waste_area is our own tag: only the overlay's is read. */
  const real = core.parseOsmSurfaces({ elements: [{ type: "way", id: 7, tags: { golf: "waste_area" }, geometry: elements[1].geometry }] });
  assert.strictEqual(real.length, 0);
  const summary = overlay.overlaySummary(features);
  assert.strictEqual(summary.singleTrees, 1);
  assert.strictEqual(summary.waste, 1);
});

(async () => {
  overlay = await import(path.join(root, "functions", "lib", "gd-map-overlay-core.mjs"));
  core = await import(path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  resolver = await import(path.join(root, "functions", "lib", "gd-geometry-resolver-core.mjs"));
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.stack || error)); }
  }
  console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " map overlay checks");
  process.exit(failed ? 1 : 0);
})();
