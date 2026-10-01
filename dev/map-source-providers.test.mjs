/* Map source providers: tile maths, stitching, georeferencing, terrain decoding, failure
 * handling and the Mapbox fence - all without a network or a real token.
 *
 * Synthetic tiles are built so every pixel's value is a function of its WORLD pixel position.
 * After stitching and cropping, each output pixel can then be checked against the world
 * position the georeference says it is at: a seam, an off-by-one crop or a drifting transform
 * all show up as a value that does not match, to the pixel.
 *
 * Run: node dev/map-source-providers.test.mjs */

import assert from "node:assert/strict";
import sharp from "sharp";

const mosaic = await import("../functions/lib/gd-tile-mosaic-core.mjs");
const grids = await import("../functions/lib/gd-elevation-grid-core.mjs");
const fetchLib = await import("../functions/lib/gd-tile-fetch.mjs");
const mapbox = await import("../functions/lib/gd-mapbox-source.mjs");
const sources = await import("../functions/lib/gd-map-sources.mjs");
const georefCore = await import("../functions/lib/gd-overlay-georef-core.mjs");
const registry = await import("../functions/lib/gd-imagery-sources.mjs");

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || "") + " expected " + b + " got " + a);

/* Hwanghak course (cc-37-178n-127-708e), an existing Korean course in course_maps. */
const KOREA = { lat: 37.1763557151634, lng: 127.704966807264 };
const KOREA_BOUNDS = { north: 37.1835, south: 37.1692, west: 127.6960, east: 127.7140 };
const TOKEN = "pk.TESTTOKENVALUE123";

/* ---------- tile maths ---------- */

test("lon -> tile X and lat -> tile Y at known references", () => {
  assert.equal(mosaic.lngToTileX(0, 0), 0.5);
  near(mosaic.latToTileY(0, 0), 0.5, 1e-12);
  /* Berlin at z10: the OSM wiki's worked example, tile 550/335. */
  assert.equal(Math.floor(mosaic.lngToTileX(13.405, 10)), 550);
  assert.equal(Math.floor(mosaic.latToTileY(52.52, 10)), 335);
  near(mosaic.latToTileY(52.52, 10), 335.826085, 1e-5);
  /* Korea at z16. */
  near(mosaic.lngToTileX(KOREA.lng, 16), 56015.979735, 1e-5);
  near(mosaic.latToTileY(KOREA.lat, 16), 25468.335834, 1e-5);
});

test("tile X/Y -> geographic bounds, and back", () => {
  const world = mosaic.tileBounds(0, 0, 0);
  near(world.north, 85.0511287798, 1e-9); near(world.south, -85.0511287798, 1e-9);
  assert.equal(world.west, -180); assert.equal(world.east, 180);
  const se = mosaic.tileBounds(1, 1, 1);
  near(se.north, 0, 1e-12); assert.equal(se.west, 0); assert.equal(se.east, 180);
  const t = mosaic.tileBounds(56015, 25468, 16);
  near(mosaic.lngToTileX(t.west, 16), 56015, 1e-9);
  near(mosaic.latToTileY(t.north, 16), 25468, 1e-9);
  near(mosaic.latToTileY(t.south, 16), 25469, 1e-9);
  assert.ok(t.west <= KOREA.lng && t.east > KOREA.lng && t.south <= KOREA.lat && t.north > KOREA.lat, "the course pin sits in its own tile");
});

test("requested bounds -> the intersecting tile list, nothing more", () => {
  const z = 16;
  const tiles = mosaic.tilesForBounds(KOREA_BOUNDS, z);
  const xs = [...new Set(tiles.map(t => t.x))], ys = [...new Set(tiles.map(t => t.y))];
  assert.equal(tiles.length, xs.length * ys.length, "a full rectangle of tiles");
  assert.equal(Math.min(...xs), Math.floor(mosaic.lngToTileX(KOREA_BOUNDS.west, z)));
  assert.equal(Math.max(...xs), Math.floor(mosaic.lngToTileX(KOREA_BOUNDS.east, z)));
  assert.equal(Math.min(...ys), Math.floor(mosaic.latToTileY(KOREA_BOUNDS.north, z)));
  assert.equal(Math.max(...ys), Math.floor(mosaic.latToTileY(KOREA_BOUNDS.south, z)));
  for (const t of tiles) {
    const b = mosaic.tileBounds(t.x, t.y, z);
    assert.ok(b.west < KOREA_BOUNDS.east && b.east > KOREA_BOUNDS.west && b.south < KOREA_BOUNDS.north && b.north > KOREA_BOUNDS.south, "tile does not intersect");
  }
  /* A box ending exactly on a tile edge must not pull in the next tile. */
  const edge = mosaic.tileBounds(10, 10, 5);
  assert.equal(mosaic.tilesForBounds(edge, 5).length, 1);
  assert.deepEqual(mosaic.tilesForBounds({ north: 1, south: 2, west: 0, east: 1 }, 5), []);
});

test("the stitch plan's crop contains the request, and is at most one pixel bigger per edge", () => {
  for (const tilePx of [256, 512]) {
    const plan = mosaic.stitchPlan(KOREA_BOUNDS, 16, tilePx);
    const b = plan.bounds, r = KOREA_BOUNDS;
    assert.ok(b.north >= r.north && b.south <= r.south && b.west <= r.west && b.east >= r.east, "crop must contain the request");
    const mpp = mosaic.metresPerPixel(KOREA.lat, 16, tilePx);
    const degLat = mpp / 111320, degLng = mpp / (111320 * Math.cos(KOREA.lat * Math.PI / 180));
    assert.ok(b.north - r.north < degLat * 1.01 && r.south - b.south < degLat * 1.01, "vertical slack under one pixel");
    assert.ok(r.west - b.west < degLng * 1.01 && b.east - r.east < degLng * 1.01, "horizontal slack under one pixel");
    /* The crop sits inside the sheet of fetched tiles. */
    assert.ok(plan.crop.left >= 0 && plan.crop.top >= 0);
    assert.ok(plan.crop.left + plan.crop.width <= plan.sheet.width && plan.crop.top + plan.crop.height <= plan.sheet.height);
  }
});

test("zoom selection: coarsest zoom that meets the target, capped by source and tile budget", () => {
  const picked = mosaic.selectZoom(KOREA_BOUNDS, { tilePx: 512, targetPx: 1568, minZoom: 1, maxZoom: 19 });
  const long = p => Math.max(p.crop.width, p.crop.height);
  assert.ok(long(picked.plan) >= 1568, "meets the target");
  assert.ok(long(mosaic.stitchPlan(KOREA_BOUNDS, picked.zoom - 1, 512)) < 1568, "one zoom coarser would not");
  assert.equal(mosaic.selectZoom(KOREA_BOUNDS, { tilePx: 512, targetPx: 100000, minZoom: 1, maxZoom: 15 }).zoom, 15, "source ceiling binds");
  const budget = mosaic.selectZoom(KOREA_BOUNDS, { tilePx: 512, targetPx: 100000, minZoom: 1, maxZoom: 19, maxTiles: 4 });
  assert.ok(budget.plan.tiles.length <= 4, "tile budget binds");
  assert.ok(mosaic.selectZoom({ north: 60, south: -60, west: -170, east: 170 }, { minZoom: 10, maxZoom: 19, maxTiles: 64 }).error, "a continent at z10 is refused, not delivered blurry");
});

/* ---------- georeferencing ---------- */

test("pixel -> lat/lng -> pixel round-trips, and agrees with the AI scan's own georef core", () => {
  const plan = mosaic.stitchPlan(KOREA_BOUNDS, 16, 512);
  for (const [w, h] of [[plan.crop.width, plan.crop.height], [1049, Math.round(1049 * plan.crop.height / plan.crop.width)]]) {
    const georef = mosaic.georefFor(plan, w, h);
    const scan = georefCore.imageGeoreference(georef);
    assert.ok(!scan.error, scan.error);
    for (const px of [{ x: 0, y: 0 }, { x: w, y: h }, { x: w / 2, y: h / 2 }, { x: 13.25, y: h - 7.5 }, { x: w - 1, y: 3 }]) {
      const ll = mosaic.pixelToLatLng(georef, px);
      const back = mosaic.latLngToPixel(georef, ll);
      near(back.x, px.x, 1e-6, "x round trip"); near(back.y, px.y, 1e-6, "y round trip");
      const viaScan = scan.toLatLng(px);
      near(viaScan.lat, ll.lat, 1e-10, "scan core lat"); near(viaScan.lng, ll.lng, 1e-10, "scan core lng");
    }
    /* The picture's corners are the plan's bounds - to well under a pixel even after resizing. */
    const nw = mosaic.pixelToLatLng(georef, { x: 0, y: 0 });
    const se = mosaic.pixelToLatLng(georef, { x: w, y: h });
    near(nw.lat, plan.bounds.north, 1e-9); near(nw.lng, plan.bounds.west, 1e-9);
    near(se.lng, plan.bounds.east, 1e-9);
    const mpp = mosaic.metresPerPixel(KOREA.lat, georef.playSurface.captureZoom);
    near((se.lat - plan.bounds.south) * 111320, 0, mpp * 0.6, "south edge within half a pixel");
  }
});

/* ---------- synthetic tiles ---------- */

/* Height as a function of world pixel position at the pixel zoom: distinct everywhere in a
   course-sized window, so any misplaced pixel decodes to the wrong value. */
const heightAt = (wx, wy) => 50 + ((wx % 300) * 0.1) + ((wy % 200) * 0.5);
const encodeTerrainRgb = h => { const v = Math.round((h + 10000) / 0.1); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; };

async function syntheticTerrainTile(z, x, y, tilePx) {
  const buf = Buffer.alloc(tilePx * tilePx * 3);
  for (let py = 0; py < tilePx; py++) for (let px = 0; px < tilePx; px++) {
    const [r, g, b] = encodeTerrainRgb(heightAt(x * tilePx + px, y * tilePx + py));
    const i = (py * tilePx + px) * 3; buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
  }
  return sharp(buf, { raw: { width: tilePx, height: tilePx, channels: 3 } }).png().toBuffer();
}
async function syntheticImageTile(tilePx, colour) {
  return sharp({ create: { width: tilePx, height: tilePx, channels: 3, background: colour } }).jpeg().toBuffer();
}

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: k => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    text: async () => String(body)
  };
}

/* A fake Mapbox: answers the documented URL shape, records every call. */
function fakeMapbox({ fail } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const m = String(url).match(/\/v4\/([^/]+)\/(\d+)\/(\d+)\/(\d+)@2x\.(jpg90|pngraw)\?access_token=(.+)$/);
    if (!m) return response(422, Buffer.from("bad url"));
    const [, product, z, x, y, format, token] = m;
    const custom = fail && fail({ product, z: +z, x: +x, y: +y, token, n: calls.length });
    if (custom) return custom;
    if (decodeURIComponent(token) !== TOKEN) return response(401, Buffer.from('{"message":"Invalid Token"}'));
    if (product === mapbox.MAPBOX_TERRAIN_PRODUCT && format === "pngraw") return response(200, await syntheticTerrainTile(+z, +x, +y, 512));
    if (product === mapbox.MAPBOX_SATELLITE_PRODUCT && format === "jpg90") return response(200, await syntheticImageTile(512, { r: 40, g: 120, b: 50 }));
    return response(404, Buffer.from("Tile not found"));
  };
  fn.calls = calls;
  return fn;
}

const ENV = { MAPBOX_PUBLIC_TOKEN: TOKEN };
const provider = (fetchImpl, env = ENV) => mapbox.createMapboxProvider({ env, fetchImpl, sharp, cache: new fetchLib.MemoryTileCache() });

test("stitched terrain has no seams: every sample is the height of the world pixel it claims", async () => {
  const fake = fakeMapbox();
  const grid = await provider(fake).getElevation(KOREA_BOUNDS, { maxTiles: 16 });
  assert.equal(grid.zoom, 14, "Terrain-DEM's max zoom");
  assert.ok(grid.tilesRequested > 1, "the test must span a tile edge to prove anything");
  const s = grid.georef.playSurface;
  let worst = 0;
  for (let j = 0; j < grid.height; j += 3) for (let i = 0; i < grid.width; i += 3) {
    worst = Math.max(worst, Math.abs(grid.heights[j * grid.width + i] - heightAt(s.originPx.x + i, s.originPx.y + j)));
  }
  assert.ok(worst < 0.051, "worst sample off by " + worst + "m");
  assert.equal(grid.encoding, "terrain-rgb");
  assert.ok(fake.calls.every(u => u.includes("@2x.pngraw")), "terrain must be requested as pngraw");
});

test("stitched imagery: right size, exact georef, one picture whatever the tile count", async () => {
  const fake = fakeMapbox();
  const im = await provider(fake).getImagery(KOREA_BOUNDS, { targetPx: 1568, maxOutputPx: 1568, maxPixels: 1100000 });
  assert.equal(im.mediaType, "image/jpeg");
  assert.ok(Math.max(im.width, im.height) <= 1568 && im.width * im.height <= 1100000, "within the AI scan's limits");
  const meta = await sharp(im.image).metadata();
  assert.equal(meta.width, im.width); assert.equal(meta.height, im.height);
  assert.equal(im.tilesRequested, fake.calls.length);
  assert.equal(im.source.provider, "mapbox"); assert.equal(im.source.product, "mapbox.satellite");
  const r = KOREA_BOUNDS, b = im.bounds;
  assert.ok(b.north >= r.north && b.south <= r.south && b.west <= r.west && b.east >= r.east);
  assert.ok(!JSON.stringify(Object.assign({}, im, { image: null })).includes(TOKEN), "the token must not be anywhere in the result");
  /* The finished picture's own corners are its stated bounds: within half an output pixel. */
  const se = mosaic.pixelToLatLng(im.georef, { x: im.width, y: im.height });
  const nw = mosaic.pixelToLatLng(im.georef, { x: 0, y: 0 });
  const degPerPxLat = im.metresPerPixel / 111320;
  near(nw.lat, b.north, 1e-9); near(nw.lng, b.west, 1e-9); near(se.lng, b.east, 1e-9);
  near(se.lat, b.south, degPerPxLat * 0.51, "south edge");
});

/* ---------- terrain decoding and lookups ---------- */

test("terrain-RGB decodes with Mapbox's formula", () => {
  /* -10000 + (R*65536 + G*256 + B) * 0.1 : RGB(1,134,160) is sea level. */
  const raw = Buffer.from([1, 134, 160, 1, 134, 170, 1, 138, 160, 1, 134, 160]);
  const grid = grids.elevationGridFromRaw(raw, { width: 2, height: 2, channels: 3, encoding: "terrain-rgb" });
  assert.ok(!grid.error, grid.error);
  near(grid.heights[0], 0, 1e-6); near(grid.heights[1], 1, 1e-4); near(grid.heights[2], 102.4, 1e-3);
  assert.equal(grid.minElevation, 0);
});

test("a tile that decodes only as a different encoding is refused, not measured", () => {
  /* Terrarium sea level (128,0,0) reads as ~828km in terrain-RGB - implausible, so only
     terrarium decodes it; a source declared terrain-rgb must fail, not switch formula. */
  const raw = Buffer.alloc(16 * 3);
  for (let i = 0; i < 16; i++) { raw[i * 3] = 128; raw[i * 3 + 1] = i; raw[i * 3 + 2] = 0; }
  const grid = grids.elevationGridFromRaw(raw, { width: 4, height: 4, channels: 3, encoding: "terrain-rgb" });
  assert.ok(grid.error && /terrain decoding failed/.test(grid.error));
});

test("bilinear elevationAt, gradient and elevation change on a known plane", async () => {
  const plan = mosaic.stitchPlan(KOREA_BOUNDS, 14, 512);
  const width = 40, height = 30;
  const heights = new Float32Array(width * height);
  /* Falls 0.5m per sample eastward: aspect 90 (east), slope atan(0.5/mps). */
  for (let j = 0; j < height; j++) for (let i = 0; i < width; i++) heights[j * width + i] = 100 - 0.5 * i;
  const georef = mosaic.georefFor({ originPx: plan.originPx, pixelZoom: plan.pixelZoom, crop: { width } }, width, height);
  const mps = mosaic.metresPerPixel(KOREA.lat, plan.pixelZoom);
  const grid = { heights, width, height, georef, metresPerSample: mps };
  /* Sample centres sit at +0.5; halfway between columns 3 and 4 is 98.25. */
  const at = mosaic.pixelToLatLng(georef, { x: 4, y: 10.5 });
  near(grids.elevationAt(grid, at.lat, at.lng), 98.25, 1e-6);
  near(grids.elevationAtPixel(grid, 0, 0), 100, 1e-9, "clamped at the edge");
  const g = grids.gradientAt(grid, at.lat, at.lng);
  near(g.aspectDeg, 90, 1e-6); near(g.slopePercent, 0.5 / mps * 100, 1e-6);
  const west = mosaic.pixelToLatLng(georef, { x: 5.5, y: 5 }), east = mosaic.pixelToLatLng(georef, { x: 15.5, y: 5 });
  near(grids.elevationChange(grid, west, east), -5, 1e-6, "ten samples east is 5m downhill");
  assert.equal(grids.maxNeighbourStep(grid), 0.5);
});

/* ---------- failures ---------- */

async function failsWith(promise, code) {
  try { await promise; } catch (error) {
    assert.ok(error instanceof fetchLib.MapSourceError, "not a MapSourceError: " + error);
    assert.equal(error.code, code, error.message);
    assert.ok(!error.message.includes(TOKEN), "the token leaked into an error message");
    return error;
  }
  assert.fail("expected a " + code + " failure");
}

test("no token, or a secret token, is a clean not-configured failure that fetches nothing", async () => {
  const fake = fakeMapbox();
  await failsWith(provider(fake, {}).getImagery(KOREA_BOUNDS), "not-configured");
  await failsWith(provider(fake, { MAPBOX_PUBLIC_TOKEN: "sk.secret" }).getElevation(KOREA_BOUNDS), "not-configured");
  assert.equal(fake.calls.length, 0);
  assert.equal(mapbox.mapboxStatus({ MAPBOX_PUBLIC_TOKEN: "sk.secret" }).configured, false);
  assert.ok(!JSON.stringify(mapbox.mapboxStatus(ENV)).includes(TOKEN), "status must not echo the token");
});

test("a bad token is unauthorized on every tile, and says so", async () => {
  const err = await failsWith(provider(fakeMapbox(), { MAPBOX_PUBLIC_TOKEN: "pk.wrong" }).getImagery(KOREA_BOUNDS), "unauthorized");
  assert.equal(err.status, 401);
  assert.ok(err.message.includes("[redacted]"));
});

test("one missing tile fails the whole picture as partial", async () => {
  let first = null;
  const fake = fakeMapbox({ fail: t => { if (t.product === mapbox.MAPBOX_SATELLITE_PRODUCT) { first = first || t.x + "/" + t.y; if (first === t.x + "/" + t.y) return response(404, Buffer.from("Tile not found")); } } });
  const err = await failsWith(provider(fake).getImagery(KOREA_BOUNDS), "partial");
  assert.equal(err.failedTiles, 1);
});

test("rate limiting is retried once, then reported", async () => {
  let n = 0;
  const once = fakeMapbox({ fail: () => (n++ === 0 ? response(429, Buffer.from("Too Many Requests"), { "retry-after": "0" }) : null) });
  const grid = await provider(once).getElevation(KOREA_BOUNDS);
  assert.ok(grid.heights.length > 0, "a single 429 is retried");
  const always = fakeMapbox({ fail: () => response(429, Buffer.from("Too Many Requests"), { "retry-after": "0" }) });
  await failsWith(provider(always).getElevation(KOREA_BOUNDS), "rate-limited");
});

test("timeouts, malformed tiles and bad bounds are explicit", async () => {
  const hang = async () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; };
  await failsWith(fetchLib.fetchTileBytes("https://api.mapbox.com/x?access_token=" + TOKEN, { provider: "mapbox", fetchImpl: hang, retries: 0 }), "timeout");
  const junk = fakeMapbox({ fail: () => response(200, Buffer.from("<html>not a tile</html>")) });
  await failsWith(provider(junk).getImagery(KOREA_BOUNDS), "malformed");
  await failsWith(provider(fakeMapbox()).getImagery({ north: 1, south: 2, west: 0, east: 1 }), "unsupported-bounds");
});

test("terrain that is not elevation fails as terrain-decode", async () => {
  /* A rendered picture served where heights were expected - every pixel the same mid grey,
     which terrain-RGB reads as ~832km and no encoding reads as plausible ground. */
  const grey = await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toBuffer();
  const fake = fakeMapbox({ fail: t => t.product === mapbox.MAPBOX_TERRAIN_PRODUCT ? response(200, grey) : null });
  await failsWith(provider(fake).getElevation(KOREA_BOUNDS), "terrain-decode");
});

test("the tile cache keys on provider/product/version/z/x/y/ratio and stops repeat downloads", async () => {
  const fake = fakeMapbox();
  const p = mapbox.createMapboxProvider({ env: ENV, fetchImpl: fake, sharp, cache: new fetchLib.MemoryTileCache() });
  await p.getElevation(KOREA_BOUNDS);
  const first = fake.calls.length;
  await p.getElevation(KOREA_BOUNDS);
  assert.equal(fake.calls.length, first, "second run must be served from cache");
  assert.equal(fetchLib.tileCacheKey({ provider: "mapbox", product: "mapbox.satellite", version: "v1", z: 16, x: 1, y: 2, ratio: 2, format: "jpg90" }), "mapbox/mapbox.satellite/v1/16/1/2@2x.jpg90");
  const cache = new fetchLib.MemoryTileCache({ maxBytes: 10 });
  cache.set("a", Buffer.alloc(6)); cache.set("b", Buffer.alloc(6));
  assert.equal(cache.get("a"), null, "least recently used is evicted over the byte cap");
  assert.ok(cache.get("b"));
});

/* ---------- selection and the fence ---------- */

test("AUTO never picks Mapbox; MAPBOX must be forced and is never storable", () => {
  const auto = sources.resolveMapSources({}, { bounds: KOREA_BOUNDS, env: ENV });
  assert.equal(auto.imagery.provider.id, "existing"); assert.equal(auto.terrain.provider.id, "existing");
  const forced = sources.resolveMapSources({ imagery: "mapbox", terrain: "MAPBOX" }, { bounds: KOREA_BOUNDS, env: ENV });
  assert.equal(forced.imagery.provider.id, "mapbox"); assert.equal(forced.imagery.forced, true);
  assert.equal(forced.imagery.storable, false); assert.equal(forced.terrain.storable, false);
  const mixed = sources.resolveMapSources({ imagery: "existing", terrain: "mapbox" }, { bounds: KOREA_BOUNDS, env: ENV });
  assert.equal(mixed.imagery.provider.id, "existing"); assert.equal(mixed.terrain.provider.id, "mapbox");
  assert.equal(sources.normaliseChoice("nonsense"), "auto");
});

test("Mapbox is not in the scan registry, so no automatic path can reach it", () => {
  assert.ok(!registry.IMAGERY_SOURCES.some(e => /mapbox/i.test(e.key + JSON.stringify(e.imagery || {}))));
  assert.equal(registry.resolveImagerySource(KOREA_BOUNDS, { env: ENV }), null, "Korea has no licensed scan source");
  assert.equal(mapbox.MAPBOX_LICENSE.storage, false);
});

test("a forced Mapbox failure is shown, never swapped for another source; the other role still succeeds", async () => {
  const providers = {
    existing: sources.createExistingProvider({ env: ENV, sharp, cache: null, fetchImpl: async () => response(500, Buffer.from("should not be called")) }),
    mapbox: mapbox.createMapboxProvider({ env: { MAPBOX_PUBLIC_TOKEN: "pk.wrong" }, fetchImpl: fakeMapbox(), sharp, cache: null })
  };
  const okTerrain = Object.assign({}, providers.mapbox, { getElevation: mapbox.createMapboxProvider({ env: ENV, fetchImpl: fakeMapbox(), sharp, cache: null }).getElevation });
  const selection = sources.resolveMapSources({ imagery: "mapbox", terrain: "mapbox" }, { bounds: KOREA_BOUNDS, providers: { existing: providers.existing, mapbox: okTerrain } });
  const got = await sources.acquireMapSources(selection, {});
  assert.equal(got.imagery.ok, false); assert.equal(got.imagery.error.code, "unauthorized"); assert.equal(got.imagery.error.provider, "mapbox");
  assert.equal(got.terrain.ok, true, "terrain is independent of imagery");
  const p = sources.provenanceFor(got, "2026-10-01T00:00:00.000Z");
  assert.equal(p.imageryProvider, null); assert.equal(p.terrainProvider, "mapbox"); assert.equal(p.terrainProduct, "mapbox.mapbox-terrain-dem-v1");
  assert.ok(!JSON.stringify(p).includes("pk."), "provenance carries no token");
});

test("the existing registry explains why it cannot serve Korea", async () => {
  const existing = sources.createExistingProvider({ env: ENV, sharp, cache: null, fetchImpl: async () => { throw new Error("no network in tests"); } });
  const err = await failsWith(existing.getImagery(KOREA_BOUNDS), "unsupported-bounds");
  assert.match(err.message, /no licensed imagery source covers this course/);
});

let failures = 0;
for (const item of tests) {
  try { await item.fn(); console.log("  ok  " + item.name); }
  catch (error) { failures += 1; console.error("  FAIL  " + item.name + "\n        " + (error && error.stack || error)); }
}
if (failures) { console.error("map-source-providers FAILED: " + failures + " of " + tests.length); process.exit(1); }
console.log("map-source-providers passed: " + tests.length + " checks");
