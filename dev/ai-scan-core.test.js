/* AI scan core, locked: what the model is asked, what shape it must answer in, how the
 * answer is read. Pure functions, so this runs with no key and no network.
 *
 * Run: node dev/ai-scan-core.test.js
 */
const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let core = null;
let georef = null;

const COURSE = { courseId: "royal-belfast", name: "Royal Belfast Golf Club" };
const CARD = { holes: [
  { holeNumber: 1, par: 4, distanceM: 366 }, { hole: 2, par: 3, yards: 165 }, { number: 3, par: 5, metres: 480 }, { holeNumber: "x" }
] };

test("the output schema is strict JSON of pixel polygons, each optionally replacing a recorded shape", () => {
  const schema = core.AI_SCAN_OUTPUT_SCHEMA;
  assert.strictEqual(schema.additionalProperties, false);
  assert.deepStrictEqual(schema.required, ["features", "notes"]);
  const feature = schema.properties.features.items;
  assert.deepStrictEqual(feature.properties.kind.enum, ["fairway", "green", "tee", "bunker"], "bunkers only to shape a pin or refit a recorded bunker - never water or hole numbers as shapes");
  assert.strictEqual(feature.properties.replaces.type, "string", "a shape can name the recorded one it replaces");
  assert.ok(!feature.required.includes("replaces"), "replaces is optional - a traced shape is new");
  assert.strictEqual(feature.properties.points.items.items.type, "integer", "pixels are integer [x, y] pairs");
  assert.ok(feature.required.includes("confidence"));
  assert.ok(!feature.required.includes("hole"), "hole is optional - the resolver numbers, not the model");
  /* The API's schema language refuses these; the first live scan died on maxItems. */
  const text = JSON.stringify(schema);
  ["minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "pattern"].forEach(word => {
    assert.ok(!text.includes('"' + word + '"'), "schema uses an unsupported constraint: " + word);
  });
  assert.ok(!text.includes('["integer","null"]'), "no type unions - keep the schema to what structured outputs accepts");
});

test("scorecard lines tolerate every parser's field names and skip junk", () => {
  assert.deepStrictEqual(core.scorecardLines(CARD), ["hole 1 par 4 366m", "hole 2 par 3 165yd", "hole 3 par 5 480m"]);
  assert.deepStrictEqual(core.scorecardLines(null), []);
});

test("the prompt tells the model the picture's scale, the card as context, and not to number", () => {
  const g = georef.imageGeoreference({ centre: { lat: 54.66015, lng: -5.78477 }, zoom: 17, width: 1024, height: 768 });
  const prompt = core.buildScanPrompt({ course: COURSE, scorecard: CARD, georef: g, notes: "the 9th is by the clubhouse" });
  assert.ok(prompt.includes("Royal Belfast Golf Club"));
  assert.ok(prompt.includes("1024 x 768 pixels"));
  assert.ok(/about 0\.6\d metres per pixel/.test(prompt), "metres per pixel is stated: " + prompt.match(/about [\d.]+ metres per pixel/));
  assert.ok(/a green is typically 20-40 m across \(\d+-\d+ px\)/.test(prompt), "the green's size is given in this picture's pixels");
  assert.ok(prompt.includes("hole 2 par 3 165yd"), "the card is in the prompt");
  assert.ok(/never for numbering/.test(prompt), "the card is context, never a numbering key");
  assert.ok(prompt.includes("From the operator: the 9th is by the clubhouse"));
  assert.ok(prompt.includes("stopping short of the green"), "fairways must not swallow the green - the resolver measures fairway-to-green distance");
  assert.ok(prompt.includes("practice greens"), "practice areas are excluded, the resolver has no image to tell them apart by");
  /* Evidence first, routing second. */
  const order = ["1. GREENS", "2. FAIRWAYS", "3. TEES", "4. CHECK"].map(step => prompt.indexOf(step));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), "the four steps are present and in order: " + JSON.stringify(order));
  assert.ok(prompt.includes("by appearance alone"), "greens are found by what they look like");
  assert.ok(prompt.includes("Never place a green because the routing suggests one should be there"), "an inferred green is forbidden");
  assert.ok(prompt.includes("At the far end of each fairway from its green"), "tees are looked for beyond the fairway start");
  assert.ok(!prompt.includes("Image 2"), "no course map, no mention of one");
  const withMap = core.buildScanPrompt({ course: COURSE, scorecard: CARD, georef: g, courseMap: true });
  assert.ok(withMap.includes("Image 2 is the club's own course map"), "the course map is introduced as image 2");
  assert.ok(withMap.includes("never take a coordinate from it"), "the course map is a tie-breaker, never a coordinate source");
  assert.ok(withMap.indexOf("Image 2") < withMap.indexOf("1. GREENS"), "the map is described before the steps that may use it");
  const noCard = core.buildScanPrompt({ course: COURSE, scorecard: null, georef: g });
  assert.ok(noCard.includes("No scorecard is available"));
});

test("the grid and the known greens drawn on the picture are explained, and known greens are not asked for again", () => {
  const g = georef.imageGeoreference({ centre: { lat: 54.66015, lng: -5.78477 }, zoom: 17, width: 1024, height: 768 });
  const prompt = core.buildScanPrompt({
    course: COURSE, scorecard: null, georef: g, grid: 128,
    anchors: [{ kind: "green", label: "G1", x: 300, y: 400 }, { kind: "green", label: "G2", x: 700, y: 120 }]
  });
  assert.ok(prompt.includes("every 128 pixels"), "the grid spacing is stated");
  assert.ok(/Read every coordinate you return off this grid/.test(prompt), "the grid is declared authoritative");
  assert.ok(prompt.includes("G1 (300, 400), G2 (700, 120)"), "known greens are listed with their pixel centres");
  assert.ok(prompt.includes("Do not return them; find every other green by the same appearance"), "known greens are examples of appearance and excluded from the answer");
  const bare = core.buildScanPrompt({ course: COURSE, scorecard: null, georef: g });
  assert.ok(!bare.includes("coordinate grid") && !bare.includes("already been mapped"), "no grid or anchors, nothing said about them");
});

const SHAPE = { label: "S1", id: "f-3", kind: "green", hole: 7, pixels: [{ x: 290, y: 390 }, { x: 310, y: 390 }, { x: 310, y: 410 }, { x: 290, y: 410 }] };
const PIN = { label: "P1", id: "f-9", kind: "bunker", hole: null, pin: true, pixels: [{ x: 500, y: 200 }] };
const FAIRWAY_PIN = { label: "P2", id: "f-10", kind: "fairway", hole: 4, pin: true, pixels: [{ x: 100, y: 600 }, { x: 400, y: 300 }] };

test("the job follows what is in view: pins - complete, shapes only - refine, nothing - trace", () => {
  assert.strictEqual(core.scanJob([]), "trace");
  assert.strictEqual(core.scanJob([SHAPE]), "refine");
  assert.strictEqual(core.scanJob([SHAPE, PIN]), "complete", "one pin in view makes it the full job");
});

test("a refine pass asks only for corrections to the recorded shapes, by label", () => {
  const g = georef.imageGeoreference({ centre: { lat: 54.66015, lng: -5.78477 }, zoom: 17, width: 1024, height: 768 });
  const prompt = core.buildScanPrompt({ course: COURSE, scorecard: CARD, georef: g, shapes: [SHAPE] });
  assert.ok(prompt.includes("This is a REFINE pass. Do not map the course again."));
  assert.ok(prompt.includes("S1: green outline [[290, 390], [310, 390], [310, 410], [290, 410]] (hole 7)"), "each recorded shape is listed with its corners in this picture");
  assert.ok(prompt.includes("Leave out every shape that already fits well. Return no new shapes"), "fitting shapes are left alone and nothing new is added");
  assert.ok(prompt.includes("never move a shape onto different ground"));
  assert.ok(!prompt.includes("1. GREENS"), "no trace steps on a refine pass");
});

test("a complete pass shapes every pin, refits recorded shapes, then traces what is missing", () => {
  const g = georef.imageGeoreference({ centre: { lat: 54.66015, lng: -5.78477 }, zoom: 17, width: 1024, height: 768 });
  const prompt = core.buildScanPrompt({ course: COURSE, scorecard: CARD, georef: g, shapes: [SHAPE, PIN, FAIRWAY_PIN] });
  assert.ok(prompt.includes("This is a COMPLETE pass."));
  assert.ok(prompt.includes("P1: bunker pin, centre [[500, 200]]") && prompt.includes("P2: fairway pin, start and end [[100, 600], [400, 300]] (hole 4)"), "pins are listed with their points");
  assert.ok(prompt.includes("never drop a pin or move it to other ground"), "the pins are trusted");
  assert.ok(prompt.includes("2. RECORDED SHAPES. Where a recorded outline (S1)"), "recorded shapes are refitted on the same pass");
  const order = ["1. PINS", "2. RECORDED SHAPES", "3. ANYTHING STILL MISSING", "1. GREENS"].map(step => prompt.indexOf(step));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), "pins first, then shapes, then the trace: " + JSON.stringify(order));
  assert.ok(prompt.includes("Never return a new bunker"));
});

test("an answer that replaces a recorded shape is saved under its id, kind and hole; what was not asked for is dropped", () => {
  const box = [[1, 1], [9, 1], [9, 9], [1, 9]];
  const complete = core.parseScanAnswer({ features: [
    { kind: "bunker", points: box, replaces: "p1", confidence: 0.7 },
    { kind: "green", points: box, replaces: "S1", hole: 2, confidence: 0.8 },
    { kind: "fairway", points: box, replaces: "S1", confidence: 0.5 },
    { kind: "green", points: box, replaces: "S9", confidence: 0.5 },
    { kind: "bunker", points: box, confidence: 0.5 },
    { kind: "tee", points: box, confidence: 0.6 }
  ], notes: "" }, [SHAPE, PIN]);
  assert.strictEqual(complete.job, "complete");
  assert.deepStrictEqual(complete.features.map(f => f.id), ["f-9", "f-3", "tee-ai-6"], "replacements take the recorded id; a new tee is new");
  assert.strictEqual(complete.features[1].hole, 7, "a replacement keeps the recorded hole number, not one the model gave");
  assert.strictEqual(complete.features[0].kind, "bunker");
  assert.deepStrictEqual(complete.dropped.map(d => d.index), [2, 3, 4], "a second answer for S1, an unknown label and a new bunker are dropped: " + JSON.stringify(complete.dropped));
  const refine = core.parseScanAnswer({ features: [
    { kind: "fairway", points: box, replaces: "S1", confidence: 0.5 },
    { kind: "green", points: box, confidence: 0.9 }
  ], notes: "" }, [SHAPE]);
  assert.strictEqual(refine.job, "refine");
  assert.deepStrictEqual(refine.features.map(f => [f.id, f.kind]), [["f-3", "green"]], "a correction keeps the recorded kind; a new shape on a refine pass is dropped");
  assert.strictEqual(refine.dropped[0].reason, "a new shape on a refine pass");
});

test("the answer is read whether it arrives as an object, JSON text, a fenced block or prose around JSON", () => {
  const shape = { features: [{ kind: "fairway", points: [[1, 2], [30, 2], [30, 10], [1, 10]], hole: null, confidence: 0.8 }, { kind: "green", points: [[40, 5], [50, 5], [50, 15]], confidence: 0.6 }], notes: "hole at the edge" };
  const fromObject = core.parseScanAnswer(shape);
  assert.strictEqual(fromObject.features.length, 2);
  assert.deepStrictEqual(fromObject.features.map(f => f.id), ["fairway-ai-1", "green-ai-2"]);
  assert.strictEqual(core.parseScanAnswer({ features: [{ kind: "tee", points: [[1, 1], [9, 1], [9, 5], [1, 5]], confidence: 0.5 }], notes: "" }).features[0].id, "tee-ai-1", "a tee keeps its kind");
  assert.strictEqual(fromObject.features[0].confidence, 0.8);
  const limits = core.parseScanAnswer({ features: [{ kind: "fairway", points: Array.from({ length: 40 }, (_, i) => [i, i]), confidence: 7, hole: 99 }], notes: "" });
  assert.strictEqual(limits.features[0].points.length, core.AI_SCAN_MAX_POINTS, "the parser caps corners since the schema cannot");
  assert.strictEqual(limits.features[0].confidence, 1, "confidence is clamped");
  assert.strictEqual(limits.features[0].hole, null, "99 is not a hole number");
  assert.strictEqual(fromObject.notes, "hole at the edge");
  assert.strictEqual(core.parseScanAnswer(JSON.stringify(shape)).features.length, 2);
  assert.strictEqual(core.parseScanAnswer("```json\n" + JSON.stringify(shape) + "\n```").features.length, 2);
  assert.strictEqual(core.parseScanAnswer("Here you go: " + JSON.stringify(shape) + " - done.").features.length, 2);
  assert.strictEqual(core.parseScanAnswer(JSON.stringify(shape.features)).features.length, 2, "a bare array is accepted");
  assert.strictEqual(core.parseScanAnswer("no shapes here").error, "answer was not JSON");
  assert.strictEqual(core.parseScanAnswer("").error, "answer was not JSON");
  assert.strictEqual(core.parseScanAnswer(null).error, "answer was empty");
});

test("a parsed answer converts through the georef core into overlay features", () => {
  const g = georef.imageGeoreference({ centre: { lat: 54.66015, lng: -5.78477 }, zoom: 16, width: 1568, height: 1176 });
  const parsed = core.parseScanAnswer({ features: [
    { kind: "fairway", points: [[100, 500], [400, 500], [400, 540], [100, 540]], confidence: 0.9 },
    { kind: "green", points: [[420, 505], [440, 500], [445, 530], [420, 535]], confidence: 0.7 },
    { kind: "green", points: [[9000, 9000], [9010, 9000], [9010, 9010]], confidence: 0.2 }
  ], notes: "" });
  const out = georef.aiShapesToOverlay(parsed.features, g);
  assert.deepStrictEqual(out.features.map(f => f.kind), ["fairway", "green"]);
  assert.ok(out.features.every(f => f.source === "ai"));
  assert.strictEqual(out.dropped.length, 1, "the off-image green is dropped with a reason: " + JSON.stringify(out.dropped));
});

(async () => {
  core = await import(path.join(root, "functions", "lib", "gd-ai-scan-core.mjs"));
  georef = await import(path.join(root, "functions", "lib", "gd-overlay-georef-core.mjs"));
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.stack || error)); }
  }
  console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " ai scan core checks");
  process.exit(failed ? 1 : 0);
})();
