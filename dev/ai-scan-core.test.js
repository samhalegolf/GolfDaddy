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

test("the output schema is strict JSON of fairway/green pixel polygons, nothing else", () => {
  const schema = core.AI_SCAN_OUTPUT_SCHEMA;
  assert.strictEqual(schema.additionalProperties, false);
  assert.deepStrictEqual(schema.required, ["features", "notes"]);
  const feature = schema.properties.features.items;
  assert.deepStrictEqual(feature.properties.kind.enum, ["fairway", "green"], "the model is never asked for tees, bunkers or hole numbers as shapes");
  assert.strictEqual(feature.properties.points.items.items.type, "integer", "pixels are integer [x, y] pairs");
  assert.strictEqual(feature.properties.points.minItems, 3);
  assert.ok(feature.required.includes("confidence"));
  assert.ok(!feature.required.includes("hole"), "hole is optional - the resolver numbers, not the model");
});

test("scorecard lines tolerate every parser's field names and skip junk", () => {
  assert.deepStrictEqual(core.scorecardLines(CARD), ["hole 1 par 4 366m", "hole 2 par 3 165yd", "hole 3 par 5 480m"]);
  assert.deepStrictEqual(core.scorecardLines(null), []);
});

test("the prompt tells the model the picture's scale, the card as context, and not to number", () => {
  const g = georef.imageGeoreference({ centre: { lat: 54.66015, lng: -5.78477 }, zoom: 17, width: 1024, height: 768 });
  const prompt = core.buildScanPrompt({ course: COURSE, scorecard: CARD, georef: g, existing: ["green around (100, 200)"], notes: "the 9th is by the clubhouse" });
  assert.ok(prompt.includes("Royal Belfast Golf Club"));
  assert.ok(prompt.includes("1024 x 768 pixels"));
  assert.ok(/about 0\.6\d metres per pixel/.test(prompt), "metres per pixel is stated: " + prompt.match(/about [\d.]+ metres per pixel/));
  assert.ok(/a green is typically 20-40 m across \(\d+-\d+ px\)/.test(prompt), "the green's size is given in this picture's pixels");
  assert.ok(prompt.includes("hole 2 par 3 165yd"), "the card is in the prompt");
  assert.ok(/NOT for numbering/.test(prompt), "the card is context, never a numbering key");
  assert.ok(prompt.includes("green around (100, 200)"), "already-saved shapes are named so they are not re-traced");
  assert.ok(prompt.includes("From the operator: the 9th is by the clubhouse"));
  assert.ok(prompt.includes("stopping short of the green"), "fairways must not swallow the green - the resolver measures fairway-to-green distance");
  assert.ok(prompt.includes("practice greens"), "practice areas are excluded, the resolver has no image to tell them apart by");
  const noCard = core.buildScanPrompt({ course: COURSE, scorecard: null, georef: g, existing: [] });
  assert.ok(noCard.includes("No scorecard is available"));
});

test("existing shapes are described at their pixel centre in THIS picture", () => {
  const g = georef.imageGeoreference({ centre: { lat: 54.66015, lng: -5.78477 }, zoom: 17, width: 1024, height: 768 });
  const centreLatLng = g.toLatLng({ x: 300, y: 400 });
  const out = core.describeExisting([
    { kind: "green", hole: 7, points: [g.toLatLng({ x: 290, y: 390 }), g.toLatLng({ x: 310, y: 390 }), g.toLatLng({ x: 310, y: 410 }), g.toLatLng({ x: 290, y: 410 })] },
    { kind: "fairway", points: [] }
  ], p => g.toPx(p));
  assert.deepStrictEqual(out, ["green (hole 7) around (300, 400)"]);
  assert.ok(centreLatLng);
});

test("the answer is read whether it arrives as an object, JSON text, a fenced block or prose around JSON", () => {
  const shape = { features: [{ kind: "fairway", points: [[1, 2], [30, 2], [30, 10], [1, 10]], hole: null, confidence: 0.8 }, { kind: "green", points: [[40, 5], [50, 5], [50, 15]], confidence: 0.6 }], notes: "hole at the edge" };
  const fromObject = core.parseScanAnswer(shape);
  assert.strictEqual(fromObject.features.length, 2);
  assert.deepStrictEqual(fromObject.features.map(f => f.id), ["fairway-ai-1", "green-ai-2"]);
  assert.strictEqual(fromObject.features[0].confidence, 0.8);
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
