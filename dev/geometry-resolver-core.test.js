/* functions/lib/gd-geometry-resolver-core.mjs: direct unit tests against the ported Native
 * Geometry Resolver, using a saved fixture (dev/fixtures/geometry-resolver-two-hole-course.json)
 * with green+fairway shapes but NO OSM hole numbers - exactly the case this resolver exists
 * for. Hermetic: no network, no Overpass, no DOM. */

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "geometry-resolver-two-hole-course.json"), "utf8"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let resolver = null;
let automapperCore = null;

test("hasNumberingIssue is true for shapes with no hole refs", () => {
  assert.strictEqual(resolver.hasNumberingIssue({ osmPayload: fixture }), true);
});

test("a card read back from the store, whose sources rows carry a hole COUNT, still reaches the resolver", () => {
  /* course_scorecards.sources_json rows are provenance summaries: { source, sourceUrl,
     holes: 18 }. Treating that count as a hole list produced no entries and, because
     the sources array was non-empty, skipped the evidence's own hole list too - every
     stored card re-read by the mapper became "Scorecard unavailable". Dorado Beach
     East could not number its one un-ref'd OSM hole with an 18-hole card in hand. */
  const t = resolver.__geometryResolverCoreTest;
  const holes = [{ hole: 1, par: 5, metres: 527.6 }, { hole: 2, par: 3, metres: 220.4 }, { hole: 3, par: 4, metres: 358.4 }];
  const fromStore = { holes, source: "golfpass", sourceUrl: "https://example.test/card", sources: [{ source: "golfpass", sourceUrl: "https://example.test/card", holes: 18 }] };
  const normalized = t.normalizeScorecard({ scorecardHoles: holes, scorecardEvidence: fromStore });
  assert.strictEqual(normalized.length, 3, "the evidence hole list is used when the sources rows yield none");
  assert.deepStrictEqual(normalized.map(h => h.holeNumber), [1, 2, 3]);
  assert.strictEqual(Math.round(normalized[0].distanceM), 528, "store rows spell distance as metres");
  /* A sources row that really carries holes still wins, as it always did. */
  const withList = { holes: holes.slice(0, 1), sources: [{ source: "golfpass", sourceUrl: "u", holes }] };
  assert.strictEqual(t.normalizeScorecard({ scorecardEvidence: withList }).length, 3);
});

test("with no tees mapped, a par 3 is read from the green before it, and lengths rank against one reading per green", async () => {
  /* Cebu Country Club: greens and fairways, not one tee. Its par 3s have no fairway, so they
     only had a borrowed neighbour's fairway to be read from, and every alternative reading was
     ranked alongside the real holes - a line of the right length could rank worse than a
     wrong one. Here: a 345m par 4, a par 3 ~165m past its green with no fairway, a 400m par 4. */
  const box = (id, tag, south, north, west, east) => ({ type: "way", id, tags: { golf: tag }, geometry: [
    { lat: south, lon: west }, { lat: south, lon: east }, { lat: north, lon: east }, { lat: north, lon: west }, { lat: south, lon: west }
  ] });
  const payload = { elements: [
    box(1, "fairway", 0, 0.0028, -0.00015, 0.00015), box(2, "green", 0.0030, 0.0032, -0.0001, 0.0001),
    box(3, "green", 0.0045, 0.0047, -0.0001, 0.0001),
    box(4, "fairway", 0.0052, 0.0085, -0.00015, 0.00015), box(5, "green", 0.0087, 0.0089, -0.0001, 0.0001)
  ] };
  const result = await resolver.resolveCourseGeometryForAutoMapper({
    osmPayload: payload, courseId: "no-tees", expectedHoleCount: 3,
    scorecardHoles: [{ holeNumber: 1, par: 4, distanceM: 345 }, { holeNumber: 2, par: 3, distanceM: 140 }, { holeNumber: 3, par: 4, distanceM: 400 }]
  });
  const par3 = result.debugEvidence.holeCandidates.find(c => c.candidateId === "tee-after-way-2-way-3");
  assert.ok(par3 && !par3.alternative, "the fairway-less green is read from a guessed tee off the previous green");
  assert.ok(!result.debugEvidence.holeCandidates.some(c => c.evidence.includes("borrowed-fairway")), "it no longer borrows a fairway");
  assert.strictEqual(result.status, "resolved");
  const byHole = {};
  result.holes.forEach(h => { byHole[h.holeNumber] = h.candidate.candidateId; });
  assert.deepStrictEqual(byHole, { 1: "way-1-way-2", 2: "tee-after-way-2-way-3", 3: "way-4-way-5" });
});

test("a fairway OSM drew in pieces is read as one hole, end to end", async () => {
  /* Cebu's par 5s are mapped as separate fairway polygons. Pairing gave each green only the
     piece beside it, so a 486m par 5 was measured as a ~115m line. A piece that starts close
     behind the far end and carries on the same way is the same hole. */
  const box = (id, tag, south, north, west, east) => ({ type: "way", id, tags: { golf: tag }, geometry: [
    { lat: south, lon: west }, { lat: south, lon: east }, { lat: north, lon: east }, { lat: north, lon: west }, { lat: south, lon: west }
  ] });
  const payload = { elements: [
    box(1, "fairway", 0, 0.00205, -0.00015, 0.00015), box(2, "fairway", 0.0025, 0.0040, -0.00015, 0.00015),
    box(3, "green", 0.0042, 0.0044, -0.0001, 0.0001),
    box(4, "fairway", 0.0060, 0.0088, -0.00015, 0.00015), box(5, "green", 0.0090, 0.0092, -0.0001, 0.0001)
  ] };
  const result = await resolver.resolveCourseGeometryForAutoMapper({
    osmPayload: payload, courseId: "pieces", expectedHoleCount: 2,
    scorecardHoles: [{ holeNumber: 1, par: 5, distanceM: 470 }, { holeNumber: 2, par: 4, distanceM: 330 }]
  });
  const byHole = {};
  result.holes.forEach(h => { byHole[h.holeNumber] = h.candidate; });
  assert.strictEqual(byHole[1].candidateId, "way-2+way-1-way-3", "the par 5 runs through both pieces");
  assert.ok(byHole[1].pathDistanceM > 440, "measured end to end, got " + Math.round(byHole[1].pathDistanceM) + "m");
  assert.strictEqual(byHole[2].candidateId, "way-4-way-5");

  /* A piece beside the far end that runs off sideways is another hole, not this one. */
  const sideways = JSON.parse(JSON.stringify(payload));
  sideways.elements[0] = box(1, "fairway", 0.0018, 0.0021, 0.0004, 0.0024);
  const apart = await resolver.resolveCourseGeometryForAutoMapper({ osmPayload: sideways, courseId: "pieces-sideways" });
  assert.ok(!apart.debugEvidence.holeCandidates.some(c => c.candidateId === "way-2+way-1-way-3"), "a sideways piece is not chained");
});

test("a course with tees mapped gets no guessed tees", async () => {
  const withTee = JSON.parse(JSON.stringify(fixture));
  withTee.elements.push({ type: "way", id: 900, tags: { golf: "tee" }, geometry: [
    { lat: -0.0003, lon: -0.00005 }, { lat: -0.0003, lon: 0.00005 }, { lat: -0.0002, lon: 0.00005 }, { lat: -0.0002, lon: -0.00005 }, { lat: -0.0003, lon: -0.00005 }
  ] });
  const result = await resolver.resolveCourseGeometryForAutoMapper({ osmPayload: withTee, courseId: "with-tee" });
  assert.ok(!result.debugEvidence.holeCandidates.some(c => c.guessedTee));
});

test("hasNumberingIssue is false when there is no golf geometry at all", () => {
  assert.strictEqual(resolver.hasNumberingIssue({ osmPayload: { elements: [] } }), false);
});

test("without scorecard evidence, geometry resolves but numbering is refused", async () => {
  const result = await resolver.resolveCourseGeometryForAutoMapper({ osmPayload: fixture, courseId: "test-course" });
  assert.strictEqual(result.status, "geometry-resolved-numbering-unavailable");
  assert.strictEqual(result.holes.length, 0);
  assert.ok(result.debugEvidence.greenCandidates.length >= 2, "greens are still detected even without a scorecard");
});

test("with scorecard distance evidence, both holes are numbered by relative length", async () => {
  const result = await resolver.resolveCourseGeometryForAutoMapper({
    osmPayload: fixture,
    courseId: "test-course",
    expectedHoleCount: 2,
    scorecardHoles: [
      { holeNumber: 1, distanceM: 400 },
      { holeNumber: 2, distanceM: 150 }
    ]
  });
  assert.ok(["resolved", "partially-resolved"].includes(result.status), "status was " + result.status);
  assert.strictEqual(result.holes.length, 2, "both holes should be assigned");
  const byHole = {};
  result.holes.forEach(h => { byHole[h.holeNumber] = h; });
  assert.ok(byHole[1] && byHole[2], "both hole 1 and hole 2 were assigned");
  assert.ok(byHole[1].candidate.pathDistanceM > byHole[2].candidate.pathDistanceM, "the longer scorecard hole (1) matched the longer candidate path");
  assert.ok(byHole[1].confidence > 0 && byHole[2].confidence > 0);
});

test("guideFromResolvedHole converts a confident assignment into a savable guide, and it feeds the automapper object pipeline", async () => {
  const result = await resolver.resolveCourseGeometryForAutoMapper({
    osmPayload: fixture,
    courseId: "test-course",
    expectedHoleCount: 2,
    scorecardHoles: [
      { holeNumber: 1, distanceM: 400 },
      { holeNumber: 2, distanceM: 150 }
    ]
  });
  const guides = result.holes.map(h => resolver.guideFromResolvedHole(h, result)).filter(Boolean);
  assert.ok(guides.length >= 1, "at least one confident guide should survive the mediumConfidence gate");
  guides.forEach(guide => {
    assert.ok(guide.hole === 1 || guide.hole === 2);
    assert.ok(Array.isArray(guide.points) && guide.points.length >= 2);
    assert.strictEqual(guide.source, "automapper-course-geometry-resolver");
  });
  const built = automapperCore.resolveGuidesIntoObjects(guides, "test-course", []);
  const objects = Object.values(built.objects);
  assert.ok(objects.some(o => o.type === "green"), "the guide pipeline produces a green object");
  assert.ok(objects.some(o => o.type === "tee"), "the guide pipeline produces a tee object");
  assert.ok(objects.every(o => o.courseId === "test-course"));
});

test("a resolver-sourced guide with low confidence is dropped, not saved", () => {
  const lowConfidenceAssignment = { holeNumber: 5, confidence: 0.1, matchScore: 0.1, evidence: [], candidate: { candidateId: "c1", path: [{ lat: 0, lng: 0 }, { lat: 0.001, lng: 0 }], greenId: "" } };
  const guide = resolver.guideFromResolvedHole(lowConfidenceAssignment, { status: "partially-resolved", holes: [lowConfidenceAssignment] });
  assert.strictEqual(guide, null, "confidence below the medium threshold must not produce a guide");
});

test("source-load failure is reported cleanly when the OSM payload has no supported geometry", async () => {
  const result = await resolver.resolveCourseGeometryForAutoMapper({ osmPayload: { elements: [] }, courseId: "empty-course" });
  assert.strictEqual(result.status, "source-load-failed");
  assert.ok(result.sourceLoadError && result.sourceLoadError.code);
});


/* Three holes as OSM hole lines with a green at each end, in metres east/north of an origin
   on the equator. A and C are both 150m par 3s, so the card alone cannot tell which is hole 1. */
function threeHoleLoop(greenTags = {}) {
  const deg = m => m / 111320;
  const pt = (x, y) => ({ lat: deg(y), lon: deg(x) });
  const line = (id, from, to) => ({ type: "way", id, tags: { golf: "hole" }, geometry: [pt(...from), pt(...to)] });
  const green = (id, x, y) => ({ type: "way", id, tags: Object.assign({ golf: "green" }, greenTags[id] || {}), geometry: [
    pt(x - 10, y - 10), pt(x + 10, y - 10), pt(x + 10, y + 10), pt(x - 10, y + 10), pt(x - 10, y - 10)
  ] });
  return { elements: [
    line(1, [0, 0], [0, 150]), green(11, 0, 150),          /* A: north from the origin */
    line(2, [130, -10], [130, 340]), green(12, 130, 340),  /* B: 350m, its tee 130m from C's green */
    line(3, [0, -160], [0, -10]), green(13, 0, -10)        /* C: ends 10m from A's tee */
  ] };
}
const threeHoleCard = [{ holeNumber: 1, par: 3, distanceM: 150 }, { holeNumber: 2, par: 4, distanceM: 350 }, { holeNumber: 3, par: 3, distanceM: 150 }];
async function resolveThreeHoles(payload, status = "resolved") {
  const result = await resolver.resolveCourseGeometryForAutoMapper({ osmPayload: payload, courseId: "loop", expectedHoleCount: 3, scorecardHoles: threeHoleCard });
  if (status) assert.strictEqual(result.status, status);
  const byHole = {};
  result.holes.forEach(h => { byHole[h.holeNumber] = h.candidate.greenId; });
  return { result, byHole };
}

test("the walk from the last green back to the first tee decides hole 1 when the lengths cannot", async () => {
  /* Walked C, B, A the holes sit closer together (C's green to B's tee 130m, B's green to A's
     tee 354m) than A, B, C (189m and 510m) - but C ends 10m from A's tee, so the round that
     starts at A comes back to where it began, and the one that starts at C ends 310m away.
     Parkes: a stray link was cheapest as hole 1 because its long walk was charged once. */
  const { result, byHole } = await resolveThreeHoles(threeHoleLoop());
  assert.deepStrictEqual(byHole, { 1: "way-11", 2: "way-12", 3: "way-13" });
  const best = result.debugEvidence.assignmentAlternatives[0];
  assert.ok(best.closure >= 0.1, "the closing walk is scored, and it is a short one: " + best.closure);
});

test("a hole number on a green is a hint the resolver obeys, whatever the card and the walks say", async () => {
  /* The same ground with C's green numbered 1 - as a numbered overlay link numbers its shapes.
     Hole 1 is C even though the loop reads better from A, and A, now unlabelled, cannot be
     hole 1 - it takes the number left over. */
  const { result, byHole } = await resolveThreeHoles(threeHoleLoop({ 13: { ref: "1" } }));
  assert.deepStrictEqual(byHole, { 1: "way-13", 2: "way-12", 3: "way-11" });
  const c = result.holes.find(h => h.holeNumber === 1);
  assert.strictEqual(c.candidate.existingHoleNumber, 1, "the number on the green reached the hole's reading");
  assert.ok(c.evidence.includes("existing-ref:1") && c.evidence.includes("existing-osm-ref-match"));
  /* A number that is on the green but fits the card badly is still kept, and kept confidently
     enough to be saved: the person said so. */
  const swapped = await resolveThreeHoles(threeHoleLoop({ 12: { ref: "1" } }), null);
  assert.strictEqual(swapped.byHole[1], "way-12", "the 350m hole is hole 1 because it is numbered 1");
  const labelled = swapped.result.holes.find(h => h.holeNumber === 1);
  assert.ok(labelled.confidence >= resolver.__geometryResolverCoreTest.MEDIUM_CONFIDENCE, "confidence " + labelled.confidence);
  assert.ok(resolver.guideFromResolvedHole(labelled, swapped.result), "it becomes a guide the mapper saves");
});

test("a number on two greens is no hint: the card numbers the course, as on a site numbered 1-9 twice", async () => {
  /* Two nines both numbered 1-9 under one 18-hole card reach the resolver so the card can
     number them; locked to the refs, holes 10-18 would have nothing to take. Here both par 3s
     say they are hole 1, so neither is believed and the loop decides as if unnumbered. */
  const { result, byHole } = await resolveThreeHoles(threeHoleLoop({ 11: { ref: "1" }, 13: { ref: "1" } }));
  assert.deepStrictEqual(byHole, { 1: "way-11", 2: "way-12", 3: "way-13" });
  assert.ok(!result.holes.some(h => h.evidence.includes("existing-osm-ref-match")), "no hole counts as numbered");
});

test("Parkes: one labelled link numbers the whole course around it", async () => {
  /* The real overlay (dev/fixtures/parkes-overlay.json): 18 links, no OSM, and a card pasted
     by hand. Unlabelled, the lengths put a stray 164m link at the far end of the course as hole
     1, 980m from hole 2. The person then numbered the link by the clubhouse as hole 1 and got
     17 holes: the resolver had weighed the label against the card and lost it, numbered that
     ground 9, and the worker threw hole 9 out for sitting on hole 1. With the label obeyed the
     resolver's hole 1 is that link, nothing else touches its ground, and all 18 are numbered. */
  const overlay = await import(path.join(root, "functions", "lib", "gd-map-overlay-core.mjs"));
  const parkes = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "parkes-overlay.json"), "utf8"));
  const LINK = "l-mveomg2u-cvhs";
  const features = parkes.features.map(f => f.link === LINK ? Object.assign({}, f, { hole: 1 }) : f);
  const elements = overlay.overlayToOsmElements(features);
  const result = await resolver.resolveCourseGeometryForAutoMapper({
    osmPayload: { elements }, courseId: "parkes", courseCentre: parkes.centre, expectedHoleCount: 18,
    scorecardHoles: parkes.scorecard, scorecardEvidence: { holes: parkes.scorecard, source: "manual-upload" }
  });
  assert.strictEqual(result.status, "resolved");
  assert.strictEqual(result.holes.length, 18);
  const linkIds = new Set(elements.filter(e => e.tags["clarity:link"] === LINK).map(e => "way-" + e.id));
  const hole1 = result.holes.find(h => h.holeNumber === 1);
  assert.ok(linkIds.has(hole1.candidate.greenId), "hole 1 is the labelled link's green");
  assert.ok(Math.abs(hole1.candidate.pathDistanceM - 189) < 5, "read from the link's back tee: " + Math.round(hole1.candidate.pathDistanceM) + "m");
  result.holes.filter(h => h.holeNumber !== 1).forEach(h => {
    const keys = (h.candidate.featureKeys || []).concat([h.candidate.greenId]);
    assert.ok(!keys.some(key => linkIds.has(key)), "hole " + h.holeNumber + " keeps off hole 1's ground");
  });
  /* Unlabelled, the lengths still decide, and the loop closes on the stray: the answer the
     person saw. */
  const plain = await resolver.resolveCourseGeometryForAutoMapper({
    osmPayload: { elements: overlay.overlayToOsmElements(parkes.features) }, courseId: "parkes", courseCentre: parkes.centre, expectedHoleCount: 18,
    scorecardHoles: parkes.scorecard, scorecardEvidence: { holes: parkes.scorecard, source: "manual-upload" }
  });
  assert.strictEqual(plain.holes.length, 18);
  assert.ok(plain.debugEvidence.assignmentAlternatives[0].closure < 0, "the stray's walk back to hole 1 is charged");
});

(async function run() {
  resolver = await import(path.join(root, "functions", "lib", "gd-geometry-resolver-core.mjs"));
  automapperCore = await import(path.join(root, "functions", "lib", "gd-automapper-core.mjs"));
  let failures = 0;
  for (const item of tests) {
    try {
      await item.fn();
      console.log("  ok  " + item.name);
    } catch (error) {
      failures += 1;
      console.error("  FAIL  " + item.name + "\n        " + (error && error.stack || error));
    }
  }
  if (failures) {
    console.error("geometry-resolver-core FAILED: " + failures + " of " + tests.length);
    process.exit(1);
  }
  console.log("geometry-resolver-core passed: " + tests.length + " checks");
})();
