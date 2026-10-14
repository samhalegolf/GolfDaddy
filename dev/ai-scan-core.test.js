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
  assert.ok(prompt.includes("From the operator, for this scan: the 9th is by the clubhouse"));
  /* No task named and nothing in view: the trace task, with its default words. */
  assert.ok(prompt.includes("YOUR TASK (Trace outlines):"), "an empty view with no task runs the trace task");
  assert.ok(prompt.includes("stopping short of the green"), "fairways must not swallow the green - the resolver measures fairway-to-green distance");
  assert.ok(prompt.includes("practice greens"), "practice areas are excluded, the resolver has no image to tell them apart by");
  const order = ["1. GREENS", "2. FAIRWAYS", "3. TEES", "4. CHECK"].map(step => prompt.indexOf(step));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), "the four steps are present and in order: " + JSON.stringify(order));
  assert.ok(prompt.includes("by appearance alone"), "greens are found by what they look like");
  assert.ok(prompt.includes("Never place a green because the routing suggests one should be there"), "an inferred green is forbidden");
  assert.ok(prompt.includes("OUTPUT RULES. Polygons are lists of [x, y] integer pixel corners"), "the outline rules close the prompt");
  assert.ok(prompt.indexOf("YOUR TASK") < prompt.indexOf("OUTPUT RULES"), "the task comes before the output rules");
  assert.ok(prompt.indexOf("The scorecard") < prompt.indexOf("YOUR TASK"), "the scaffold comes before the task");
  assert.ok(!prompt.includes("Image 2"), "no course map, no mention of one");
  const withMap = core.buildScanPrompt({ course: COURSE, scorecard: CARD, georef: g, courseMap: true });
  assert.ok(withMap.includes("Image 2 is the club's own course map"), "the course map is introduced as image 2");
  assert.ok(withMap.includes("never take a coordinate from it"), "the course map is a tie-breaker, never a coordinate source");
  assert.ok(withMap.indexOf("Image 2") < withMap.indexOf("YOUR TASK"), "the map is described before the task that may use it");
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
  assert.ok(!bare.includes("coordinate grid") && bare.includes("Nothing has been recorded in this view yet"), "no grid or anchors, nothing said about them beyond that the view is empty");
});

const SHAPE = { label: "S1", id: "f-3", kind: "green", hole: 7, pixels: [{ x: 290, y: 390 }, { x: 310, y: 390 }, { x: 310, y: 410 }, { x: 290, y: 410 }] };
const PIN = { label: "P1", id: "f-9", kind: "bunker", hole: null, pin: true, pixels: [{ x: 500, y: 200 }] };
const FAIRWAY_PIN = { label: "P2", id: "f-10", kind: "fairway", hole: 4, pin: true, pixels: [{ x: 100, y: 600 }, { x: 400, y: 300 }] };

test("the tasks: find greens answers with pins and is first; the outline tasks keep the old jobs; a request picks one or the view does", () => {
  assert.deepStrictEqual(core.AI_SCAN_TASKS.map(t => t.id), ["find-greens", "trace", "shape-pins", "refit", "custom"]);
  assert.strictEqual(core.AI_SCAN_TASKS[0].output, "pins", "the first task pins, so the operator shapes natively");
  assert.ok(core.AI_SCAN_TASKS.every(t => core.AI_SCAN_OUTPUTS.includes(t.output)));
  assert.ok(core.AI_SCAN_TASKS.every(t => t.defaultPrompt.length <= core.AI_SCAN_PROMPT_MAX));
  const find = core.scanTask("find-greens").defaultPrompt;
  ["ONE point at its centre", "TWO points", "sample", "hole number", "par 3s have none", "practice greens"].forEach(phrase => {
    assert.ok(find.includes(phrase), "find greens' words mention: " + phrase);
  });
  assert.ok(find.includes("Never place a green because the routing suggests one"), "pins are found by appearance, like outlines");
  assert.strictEqual(core.scanTask("refit").newShapes, false, "refit never adds");
  /* No task named: the view decides, as the first scans did. */
  assert.strictEqual(core.scanJob([]), "trace");
  assert.strictEqual(core.scanJob([SHAPE]), "refine");
  assert.strictEqual(core.scanJob([SHAPE, PIN]), "complete", "one pin in view makes it the full job");
  assert.strictEqual(core.defaultTaskId([]), "trace");
  assert.strictEqual(core.defaultTaskId([SHAPE]), "refit");
  assert.strictEqual(core.defaultTaskId([SHAPE, PIN]), "shape-pins");
  /* A request's task: known id or the default; output and words from the request, the stored
     row, then the task's own; the words capped. */
  const asked = core.resolveTask({ id: "find-greens", prompt: " my words ", output: "nonsense" }, [SHAPE]);
  assert.deepStrictEqual([asked.id, asked.output, asked.prompt, asked.newShapes], ["find-greens", "pins", "my words", true]);
  const stored = core.resolveTask({ id: "custom" }, [], { prompt: "saved words", output: "pins" });
  assert.deepStrictEqual([stored.id, stored.output, stored.prompt], ["custom", "pins", "saved words"], "a request without words runs the saved ones");
  assert.strictEqual(core.resolveTask({ id: "made-up" }, [SHAPE, PIN]).id, "shape-pins", "an unknown task falls back to what fits the view");
  assert.strictEqual(core.resolveTask({ id: "custom", prompt: "x".repeat(9000) }, []).prompt.length, core.AI_SCAN_PROMPT_MAX);
  /* The outline Studio shows is the real prompt around a marker. */
  const outline = core.scanPromptOutline({ id: "find-greens" });
  assert.ok(outline.includes("«your words»") && outline.includes("OUTPUT RULES. Answer with pins") && outline.includes("P1: tee pin, centre [[500, 200]] (hole 1)"));
});

test("a pin task's prompt lists the samples with their hole numbers, and asks for pins, never replacements", () => {
  const g = georef.imageGeoreference({ centre: { lat: 54.66015, lng: -5.78477 }, zoom: 17, width: 1024, height: 768 });
  const task = core.resolveTask({ id: "find-greens" }, [FAIRWAY_PIN]);
  const prompt = core.buildScanPrompt({ course: COURSE, scorecard: CARD, georef: g, shapes: [FAIRWAY_PIN], task });
  assert.ok(prompt.includes("YOUR TASK (Find greens, tees and fairways):"));
  assert.ok(prompt.includes("P2: fairway pin, start and end [[100, 600], [400, 300]] (hole 4)"), "the sample pin is listed with its hole");
  assert.ok(prompt.includes("OUTPUT RULES. Answer with pins, not outlines"));
  assert.ok(prompt.includes("Never set \"replaces\""), "pins never replace");
  assert.ok(!prompt.includes("1. GREENS"), "no outline steps on a pin task");
  const blank = core.buildScanPrompt({ course: COURSE, scorecard: null, georef: g, task: core.resolveTask({ id: "custom", prompt: "" }, []) });
  assert.ok(blank.includes("Map the golf features you can see in image 1"), "a blank prompt still asks for something");
});

test("a refit pass asks only for corrections to the recorded shapes, by label", () => {
  const g = georef.imageGeoreference({ centre: { lat: 54.66015, lng: -5.78477 }, zoom: 17, width: 1024, height: 768 });
  const prompt = core.buildScanPrompt({ course: COURSE, scorecard: CARD, georef: g, shapes: [SHAPE] });
  assert.ok(prompt.includes("This is a REFIT pass. Do not map the course again."));
  assert.ok(prompt.includes("S1: green outline [[290, 390], [310, 390], [310, 410], [290, 410]] (hole 7)"), "each recorded shape is listed with its corners in this picture");
  assert.ok(prompt.includes("Leave out every shape that already fits well. Return no new shapes"), "fitting shapes are left alone and nothing new is added");
  assert.ok(prompt.includes("never move a shape onto different ground"));
  assert.ok(!prompt.includes("1. GREENS"), "no trace steps on a refit pass");
});

test("a shape-pins pass shapes every pin, refits recorded shapes, then traces what is missing", () => {
  const g = georef.imageGeoreference({ centre: { lat: 54.66015, lng: -5.78477 }, zoom: 17, width: 1024, height: 768 });
  const prompt = core.buildScanPrompt({ course: COURSE, scorecard: CARD, georef: g, shapes: [SHAPE, PIN, FAIRWAY_PIN] });
  assert.ok(prompt.includes("This is a COMPLETE pass."));
  assert.ok(prompt.includes("P1: bunker pin, centre [[500, 200]]") && prompt.includes("P2: fairway pin, start and end [[100, 600], [400, 300]] (hole 4)"), "pins are listed with their points");
  assert.ok(prompt.includes("never drop a pin or move it to other ground"), "the pins are trusted");
  assert.ok(prompt.includes("2. RECORDED SHAPES. Where a recorded outline does not fit"), "recorded shapes are refitted on the same pass");
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
  assert.strictEqual(complete.task.id, "shape-pins");
  assert.deepStrictEqual(complete.features.map(f => f.id), ["f-9", "f-3", "tee-ai-6"], "replacements take the recorded id; a new tee is new");
  assert.strictEqual(complete.features[1].hole, 7, "a replacement keeps the recorded hole number, not one the model gave");
  assert.strictEqual(complete.features[0].kind, "bunker");
  assert.ok(complete.features.every(f => !f.pin), "an outline task returns outlines");
  assert.deepStrictEqual(complete.dropped.map(d => d.index), [2, 3, 4], "a second answer for S1, an unknown label and a new bunker are dropped: " + JSON.stringify(complete.dropped));
  const refit = core.parseScanAnswer({ features: [
    { kind: "fairway", points: box, replaces: "S1", confidence: 0.5 },
    { kind: "green", points: box, confidence: 0.9 }
  ], notes: "" }, [SHAPE]);
  assert.strictEqual(refit.job, "refine");
  assert.deepStrictEqual(refit.features.map(f => [f.id, f.kind]), [["f-3", "green"]], "a correction keeps the recorded kind; a new shape on a refit pass is dropped");
  assert.strictEqual(refit.dropped[0].reason, "a new shape on a refit pass");
});

test("a pin task's answer becomes pins: one point for a green, tee or bunker, two for a fairway, hole kept when given, replacements dropped", () => {
  const task = core.resolveTask({ id: "find-greens" }, [FAIRWAY_PIN]);
  const parsed = core.parseScanAnswer({ features: [
    { kind: "green", points: [[300, 400]], hole: 5, confidence: 0.9 },
    { kind: "tee", points: [[100, 700], [110, 705]], confidence: 0.6 },
    { kind: "fairway", points: [[120, 680], [280, 420], [290, 410]], confidence: 0.8 },
    { kind: "bunker", points: [[320, 420]], confidence: 0.5 },
    { kind: "green", points: [[400, 300]], replaces: "P2", confidence: 0.9 },
    { kind: "green", points: [[500, 500]], hole: 99, confidence: 0.4 }
  ], notes: "hole 6 cut off" }, [FAIRWAY_PIN], task);
  assert.strictEqual(parsed.task.output, "pins");
  assert.deepStrictEqual(parsed.features.map(f => [f.kind, f.points.length, f.hole, f.pin]), [
    ["green", 1, 5, true], ["tee", 1, null, true], ["fairway", 2, null, true], ["bunker", 1, null, true], ["green", 1, null, true]
  ], "a pin holds its kind's point count, a hole number only when it is one, and a bunker pin is kept");
  assert.strictEqual(parsed.dropped.length, 1);
  assert.ok(/pins never replace/.test(parsed.dropped[0].reason), parsed.dropped[0].reason);
  /* And through the georef core they land on the overlay as pins, not grown into polygons. */
  const g = georef.imageGeoreference({ centre: { lat: 54.66015, lng: -5.78477 }, zoom: 17, width: 1024, height: 768 });
  const out = georef.aiShapesToOverlay(parsed.features, g);
  assert.strictEqual(out.features.length, 5, JSON.stringify(out.dropped));
  assert.ok(out.features.every(f => f.pin === true && f.source === "ai"), "saved as AI pins");
  assert.deepStrictEqual(out.features.map(f => f.points.length), [1, 1, 2, 1, 1]);
  assert.strictEqual(out.features[0].hole, 5);
  assert.ok(out.pixels.every(p => p.pin === true), "the pixel echo says they are pins, so Studio draws dots");
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
