/* The mapping debug trail actually reaching the debugger.
 *
 * SURFACE: the recorder is STUDIO-ONLY, by decision. gd-course-mapping-debug.js
 * is marked data-gd-surface="studio" and the app build strips it, so on the app
 * and native surfaces window.GDCourseMappingDebug is undefined,
 * mappingDebugApi() returns null, and every recordMappingDebug call in the
 * pipeline is a silent no-op. That is a real cost and it is accepted knowingly:
 * a failed scan on a phone leaves no debug trail, and diagnosing one means
 * reproducing it in the studio. It is the deliberate price of keeping a debug
 * module out of the production APK/IPA, which dev/surface-split.test.js
 * enforces at two points (the app build, and the --app-only native prune).
 *
 * This file used to assert the opposite - it was written when the recorder
 * shipped to the app - so if you are here because the app has no scan
 * diagnostics: that is the design, not a regression. Reversing it again means
 * changing surface-split.test.js and boot-smoke.test.js with it; those three
 * are the ones that disagreed with each other for weeks.
 *
 * Everything below the first test is about the RECORDER'S OWN correctness -
 * sources, phases, run ids, how failures and silent exits are reported - and
 * holds whichever surface it ships to. Those faults each made a failed scan
 * hard to read, and are locked down here because every one of them is the kind
 * of thing a later tidy-up would quietly undo. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "index.html");
const DEBUG = path.join(ROOT, "scripts", "gd-course-mapping-debug.js");
const PIN_LOCK = path.join(ROOT, "scripts", "gd-course-library-pin-lock.js");
const PIPELINE = path.join(ROOT, "scripts", "gd-course-play-pipeline.js");
const BUILD = path.join(ROOT, "scripts", "clarity-deploy-build.js");

const indexSrc = fs.readFileSync(INDEX, "utf8");
const debugSrc = fs.readFileSync(DEBUG, "utf8");
const pinSrc = fs.readFileSync(PIN_LOCK, "utf8");
const pipelineSrc = fs.readFileSync(PIPELINE, "utf8");

const tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("the recorder is studio-marked, so the app build strips it", () => {
  /* The studio still has to LOAD the recorder - an unmarked-to-deleted slip
     would take the trail away from the studio too, and then it exists nowhere.
     The marking is what keeps it off the app and out of the native bundle. */
  const tag = indexSrc
    .split("\n")
    .find(function (line) { return line.includes("gd-course-mapping-debug.js"); });
  assert.ok(tag, "index.html must still load the mapping debug recorder");
  assert.ok(
    /data-gd-surface\s*=\s*"studio"/.test(tag),
    "the recorder must stay studio-marked - unmarked it ships inside the APK/IPA"
  );
});

test("the build really does delete studio-marked scripts", () => {
  /* Proves the line above matters rather than asserting a style rule. */
  const buildSrc = fs.readFileSync(BUILD, "utf8");
  assert.ok(/stripSurface\(/.test(buildSrc), "the app build must still strip a surface");
  assert.ok(/STUDIO/.test(buildSrc), "the stripped surface must still be the studio one");
});

test("every source the pipeline emits is a source the recorder accepts", () => {
  /* cleanSource rewrites anything unlisted to "unknown". cloud-map and
     cloud-scans were missing, so a third of all mapping events - the entire
     cloud leg of a scan - was filed as Unknown and unreadable. Derived from
     the source rather than hardcoded, so a new source added to the pipeline
     without a matching entry fails here. */
  const emitted = new Set(
    (pinSrc.match(/recordMappingDebug\([^,]*,\s*\{\s*source:'[a-z-]+'/g) || [])
      .map(function (m) { return m.match(/source:'([a-z-]+)'/)[1]; })
  );
  assert.ok(emitted.size >= 6, "expected to find the pipeline's debug sources, found " + emitted.size);
  const validBlock = debugSrc.slice(
    debugSrc.indexOf("var VALID_SOURCES"),
    debugSrc.indexOf("};", debugSrc.indexOf("var VALID_SOURCES"))
  );
  emitted.forEach(function (source) {
    assert.ok(
      validBlock.includes('"' + source + '"') || new RegExp("\\b" + source + ":").test(validBlock),
      'source "' + source + '" is emitted by the pipeline but would be coerced to "unknown"'
    );
  });
});

test("every phase the pipeline emits is a phase the recorder accepts", () => {
  const emitted = new Set(
    (pinSrc.match(/phase:'[a-z-]+'/g) || []).map(function (m) { return m.match(/phase:'([a-z-]+)'/)[1]; })
  );
  const validBlock = debugSrc.slice(
    debugSrc.indexOf("var VALID_PHASES"),
    debugSrc.indexOf("};", debugSrc.indexOf("var VALID_PHASES"))
  );
  emitted.forEach(function (phase) {
    assert.ok(
      new RegExp("\\b" + phase + ":").test(validBlock),
      'phase "' + phase + '" is emitted but cleanPhase would silently rewrite it to "progress"'
    );
  });
});

test("an event with no run id joins the active run instead of stealing it", () => {
  /* Minting a run for a runId-less event named it "course" from makeRunId's
     fallback stem, took over state.activeRunId, and evicted a real run from
     the 10-deep RECENT_LIMIT - erasing the trail being debugged. */
  const fn = debugSrc.slice(debugSrc.indexOf("function recordEvent("));
  assert.ok(
    /var attachRunId = explicitRunId \|\| String\(state\.activeRunId \|\| ""\)\.trim\(\);/.test(fn),
    "a runId-less event must fall back to the run already in flight"
  );
  assert.ok(
    /doNotActivate: true/.test(fn.slice(0, fn.indexOf("var phase"))),
    "attaching to a run must never reassign state.activeRunId"
  );
});

test("a thrown server wait is reported as failed, not as pending", () => {
  /* The catch discarded the error and fell through to the pending branch, so a
     crash and a genuinely queued job looked identical in the log. */
  assert.ok(/serverWaitError=e\|\|null;/.test(pinSrc), "the wait error must be kept");
  assert.ok(
    /const waitFailed=waitStatus==='failed'\|\|!!serverWaitError;/.test(pinSrc),
    "a thrown wait must count as a failure"
  );
  assert.ok(/threw:!!serverWaitError/.test(pinSrc), "the log must say whether it threw");
});

test("the silent early exits now say why nothing scanned", () => {
  /* Both answers to "I pressed Play and nothing happened". */
  assert.ok(
    /event:'mapping-attempt-skipped-manual-course'/.test(pinSrc),
    "a manual GPS course must record why no scan ran"
  );
  assert.ok(
    /event:'mapping-attempt-joined-in-flight'/.test(pinSrc),
    "joining an in-flight scan must not look like a dropped request"
  );
});

test("a fallback that could not arm does not log as opened", () => {
  assert.ok(
    /event:'manual-fallback-not-armed'/.test(pinSrc),
    "no map element means no click handler - the log must not claim a fallback is waiting for a tap"
  );
});

test("an empty monitor reports no active course rather than a course named 'course'", () => {
  /* "course" is slug()'s fallback stem. Rendering it with a row of zeros read
     as a scan that ran and found nothing. */
  const fn = pipelineSrc.slice(pipelineSrc.indexOf("function buildDebugSnapshot("));
  assert.ok(/var hasActiveCourse=!!resolved;/.test(fn), "the snapshot must know whether a course is open");
  assert.ok(
    /activeCourseKey:hasActiveCourse\?\(course\.courseKey\|\|course\.courseId\):""/.test(fn),
    "an empty snapshot must not report a course key"
  );
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed += 1; console.error("  FAIL " + t.name); console.error("       " + (err && err.message || err)); }
  }
  if (failed) { console.error("course-mapping-debug-wiring failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("course-mapping-debug-wiring passed: " + tests.length + " checks");
})();
