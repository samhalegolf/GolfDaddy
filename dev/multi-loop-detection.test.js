/* Courses with more than 18 holes.
 *
 * Royal Auckland is a 27-hole complex. It mapped, reported "done", and
 * published as a NINE hole course - holes numbered exactly 1-9. That is worse
 * than a failure, because nothing downstream could tell it was wrong.
 *
 * The chain: OSM numbers each loop of a multi-nine site 1-9; every layer keys
 * holes by number (holes[green.holeNumber]) so three loops collapse into nine;
 * and the guard that catches short scans is `expectedHoles && holesResolved <
 * expectedHoles`, which never fired because expectedHoles was null - Royal
 * Auckland has no shared scorecard and OSM has no holes=N tag on it.
 *
 * So the detector cannot lean on hole counts at all. It has to see the
 * collision itself: the same hole number appearing on ground far enough apart
 * to be a different loop. Distance is what separates that from OSM's habit of
 * tagging one hole as both a way and a relation. */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/* Overpass returns `out geom`, so a way carries a geometry array of {lat,lon}. */
function holeFeature(number, lat, lng, type) {
  return {
    type: type || "way",
    id: Math.round(Math.abs(lat * 1e5) + number),
    tags: { golf: "hole", ref: String(number) },
    geometry: [
      { lat: lat, lon: lng },
      { lat: lat + 0.0004, lon: lng + 0.0004 }
    ]
  };
}

/* Three loops of nine, each ~700m from the next - the Royal Auckland shape. */
function multiLoopPayload(loops) {
  const elements = [];
  for (let loop = 0; loop < (loops || 3); loop++) {
    for (let hole = 1; hole <= 9; hole++) {
      elements.push(holeFeature(hole, -36.9600 + loop * 0.0063, 174.8400 + hole * 0.0006));
    }
  }
  return { elements: elements };
}

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("three loops numbered 1-9 are caught", async () => {
  const { detectHoleNumberCollision } = await import(path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  const result = detectHoleNumberCollision(multiLoopPayload(3));
  assert.strictEqual(result.multiLoop, true);
  assert.strictEqual(result.loops, 3, "three separated clusters per number");
  assert.strictEqual(result.distinctNumbers, 9, "the count it would have published as");
  assert.strictEqual(result.holeFeatures, 27, "the holes that actually exist");
  assert.deepStrictEqual(result.collidedHoles, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(result.widestSeparationM > 250, "separation must be reported, got " + result.widestSeparationM);
});

test("an ordinary 18-hole course is left alone", async () => {
  const { detectHoleNumberCollision } = await import(path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  const elements = [];
  for (let hole = 1; hole <= 18; hole++) {
    elements.push(holeFeature(hole, -36.9600 + hole * 0.0004, 174.8400 + hole * 0.0006));
  }
  const result = detectHoleNumberCollision({ elements: elements });
  assert.strictEqual(result.multiLoop, false, "no number repeats, nothing to refuse");
  assert.strictEqual(result.loops, 1);
  assert.strictEqual(result.distinctNumbers, 18);
});

test("the same hole tagged twice is not mistaken for a second loop", async () => {
  /* OSM commonly carries one hole as both a way and a relation. Those sit on
     top of each other. Counting features alone would refuse every course that
     does this - distance is the whole reason the check is safe to run. */
  const { detectHoleNumberCollision } = await import(path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  const elements = [];
  for (let hole = 1; hole <= 18; hole++) {
    const lat = -36.9600 + hole * 0.0004;
    elements.push(holeFeature(hole, lat, 174.8400, "way"));
    elements.push(holeFeature(hole, lat + 0.00012, 174.8400, "relation"));
  }
  const result = detectHoleNumberCollision({ elements: elements });
  assert.strictEqual(result.multiLoop, false, "duplicate representations must not trip the check");
  assert.strictEqual(result.holeFeatures, 36, "both representations are still counted");
  assert.strictEqual(result.distinctNumbers, 18);
});

test("two loops is enough - it does not need to be three", async () => {
  const { detectHoleNumberCollision } = await import(path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  const result = detectHoleNumberCollision(multiLoopPayload(2));
  assert.strictEqual(result.multiLoop, true);
  assert.strictEqual(result.loops, 2);
  assert.strictEqual(result.distinctNumbers, 9);
});

test("a payload with no golf holes says nothing", async () => {
  const { detectHoleNumberCollision } = await import(path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  [{ elements: [] }, {}, null, { elements: [{ type: "way", tags: { golf: "green" } }] }].forEach(function (payload) {
    const result = detectHoleNumberCollision(payload);
    assert.strictEqual(result.multiLoop, false);
    assert.strictEqual(result.distinctNumbers, 0);
  });
});

test("a hole feature with no geometry is skipped, not crashed on", async () => {
  const { detectHoleNumberCollision } = await import(path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  const result = detectHoleNumberCollision({
    elements: [{ type: "way", tags: { golf: "hole", ref: "1" } }, holeFeature(1, -36.96, 174.84)]
  });
  assert.strictEqual(result.multiLoop, false);
  assert.strictEqual(result.holeFeatures, 1);
});

test("the separation threshold sits between a green's span and a loop's gap", async () => {
  const core = await import(path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  assert.ok(core.LOOP_SEPARATION_M > core.OSM_AUTO_GREEN_MAX_SPAN_M,
    "must be wider than one green, or a big green would read as two loops");
  assert.ok(core.LOOP_SEPARATION_M < core.OSM_AUTOMAPPER_RADIUS_M,
    "must be inside the query radius to be reachable at all");
});

test("frames are only rendered for a course that is actually complete", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
  /* The chain used to fire on any saved geometry, so an 11-of-18 scan still had a
     full frame set rendered into the bucket - the same storage the orphan cleanup
     reclaims, fed from the front. */
  assert.notStrictEqual(src.indexOf("coverage-incomplete"), -1,
    "chainVisualSnapshot must refuse a course whose coverage is incomplete");
  const gateAt = src.indexOf("coverage && !coverage.complete");
  const sourceAt = src.indexOf("const source = resolveImagerySource(courseBounds)");
  assert.notStrictEqual(gateAt, -1, "the gate must exist");
  assert.ok(gateAt < sourceAt, "and must run before any imagery work is queued");
});

test("a rescan still gathers the cards a multi-course site needs to name itself", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
  /* The shared store holds ONE card; naming N courses needs N. A cache hit skipped
     the resolver entirely, so Te Arai's second scan reported cards:0 and could not
     name either loop despite having stored a card on its first. */
  assert.notStrictEqual(src.indexOf("distinctCardCount(course.scorecardCards) < wantCards"), -1,
    "a multi-loop site must gather cards even when the store already has one");
  /* And the target is the loop count the scan actually found, counted over DISTINCT
     courses - an aggregator serves the same course on two pages, so four cards can
     be two courses and stopping at "four" leaves a site half-named. */
  assert.notStrictEqual(src.indexOf("Math.max(2, Number(collision.loops)"), -1,
    "the number of cards wanted comes from the number of loops separated");
});

test("two courses are never both called the facility", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
  /* "Te Arai Links" twice in the picker is unusable - the player cannot tell which
     is which. Course 1 / Course 2 is honest, and the geometry is matched to a card
     regardless of whether a publishable label was found. */
  assert.notStrictEqual(src.indexOf('"Course " + (index + 1)'), -1,
    "an unnamed loop takes a provisional name that distinguishes it");
  assert.notStrictEqual(src.indexOf("loops[entry.index].matchedCard = cardName"), -1,
    "the loop-to-card match is recorded even when the card cannot supply a name");
  assert.notStrictEqual(src.indexOf('nameSource = "provisional"'), -1,
    "and the row says the name is provisional");
});

test("a site wider than its own sweep is re-queried before separation", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
  /* Te Arai Links: hole numbers 2533m apart against a 1400m radius, so seven of its
     36 hole ways were outside the query and both separated courses published short.
     courseFootprintFrame could not help (no golf=course polygon in OSM) and the
     wider-retry excluded multi-loop sites - the very sites most likely to outgrow a
     fixed radius. */
  const widenAt = src.indexOf("collision.widestSeparationM > scope.radiusM");
  assert.notStrictEqual(widenAt, -1, "a site wider than the sweep must trigger a wider query");
  const separateAt = src.indexOf("separateLoops(payload, course.center)");
  assert.notStrictEqual(separateAt, -1);
  assert.ok(widenAt < separateAt, "and it must widen BEFORE separating, or the loops are built from a clipped payload");
});

test("the worker separates a multi-course site before it considers refusing", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
  const idx = src.indexOf("let collision = detectHoleNumberCollision(payload);");
  assert.notStrictEqual(idx, -1, "the worker must run the detector");
  /* The detector is no longer an error detector. A second course on the site is a
     course to publish, not ambiguity to resolve, so the worker separates the loops
     and publishes every one of them. The refusal survives only for the case that is
     still genuinely unresolvable: separation could not tell the courses apart, and
     the geometry resolver could not either. */
  const after = src.slice(idx);
  const separateAt = after.indexOf("separateLoops(payload, course.center)");
  const refuseAt = after.indexOf("throw fail(");
  assert.notStrictEqual(separateAt, -1, "the worker must try to separate the loops before giving up");
  assert.notStrictEqual(refuseAt, -1, "the refusal must survive for the cases separation cannot fix");
  assert.ok(separateAt < refuseAt, "refusing before trying to separate is the bug this replaced");
  assert.notStrictEqual(after.indexOf("publishSeparatedLoops("), -1, "and every separated course must be published, not only the pinned one");
  /* Execution order, not file order: saveResolvedGeometry is DEFINED earlier in
     the file than runMapperJob, so comparing against its definition would pass
     for the wrong reason. What matters is that inside runMapperJob the check
     comes before the call that writes. */
  const body = src.slice(src.indexOf("async function runMapperJob(job, origin) {"));
  const checkAt = body.indexOf("let collision = detectHoleNumberCollision(payload);");
  const writeAt = body.indexOf("await saveResolvedGeometry(");
  assert.notStrictEqual(writeAt, -1, "runMapperJob must still write geometry somewhere");
  assert.ok(checkAt !== -1 && checkAt < writeAt,
    "the check has to run BEFORE saveResolvedGeometry, or a short course is already saved");
});

test("the refusal is terminal, not retried forever", async () => {
  /* Retrying cannot invent a loop order. transientMapperFailure must leave it
     alone - it is an allowlist, so this holds as long as the message avoids
     the transient keywords. */
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
  const start = src.indexOf("function transientMapperFailure(error) {");
  const isTransient = new Function(src.slice(start, src.indexOf("\n}", start) + 2) + "\nreturn transientMapperFailure;")();
  assert.strictEqual(
    isTransient(new Error("multi-loop course: hole numbers 1, 2, 3 appear in 3 separate locations up to 700m apart - 27 hole features resolve to only 9 distinct numbers.")),
    false
  );
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("multi-loop-detection failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("multi-loop-detection passed: " + tests.length + " checks");
})();
