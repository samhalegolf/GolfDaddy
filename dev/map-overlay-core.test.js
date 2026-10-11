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
    { features: 3, fairways: 2, holeLines: 1, greens: 0, tees: 0, bunkers: 0, water: 0, trees: 0, singleTrees: 0, hazards: 0, waste: 0, pins: 0, numbered: 2, linked: 0 });
  const tee = overlay.overlayToOsmElements([{ kind: "tee", points: [at(0, 0), at(8, 0), at(8, 6), at(0, 6)] }]);
  assert.strictEqual(tee[0].tags.golf, "tee", "a tee polygon becomes a golf=tee way");
  assert.strictEqual(tee[0].geometry.length, 5, "closed like every polygon kind");
});

test("a link groups shapes as one hole without numbering them", () => {
  /* Linking says "same hole", never which. An unlinked or unnumbered group stays unnumbered
     for the scorecard; a group with one typed number shares it; two numbers share neither. */
  const ways = overlay.overlayToOsmElements([
    fairwayFeature("a", 0, 100, 0), Object.assign(fairwayFeature("b", 0, 100, 60), { link: "l-1" }),
    Object.assign(fairwayFeature("c", 0, 100, 120, 4), { link: "l-2" }), Object.assign(fairwayFeature("d", 0, 100, 180), { link: "l-2" }),
    Object.assign(fairwayFeature("e", 0, 100, 240, 5), { link: "l-3" }), Object.assign(fairwayFeature("f", 0, 100, 300, 6), { link: "l-3" }),
    Object.assign(fairwayFeature("g", 0, 100, 360), { link: "l-3" })
  ]);
  const ref = id => ways.find(w => w.tags["clarity:overlay"] === id).tags.ref;
  assert.strictEqual(ref("a"), undefined, "no link, no number");
  assert.strictEqual(ref("b"), undefined, "a link alone never invents a number");
  assert.strictEqual(ref("d"), "4", "one typed number in a link is shared");
  assert.strictEqual(ref("g"), undefined, "two numbers in one link - neither is guessed onto the rest");
  assert.strictEqual(ref("e"), "5", "a typed number is never overwritten");
  const kept = overlay.normalizeOverlayFeatures([Object.assign(fairwayFeature("x", 0, 100, 0), { link: "l-9 <b>" })]);
  assert.strictEqual(kept[0].link, "l-9b", "the link survives a save, cleaned");
  assert.strictEqual(overlay.overlaySummary(kept).linked, 1);
});

test("the resolver keeps an unnumbered link together, against what distance alone would pair", async () => {
  /* The fairway's green end sits 8m from green "near", which distance pairs it with. A person
     linked it - and a tee 260m back, past where a tee is normally looked for - to green "far". */
  const { resolverHoleCandidates } = await import(path.join(root, "functions", "lib", "gd-geometry-resolver-core.mjs"));
  const square = (x, y, r) => [at(x - r, y - r), at(x + r, y - r), at(x + r, y + r), at(x - r, y + r)];
  const shapes = link => [
    { id: "near", kind: "green", points: square(0, 0, 12) },
    Object.assign({ id: "far", kind: "green", points: square(60, 262, 12) }, link ? { link: "l-a" } : {}),
    Object.assign({ id: "fw", kind: "fairway", points: [at(-20, 20), at(20, 20), at(20, 230), at(-20, 230)] }, link ? { link: "l-a" } : {}),
    Object.assign({ id: "t", kind: "tee", points: square(0, -230, 4) }, link ? { link: "l-a" } : {})
  ];
  const owner = (result, fairwayId) => result.primary.find(c => c.evidence.some(e => e.indexOf("fairway:") === 0 && e.indexOf(fairwayId) >= 0));
  const wayId = (features, id) => String(overlay.overlayToOsmElements(features).find(w => w.tags["clarity:overlay"] === id).id);

  const plain = shapes(false);
  const unlinked = resolverHoleCandidates({ osmPayload: overlay.mergeOverlayIntoPayload({ elements: [] }, plain) });
  const nearGreen = owner(unlinked, wayId(plain, "fw"));
  assert.ok(nearGreen && nearGreen.greenId.indexOf(wayId(plain, "near")) >= 0, "without a link, distance gives the fairway to the near green");

  const linked = shapes(true);
  const ways = overlay.overlayToOsmElements(linked);
  assert.strictEqual(ways.find(w => w.tags["clarity:overlay"] === "fw").tags["clarity:link"], "l-a", "the link reaches the payload");
  const result = resolverHoleCandidates({ osmPayload: overlay.mergeOverlayIntoPayload({ elements: [] }, linked) });
  const hole = owner(result, wayId(linked, "fw"));
  assert.ok(hole && hole.greenId.indexOf(wayId(linked, "far")) >= 0, "the link gives the fairway to its own green: " + JSON.stringify(hole && hole.evidence));
  assert.ok(hole.evidence.indexOf("linked:l-a") >= 0, "and says so");
  assert.ok(hole.evidence.some(e => e === "tee:way-" + wayId(linked, "t")), "the linked tee starts the hole even past the usual tee search: " + JSON.stringify(hole.evidence));
  assert.ok(!result.all.some(c => c.greenId.indexOf(wayId(linked, "near")) >= 0 && c.evidence.some(e => e.indexOf("fairway:way-" + wayId(linked, "fw")) === 0)),
    "no reading, not even an alternative, gives a linked fairway to another green");
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

test("numbered tees and greens give the automapper's first pass its numbered hole lines", () => {
  /* Royal Belfast's case: every hole outlined and numbered, no hole line drawn. The numbers
     here run against the lengths (hole 1 is the short one) so a length-ranked guess would
     swap them - the first pass has to take the typed numbers as they are. */
  const sq = (x, y, r) => [at(x - r, y - r), at(x + r, y - r), at(x + r, y + r), at(x - r, y + r)];
  const features = [
    { id: "g1", kind: "green", hole: 1, points: sq(0, 300, 10) },
    { id: "t1", kind: "tee", link: "l-1", points: sq(0, 150, 4) },
    { id: "g1-link", kind: "fairway", hole: 1, link: "l-1", points: sq(0, 230, 15) },
    { id: "g2", kind: "green", hole: 2, points: sq(420, 0, 12) },
    { id: "t2-front", kind: "tee", hole: 2, points: sq(60, 0, 4) },
    { id: "t2-back", kind: "tee", hole: 2, points: sq(10, 0, 4) }
  ];
  const merged = overlay.mergeOverlayIntoPayload({ elements: [] }, features);
  const lines = merged.elements.filter(e => e.tags[overlay.DERIVED_TAG]);
  assert.deepStrictEqual(lines.map(l => l.tags.ref), ["1", "2"], "one line per numbered hole, the link's number included");
  assert.strictEqual(lines[0].tags.golf, "hole");
  assert.strictEqual(lines[0].geometry.length, 3, "tee, through the fairway, to the green");
  assert.ok(Math.abs(lines[1].geometry[0].lon - at(10, 0).lng) < 1e-6, "the back tee starts the line");
  assert.strictEqual(overlay.overlaySummary(features).holeLines, 0, "a derived line is not counted as one a person drew");

  const geometry = core.resolveCourseGeometry(merged, "numbered", at(200, 100), [], []);
  assert.strictEqual(geometry.holesResolved, 2, "the first pass resolves both holes without the resolver");
  const greens = Object.values(geometry.objects).filter(o => o.type === "green");
  const green1 = greens.find(o => o.holeNumber === 1);
  assert.ok(green1 && Math.abs(green1.position.lat - at(0, 300).lat) < 1e-4, "hole 1 is the green typed 1: " + JSON.stringify(green1 && green1.position));
});

test("no derived line where it would guess or overrule", () => {
  const sq = (x, y, r) => [at(x - r, y - r), at(x + r, y - r), at(x + r, y + r), at(x - r, y + r)];
  const derived = payload => payload.elements.filter(e => e.tags && e.tags[overlay.DERIVED_TAG]).map(e => e.tags.ref);
  const twoGreens = [
    { kind: "green", hole: 3, points: sq(0, 300, 10) }, { kind: "green", hole: 3, points: sq(200, 300, 10) },
    { kind: "tee", hole: 3, points: sq(0, 0, 4) }
  ];
  assert.deepStrictEqual(derived(overlay.mergeOverlayIntoPayload({ elements: [] }, twoGreens)), [], "two greens on one number is not picked between");
  const drawn = [
    { kind: "green", hole: 4, points: sq(0, 300, 10) }, { kind: "tee", hole: 4, points: sq(0, 0, 4) },
    { kind: "hole", hole: 4, points: [at(0, 0), at(0, 300)] }
  ];
  assert.deepStrictEqual(derived(overlay.mergeOverlayIntoPayload({ elements: [] }, drawn)), [], "a hole line a person drew is kept as the only one");
  const noTee = [{ kind: "green", hole: 5, points: sq(0, 300, 10) }];
  assert.deepStrictEqual(derived(overlay.mergeOverlayIntoPayload({ elements: [] }, noTee)), [], "a green alone has no line");
  const osm = { elements: [{ type: "way", id: 77, tags: { golf: "hole", ref: "6" }, geometry: ring([at(0, 0), at(0, 310)]) }] };
  const both = [
    { kind: "green", hole: 6, points: sq(0, 300, 10) }, { kind: "tee", hole: 6, points: sq(0, 0, 4) },
    { kind: "green", hole: 7, points: sq(300, 300, 10) }, { kind: "tee", hole: 7, points: sq(300, 0, 4) }
  ];
  assert.deepStrictEqual(derived(overlay.mergeOverlayIntoPayload(osm, both)), ["7"], "OSM's own numbered line wins for its hole");
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
  /* A real OSM wood is read too - unless it holds the course (a green inside it), which is a
     wood drawn round the course with the course cut out. */
  const real = core.parseOsmSurfaces({ elements: [{ type: "way", id: 5, tags: { natural: "wood" }, geometry: elements[0].geometry }] });
  assert.deepStrictEqual(real.map(s => s.type), ["trees"]);
  const green = { type: "way", id: 6, tags: { golf: "green" }, geometry: [at(18, 18), at(22, 18), at(22, 22), at(18, 22), at(18, 18)].map(p => ({ lat: p.lat, lon: p.lng })) };
  assert.strictEqual(core.parseOsmSurfaces({ elements: [{ type: "way", id: 5, tags: { natural: "wood" }, geometry: elements[0].geometry }, green] }).length, 0);
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

/* ---------- OSM -> overlay ---------- */

const osmRing = (east, north, r) => [at(east - r, north - r), at(east + r, north - r), at(east + r, north + r), at(east - r, north + r), at(east - r, north - r)].map(p => ({ lat: p.lat, lon: p.lng }));

test("OSM's shapes come over as editable overlay shapes, each naming the element it replaces", () => {
  const payload = { elements: [
    { type: "way", id: 1, tags: { golf: "hole", ref: "1" }, geometry: [at(0, 0), at(300, 0)].map(p => ({ lat: p.lat, lon: p.lng })) },
    { type: "way", id: 2, tags: { golf: "green", ref: "1" }, geometry: osmRing(300, 0, 12) },
    { type: "way", id: 3, tags: { golf: "tee", ref: "1" }, geometry: osmRing(0, 0, 4) },
    { type: "relation", id: 4, tags: { golf: "fairway" }, members: [
      { role: "outer", geometry: osmRing(170, 0, 60).slice(0, 3) }, { role: "outer", geometry: osmRing(170, 0, 60).slice(2) }] },
    { type: "way", id: 5, tags: { golf: "bunker" }, geometry: osmRing(250, 20, 5) },
    { type: "way", id: 6, tags: { natural: "wood" }, geometry: osmRing(150, 120, 40) },
    { type: "way", id: 7, tags: { natural: "wood" }, geometry: osmRing(150, 0, 400) }
  ] };
  const features = overlay.osmToOverlayFeatures(payload, []);
  const byOsm = {};
  features.forEach(f => { byOsm[f.osm] = f; });
  assert.deepStrictEqual(Object.keys(byOsm).sort(), ["relation/4", "way/2", "way/3", "way/5", "way/6"], "hole lines stay in OSM; the wood round the course is left out");
  assert.strictEqual(byOsm["way/2"].kind, "green");
  assert.strictEqual(byOsm["way/2"].hole, 1);
  assert.strictEqual(byOsm["relation/4"].kind, "fairway");
  assert.strictEqual(byOsm["relation/4"].points.length, 4, "the split relation is one outline");
  assert.strictEqual(byOsm["way/6"].kind, "trees");
  assert.ok(features.every(f => f.source === "osm"));
  /* They survive the save. */
  assert.deepStrictEqual(overlay.normalizeOverlayFeatures(features).map(f => f.osm).sort(), Object.keys(byOsm).sort());
  /* Not offered twice: by id, or when someone has already drawn that green. */
  assert.strictEqual(overlay.osmToOverlayFeatures(payload, features).length, 0);
  const drawn = [{ id: "f-1", kind: "green", points: [at(285, -15), at(315, -15), at(315, 15), at(285, 15)] }];
  assert.ok(!overlay.osmToOverlayFeatures(payload, drawn).some(f => f.osm === "way/2"));
});

test("a converted shape replaces its OSM element in the mapper's payload", () => {
  const payload = { elements: [
    { type: "way", id: 5, tags: { golf: "bunker" }, geometry: osmRing(250, 20, 5) },
    { type: "way", id: 8, tags: { golf: "bunker" }, geometry: osmRing(100, 20, 5) }
  ] };
  const [bunker] = overlay.osmToOverlayFeatures(payload, []).filter(f => f.osm === "way/5");
  bunker.points = bunker.points.map(p => ({ lat: p.lat + 0.00002, lng: p.lng }));
  const merged = overlay.mergeOverlayIntoPayload(payload, [bunker]);
  const bunkers = merged.elements.filter(e => e.tags.golf === "bunker");
  assert.strictEqual(bunkers.length, 2, "the tweaked bunker stands in for the OSM one, not beside it");
  assert.ok(!merged.elements.some(e => e.id === 5));
  assert.ok(merged.elements.some(e => e.id === 8));
});

test("the mapper's default fairways come over numbered to their hole", () => {
  const shape = [at(100, -15), at(200, -15), at(200, 15), at(100, 15)];
  const saved = [
    { type: "fairway_area", source: core.FAIRWAY_FILL_SOURCE, osmId: "fill/3", holeNumber: 3, shape },
    { type: "fairway_area", source: core.FAIRWAY_FILL_SOURCE, osmId: "fill/3", holeNumber: 4, shape },
    { type: "fairway_area", source: "osm_auto_surface", osmId: "way/9", holeNumber: 3, shape }
  ];
  const features = overlay.osmToOverlayFeatures({ elements: [] }, [], saved);
  assert.deepStrictEqual(features.map(f => [f.kind, f.hole, f.source]), [["fairway", 3, "auto"]], "one per fill, from the hole it was laid for");
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
