/* Partial flattens are kept.
 *
 * The flatten used to demand 100% tile coverage. At the median capture that is
 * ~270 consecutive successful fetches, so a single 404 or one slow tile threw the
 * whole hole away and left it on tile references - permanently, because nothing
 * ever retried it. The flatten exists to end exactly that state.
 *
 * Accepting a partial is only safe if it can still be improved, so three things
 * have to hold together and are asserted here:
 *   1. the floor is below 1, or nothing changes;
 *   2. a partial KEEPS its tile list - tiles are the only way to re-composite,
 *      and dropping them is what would make the gaps permanent;
 *   3. a retry must BEAT the stored coverage, so a run of poor captures cannot
 *      walk a good frame back down.
 *
 * The retry-floor arithmetic is executed rather than pattern-matched: its failure
 * mode is Number(null) === 0, which reads as harmless and silently accepts any
 * composite at all. The surrounding file is 120KB of browser globals, so the
 * structural claims are asserted against source per the convention here. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CAMERA = path.join(ROOT, "scripts", "inline", "gd-captured-hole-frame-camera-v19.js");
const src = fs.readFileSync(CAMERA, "utf8");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("the coverage floor is below 1", () => {
  const m = src.match(/var DEFAULT_MIN_COVERAGE\s*=\s*([0-9.]+)/);
  assert.ok(m, "DEFAULT_MIN_COVERAGE must be a named constant, not a literal at the use site");
  const floor = Number(m[1]);
  assert.ok(floor < 1, "a floor of 1 is the all-or-nothing behaviour this replaced");
  assert.ok(floor > 0.5, "too low and a mostly-missing composite passes as a frame");
});

test("the default is read through Number.isFinite, so 0 stays selectable", () => {
  assert.ok(
    /var minCoverage=Number\.isFinite\(Number\(opts\.minCoverage\)\)\?Number\(opts\.minCoverage\):DEFAULT_MIN_COVERAGE/.test(src),
    "an ||-style default would make an explicit minCoverage of 0 silently become the default"
  );
});

test("a partial frame is recorded as partial", () => {
  assert.ok(/imageCoverage:covered/.test(src), "coverage must be recorded to judge a later retry");
  assert.ok(/imagePartial:covered<1/.test(src), "downstream must be able to tell a partial from a complete frame");
});

test("a partial keeps its tiles, a complete frame drops them", () => {
  assert.ok(
    /if\(!flattened\.imagePartial\)delete lean\.tiles;/.test(src),
    "an unconditional delete makes the missing tiles permanent - there is nothing left to retry from"
  );
});

test("a re-capture carries the stored coverage forward", () => {
  assert.ok(
    /manifest\.imagePartial=stored\.imagePartial===true;/.test(src),
    "without this a re-capture of a partial looks complete and the retry is skipped"
  );
});

test("scheduleCaptureFlatten retries a partial, and only with tiles in hand", () => {
  const m = src.match(/var partialRetry=([^;]+);/);
  assert.ok(m, "the retry condition must exist");
  const cond = m[1];
  assert.ok(/imagePartial===true/.test(cond), "only partials are retried, never complete frames");
  assert.ok(/tiles/.test(cond) && /length/.test(cond), "no tiles means flattenCaptureManifest can only answer no-tiles");
  assert.ok(
    /if\(\(manifest\.imageData\|\|manifest\.imagePath\)&&!partialRetry\)return null;/.test(src),
    "the early return must let a partial through"
  );
});

/* The arithmetic itself, lifted verbatim from the source so a change there fails here. */
function retryFloorFrom(src) {
  const m = src.match(/var retryFloor=(partialRetry\?[^;]+);/);
  assert.ok(m, "retryFloor must be a single expression this test can evaluate");
  return new Function("partialRetry", "manifest", "return " + m[1] + ";");
}

test("a retry floor sits strictly above the coverage already stored", () => {
  const floor = retryFloorFrom(src);
  const got = floor(true, { imageCoverage: 0.95 });
  assert.ok(got > 0.95, "a retry that merely matches 0.95 would rewrite the frame for nothing, got " + got);
  assert.ok(got <= 1, "a floor above 1 is unreachable and would disable retries entirely, got " + got);
});

test("a retry floor never exceeds 1", () => {
  const floor = retryFloorFrom(src);
  assert.strictEqual(floor(true, { imageCoverage: 0.9995 }), 1, "must clamp, or a near-complete frame can never be replaced");
});

test("a first flatten gets the default floor, NOT zero", () => {
  const floor = retryFloorFrom(src);
  const first = floor(false, {});
  assert.strictEqual(
    Number.isFinite(Number(first)), false,
    "Number(null) is 0 - returning null here hands a first flatten a floor of zero and accepts any composite at all"
  );
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log("  ok  " + t.name);
    } catch (err) {
      failed += 1;
      console.error("  FAIL " + t.name);
      console.error("       " + (err && err.message || err));
    }
  }
  if (failed) {
    console.error("captured-frame-partial-flatten failed: " + failed + "/" + tests.length);
    process.exit(1);
  }
  console.log("captured-frame-partial-flatten passed: " + tests.length + " checks");
})();
