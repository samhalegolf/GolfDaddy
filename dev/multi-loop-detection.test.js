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

test("a separated loop is not re-partitioned by distance to its sibling", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
  /* guideBelongsToCourse assigns per hole by nearest centre - the very rule
     separateLoops replaced. Passing sibling centres after separation made it undo
     the routing-continuity assignment: Te Arai's loop 0 came out contiguous 1-18 and
     published 16, having lost holes 9 and 10 to the sibling's centroid. The loop's
     payload already contains only its own holes, so there is nothing to partition. */
  const publishAt = src.indexOf("async function publishSeparatedLoops(");
  assert.notStrictEqual(publishAt, -1);
  const body = src.slice(publishAt, src.indexOf("\n}", publishAt));
  assert.notStrictEqual(body.indexOf("resolveCourseGeometry(loop.payload, courseId, loop.centre || course.center, [], [])"), -1,
    "a separated loop must be resolved with NO sibling centres");
  assert.strictEqual(body.indexOf("otherCentres"), -1, "and the sibling list must be gone, not just unused");
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

/* ---------------------------------------------------------------------------
 * Te Arai Links, the second time: 18 + 17, missing hole 5.
 *
 * Separation was right; the payload was short. The widen box was a square centred
 * on the stored PIN, which at Te Arai is the North clubhouse in the north-west
 * corner of a site that runs south-east - mis-centred by 908m, so its south edge
 * cut through Course 2's bottom holes and hole 5 fell out entirely.
 *
 * Coordinates below are the real ones from job 775f4fb0.
 * ------------------------------------------------------------------------- */

const TE_ARAI_PIN = { lat: -36.1803585453704, lng: 174.65374976713 };
/* tee -> green, from course_maps.objects_json for course-2. Hole 5 absent, as scanned. */
const TE_ARAI_COURSE_2 = {
  1: [[-36.192845, 174.666789], [-36.196982, 174.668598]], 2: [[-36.197451, 174.669209], [-36.200400, 174.667362]],
  3: [[-36.200556, 174.667845], [-36.199610, 174.670895]], 4: [[-36.198823, 174.670911], [-36.200591, 174.674978]],
  6: [[-36.200843, 174.675950], [-36.198084, 174.674570]], 7: [[-36.197625, 174.673821], [-36.194376, 174.670849]],
  8: [[-36.194518, 174.670313], [-36.193105, 174.669972]], 9: [[-36.192242, 174.669312], [-36.191454, 174.666862]],
  10: [[-36.192362, 174.666585], [-36.190485, 174.662886]], 11: [[-36.190304, 174.662253], [-36.186967, 174.663981]],
  12: [[-36.186605, 174.663680], [-36.186368, 174.661788]], 13: [[-36.185916, 174.662075], [-36.182969, 174.658714]],
  14: [[-36.182943, 174.659361], [-36.180363, 174.658303]], 15: [[-36.180208, 174.658681], [-36.183342, 174.660380]],
  16: [[-36.183647, 174.660979], [-36.185778, 174.663149]], 17: [[-36.185939, 174.663297], [-36.186581, 174.664205]],
  18: [[-36.186851, 174.664532], [-36.190469, 174.667318]]
};

let teAraiId = 9000;
function teAraiHole(number, tee, green) {
  return {
    type: "way", id: teAraiId += 1, tags: { golf: "hole", ref: String(number) },
    geometry: [{ lat: tee[0], lon: tee[1] }, { lat: green[0], lon: green[1] }]
  };
}
function teAraiCourse2Payload() {
  return { elements: Object.entries(TE_ARAI_COURSE_2).map(([number, [tee, green]]) => teAraiHole(number, tee, green)) };
}
function teAraiSitePayload() {
  const elements = teAraiCourse2Payload().elements;
  /* Course 1 reduced to its scanned bounding extremes - enough to place the site bbox. */
  elements.push(teAraiHole(1, [-36.171869, 174.64526], [-36.188136997295814, 174.6604545]));
  return { elements };
}
const frameHas = (frame, lat, lng) => lat >= frame.south && lat <= frame.north && lng >= frame.west && lng <= frame.east;

test("the widen box is centred on the holes, not on the clubhouse pin", async () => {
  const core = await import(path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  const payload = teAraiSitePayload();
  const anchor = core.frameCentre(core.holeFeatureFrame(payload));
  assert.ok(anchor, "a payload with numbered holes must yield a hole frame");
  const offset = core.distance(TE_ARAI_PIN, anchor);
  assert.ok(offset > 500,
    "Te Arai's pin sits ~908m from the middle of its holes - that offset is the whole bug (got " + Math.round(offset) + "m)");

  const HALF_M = 2198; // what the real scan computed from widestSeparationM + pad
  const scopeFrame = core.osmScopeFrame({ mode: "around", radiusM: 1400, center: TE_ARAI_PIN }, TE_ARAI_PIN);
  const pinCentred = core.expandOsmFrame(scopeFrame, HALF_M - 1400);
  const holeCentred = core.unionOsmFrames(
    scopeFrame,
    core.expandOsmFrame({ south: anchor.lat, west: anchor.lng, north: anchor.lat, east: anchor.lng }, HALF_M),
    core.holeFeatureFrame(payload, 400)
  );

  /* The four features that were hanging outside the old box, in order of how far. */
  const clipped = [
    ["hole 2 green", -36.200400, 174.667362], ["hole 3 tee", -36.200556, 174.667845],
    ["hole 4 green", -36.200591, 174.674978], ["hole 6 tee", -36.200843, 174.675950]
  ];
  clipped.forEach(([name, lat, lng]) => {
    assert.strictEqual(frameHas(pinCentred, lat, lng), false, name + " was outside the pin-centred box - that is the recorded failure");
    assert.strictEqual(frameHas(holeCentred, lat, lng), true, name + " must be inside the hole-centred box");
  });

  /* And it must not buy that by simply being enormous. Same half-extent in, so the
     hole-centred box is the same size - it is aimed better, not grown. */
  const areaOf = frame => (frame.north - frame.south) * (frame.east - frame.west);
  assert.ok(areaOf(holeCentred) <= areaOf(pinCentred) * 1.05,
    "re-centring must not be a disguised way of widening - area went from "
    + areaOf(pinCentred).toExponential(3) + " to " + areaOf(holeCentred).toExponential(3));
});

test("a one-hole gap becomes a small box between the greens either side of it", async () => {
  const core = await import(path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  const gaps = core.holeGapFrames(teAraiCourse2Payload());
  assert.strictEqual(gaps.length, 1, "Course 2 has exactly one interior gap");
  assert.deepStrictEqual(gaps[0].missing, [5]);
  assert.strictEqual(gaps[0].anchors.length, 2, "hole 4's green and hole 6's tee");

  /* Hole 5 has to start near one anchor and finish near the other, so the box only
     has to be big enough to hold a golf hole - not big enough to hold the site. */
  const frame = gaps[0].frame;
  assert.ok(frameHas(frame, -36.200591, 174.674978), "hole 4's green anchors the box");
  assert.ok(frameHas(frame, -36.200843, 174.675950), "hole 6's tee anchors the box");
  const acrossM = (frame.north - frame.south) * 111320;
  assert.ok(acrossM > 800 && acrossM < 1600, "a ~1km box, not a site-wide sweep (got " + Math.round(acrossM) + "m)");
});

test("a gap too wide to be a clip is left alone", async () => {
  const core = await import(path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  /* Five holes missing in a row is a separation failure. Requerying a box around it
     would paper over the real bug, so holeGapFrames declines to aim at it. */
  const sparse = { elements: [1, 2, 3, 9, 10, 11].map(number => {
    const pair = TE_ARAI_COURSE_2[number] || TE_ARAI_COURSE_2[1];
    return teAraiHole(number, pair[0], pair[1]);
  }) };
  assert.deepStrictEqual(core.holeGapFrames(sparse).map(gap => gap.missing), [],
    "a 5-hole gap is not a clipped scan and must not trigger a requery");

  /* A trailing shortfall is invisible here by design - nothing in the geometry says
     an 18th hole should exist. That is expectedHoles' job, not this function's. */
  const short = { elements: [1, 2, 3].map(n => teAraiHole(n, TE_ARAI_COURSE_2[n][0], TE_ARAI_COURSE_2[n][1])) };
  assert.deepStrictEqual(core.holeGapFrames(short), [], "1,2,3 has no interior gap to fill");
});

test("merging a gap requery into the main payload does not double-count the overlap", async () => {
  const core = await import(path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs"));
  const payload = teAraiCourse2Payload();
  /* The gap box overlaps the main sweep, so the same ways come back twice. */
  assert.strictEqual(core.mergeOsmPayloads(payload, payload).elements.length, payload.elements.length,
    "identical elements must dedupe on type/id");
  const extra = { elements: [teAraiHole(5, [-36.200700, 174.675400], [-36.201400, 174.676800])] };
  const merged = core.mergeOsmPayloads(payload, extra);
  assert.strictEqual(merged.elements.length, payload.elements.length + 1);
  assert.ok(core.holeGapFrames(merged).length === 0, "once hole 5 arrives there is no gap left to aim at");
});

test("the gap requery runs after separation, and only adopts a result that improves", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
  /* Order matters: the gap is only visible per course. The site as a whole has every
     number, because the OTHER course supplies the one this course is missing.
     Execution order, not file order - requeryHoleGaps is DEFINED above runMapperJob,
     so searching the whole file would compare against its definition and fail for
     the wrong reason. */
  const run = src.slice(src.indexOf("async function runMapperJob(job, origin) {"));
  const separateAt = run.indexOf("separateLoops(payload, course.center)");
  const gapAt = run.indexOf("requeryHoleGaps(job, course, payload, loops)");
  assert.notStrictEqual(gapAt, -1, "the worker must attempt a gap requery");
  assert.ok(separateAt < gapAt, "a gap is only visible after separation - the site as a whole looks complete");

  /* The adoption floor. The original 6-hole publish got through on `holesResolved > 0`,
     which is not a floor at all; this one has to beat what it replaces. */
  const body = src.slice(src.indexOf("async function requeryHoleGaps("));
  assert.notStrictEqual(body.indexOf("record.after.contiguous > record.before.contiguous"), -1,
    "adoption must require more complete courses than before");
  assert.notStrictEqual(body.indexOf("no-improvement"), -1,
    "and must record why it declined when it does not");
  /* Bounded: a scan cannot spend itself on gap queries. */
  assert.notStrictEqual(src.indexOf("HOLE_GAP_MAX_QUERIES"), -1, "the number of gap queries must be capped");
  assert.notStrictEqual(body.indexOf("no-small-gaps"), -1,
    "'looked and found nothing to ask for' must be distinguishable from 'never looked'");
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
