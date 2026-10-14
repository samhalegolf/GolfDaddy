/* Trees found without Studio: a hole's picture (a stored frame, or Esri for the run), the
 * shapes it is looked along read from the course objects, and the stored layer the watch reads.
 *
 * Run: node dev/course-trees-core.test.mjs */

import assert from "node:assert/strict";
import sharp from "sharp";

const lib = await import("../functions/lib/gd-course-trees-core.mjs");
const { pixelToLatLng } = await import("../functions/lib/gd-tile-mosaic-core.mjs");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* A 300 x 200 picture at ~0.45 m/px in the North Island of NZ: a fairway along the bottom, rough above
   it with three textured crowns, a grey-blue shadow and a smooth dark patch (as in
   dev/map-overlay-shapes.test.js). Its playSurface puts it on the ground. */
const W = 300, H = 200;
const WORLD = 256 * Math.pow(2, 18.1);
const playSurface = { originPx: { x: Math.round(0.986 * WORLD), y: Math.round(0.6 * WORLD) }, captureZoom: 18.1, outputDimensions: { width: W, height: H } };
const georef = { playSurface };
const ll = (x, y) => pixelToLatLng(georef, { x, y });
const CROWNS = [{ x: 40, y: 80, r: 12 }, { x: 90, y: 75, r: 12 }, { x: 140, y: 82, r: 12 }];
function picture() {
  const data = new Uint8ClampedArray(W * H * 4);
  let seed = 23;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const inDisc = (x, y, c) => Math.hypot(x - c.x, y - c.y) <= c.r;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    let rgb, n;
    if (CROWNS.some(c => inDisc(x, y, c))) { rgb = [40, 75, 35]; n = (rnd() - 0.5) * 50; }
    else if (inDisc(x, y, { x: 200, y: 80, r: 14 })) { rgb = [45, 50, 62]; n = (rnd() - 0.5) * 40; }
    else if (inDisc(x, y, { x: 255, y: 70, r: 16 })) { rgb = [45, 75, 35]; n = (rnd() - 0.5) * 4; }
    else if (y >= 120) { rgb = [110, 160, 75]; n = (rnd() - 0.5) * 12; }
    else { rgb = [85, 125, 60]; n = (rnd() - 0.5) * 12; }
    data[i] = rgb[0] + n; data[i + 1] = rgb[1] + n; data[i + 2] = rgb[2] + n; data[i + 3] = 255;
  }
  return { width: W, height: H, data, playSurface };
}
const fairway = [ll(-5, 120), ll(305, 120), ll(305, 205), ll(-5, 205)];
const OBJECTS = {
  f1: { type: "fairway_area", holeNumber: 1, shape: fairway },
  f1b: { type: "fairway_area", holeNumber: 2, shape: fairway },
  g: { type: "green", holeNumber: 1, position: ll(280, 160) },
  t: { type: "tee", holeNumber: 1, position: ll(10, 160) },
  b: { type: "bunker", holeNumber: 1, shape: [ll(100, 100), ll(110, 100), ll(110, 110)] }
};

test("a course's objects become each hole's play shapes and the course's surfaces, once each", () => {
  const inputs = lib.courseTreeInputs(OBJECTS);
  assert.deepStrictEqual(inputs.holes, [1, 2]);
  assert.strictEqual(inputs.play.get(1).length, 2, "hole 1: its fairway and its green");
  assert.strictEqual(inputs.turf.length, 2, "the fairway stored on two holes is one piece of turf");
  assert.strictEqual(inputs.surfaces.length, 4, "fairway, green, tee and bunker, each once");
});

test("a hole's picture: the crowns beside its fairway are found at every level, nothing on the turf, shadow or smooth rough", () => {
  const inputs = lib.courseTreeInputs(OBJECTS);
  const out = lib.findTreesOnPicture({ picture: picture(), play: inputs.play.get(1), inputs, bandM: 45 });
  const at = out.trees.filter(t => t.l <= lib.TREE_DEFAULT_LEVEL);
  CROWNS.forEach(c => {
    const where = ll(c.x, c.y);
    assert.ok(at.some(t => Math.hypot((t.lat - where.lat) * 111320, (t.lng - where.lng) * 111320 * Math.cos(where.lat * Math.PI / 180)) < 3), "missed the crown at " + c.x + "," + c.y);
  });
  assert.strictEqual(at.length, CROWNS.length, "found " + at.length);
  assert.ok(at.every(t => t.r > 3 && t.r < 9), "crowns are a few metres across");
});

test("neighbouring holes' trees merge to one each, the stricter kept", () => {
  const a = { lat: -37.78, lng: 175.28, r: 4, l: 3, h: 0 };
  const b = { lat: -37.78, lng: 175.28 + 1 / 111320, r: 4, l: 1, h: 0 };
  const c = { lat: -37.7801, lng: 175.2801, r: 4, l: 0, h: 0 };
  const merged = lib.mergeTrees([[a, c], [b]]);
  assert.strictEqual(merged.length, 2);
  assert.ok(merged.some(t => t === b) && !merged.some(t => t === a));
});

test("the stored layer is compact, reads back, and the watch takes the trees at its level", () => {
  const trees = [{ lat: -37.123456789, lng: 175.987654321, r: 4.44, l: 0, h: 0 }, { lat: -37.1, lng: 175.9, r: 5, l: 4, h: 0 }, { lat: -37.2, lng: 175.8, r: 5, l: 5, h: 1 }];
  const packed = lib.packTrees(trees);
  assert.ok(JSON.stringify(packed).length < 120, "a few dozen bytes a tree");
  assert.deepStrictEqual(lib.unpackTrees(packed)[0], { lat: -37.1234568, lng: 175.9876543, r: 4.4, l: 0, h: 0 });
  assert.strictEqual(lib.liveTrees({ trees: packed, level: 2 }).length, 2, "the one found from height stands at every level");
  assert.strictEqual(lib.liveTrees({ trees: packed, level: 5 }).length, 3);
  assert.deepStrictEqual(lib.liveTrees(null), []);
});

test("a whole course reads each hole off its own frame, scaled to the finder's resolution", async () => {
  /* The frame is baked twice as fine as the finder reads: it is halved, and the georeference
     follows. */
  const fine = picture();
  const big = await sharp(Buffer.from(fine.data.buffer), { raw: { width: W, height: H, channels: 4 } }).resize(W * 2, H * 2).png().toBuffer();
  const framePlay = { originPx: { x: playSurface.originPx.x * 2, y: playSurface.originPx.y * 2 }, captureZoom: playSurface.captureZoom + 1, outputDimensions: { width: W * 2, height: H * 2 } };
  const asked = [];
  const out = await lib.findCourseTrees({ f1: OBJECTS.f1, g: OBJECTS.g, t: OBJECTS.t }, {
    frames: new Map([[1, { path: "c/h1.jpg", playSurface: framePlay }]]),
    downloadFrame: async path => { asked.push(path); return big; },
    sharp
  });
  assert.deepStrictEqual(asked, ["c/h1.jpg"]);
  assert.strictEqual(out.holes[1].source, "frame");
  assert.strictEqual(out.imagery, "frames");
  assert.strictEqual(out.trees.filter(t => t.l <= lib.TREE_DEFAULT_LEVEL).length, CROWNS.length, JSON.stringify(out.holes));
});

test("a hole with no frame asks Esri, and says why when it cannot", async () => {
  const out = await lib.findCourseTrees({ f1: OBJECTS.f1 }, { frames: new Map(), esriKey: "", sharp });
  assert.ok(/Esri key/.test(out.holes[1].error), "no key, no Esri: " + JSON.stringify(out.holes));
  assert.ok(lib.esriTileUrl({ z: 18, x: 5, y: 7 }, "k").includes("/tile/18/7/5?token=k"), "Esri tiles are z/y/x");
});

let failed = 0;
for (const t of tests) {
  try { await t.fn(); console.log("  ok  " + t.name); }
  catch (error) { failed++; console.log("FAIL  " + t.name + "\n      " + (error && error.stack || error)); }
}
console.log((failed ? "FAILED " + failed + "/" : "passed ") + tests.length + " course trees checks");
process.exit(failed ? 1 : 0);
