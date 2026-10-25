/* scripts/trees/tree-species.js - guessing a tree's species from the aerial photo.
 * Synthetic pictures: a mown-turf background with crowns painted on in the colours and
 * textures each species shows from above. */
const assert = require("assert");
const path = require("path");
const S = require(path.join(__dirname, "..", "scripts", "trees", "tree-species.js"));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const PPM = 3;           // pixels per metre, about the 3D viewer's
const TURF = [112, 150, 72];

/* A seeded wobble so "textured" crowns are the same every run. */
function rng(seed) { let a = seed >>> 0; return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; }; }

function picture(w, h) {
  const data = new Uint8ClampedArray(w * h * 4), r = rng(1);
  for (let i = 0; i < w * h; i++) {
    const k = 0.96 + r() * 0.08;
    data[i * 4] = TURF[0] * k; data[i * 4 + 1] = TURF[1] * k; data[i * 4 + 2] = TURF[2] * k; data[i * 4 + 3] = 255;
  }
  return { width: w, height: h, data };
}
/* A crown: colour, radius in metres, texture = how much lightness varies inside it. */
function crown(img, x, y, rM, colour, texture, seed) {
  const r = rng(seed || 7), rPx = rM * PPM;
  for (let py = Math.floor(y - rPx); py <= y + rPx; py++) for (let px = Math.floor(x - rPx); px <= x + rPx; px++) {
    if (px < 0 || py < 0 || px >= img.width || py >= img.height || Math.hypot(px + 0.5 - x, py + 0.5 - y) > rPx) continue;
    const k = 1 + (r() - 0.5) * 2 * texture, i = (py * img.width + px) * 4;
    img.data[i] = colour[0] * k; img.data[i + 1] = colour[1] * k; img.data[i + 2] = colour[2] * k;
  }
}
function one(rM, colour, texture, opts) {
  const img = picture(160, 160);
  crown(img, 80, 80, rM, colour, texture);
  return S.classify([{ x: 80, y: 80, r: rM }], Object.assign({ image: img, pxPerMetre: PPM, lat: -36.9 }, opts))[0];
}

const PINE = [36, 56, 34], MACRO = [30, 46, 30], WILLOW = [150, 176, 70], GUM = [98, 108, 96], CABBAGE = [104, 118, 70], POPLAR = [140, 178, 62], POHUTUKAWA = [52, 82, 46];

test("a dark, open crown of pine size reads as radiata pine", () => {
  assert.strictEqual(one(5, PINE, 0.35), "radiata-pine");
});

test("a broad, very dark, dense crown reads as macrocarpa", () => {
  assert.strictEqual(one(9, MACRO, 0.08), "macrocarpa");
});

test("a light yellow-green crown by mapped water reads as willow", () => {
  const water = [[{ x: 100, y: 60 }, { x: 150, y: 60 }, { x: 150, y: 100 }, { x: 100, y: 100 }]];
  assert.strictEqual(one(6, WILLOW, 0.12, { water }), "willow");
});

test("the same crown with no water anywhere near is not a willow", () => {
  const far = [[{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }]];
  assert.notStrictEqual(one(6, WILLOW, 0.12, { water: far }), "willow");
});

test("a grey, low-chroma, open crown reads as eucalyptus", () => {
  assert.strictEqual(one(6, GUM, 0.3), "eucalyptus");
});

test("a small olive crown reads as a cabbage tree", () => {
  assert.strictEqual(one(1.5, CABBAGE, 0.25), "cabbage-tree");
});

test("a small, vivid yellow-green crown reads as poplar", () => {
  assert.strictEqual(one(2.6, POPLAR, 0.1), "poplar");
});

test("a broad dark-green dome in the north reads as pōhutukawa, but not far south", () => {
  assert.strictEqual(one(8, POHUTUKAWA, 0.18, { lat: -36.8 }), "pohutukawa");
  assert.notStrictEqual(one(8, POHUTUKAWA, 0.18, { lat: -45.9 }), "pohutukawa");
});

test("a shelter belt comes out as one species even with an off-colour tree in it", () => {
  const img = picture(400, 120), trees = [];
  for (let k = 0; k < 7; k++) {
    const x = 40 + k * 48;
    /* The middle one is lighter and greener than its neighbours - alone it might read otherwise. */
    crown(img, x, 60, 6, k === 3 ? [70, 98, 50] : PINE, 0.3, k + 3);
    trees.push({ x, y: 60, r: 6 });
  }
  const ids = S.classify(trees, { image: img, pxPerMetre: PPM, lat: -36.9 });
  assert.strictEqual(new Set(ids).size, 1, "expected one species along the belt, got " + ids.join(", "));
});

test("a belt of broad crowns more than 24m apart centre to centre is still one stand", () => {
  /* 9m crowns 22m apart: 4m edge to edge, inside the stand gap, but further apart centre to
     centre than a fixed 24m neighbourhood would look. Alternating pine and macrocarpa colours
     make each tree borderline on its own. */
  const img = picture(900, 120), trees = [];
  for (let k = 0; k < 7; k++) {
    const x = 50 + k * 22 * PPM;
    crown(img, x, 60, 9, k % 2 ? MACRO : PINE, 0.2, k + 21);
    trees.push({ x, y: 60, r: 9 });
  }
  const ids = S.classify(trees, { image: img, pxPerMetre: PPM, lat: -36.9 });
  assert.strictEqual(new Set(ids).size, 1, "expected one species along the belt, got " + ids.join(", "));
});

test("a clearly different tree in a stand keeps its own species", () => {
  const img = picture(400, 160), trees = [];
  for (let k = 0; k < 5; k++) {
    const x = 60 + k * 66;
    crown(img, x, 80, 8, POHUTUKAWA, 0.18, k + 11);
    trees.push({ x, y: 80, r: 8 });
  }
  /* A cabbage tree tucked between two pōhutukawa. */
  crown(img, 93, 128, 1.5, CABBAGE, 0.25, 40);
  trees.push({ x: 93, y: 128, r: 1.5 });
  const ids = S.classify(trees, { image: img, pxPerMetre: PPM, lat: -36.8 });
  assert.deepStrictEqual(ids.slice(0, 5), Array(5).fill("pohutukawa"));
  assert.strictEqual(ids[5], "cabbage-tree");
});

test("a tree whose crown is outside the picture falls back without failing", () => {
  const img = picture(60, 60);
  const ids = S.classify([{ x: 500, y: 500, r: 5 }], { image: img, pxPerMetre: PPM });
  assert.strictEqual(ids[0], S.FALLBACK);
});

test("no picture at all still gives every tree a species", () => {
  const ids = S.classify([{ x: 1, y: 1, r: 1.5 }, { x: 100, y: 1, r: 6 }], { image: null, pxPerMetre: PPM });
  assert.deepStrictEqual(ids, ["cabbage-tree", S.FALLBACK]);
});

test("water distance is zero inside a ring and measured to its edge outside", () => {
  const ring = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  assert.strictEqual(S.waterDistance([ring], 5, 5), 0);
  assert.strictEqual(S.waterDistance([ring], 15, 5), 5);
  assert.strictEqual(S.waterDistance([], 15, 5), Infinity);
});

test("the summary counts species, most common first", () => {
  assert.strictEqual(S.summary(["willow", "radiata-pine", "radiata-pine"]), "2 radiata pine, 1 willow");
});

let failed = 0;
tests.forEach((t) => {
  try { t.fn(); console.log("  ok  " + t.name); }
  catch (e) { failed++; console.error("  FAIL  " + t.name + "\n        " + (e && e.message)); }
});
if (failed) process.exit(1);
console.log("tree-species passed: " + tests.length + " checks");
