/* The close-up pass of a pin scan, locked: which pins are checked, where the crops are cut,
 * what the model is asked, how its checks are read, and what they do to the pins. Pure
 * functions, plus one real render through sharp so the crop pipeline is proven to cut.
 *
 * Run: node dev/ai-scan-verify-core.test.js
 */
const assert = require("assert");
const path = require("path");

const root = path.join(__dirname, "..");
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let core = null;
let crops = null;

const GEOREF = { width: 1568, height: 1045, metresPerPixel: 0.6 };
const FEATURES = [
  { id: "green-ai-1", kind: "green", pin: true, hole: 7, points: [[300, 400]], seen: "smooth light oval", confidence: 0.9 },
  { id: "tee-ai-2", kind: "tee", pin: true, hole: 7, points: [[100, 600]], confidence: 0.6 },
  { id: "fairway-ai-3", kind: "fairway", pin: true, hole: 7, points: [[120, 580], [280, 420]], confidence: 0.8 },
  { id: "green-ai-4", kind: "green", pin: true, hole: 8, points: [[1550, 20]], confidence: 0.4 },
  { id: "bunker-ai-5", kind: "bunker", pin: true, hole: null, points: [[310, 410]], confidence: 0.7 },
  { id: "green-ai-6", kind: "green", points: [[10, 10], [20, 10], [20, 20], [10, 20]], confidence: 0.9 }
];

test("only single-point green and tee pins are checked, in answer order, capped", () => {
  const targets = core.verifyTargets(FEATURES);
  assert.deepStrictEqual(targets.map(t => t.id), ["green-ai-1", "tee-ai-2", "green-ai-4"], "fairways, bunkers and outlines are not looked at");
  assert.deepStrictEqual(targets[0], { id: "green-ai-1", kind: "green", hole: 7, seen: "smooth light oval", x: 300, y: 400 });
  const many = Array.from({ length: 60 }, (_, i) => ({ id: "g" + i, kind: "green", pin: true, points: [[i, i]] }));
  assert.strictEqual(core.verifyTargets(many).length, core.VERIFY_MAX_CROPS);
});

test("a crop is a fixed window in metres around the pin, slid inside the image, scaled up, with the pin's place known", () => {
  const windows = core.cropWindows(core.verifyTargets(FEATURES), GEOREF);
  const side = Math.round(core.VERIFY_WINDOW_M / GEOREF.metresPerPixel);
  assert.strictEqual(windows[0].side, side, "220 m at 0.6 m/px");
  assert.deepStrictEqual([windows[0].left, windows[0].top], [Math.round(300 - side / 2), Math.round(400 - side / 2)]);
  assert.strictEqual(windows[0].outPx, core.VERIFY_CROP_PX);
  assert.ok(Math.abs(windows[0].pin.x - core.VERIFY_CROP_PX / 2) <= 2 && Math.abs(windows[0].pin.y - core.VERIFY_CROP_PX / 2) <= 2, "a pin well inside the image sits at the crop's centre");
  assert.ok(Math.abs(windows[0].metresPerPixel - GEOREF.metresPerPixel / windows[0].scale) < 1e-9);
  /* The corner pin: the window slides, the pin is near the crop's top-right. */
  const corner = windows[2];
  assert.deepStrictEqual([corner.left, corner.top], [GEOREF.width - side, 0]);
  assert.ok(corner.pin.y < 40 && corner.pin.x > core.VERIFY_CROP_PX - 40, "the pin is drawn where it really is in the slid window: " + JSON.stringify(corner.pin));
  assert.deepStrictEqual(windows.map(w => w.crop), [1, 2, 3]);
  /* A picture smaller than the window: the window is the whole picture. */
  const tiny = core.cropWindows([{ id: "g", kind: "green", x: 50, y: 50 }], { width: 200, height: 150, metresPerPixel: 0.6 });
  assert.deepStrictEqual([tiny[0].side, tiny[0].left, tiny[0].top], [150, 0, 0]);
});

test("the overlay drawn on a crop is a labelled grid and a magenta crosshair on the pin", () => {
  const svg = core.cropOverlaySvg({ outPx: 640, pin: { x: 320, y: 300 } });
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640">'));
  assert.ok(svg.includes(">128<") && svg.includes(">512<") && !svg.includes(">640<"), "labels at every grid line inside the crop");
  assert.ok(svg.includes('<circle cx="320" cy="300"') && svg.includes('stroke="#ff2fd6"'), "the pin ring, in a colour no golf course has");
});

test("the question names every crop, its kind and hole, the scale, and asks for confirmed / moved / missing by what is seen", () => {
  const windows = core.cropWindows(core.verifyTargets(FEATURES), GEOREF);
  const prompt = core.buildVerifyPrompt({ course: { name: "Karana Downs" }, windows });
  assert.ok(prompt.includes("close-ups cut from the satellite image of Karana Downs"));
  assert.ok(prompt.includes("Crop 1: the green pin for hole 7, marked at (" + windows[0].pin.x + ", " + windows[0].pin.y + ') - the first pass said it saw "smooth light oval"'));
  assert.ok(prompt.includes("Crop 2: the tee pin for hole 7, marked at"));
  ["\"confirmed\" when the feature of that kind IS under the crosshair", "\"moved\" when a feature of that kind is visible elsewhere in the crop", "\"missing\" when nothing of that kind is visible anywhere in the crop", "a pin on water, a roof, a road, bare earth or tree canopy is wrong", "never by where the pin is or what the first pass said"].forEach(phrase => {
    assert.ok(prompt.includes(phrase), "the question says: " + phrase);
  });
  assert.ok(/is \d+-\d+ px across/.test(prompt), "a green's size is given in crop pixels");
  const schema = core.VERIFY_OUTPUT_SCHEMA;
  assert.deepStrictEqual(schema.properties.checks.items.properties.verdict.enum, ["confirmed", "moved", "missing"]);
  assert.ok(!JSON.stringify(schema).includes("minItems") && !JSON.stringify(schema).includes("maximum"), "the schema dialect the API accepts");
});

test("checks are read by crop number and a moved point comes back in scan-image pixels; slips read as unanswered", () => {
  const windows = core.cropWindows(core.verifyTargets(FEATURES), GEOREF);
  const w = windows[0];
  const answer = { checks: [
    { crop: 1, verdict: "moved", point: [w.pin.x + 100, w.pin.y - 50], seen: "green 50 m east", confidence: 0.8 },
    { crop: 2, verdict: "missing", seen: "river", confidence: 0.95 },
    { crop: 3, verdict: "moved", point: [9000, 1], seen: "?", confidence: 0.3 },
    { crop: 3, verdict: "confirmed", seen: "late duplicate", confidence: 1 },
    { crop: 9, verdict: "confirmed", seen: "no such crop", confidence: 1 },
    { crop: 1, verdict: "confirmed", seen: "second answer, ignored", confidence: 1 }
  ], notes: "lined up fine" };
  const parsed = core.parseVerifyAnswer(answer, windows);
  assert.strictEqual(parsed.error, undefined);
  assert.strictEqual(parsed.checks[1].verdict, "moved");
  assert.deepStrictEqual(parsed.checks[1].point, { x: Math.round(w.left + (w.pin.x + 100) / w.scale), y: Math.round(w.top + (w.pin.y - 50) / w.scale) });
  assert.strictEqual(parsed.checks[1].seen, "green 50 m east", "the first answer for a crop wins");
  assert.strictEqual(parsed.checks[2].verdict, "missing");
  assert.strictEqual(parsed.checks[3].verdict, "confirmed", "a moved point outside the crop is not a check, so the next answer for that crop counts");
  assert.strictEqual(parsed.checks[9], undefined);
  assert.strictEqual(parsed.notes, "lined up fine");
  /* A "moved" that lands within a few metres of the pin is a confirmation. */
  const nudge = core.parseVerifyAnswer({ checks: [{ crop: 1, verdict: "moved", point: [w.pin.x + 3, w.pin.y + 2], seen: "green", confidence: 0.9 }], notes: "" }, windows);
  assert.strictEqual(nudge.checks[1].verdict, "confirmed");
  assert.strictEqual(nudge.checks[1].point, undefined);
  /* Text forms. */
  assert.strictEqual(core.parseVerifyAnswer("```json\n" + JSON.stringify(answer) + "\n```", windows).checks[2].verdict, "missing");
  assert.strictEqual(core.parseVerifyAnswer("nothing", windows).error, "answer was not JSON");
  assert.strictEqual(core.parseVerifyAnswer(null, windows).error, "answer was empty");
});

test("applying the checks: moved pins take their new point, missing ones are dropped with the ground, fairways follow their hole's ends, the rest are kept", () => {
  const windows = core.cropWindows(core.verifyTargets(FEATURES), GEOREF);
  const w = windows[0];
  const parsed = core.parseVerifyAnswer({ checks: [
    { crop: 1, verdict: "moved", point: [w.pin.x + 100, w.pin.y - 50], seen: "green 50 m east", confidence: 0.8 },
    { crop: 2, verdict: "missing", seen: "river", confidence: 0.95 }
  ], notes: "" }, windows);
  const out = core.applyVerification(FEATURES, parsed, windows);
  assert.deepStrictEqual(out.summary, { checked: 3, confirmed: 0, moved: 1, missing: 1, unanswered: 1 });
  assert.deepStrictEqual(out.features.map(f => f.id), ["green-ai-1", "fairway-ai-3", "green-ai-4", "bunker-ai-5", "green-ai-6"], "the tee on the river is gone; the unanswered green stays");
  assert.deepStrictEqual(out.dropped, [{ index: 1, reason: "close-up: no tee for hole 7 at the pin - river" }]);
  const green = out.features[0];
  const dx = parsed.checks[1].point.x - 300, dy = parsed.checks[1].point.y - 400;
  assert.deepStrictEqual(green.points, [[300 + dx, 400 + dy]]);
  assert.strictEqual(green.moved, true);
  assert.strictEqual(green.seen, "green 50 m east", "what the close-up saw replaces the first pass's words");
  const fairway = out.features[1];
  assert.deepStrictEqual(fairway.points, [[120, 580], [280 + dx, 420 + dy]], "the fairway's end follows hole 7's green; its start stays because the tee was dropped, not moved");
  assert.strictEqual(fairway.moved, true);
  assert.strictEqual(out.features[2].moved, undefined);
  assert.strictEqual(FEATURES[0].points[0][0], 300, "the input is not mutated");
  /* Nothing answered: nothing changes. */
  const none = core.applyVerification(FEATURES, { checks: {} }, windows);
  assert.strictEqual(none.features.length, FEATURES.length);
  assert.deepStrictEqual(none.summary, { checked: 3, confirmed: 0, moved: 0, missing: 0, unanswered: 3 });
});

test("the cropper really cuts: a crop comes back as a PNG of the right size with the overlay on it", async () => {
  const sharp = require("sharp");
  const source = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 60, g: 120, b: 60 } } }).jpeg().toBuffer();
  const windows = core.cropWindows([{ id: "g", kind: "green", hole: 1, x: 400, y: 300 }], { width: 800, height: 600, metresPerPixel: 0.6 });
  const out = await crops.renderCrops({ mediaType: "image/jpeg", data: source.toString("base64") }, windows);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual([out[0].crop, out[0].mediaType], [1, "image/png"]);
  const meta = await sharp(Buffer.from(out[0].data, "base64")).metadata();
  assert.deepStrictEqual([meta.width, meta.height, meta.format], [core.VERIFY_CROP_PX, core.VERIFY_CROP_PX, "png"]);
  /* The crosshair is magenta at the pin, the ground is green beside it. */
  const img = sharp(Buffer.from(out[0].data, "base64"));
  const { x, y } = windows[0].pin;
  const ring = await img.clone().extract({ left: x + 22 - 1, top: y - 1, width: 3, height: 3 }).raw().toBuffer();
  assert.ok(ring[0] > 200 && ring[1] < 100 && ring[2] > 150, "the ring is drawn on the pin: " + Array.from(ring.slice(0, 3)));
  const turf = await img.clone().extract({ left: x + 60, top: y + 60, width: 1, height: 1 }).raw().toBuffer();
  assert.ok(turf[1] > turf[0] && turf[1] > turf[2], "the ground is still the picture");
});

(async () => {
  core = await import(path.join(root, "functions", "lib", "gd-ai-scan-verify-core.mjs"));
  crops = await import(path.join(root, "functions", "lib", "gd-ai-scan-crops.mjs"));
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log("  ok  " + t.name); }
    catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.stack || error)); }
  }
  console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " ai scan verify checks");
  process.exit(failed ? 1 : 0);
})();
