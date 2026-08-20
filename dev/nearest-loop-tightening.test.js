/* St Andrews Links, and the Balgove failure it caused.
 *
 * Real job row, 2026-08-20:
 *   "multi-loop course: hole numbers 1..18 appear in 6 separate locations"
 *
 * Balgove is a 9-hole course sitting among five other St Andrews courses. The
 * 1400m Overpass sweep returns all six, every one of them numbered from 1, and
 * the mapper's only answer was to refuse. Worse, it refused SILENTLY as far as
 * the player was concerned: the verdict that would have offered them a pin was
 * only computed on the success path, so a failed run asked for nothing.
 *
 * Two fixes, both tested here. Tighten onto the loop nearest the pin using the
 * payload already in hand - no second Overpass call - and make the refusal
 * carry a verdict when tightening cannot save it. */
const assert = require("assert");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CORE = path.join(ROOT, "functions", "lib", "gd-automapper-core.mjs");
const FIT = path.join(ROOT, "functions", "lib", "gd-course-fit-core.mjs");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* Six courses, each numbered 1-18, each ~700m from the next - the shape the
   Balgove run actually hit. Overpass returns `out geom`, so a hole is a way
   with a geometry array. */
function stAndrewsPayload(loops) {
  const elements = [];
  for (let loop = 0; loop < (loops || 6); loop++) {
    for (let hole = 1; hole <= 18; hole++) {
      elements.push({
        type: "way", id: loop * 100 + hole,
        tags: { golf: "hole", ref: String(hole) },
        geometry: [
          { lat: 56.3400 + loop * 0.0063, lon: -2.8100 + hole * 0.0006 },
          { lat: 56.3404 + loop * 0.0063, lon: -2.8096 + hole * 0.0006 }
        ]
      });
    }
  }
  return { elements };
}
const loopCentre = (loop) => ({ lat: 56.3402 + loop * 0.0063, lng: -2.8100 + 9 * 0.0006 });

test("the collision keeps the clusters instead of counting them", async () => {
  const { detectHoleNumberCollision } = await import(CORE);
  const collision = detectHoleNumberCollision(stAndrewsPayload(6));
  assert.strictEqual(collision.loops, 6, "six courses in the sweep");
  assert.strictEqual(collision.clusters.length, 18, "one entry per hole number");
  assert.strictEqual(collision.clusters.find((c) => c.number === 1).centres.length, 6,
    "hole 1 exists in six places - those six places are the six courses");
});

test("tightening onto the pin leaves exactly one loop", async () => {
  const { detectHoleNumberCollision, selectNearestLoop } = await import(CORE);
  const payload = stAndrewsPayload(6);
  const tightened = selectNearestLoop(payload, loopCentre(2));
  assert.ok(tightened, "a colliding payload must be separable");
  assert.strictEqual(tightened.keptHoleFeatures, 18, "one course's worth of holes");
  assert.strictEqual(tightened.droppedHoleFeatures, 90, "the other five courses go");
  assert.strictEqual(detectHoleNumberCollision(tightened.payload).multiLoop, false,
    "after tightening there is nothing left to be ambiguous about");
});

test("it keeps the loop the pin is actually on, not just any loop", async () => {
  const { selectNearestLoop } = await import(CORE);
  [0, 3, 5].forEach((loop) => {
    const kept = selectNearestLoop(stAndrewsPayload(6), loopCentre(loop)).payload.elements
      .filter((e) => e.tags && e.tags.golf === "hole");
    const loopsKept = new Set(kept.map((e) => Math.floor(e.id / 100)));
    assert.deepStrictEqual([...loopsKept], [loop], "pin on loop " + loop + " must keep loop " + loop);
  });
});

test("greens, tees and bunkers survive tightening", async () => {
  const { selectNearestLoop } = await import(CORE);
  /* Only numbered hole guides can be attributed to a loop. Everything else is
     matched to a guide by proximity later, so dropping it here would throw away
     the geometry the course is actually built from. */
  const payload = stAndrewsPayload(6);
  payload.elements.push({ type: "way", id: 90001, tags: { golf: "green" }, geometry: [{ lat: 56.3402, lon: -2.8100 }] });
  payload.elements.push({ type: "way", id: 90002, tags: { golf: "bunker" }, geometry: [{ lat: 56.3402, lon: -2.8100 }] });
  const kept = selectNearestLoop(payload, loopCentre(0)).payload.elements.map((e) => e.id);
  assert.ok(kept.includes(90001) && kept.includes(90002));
});

test("an ordinary single course is left completely alone", async () => {
  const { selectNearestLoop } = await import(CORE);
  assert.strictEqual(selectNearestLoop(stAndrewsPayload(1), loopCentre(0)), null,
    "nothing to drop means nothing to do - a normal course must not take this path at all");
});

test("no centre means no guessing", async () => {
  const { selectNearestLoop } = await import(CORE);
  assert.strictEqual(selectNearestLoop(stAndrewsPayload(6), null), null);
  assert.strictEqual(selectNearestLoop(stAndrewsPayload(6), { lat: null, lng: null }), null);
});

test("a refusal now carries a verdict that can ask for a pin", async () => {
  const { courseFitVerdict, courseFitMessage } = await import(FIT);
  const { detectHoleNumberCollision } = await import(CORE);
  /* What the worker attaches to the failure when tightening could not save it. */
  const collision = detectHoleNumberCollision(stAndrewsPayload(6));
  const verdict = courseFitVerdict({ collision, expectedHoles: 0, holesResolved: 0, courseBounds: null });
  assert.strictEqual(verdict.trusted, false);
  assert.strictEqual(verdict.reason, "multiple-courses");
  assert.strictEqual(verdict.scope, "ground", "a wrong place must stop the round, not just warn");
  assert.ok(/6 courses/.test(courseFitMessage(verdict)), "the player is owed the count: " + courseFitMessage(verdict));
});

test("the worker tightens before it refuses", () => {
  const src = require("fs").readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
  const body = src.slice(src.indexOf("async function runMapperJob(job) {"));
  const tightenAt = body.indexOf("selectNearestLoop(payload, course.center)");
  const throwAt = body.indexOf("throw fail(\n        \"multi-loop course");
  assert.notStrictEqual(tightenAt, -1, "the worker must try tightening at all");
  assert.notStrictEqual(throwAt, -1, "the refusal must still exist for the cases tightening cannot fix");
  assert.ok(tightenAt < throwAt, "refusing before trying to separate the loops is the Balgove bug");
});

test("the failed job's verdict reaches the package", () => {
  const src = require("fs").readFileSync(path.join(ROOT, "functions", "course-package.mjs"), "utf8");
  assert.ok(/diagnostics && j\.result\.diagnostics\.fit/.test(src),
    "a refusal saves what it learned under diagnostics; reading only result.fit misses every failure");
  const build = src.slice(src.indexOf("export async function buildCoursePackage"));
  ["manual-required", "failed"].forEach((state) => {
    const at = build.indexOf('status: "' + state + '"');
    assert.notStrictEqual(at, -1, state + " branch must exist");
    assert.ok(/withFit\(\{ courseId, status: "(manual-required|failed)"/.test(build.slice(Math.max(0, at - 120), at + 40)),
      state + " must carry the verdict, or the pin is unreachable in the case it exists for");
  });
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed++; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("nearest-loop-tightening failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("nearest-loop-tightening passed: " + tests.length + " checks");
})();
