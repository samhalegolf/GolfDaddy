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
