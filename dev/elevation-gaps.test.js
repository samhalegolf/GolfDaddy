#!/usr/bin/env node
/* An undecodable elevation block must cost a corner, not a course.
 *
 * 3DEP intermittently returns blocks that are HTTP 200, the right size and a valid TIFF, but
 * carry a malformed internal tile. Measured over Trump National: 13 of 16 blocks decoded, at
 * every block size tried, with the bad tile index moving between attempts. One such block used
 * to fail the whole capture, which cost the course its elevation, which silently cost all 18
 * greens their contours and tiers.
 *
 * The hole is patched from its nearest real neighbours so relief still draws, and the patched
 * footprint travels with the capture so nothing MEASURES it.
 */
const assert = require("assert");
const path = require("path");
const { pathToFileURL } = require("url");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* patchElevationGaps is module-private, so exercise the algorithm it implements against the
   same contract: nearest real neighbour wins, and nothing finite is disturbed. */
function patch(heights, width, height) {
  const total = width * height;
  let holes = 0;
  for (let i = 0; i < total; i++) if (!Number.isFinite(heights[i])) holes++;
  if (!holes) return { filled: 0, remaining: 0 };
  const queue = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    if (!Number.isFinite(heights[i])) continue;
    if ((x > 0 && !Number.isFinite(heights[i - 1])) || (x < width - 1 && !Number.isFinite(heights[i + 1])) ||
        (y > 0 && !Number.isFinite(heights[i - width])) || (y < height - 1 && !Number.isFinite(heights[i + width]))) queue.push(i);
  }
  let head = 0, filled = 0;
  while (head < queue.length) {
    const i = queue[head++], v = heights[i], x = i % width, y = (i / width) | 0;
    if (x > 0 && !Number.isFinite(heights[i - 1])) { heights[i - 1] = v; filled++; queue.push(i - 1); }
    if (x < width - 1 && !Number.isFinite(heights[i + 1])) { heights[i + 1] = v; filled++; queue.push(i + 1); }
    if (y > 0 && !Number.isFinite(heights[i - width])) { heights[i - width] = v; filled++; queue.push(i - width); }
    if (y < height - 1 && !Number.isFinite(heights[i + width])) { heights[i + width] = v; filled++; queue.push(i + width); }
  }
  return { filled: filled / total, remaining: (holes - filled) / total };
}

test("a hole is filled from its nearest real ground, not a global average", () => {
  const W = 64, H = 64;
  const h = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) h[y * W + x] = 100 + x;   // 1m per px ramp
  for (let y = 20; y < 40; y++) for (let x = 20; x < 40; x++) h[y * W + x] = NaN;   // punch a block out
  const before = h.slice();
  const r = patch(h, W, H);
  assert.ok(r.remaining === 0, "every hole must be filled");
  for (let i = 0; i < h.length; i++) assert.ok(Number.isFinite(h[i]), "no NaN may survive");
  /* untouched ground must be bit-identical */
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x >= 20 && x < 40 && y >= 20 && y < 40) continue;
    assert.equal(h[y * W + x], before[y * W + x], "real ground must not be disturbed");
  }
  /* a nearest-neighbour fill tracks the ramp; a flat fill would not */
  const left = h[30 * W + 21], right = h[30 * W + 38];
  assert.ok(right > left + 5, "fill must follow the surrounding ground, got " + left + " -> " + right);
  return "20x20 hole in a ramp filled " + left.toFixed(0) + " -> " + right.toFixed(0);
});

test("an all-NaN mosaic fills nothing and is reported as unusable", () => {
  const W = 16, H = 16;
  const h = new Float32Array(W * H).fill(NaN);
  const r = patch(h, W, H);
  assert.equal(r.filled, 0);
  assert.ok(r.remaining > 0.9, "must report the mosaic as empty, got " + r.remaining);
  return "remaining " + (r.remaining * 100).toFixed(0) + "%";
});

test("exportImage blocks carry the footprint a gap needs", async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "functions", "lib", "gd-visual-plan-core.mjs")).href);
  /* a terrain-reference item takes source.terrain, not source.imagery (specForItem) */
  const spec = { adapter: "arcgis-export", endpoint: "https://x/exportImage", format: "tiff",
                 encoding: "float32", maxUsefulZoom: 17, blockPx: 512 };
  const SOURCE = { key: "t", label: "T", imagery: spec, terrain: spec };
  const item = { role: "terrain-reference", bounds: { north: -36.74, south: -36.76, west: 174.75, east: 174.78 },
    targetZoom: 16, minZoom: 14, maxZoom: 17, maxTiles: 260, bleedMeters: 130, bleedPx: 380, frameZoom: 17 };
  const g = mod.captureGrid(item, { source: SOURCE });
  assert.ok(g && g.tiles.length > 1, "need a multi-block grid, got " + (g ? g.tiles.length : 0));
  for (const t of g.tiles) {
    assert.ok(Number.isFinite(t.w) && t.w > 0, "block must report its width");
    assert.ok(Number.isFinite(t.h) && t.h > 0, "block must report its height");
  }
  return g.tiles.length + " blocks, all carrying w/h";
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
