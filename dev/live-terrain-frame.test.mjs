/*
 * /api/live-terrain-frame - Clarity 3D Mesh's server half.
 *
 * Pinned here:
 *   - the window is validated (integers, golf zooms, size limits, on the map);
 *   - the DEM is resampled onto EXACTLY the window: a linear height field comes back as the
 *     same linear field at the grid's pixel centres, whatever the DEM zoom;
 *   - the grid keeps the window's aspect and stays inside its size limits;
 *   - the handler refuses anyone not signed in, answers only the elevation layer (pictures are fetched
 *     by the browser), echoes the window, falls through to the next DEM when one fails, says
 *     why when none works, and never lets a CDN cache the answer.
 *
 * Run: node dev/live-terrain-frame.test.mjs
 */
import assert from "node:assert";
import sharp from "sharp";
import {
  parseWindow, windowBounds, windowMetres, demPlan, resampleToWindow, heightRange,
  DEM_MAX_SIDE, DEM_MIN_SIDE
} from "../functions/lib/gd-live-terrain-core.mjs";
import { createHandler, elevationCandidates } from "../functions/live-terrain-frame.mjs";
import { decodeElevation } from "../functions/lib/gd-relief-core.mjs";

let passed = 0;
async function ok(name, fn) { await fn(); passed++; console.log("ok  - " + name); }

const P = (o) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)]));

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
  for (const zoom of [13, 15, 17, 18]) {
    const plan = demPlan(WIN, zoom);
    assert.strictEqual(plan.demZoom, Math.min(zoom, WIN.z));
    const aspect = plan.grid.width / plan.grid.height;
    assert.ok(Math.abs(aspect - WIN.w / WIN.h) < 0.01, "aspect at z" + zoom);
    assert.ok(Math.max(plan.grid.width, plan.grid.height) <= Math.min(DEM_MAX_SIDE, Math.max(WIN.w, WIN.h)));
    assert.ok(Math.max(plan.grid.width, plan.grid.height) >= Math.min(DEM_MIN_SIDE, Math.max(WIN.w, WIN.h)));
    assert.ok(plan.fetch.left <= plan.window.x0 - 1 && plan.fetch.top <= plan.window.y0 - 1, "a margin for the resample");
    assert.ok(plan.fetch.left + plan.fetch.width >= plan.window.x1 + 1);
  }
});

await ok("the resample lands on exactly the window's ground", () => {
  /* A tilted plane in DEM-zoom pixels: h = 3 + 0.25x - 0.1y. Catmull-Rom reproduces a linear
     field exactly, so any offset in where the grid samples shows up as a height error. */
  for (const zoom of [13, 16]) {
    const plan = demPlan(WIN, zoom);
    const { left, top, width, height } = plan.fetch;
    /* Measured from the window corner: absolute pixel numbers run to millions, which a
       Float32Array cannot hold to the precision this test is asking about. */
    const field = (gx, gy) => 3 + 0.25 * (gx - plan.window.x0) - 0.1 * (gy - plan.window.y0);
    const src = new Float32Array(width * height);
    for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) src[j * width + i] = field(left + i + 0.5, top + j + 0.5);
    const out = resampleToWindow(src, width, height, plan);
    const sx = (plan.window.x1 - plan.window.x0) / plan.grid.width, sy = (plan.window.y1 - plan.window.y0) / plan.grid.height;
    let worst = 0;
    for (const [i, j] of [[0, 0], [plan.grid.width - 1, 0], [0, plan.grid.height - 1], [plan.grid.width - 1, plan.grid.height - 1], [7, 11]]) {
      const want = field(plan.window.x0 + (i + 0.5) * sx, plan.window.y0 + (j + 0.5) * sy);
      worst = Math.max(worst, Math.abs(out[j * plan.grid.width + i] - want));
    }
    assert.ok(worst < 1e-3, "z" + zoom + " worst error " + worst);
    const r = heightRange(out);
    assert.ok(r.max > r.min);
  }
});

/* ---- the handler, with the tile fetch stubbed and everything else real ---- */

function demPng(spec, w, h, base) {
  const raw = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const v = base + (i % w) * 0.05;
    if (spec.encoding === "terrarium") {
      const t = v + 32768;
      raw[i * 3] = Math.floor(t / 256); raw[i * 3 + 1] = Math.floor(t) % 256; raw[i * 3 + 2] = Math.round((t % 1) * 256) % 256;
    } else {
      const n = Math.round((v + 10000) * 10);
      raw[i * 3] = (n >> 16) & 255; raw[i * 3 + 1] = (n >> 8) & 255; raw[i * 3 + 2] = n & 255;
    }
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

function fakeMosaic({ failDem = [], log = [] } = {}) {
  return async (spec, zoom, origin, size) => {
    log.push({ url: spec.urlTemplate, zoom, origin, size });
    if (failDem.some(f => spec.urlTemplate.includes(f))) return null;
    return demPng(spec, size.width, size.height, 40);
  };
}

const ENV = { MAPBOX_PUBLIC_TOKEN: "pk.test" };
const req = (q, method = "GET") => new Request("http://x/api/live-terrain-frame?" + q, { method });
const query = (layer, win = WIN) => "layer=" + layer + "&z=" + win.z + "&x=" + win.x + "&y=" + win.y + "&w=" + win.w + "&h=" + win.h;

await ok("a caller who is not signed in is refused before anything is fetched", async () => {
  const log = [];
  const handler = createHandler({ verifyUser: async () => "", env: ENV, mosaic: fakeMosaic({ log }) });
  const res = await handler(req(query("elevation")));
  assert.strictEqual(res.status, 401);
  assert.strictEqual(log.length, 0);
});

await ok("a bad window or layer is a 400 - pictures are the browser's, not this endpoint's", async () => {
  const log = [];
  const handler = createHandler({ verifyUser: async () => "user-1", env: ENV, mosaic: fakeMosaic({ log }) });
  assert.strictEqual((await handler(req(query("elevation", { ...WIN, z: 11 })))).status, 400);
  assert.strictEqual((await handler(req(query("aerial")))).status, 400);
  assert.strictEqual(log.length, 0, "and no Mapbox picture is ever fetched here");
});

await ok("elevation: terrain-RGB on the window's grid, with its range and source", async () => {
  const handler = createHandler({ verifyUser: async () => "user-1", env: ENV, mosaic: fakeMosaic() });
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
  assert.ok(res.headers.get("X-Elevation-Source"));
  /* The source's real spacing, which decides whether the phone draws green slope lines. */
  const sampleM = Number(res.headers.get("X-Elevation-Sample-M"));
  assert.ok(sampleM > 0, "spacing reported");
  assert.match(res.headers.get("Access-Control-Expose-Headers"), /X-Elevation-Sample-M/);
  assert.strictEqual(res.headers.get("X-Window"), [WIN.z, WIN.x, WIN.y, WIN.w, WIN.h].join("/"));
});

await ok("a DEM that fails falls through to the next, and none at all is a 502 that says so", async () => {
  const bounds = windowBounds(WIN);
  const candidates = elevationCandidates(bounds, ENV);
  assert.ok(candidates.length >= 2, "global and Mapbox at least");
  assert.strictEqual(candidates[candidates.length - 1].key, "mapbox-terrain-dem", "Mapbox is the last resort, never first");
  const first = candidates[0].dem.urlTemplate.split("?")[0].slice(0, 40);
  const handler = createHandler({ verifyUser: async () => "user-1", env: ENV, mosaic: fakeMosaic({ failDem: [first] }) });
  const res = await handler(req(query("elevation")));
  assert.strictEqual(res.status, 200);
  assert.notStrictEqual(res.headers.get("X-Elevation-Source"), candidates[0].key);

  const none = createHandler({ verifyUser: async () => "user-1", env: ENV, mosaic: fakeMosaic({ failDem: ["http"] }) });
  const bad = await none(req(query("elevation")));
  assert.strictEqual(bad.status, 502);
  assert.match((await bad.json()).error, /no elevation/);
});

console.log("\nlive-terrain-frame: " + passed + " passed");
