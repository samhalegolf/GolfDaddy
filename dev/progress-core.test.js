/* One progress bar for every long action in the Course Database.
 *
 * The bar is only worth having if its number means something, so most of what is locked here is
 * about honesty rather than arithmetic:
 *
 *   - a percentage is either counted work or a phase boundary, never elapsed time;
 *   - an unknown stage reports nothing rather than a guess;
 *   - the phase tables actually match the stage strings the workers emit, checked against the
 *     worker source itself - a renamed heartbeat stage would otherwise silently degrade every
 *     bar for that job kind to "no idea", which is exactly the failure the bar exists to
 *     prevent and exactly the kind that nobody notices for months.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const core = require(path.join(ROOT, "scripts", "gd-progress-core.js"));

let checks = 0;
function test(name, fn) { fn(); checks += 1; console.log("  PASS  " + name); }

test("a counted stage is parsed into real done/total", () => {
  assert.deepStrictEqual(core.parseCountedStage("refining-hole-7-of-18"), { base: "refining-hole", done: 7, total: 18 });
  assert.deepStrictEqual(core.parseCountedStage("publishing-course-2-of-4"), { base: "publishing-course", done: 2, total: 4 });
  assert.strictEqual(core.parseCountedStage("querying-overpass"), null);
});

test("a bare trailing number is a round counter, never a fraction", () => {
  /* "gathering-cards-for-facility-3" means the third round, not 3 of anything. Reading it as a
     fraction would invent a denominator. */
  assert.strictEqual(core.parseCountedStage("gathering-cards-for-facility-3"), null);
  assert.strictEqual(core.baseStage("gathering-cards-for-facility-3"), "gathering-cards-for-facility");
});

test("counted work spans its band and lands proportionally", () => {
  const band = core.PHASES.refine_surface_shapes.find(b => b.stage === "refining-hole");
  const half = core.stagePercent("refine_surface_shapes", "refining-hole-9-of-18");
  assert.strictEqual(half, band.from + (band.to - band.from) * 0.5);
  assert.strictEqual(core.stagePercent("refine_surface_shapes", "refining-hole-18-of-18"), band.to);
});

test("an uncounted stage reports its band START, never the middle", () => {
  /* Nothing measures position inside a phase, so the only defensible number is the boundary
     that has definitely been reached. */
  const band = core.PHASES.automap.find(b => b.stage === "resolving-geometry");
  assert.strictEqual(core.stagePercent("automap", "resolving-geometry"), band.from);
});

test("an unknown stage reports no percentage at all", () => {
  assert.strictEqual(core.stagePercent("automap", "some-stage-nobody-added"), null);
  assert.strictEqual(core.stagePercent("not-a-job-kind", "querying-overpass"), null);
  /* ...and still says what it is doing, from the raw name. */
  assert.strictEqual(core.stageLabel("automap", "some-new-stage"), "Some new stage");
});

test("every phase table is ascending, contiguous and ends at 100", () => {
  Object.keys(core.PHASES).forEach(kind => {
    const bands = core.PHASES[kind];
    assert.ok(bands.length, kind + " must have bands");
    let previousTo = 0;
    bands.forEach(band => {
      assert.ok(band.to > band.from, kind + "/" + band.stage + " must move forwards");
      assert.strictEqual(band.from, previousTo, kind + "/" + band.stage + " must start where the last band ended");
      assert.ok(band.label, kind + "/" + band.stage + " needs a human label");
      previousTo = band.to;
    });
    assert.strictEqual(previousTo, 100, kind + " must finish at 100");
  });
});

test("the phase tables match the stages the mapper worker actually emits", () => {
  /* The real guard. Each heartbeatJob stage in the worker is either in the table for its job
     kind, or the bar for that kind silently loses its percentage. */
  const worker = fs.readFileSync(path.join(ROOT, "functions", "course-mapper-worker-background.mjs"), "utf8");
  const emitted = new Set();
  const re = /heartbeatJob\(job,\s*\{\s*stage:\s*"([^"]+)"/g;
  let match;
  /* The counted stages are built by concatenation ("refining-hole-" + n + "-of-" + total), so
     the literal in the source ends at the hyphen. Trimming it is what makes the emitted name
     and the band name comparable. */
  const normalise = raw => core.baseStage(String(raw).replace(/-+$/, ""));
  while ((match = re.exec(worker))) emitted.add(normalise(match[1]));
  assert.ok(emitted.size >= 10, "expected to find the worker's heartbeat stages, found " + emitted.size);

  const known = new Set();
  ["automap", "collect_extra_objects", "refine_surface_shapes"].forEach(kind => {
    core.PHASES[kind].forEach(band => known.add(band.stage));
  });
  const missing = [...emitted].filter(stage => !known.has(stage));
  assert.deepStrictEqual(missing, [],
    "these worker stages have no band, so their bar would show no percentage: " + missing.join(", "));
});

test("the watch phase table matches the stages the bake actually writes", () => {
  const fn = fs.readFileSync(path.join(ROOT, "functions", "course-watch-maps.mjs"), "utf8");
  const emitted = new Set();
  const re = /writeProgress\(courseId,\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(fn))) emitted.add(core.baseStage(String(match[1]).replace(/-+$/, "")));
  assert.ok(emitted.size >= 3, "expected the bake's stages, found " + [...emitted].join(", "));
  const known = new Set(core.PHASES.watch_map.map(band => band.stage));
  const missing = [...emitted].filter(stage => !known.has(stage));
  assert.deepStrictEqual(missing, [], "unbanded bake stages: " + missing.join(", "));
});

test("the bar never goes backwards, but the label still tells the truth", () => {
  core.resetFloors();
  assert.strictEqual(core.applyFloor("c:automap", 50), 50);
  /* automap legitimately re-enters an earlier stage on a wider retry. */
  assert.strictEqual(core.applyFloor("c:automap", 18), 50, "a retry must not rewind the bar");
  assert.strictEqual(core.applyFloor("c:automap", 71), 71);
  core.clearFloor("c:automap");
  assert.strictEqual(core.applyFloor("c:automap", 4), 4, "a finished run must not leave its ceiling behind");
});

test("a queued job reads as 0%, not as missing", () => {
  const m = core.mapperProgress({ state: "queued", activeKind: "automap" });
  assert.strictEqual(m.live, true);
  assert.strictEqual(m.pct, 0);
  assert.match(m.label, /Queued/);
});

test("a job that is not running draws no bar at all", () => {
  assert.strictEqual(core.mapperProgress({ state: "geometry-ready" }).live, false);
  assert.strictEqual(core.visualProgress({ state: "frames-ready" }).live, false);
  assert.strictEqual(core.watchProgress({ status: "ready" }).live, false);
  assert.strictEqual(core.barMarkup(core.mapperProgress({ state: "geometry-ready" })), "");
});

test("the same stage means different things to different job kinds", () => {
  /* Both automap and Collect Extra Objects emit "querying-overpass". It is a fifth of one job
     and half of the other, so it occupies a different band in each - which is why the bar needs
     activeKind and cannot place a stage on its name alone.

     Both bands START at 0, since it is the first phase of both jobs and entering a phase means
     none of it is finished yet. The span is where they differ, and the span is what the next
     reported stage lands on. */
  const inAutomap = core.PHASES.automap.find(b => b.stage === "querying-overpass");
  const inCollect = core.PHASES.collect_extra_objects.find(b => b.stage === "querying-overpass");
  assert.notStrictEqual(inAutomap.to, inCollect.to, "the same stage must span a different share of a different job");
  /* And the following stage proves it in the number the screen actually shows. */
  assert.notStrictEqual(
    core.stagePercent("automap", "resolving-geometry"),
    core.stagePercent("collect_extra_objects", "collecting-objects")
  );
});

test("entering the first phase is 0% and says so, rather than pretending to be underway", () => {
  /* Honest, and the reason the label matters: "Querying OpenStreetMap · 0%" is a started job
     with nothing finished. The word is what separates it from a queued one, not the number. */
  const m = core.mapperProgress({ state: "running", activeKind: "automap", progress: { stage: "querying-overpass" } });
  assert.strictEqual(m.pct, 0);
  assert.strictEqual(m.label, "Querying OpenStreetMap");
});

test("the visual pipeline's real counts are used directly", () => {
  const m = core.visualProgress({ building: true, activeKind: "export", progress: { capturesDone: 9, capturesTotal: 18 } });
  assert.strictEqual(m.pct, 50);
  assert.strictEqual(m.detail, "9/18");
  assert.match(m.label, /Baking frames/);
});

test("a live source with nothing to report is indeterminate, not zero", () => {
  const m = core.visualProgress({ building: true, activeKind: "snapshot", progress: null });
  assert.strictEqual(m.live, true);
  assert.strictEqual(m.pct, null, "no count and no phase must not become 0% - that reads as 'stuck at the start'");
  assert.ok(core.barMarkup(m).includes("gdAdminProgressBarIndeterminate"));
});

test("no percentage is ever derived from elapsed time", () => {
  /* Structural, because this is the one mistake that would look completely fine on screen. */
  const src = fs.readFileSync(path.join(ROOT, "scripts", "gd-progress-core.js"), "utf8");
  const body = src.slice(src.indexOf("var PHASES"));
  assert.ok(!/Date\.now\(\)/.test(body), "the progress maths must not read the clock");
  assert.ok(!/elapsed/i.test(body.replace(/\/\*[\s\S]*?\*\//g, "")), "no elapsed-time term may reach the percentage");
});

test("the bar renders a real percentage, and escapes what it is given", () => {
  const m = core.watchProgress({ progress: { stage: "baking-hole-9-of-18" } });
  const html = core.barMarkup(m);
  assert.ok(html.includes('style="width:51%"'), "the fill must carry the percentage");
  assert.ok(html.includes('aria-valuenow="51"'));
  assert.ok(html.includes("51%"), "the number must be readable, not just drawn");
  assert.ok(html.includes("9/18"), "the count it came from must be visible beside it");

  const nasty = core.barMarkup({ live: true, pct: 10, label: '<img src=x onerror="alert(1)">', detail: "" });
  assert.ok(!nasty.includes("<img"), "labels must be escaped");
  assert.ok(nasty.includes("&lt;img"));
});

test("an indeterminate bar reports no value to a screen reader", () => {
  const html = core.barMarkup({ live: true, pct: null, label: "Baking hole images" });
  assert.ok(!html.includes("aria-valuenow"), "a bar with no value must not announce one");
  assert.ok(html.includes('aria-valuetext="in progress"'));
});

test("a stalled run is marked, and says for how long", () => {
  const html = core.barMarkup({ live: true, pct: 40, label: "Scanning", stalled: true, stalledSeconds: 180 });
  assert.ok(html.includes("gdAdminProgressBarStalled"));
  assert.ok(html.includes("stalled 3m"));
});

test("one sentence describes any model the same way", () => {
  assert.strictEqual(
    core.progressText(core.watchProgress({ progress: { stage: "baking-hole-9-of-18" } })),
    "Baking hole images 9/18 · 51%"
  );
});

console.log("\n" + checks + " progress-core checks passed.");
