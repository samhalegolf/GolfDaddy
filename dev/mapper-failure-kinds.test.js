/* The kinds a terminal mapping failure is sorted into, the prompt each one carries, and
 * the text the Claude mapper-debug Routine is fired with.
 *
 * The three failures of 26-27 September 2026 are the fixtures: Royal Belfast (eleven
 * greens, no hole lines), 소피아그린CC (nothing in OSM, scorecard found) and the Uljin
 * "Golf course" (nothing in OSM). Their diagnostics are what the job rows carried. */
const assert = require("assert");
const path = require("path");
const root = path.join(__dirname, "..");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const BELFAST = {
  centre: { lat: 54.6601537, lng: -5.7847654 }, courseName: "Royal Belfast Golf Club",
  osmFeatures: { tees: 0, holes: 0, water: 0, greens: 11, bunkers: 0, elements: 13, fairways: 0, numberedHoles: 0 },
  expectedHoles: 18, scorecardFound: true,
  resolverStatus: { status: "insufficient-confidence", trigger: "no-osm-numbering", confidence: 0, hadScorecard: true }
};
const SOPHIA = {
  centre: { lat: 37.1780373, lng: 127.7075087 }, courseName: "소피아그린CC",
  osmFeatures: { tees: 0, holes: 0, water: 0, greens: 0, bunkers: 0, elements: 1, fairways: 0, numberedHoles: 0 },
  expectedHoles: 18, scorecardFound: true,
  resolverStatus: { status: "source-load-failed", trigger: "short-of-expected", confidence: 0, hadScorecard: true }
};

(async () => {
  const kinds = await import(path.join(root, "functions", "lib", "gd-mapper-failure-kinds.mjs"));
  const captures = await import(path.join(root, "functions", "lib", "gd-mapper-debug-captures.mjs"));

  test("the September failures sort into the kinds an operator would name", () => {
    assert.strictEqual(kinds.classifyMapperFailure({ error: "no numbered hole geometry found for royal-belfast", diagnostics: BELFAST }).kind, "surfaces-only",
      "eleven greens and no hole lines is 'some green polygons found'");
    assert.strictEqual(kinds.classifyMapperFailure({ error: "no numbered hole geometry found for cc", diagnostics: SOPHIA }).kind, "no-osm-data-with-scorecard");
    assert.strictEqual(kinds.classifyMapperFailure({ error: "x", diagnostics: Object.assign({}, SOPHIA, { scorecardFound: false }) }).kind, "no-osm-data-no-scorecard");
    const unnumbered = Object.assign({}, BELFAST, { osmFeatures: Object.assign({}, BELFAST.osmFeatures, { holes: 18, numberedHoles: 0 }) });
    assert.strictEqual(kinds.classifyMapperFailure({ error: "x", diagnostics: unnumbered }).kind, "holes-unnumbered");
    const partial = Object.assign({}, BELFAST, { osmFeatures: Object.assign({}, BELFAST.osmFeatures, { holes: 18, numberedHoles: 5 }) });
    assert.strictEqual(kinds.classifyMapperFailure({ error: "x", diagnostics: partial }).kind, "partial-numbering");
  });

  test("failures with no OSM counts sort by their error sentence", () => {
    assert.strictEqual(kinds.classifyMapperFailure({ error: "stale-running-reaped: worker died mid-job 8 times", diagnostics: null }).kind, "worker-died");
    assert.strictEqual(kinds.classifyMapperFailure({ error: "course nowhere has no known location in course_maps", diagnostics: null }).kind, "no-course-location");
    assert.strictEqual(kinds.classifyMapperFailure({ error: "Supabase 400: something", diagnostics: { note: "no osmFeatures" } }).kind, "other");
    assert.strictEqual(kinds.classifyMapperFailure({}).kind, "other", "nothing at all is still a kind");
  });

  test("every kind has a label, a plain-words 'when' and a default prompt; 'other' is last", () => {
    kinds.FAILURE_KINDS.forEach(entry => {
      assert.ok(entry.kind && entry.label && entry.when && entry.defaultPrompt, entry.kind + " is complete");
    });
    assert.strictEqual(kinds.FAILURE_KINDS[kinds.FAILURE_KINDS.length - 1].kind, "other");
    assert.strictEqual(kinds.failureKind("not-a-kind").kind, "other", "an unknown kind falls back rather than throwing");
  });

  test("placeholders fill from the job and unknown ones are left visible", () => {
    const filled = kinds.fillPromptTemplate("{{courseName}} at {{centre}} has {{greens}} greens {{mystery}}", { courseName: "Royal Belfast", centre: "54.66015,-5.78477", greens: 11 });
    assert.strictEqual(filled, "Royal Belfast at 54.66015,-5.78477 has 11 greens {{mystery}}");
  });

  test("the routine text opens with the operator's prompt and ends with the diagnostics", () => {
    const job = { id: "job-1", course_id: "royal-belfast", kind: "automap" };
    const failure = { message: "no numbered hole geometry found for royal-belfast", attempts: 1, diagnostics: BELFAST };
    const classified = kinds.classifyMapperFailure({ error: failure.message, diagnostics: BELFAST });
    const text = kinds.buildMapperDebugText({
      job, failure, classified, prompt: "Route {{expectedHoles}} holes between the {{greens}} greens at {{courseName}}.",
      captures: {
        satellite: { url: "https://x/sat.png", attribution: "Esri" }, osm: { url: "https://x/osm.png" },
        bounds: { north: 54.67, south: 54.65, west: -5.80, east: -5.77 }, width: 1024, height: 1024, zoom: 16
      }
    });
    assert.ok(text.startsWith("Route 18 holes between the 11 greens at Royal Belfast Golf Club."), "prompt first, filled: " + text.slice(0, 80));
    const order = ["--- failure ---", "failure_kind: surfaces-only", "job_id: job-1", "--- captures ---", "satellite: https://x/sat.png", "osm: https://x/osm.png", "pixel to coordinate", "--- output contract ---", "```json", "\"kind\": \"fairway\"", "--- diagnostics ---", "\"greens\":11"];
    let at = -1;
    order.forEach(needle => { const next = text.indexOf(needle); assert.ok(next > at, needle + " comes in order"); at = next; });
  });

  test("a huge diagnostics blob is cut, the contract is not", () => {
    const failure = { message: "x", attempts: 1, diagnostics: Object.assign({}, SOPHIA, { blob: "y".repeat(40000) }) };
    const text = kinds.buildMapperDebugText({ job: { id: "j", course_id: "cc" }, failure, classified: kinds.classifyMapperFailure({ error: "x", diagnostics: failure.diagnostics }), prompt: "p", captures: null });
    assert.ok(text.length <= kinds.ROUTINE_TEXT_LIMIT, "within what fireClaudeRoutine will send whole");
    assert.ok(text.includes("--- output contract ---"), "the contract survived");
    assert.ok(text.includes("satellite: not captured"), "no captures is said, not omitted");
  });

  test("the Studio outline is the same builder, not a hand copy", () => {
    const outline = kinds.routineTextOutline("surfaces-only");
    assert.ok(outline.includes("--- captures ---") && outline.includes("--- output contract ---") && outline.includes("failure_kind: surfaces-only"));
  });

  test("the capture grid is whole tiles around the centre and the stated pixel rule is right", () => {
    const grid = captures.captureGridFor(BELFAST.centre);
    assert.strictEqual(grid.tiles.length, 16);
    assert.strictEqual(grid.width, 1024);
    const b = grid.bounds;
    assert.ok(b.north > BELFAST.centre.lat && b.south < BELFAST.centre.lat && b.west < BELFAST.centre.lng && b.east > BELFAST.centre.lng, "centre inside the bounds");
    const nw = captures.pixelToLatLng(grid, 0, 0);
    assert.ok(Math.abs(nw.lat - b.north) < 1e-9 && Math.abs(nw.lng - b.west) < 1e-9, "pixel 0,0 is the north-west corner");
    const mid = captures.pixelToLatLng(grid, grid.width / 2, grid.height / 2);
    assert.ok(Math.abs(mid.lat - BELFAST.centre.lat) < 0.004 && Math.abs(mid.lng - BELFAST.centre.lng) < 0.006, "the middle pixel is within half a tile of the centre");
    assert.strictEqual(captures.captureGridFor({ lat: NaN, lng: 1 }), null);
    assert.ok(captures.osmTileUrl(grid.tiles[0], grid.zoom).startsWith("https://tile.openstreetmap.org/16/"));
    assert.ok(captures.satelliteTileUrl(grid.tiles[0], grid.zoom, "k&y").endsWith("?token=k%26y"));
  });

  test("the purge removes only date folders older than the retention window", async () => {
    const removed = [];
    const now = Date.parse("2026-09-28T12:00:00Z");
    const store = {
      list: async prefix => {
        if (prefix === "mapper-debug/") return [{ name: "2026-09-10", id: null }, { name: "2026-09-27", id: null }, { name: "stray.png", id: "f0" }];
        if (prefix === "mapper-debug/2026-09-10/") return [{ name: "job-a", id: null }];
        if (prefix === "mapper-debug/2026-09-10/job-a/") return [{ name: "satellite.png", id: "f1" }, { name: "osm.png", id: "f2" }];
        throw new Error("unexpected list " + prefix);
      },
      remove: async paths => { removed.push(...paths); }
    };
    const result = await captures.purgeMapperDebugCaptures(store, { now });
    assert.deepStrictEqual(result.dates, ["2026-09-10"], "yesterday's folder stays");
    assert.deepStrictEqual(removed, ["mapper-debug/2026-09-10/job-a/satellite.png", "mapper-debug/2026-09-10/job-a/osm.png"]);
    assert.strictEqual(captures.captureFolder("job/one two", now), "mapper-debug/2026-09-28/job-one-two");
  });

  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (err) { failed++; console.error("  FAIL " + t.name); console.error("       " + (err && err.stack || err)); }
  }
  if (failed) { console.error("mapper-failure-kinds failed: " + failed + "/" + tests.length); process.exit(1); }
  console.log("mapper-failure-kinds passed: " + tests.length + " checks");
})();
