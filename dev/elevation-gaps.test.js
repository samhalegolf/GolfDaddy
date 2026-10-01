#!/usr/bin/env node
/* An undecodable elevation block must cost a corner, not a course.
 *
 * 3DEP intermittently returns blocks that are HTTP 200, the right size and a valid TIFF, but
 * carry a malformed internal tile. Measured over Trump National: 13 of 16 blocks decoded, at
 * every block size tried, with the bad tile index moving between attempts. One such block used
 * to fail the whole capture, which cost the course its elevation, which silently cost all 18
 * greens their contours and tiers.
 *
 * The terrain bake keeps the bad block as nodata, fills it from its nearest real neighbours so
 * relief still draws, and marks every filled pixel in the asset mask so nothing MEASURES it
 * (functions/lib/terrain/gd-terrain-normalise.mjs fillGaps / filledRegions).
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const load = rel => import(pathToFileURL(path.join(__dirname, "..", rel)).href);

test("a hole is filled from its nearest real ground, not a global average - and marked", async () => {
  const { fillGaps, filledRegions, MASK_FILLED } = await load("functions/lib/terrain/gd-terrain-normalise.mjs");
  const W = 64, H = 64;
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) h[y * W + x] = 100 + x;   // 1m per px ramp
  for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) h[y * W + x] = NaN;   // punch a block out
  const before = h.slice();
  const mask = new Uint8Array(W * H).fill(1);
  for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) mask[y * W + x] = 0;
  const r = fillGaps(h, mask, W, H);
  assert.ok(Math.abs(r.filledFraction - 400 / 4096) < 1e-9, "filled fraction reported");
  for (let i = 0; i < h.length; i++) assert.ok(Number.isFinite(h[i]), "no NaN may survive");
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const inside = x >= 20 && x < 40 && y >= 20 && y < 40;
    if (!inside) assert.equal(h[y * W + x], before[y * W + x], "real ground must not be disturbed");
    assert.equal(mask[y * W + x] === MASK_FILLED, inside, "exactly the filled pixels are marked");
  }
  const left = h[30 * W + 21], right = h[30 * W + 38];
  assert.ok(right > left + 5, "fill must follow the surrounding ground, got " + left + " -> " + right);
  const regions = filledRegions(mask, W, H, 16);
  assert.ok(regions.length && regions.every(g => g.x + g.w > 20 && g.x < 40 && g.y + g.h > 20 && g.y < 40), "regions cover the hole only");
  return "20x20 hole in a ramp filled " + left.toFixed(0) + " -> " + right.toFixed(0);
});

test("an all-nodata grid cannot be filled and says so", async () => {
  const { fillGaps } = await load("functions/lib/terrain/gd-terrain-normalise.mjs");
  const W = 16, H = 16;
  assert.throws(() => fillGaps(new Float32Array(W * H).fill(NaN), new Uint8Array(W * H), W, H), /no real ground/);
});

test("an undecodable exportImage block stays nodata and the rest of the course is kept", async () => {
  const { ADAPTERS } = await load("functions/lib/terrain/gd-terrain-adapters.mjs");
  const { float32Tiff } = await load("dev/float32-tiff-fixture.mjs");
  const arcgis = ADAPTERS.find(a => a.sourceType === "arcgis-image-server");
  const source = { id: "t", sourceType: "arcgis-image-server", endpoint: "https://x/exportImage", format: "tiff",
    encoding: "float32", maxUsefulZoom: 17, blockPx: 256, resolutionM: 1, verticalDatum: "NAVD88" };
  let n = 0;
  const fetchImpl = async url => {
    const u = new URL(url);
    const [W, H] = u.searchParams.get("size").split(",").map(Number);
    const bad = (n++ === 1);
    const body = bad ? Buffer.from("II*\0garbage-not-a-tiff") : await float32Tiff(new Float32Array(W * H).fill(12.5), W, H);
    return { ok: true, status: 200, headers: { get: k => (k === "content-type" ? "image/tiff" : null) }, arrayBuffer: async () => body };
  };
  const raw = await arcgis.fetchTerrain({ source, bounds: { north: 36.57, south: 36.565, west: -121.945, east: -121.938 }, zoom: 17 }, { fetchImpl });
  assert.ok(raw.requests.total > 1, "multi-block window");
  assert.equal(raw.requests.failed, 1, "one block failed");
  let nan = 0, real = 0;
  for (const v of raw.heights) { if (Number.isFinite(v)) { real++; assert.equal(v, 12.5); } else nan++; }
  assert.ok(nan > 0 && real > 0, "the bad block is nodata, the rest is real ground");
  return raw.requests.total + " blocks, 1 left as nodata";
});

(async () => {
  console.log("elevation gaps\n");
  let failed = 0;
  for (const { name, fn } of tests) {
    try { const note = await fn(); console.log("  ok   " + name + (note ? "  (" + note + ")" : "")); }
    catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
  }
  console.log("\n" + (tests.length - failed) + " passed" + (failed ? ", " + failed + " failed" : ""));
  process.exit(failed ? 1 : 0);
})();
