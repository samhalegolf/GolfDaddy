/*
 * /api/live-terrain-frame - the Clarity 3D Mesh test mode's server half.
 *
 * Pinned here:
 *   - the window is validated (integers, golf zooms, size limits, on the map);
 *   - elevation is resampled onto EXACTLY the window: a linear height field comes back as the
 *     same linear field at the grid's pixel centres, whatever zoom it was stored at;
 *   - the grid keeps the window's aspect and stays inside its size limits;
 *   - a named course's baked terrain asset answers without any provider being contacted;
 *   - the handler refuses non-admins, answers only the elevation layer (pictures are fetched
 *     by the browser), echoes the window, falls through to the next source when one fails,
 *     says why when none works, and never lets a CDN cache the answer.
 *
 * Run: node dev/live-terrain-frame.test.mjs
 */
import assert from "node:assert";
import sharp from "sharp";
import { parseWindow, windowBounds, windowMetres, demGrid, DEM_MAX_SIDE, DEM_MIN_SIDE } from "../functions/lib/gd-live-terrain-core.mjs";
import { createHandler } from "../functions/live-terrain-frame.mjs";
import { decodeElevation } from "../functions/lib/gd-relief-core.mjs";
import { reprojectToGrid, heightRange } from "../functions/lib/terrain/gd-terrain-normalise.mjs";
import { mercMetresPerPixel, pixelRectFor } from "../functions/lib/terrain/gd-terrain-adapters.mjs";
import { TERRAIN_SOURCES } from "../functions/lib/terrain/gd-terrain-sources.mjs";

let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log("ok  - " + name); }

const P = (o) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)]));
const MERC_HALF = 20037508.342789244;

/* A 1200x1600 window at z18 over Akarana, Auckland. */
function worldPx(lat, lng, z) {
  const scale = 256 * Math.pow(2, z), r = lat * Math.PI / 180;
  return { x: ((lng + 180) / 360) * scale, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * scale };
}
const AT = worldPx(-36.9133, 174.7395, 18);
const WIN = { z: 18, x: Math.floor(AT.x) - 600, y: Math.floor(AT.y) - 800, w: 1200, h: 1600 };

await ok("a good window parses; bad ones say why", () => {
  assert.deepStrictEqual(parseWindow(P(WIN)), WIN);
  assert.match(parseWindow(P({ ...WIN, z: 12 })).error, /z must be/);
  assert.match(parseWindow(P({ ...WIN, z: 18.5 })).error, /integers/);
  assert.match(parseWindow(P({ ...WIN, w: 4096 })).error, /window must be/);
  assert.match(parseWindow(P({ ...WIN, w: 8 })).error, /window must be/);
  assert.match(parseWindow(P({ ...WIN, x: -1 })).error, /off the map/);
  assert.match(parseWindow(P({ z: 18 })).error, /integers/);
});

await ok("bounds and metres come from the window itself", () => {
  const b = windowBounds(WIN);
  assert.ok(b.north > b.south && b.east > b.west);
  const m = windowMetres(WIN);
  assert.ok(Math.abs(m.width / m.height - WIN.w / WIN.h) < 1e-9, "same metres per pixel both ways");
  assert.ok(m.metresPerPixel > 0.3 && m.metresPerPixel < 0.7, "z18 is about half a metre a pixel");
});

await ok("the DEM grid keeps the window's aspect and its size limits", () => {
  for (const win of [WIN, { ...WIN, w: 300, h: 200 }, { ...WIN, z: 15, w: 2048, h: 900 }]) {
    const grid = demGrid(win);
    assert.strictEqual(grid.zoom, win.z);
    assert.deepStrictEqual(grid.originPx, { x: win.x, y: win.y });
    assert.ok(Math.abs(grid.width / grid.height - win.w / win.h) < 0.02, "aspect");
    const long = Math.max(grid.width, grid.height);
    assert.ok(long <= Math.min(DEM_MAX_SIDE, Math.max(win.w, win.h)));
    assert.ok(long >= Math.min(DEM_MIN_SIDE, Math.max(win.w, win.h)));
    assert.ok(Math.abs(grid.stepX * grid.width - win.w) < 1e-9 && Math.abs(grid.stepY * grid.height - win.h) < 1e-9, "the grid spans exactly the window");
  }
});

/* A tilted plane, stored on a mercator grid at a coarser zoom: h = 3 + 0.25X - 0.1Y in
   metres from a fixed corner. Catmull-Rom reproduces a linear field exactly, so any offset in
   where the window grid samples shows up as a height error. */
function planeRaw(zoom) {
  const b = windowBounds(WIN);
  const pad = 0.002;
  const rect = pixelRectFor({ north: b.north + pad, south: b.south - pad, west: b.west - pad, east: b.east + pad }, zoom);
  const mpp = mercMetresPerPixel(zoom);
  const ox = rect.left * mpp - MERC_HALF, oy = MERC_HALF - rect.top * mpp;
  const field = (X, Y) => 3 + 0.25 * (X - ox) / 10 - 0.1 * (oy - Y) / 10;
  const heights = new Float32Array(rect.width * rect.height);
  for (let j = 0; j < rect.height; j++) for (let i = 0; i < rect.width; i++) heights[j * rect.width + i] = field(ox + (i + 0.5) * mpp, oy - (j + 0.5) * mpp);
  return { raw: { crs: "EPSG:3857", width: rect.width, height: rect.height, heights, transform: { originX: ox, originY: oy, pixelSize: mpp } }, field };
}

await ok("the resample lands on exactly the window's ground", () => {
  for (const zoom of [13, 16]) {
    const { raw, field } = planeRaw(zoom);
    const grid = demGrid(WIN);
    const out = reprojectToGrid(raw, grid);
    const mpp = mercMetresPerPixel(WIN.z);
    let worst = 0;
    for (const [i, j] of [[0, 0], [grid.width - 1, 0], [0, grid.height - 1], [grid.width - 1, grid.height - 1], [7, 11]]) {
      const X = (WIN.x + (i + 0.5) * grid.stepX) * mpp - MERC_HALF, Y = MERC_HALF - (WIN.y + (j + 0.5) * grid.stepY) * mpp;
      worst = Math.max(worst, Math.abs(out[j * grid.width + i] - field(X, Y)));
    }
    assert.ok(worst < 1e-2, "z" + zoom + " worst error " + worst);
    const r = heightRange(out);
    assert.ok(r.max > r.min);
  }
});

/* ---- the handler, with providers stubbed and everything else real ---- */

/* A fake adapter: the plane above from whatever "provider" is asked, or a failure. */
function fakeTerrain({ fail = [], log = [] } = {}) {
  const adapter = (sourceType) => ({
    sourceType,
    canHandle: s => s.sourceType === sourceType,
    async fetchTerrain({ source }) {
      log.push(source.id);
      if (fail.includes(source.id)) throw new Error(source.id + " is down");
      return Object.assign(planeRaw(15).raw, { sourceId: source.id, requests: { total: 1, failed: 0, missing: 0 } });
    }
  });
  return { adapters: ["xyz-elevation", "arcgis-image-server", "clarity-staged"].map(adapter), sources: TERRAIN_SOURCES };
}

const ENV = { LINZ_BASEMAPS_API_KEY: "k" };
const req = (q, method = "GET") => new Request("http://x/api/live-terrain-frame?" + q, { method });
const query = (layer, win = WIN) => "layer=" + layer + "&z=" + win.z + "&x=" + win.x + "&y=" + win.y + "&w=" + win.w + "&h=" + win.h;

await ok("non-admins are refused before anything is fetched", async () => {
  const log = [];
  const handler = createHandler({ verifyAdmin: async () => "", env: ENV, terrain: fakeTerrain({ log }) });
  const res = await handler(req(query("elevation")));
  assert.strictEqual(res.status, 403);
  assert.strictEqual(log.length, 0);
});

await ok("a bad window or layer is a 400 - pictures are the browser's, not this endpoint's", async () => {
  const log = [];
  const handler = createHandler({ verifyAdmin: async () => "a@b", env: ENV, terrain: fakeTerrain({ log }) });
  assert.strictEqual((await handler(req(query("elevation", { ...WIN, z: 11 })))).status, 400);
  assert.strictEqual((await handler(req(query("aerial")))).status, 400);
  assert.strictEqual(log.length, 0, "and no picture is ever fetched here");
});

await ok("elevation: terrain-RGB on the window's grid, with its range and source", async () => {
  const handler = createHandler({ verifyAdmin: async () => "a@b", env: ENV, terrain: fakeTerrain() });
  const res = await handler(req(query("elevation")));
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("Cache-Control"), /^private/);
  assert.strictEqual(res.headers.get("Netlify-CDN-Cache-Control"), "no-store");
  assert.match(res.headers.get("Access-Control-Expose-Headers"), /X-Window/);
  const size = res.headers.get("X-Elevation-Size").split("x").map(Number);
  const png = Buffer.from(await res.arrayBuffer());
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  assert.deepStrictEqual([info.width, info.height], size);
  const decoded = decodeElevation(data, info.width, info.height, info.channels, "terrain-rgb");
  assert.ok(Math.abs(decoded.min - Number(res.headers.get("X-Elevation-Min"))) < 0.11);
  assert.ok(Math.abs(decoded.max - Number(res.headers.get("X-Elevation-Max"))) < 0.11);
  assert.strictEqual(res.headers.get("X-Elevation-Source"), "linz-nz-elevation", "the resolver's pick for Auckland");
  assert.strictEqual(res.headers.get("X-Elevation-From"), "provider");
  /* The source's real spacing, which decides whether the phone draws green slope lines. */
  const sampleM = Number(res.headers.get("X-Elevation-Sample-M"));
  assert.ok(sampleM > 0, "spacing reported");
  assert.match(res.headers.get("Access-Control-Expose-Headers"), /X-Elevation-Sample-M/);
  assert.strictEqual(res.headers.get("X-Window"), [WIN.z, WIN.x, WIN.y, WIN.w, WIN.h].join("/"));
});

await ok("a named course's baked asset answers - no provider is contacted", async () => {
  const log = [];
  const { raw } = planeRaw(16);
  const asset = {
    manifest: {
      terrainVersion: 3, sourceResolutionM: 1,
      quality: { class: "lidar", greenDetail: "conditional" },
      sources: [{ id: "linz-nz-elevation", name: "LINZ", attribution: { text: "LINZ CC BY" } }],
      grid: {
        captureZoom: 16, width: raw.width, height: raw.height,
        originPx: { x: Math.round((raw.transform.originX + MERC_HALF) / raw.transform.pixelSize), y: Math.round((MERC_HALF - raw.transform.originY) / raw.transform.pixelSize) },
        bounds: (() => { const b = windowBounds(WIN); return { north: b.north + 0.002, south: b.south - 0.002, west: b.west - 0.002, east: b.east + 0.002 }; })()
      }
    },
    heights: raw.heights
  };
  const asked = [];
  const handler = createHandler({ verifyAdmin: async () => "a@b", env: ENV, terrain: fakeTerrain({ log }), loadAsset: async id => { asked.push(id); return asset; } });
  const res = await handler(req(query("elevation") + "&course=akarana"));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(asked, ["akarana"]);
  assert.strictEqual(log.length, 0, "no provider");
  assert.strictEqual(res.headers.get("X-Elevation-From"), "asset");
  assert.strictEqual(res.headers.get("X-Terrain-Version"), "3");
  assert.strictEqual(res.headers.get("X-Green-Detail"), "conditional");
  assert.strictEqual(res.headers.get("X-Elevation-Sample-M"), "1.00");
});

await ok("a source that fails falls through to the next, and none at all is a 502 that says so", async () => {
  const log = [];
  const handler = createHandler({ verifyAdmin: async () => "a@b", env: ENV, terrain: fakeTerrain({ fail: ["linz-nz-elevation"], log }) });
  const res = await handler(req(query("elevation")));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("X-Elevation-Source"), "global-terrain-tiles");
  assert.deepStrictEqual(log, ["linz-nz-elevation", "global-terrain-tiles"]);

  const none = createHandler({ verifyAdmin: async () => "a@b", env: ENV, terrain: fakeTerrain({ fail: ["linz-nz-elevation", "global-terrain-tiles"] }) });
  const bad = await none(req(query("elevation")));
  assert.strictEqual(bad.status, 502);
  assert.match((await bad.json()).error, /no elevation/);
});

console.log("\nlive-terrain-frame: " + passed + " passed");
